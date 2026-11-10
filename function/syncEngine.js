/* =====================================================================
   SUPABASE DATA SYNC ENGINE
   Local-first synchronization for patient records & settings.

   Cloud rows finalized with "Save to Database" carry their full editable
   payload (metadata.formData) plus a dbSaved marker. Those rows are never
   pushed from local history, so the embedded payload is never overwritten,
   and heavy payloads are not downloaded during regular syncs.
   ===================================================================== */
(function (window) {
    'use strict';

    const SAVED_KEYS_STORAGE = 'entDbSavedRecordKeysV1';
    const STUB_UPGRADE_CURSOR_KEY = 'entCloudStubUpgradeCursorV1';
    const REMOTE_ONLY_LIMIT = 100;
    const STUB_UPGRADE_LIMIT = 50;

    const TYPE_LABELS = {
        cf4: 'CF4 Form',
        nasal: 'Nasal Endoscopy',
        laryngeal: 'Laryngeal Endoscopy'
    };

    function isOfflineWorkspacePage() {
        const page = String((window.location && window.location.pathname) || '')
            .split('/').pop().toLowerCase();
        return page === 'offlineworkspace.html';
    }

    function hasOfflineSession() {
        const auth = window.EntAuth;
        return !!(auth && typeof auth.isOfflineSession === 'function' && auth.isOfflineSession());
    }

    let isSyncing = false;
    const idleWaiters = [];

    function readDbSavedKeys() {
        try {
            const parsed = JSON.parse(localStorage.getItem(SAVED_KEYS_STORAGE) || '[]');
            return new Set(Array.isArray(parsed) ? parsed : []);
        } catch (error) {
            return new Set();
        }
    }

    function resolveIdleWaiters() {
        while (idleWaiters.length) idleWaiters.shift()();
    }

    // Resolves once the current sync cycle (if any) has finished.
    function whenIdle() {
        if (!isSyncing) return Promise.resolve();
        return new Promise(resolve => idleWaiters.push(resolve));
    }

    function stripHeavyFields(metadata) {
        if (!metadata || typeof metadata !== 'object') return null;
        const copy = { ...metadata };
        delete copy.formData; // full form payloads stay in the cloud only
        return copy;
    }

    // Which doctor's rows may this device read and write?
    //   doctor    -> own rows,  secretary -> her assigned doctor's rows,
    //   admin     -> every row of the clinic.
    // With no signed-in user the engine keeps the old clinic-wide behaviour.
    function owner() {
        const auth = window.EntAuth;
        if (!auth || typeof auth.scope !== 'function') {
            return { doctorId: '', seeAll: true, username: 'unassigned' };
        }
        const scoped = auth.scope() || {};
        const user = typeof auth.currentUser === 'function' ? (auth.currentUser() || {}) : {};
        return {
            // doctorId is the SHELF (whose patients this account counts).
            // userId is the ACCOUNT (whose local records it may push). They are
            // the same value for a doctor and DIFFERENT for a secretary - a
            // secretary writes to her doctor's shelf but owns only the records
            // she herself created. Conflating the two is what let one account
            // push another account's records onto a shelf it could reach.
            userId: String(user.id || '').trim(),
            doctorId: scoped.doctorId || '',
            seeAll: !!scoped.seeAll,
            username: user.username || 'unknown'
        };
    }

    function doctorFilter() {
        const current = owner();
        return current.seeAll ? '' : `&doctor_id=eq.${encodeURIComponent(current.doctorId)}`;
    }

    function buildStub(row) {
        return {
            key: row.record_key,
            reportType: row.report_type || 'unknown',
            reportLabel: TYPE_LABELS[row.report_type] || row.report_type || 'unknown',
            patientName: row.patient_name || '',
            patientId: row.patient_id || '',
            caseNumber: row.case_number || '',
            fileName: row.file_name || '',
            procedureDate: row.procedure_date || '',
            lastActivityAt: row.updated_at || '',
            syncedAt: row.updated_at || '',
            cloudStub: true
        };
    }

    // v2 coercion helpers.
//
// report_type is the ent_report_type ENUM ('cf4','nasal','laryngeal').
// v1 had a free-text column and wrote 'unknown' for unrecognised drafts;
// Postgres rejects an enum value that is not a member, so the fallback has
// to be a real member. A record key looks like "cf4|2026-09-30|PATIENT",
// so its first segment is a trustworthy hint.
const REPORT_TYPES = ['cf4', 'nasal', 'laryngeal'];

function toReportType(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (REPORT_TYPES.indexOf(raw) !== -1) return raw;
    if (raw.indexOf('|') !== -1) {
        const head = raw.split('|')[0];
        if (REPORT_TYPES.indexOf(head) !== -1) return head;
    }
    return 'cf4';
}

// procedure_date is a DATE column. v1 stored '' for "not recorded"; in v2
// that is a cast error, so an unusable value becomes NULL.
function toIsoDate(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return null;
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
}

    // Light-weight listing: regular syncs never download payload->formData.
    // v2: the clinic filter is GONE on purpose. clinic_id is derived from the
    // caller's staff_profiles row by every policy in 0008, so asking for a
    // clinic here was redundant at best and a cross-clinic read at worst.
    async function fetchRemoteStubs() {
        const columns = 'record_key,doctor_id,report_type,patient_name,patient_id,case_number,file_name,procedure_date,updated_at,is_draft';
        try {
            // payload->draftShared marks a row the DRAFTS browser uploaded WITH
            // its form. This sync never carries a form (patientRecords keeps
            // only metadata), so it must be told apart from those rows - see
            // the guard in the push loop below.
            return await window.EntSupabase.apiRequest(
                `reports?select=${columns},payload->dbSaved,payload->draftShared&order=updated_at.desc&limit=500`
            );
        } catch (error) {
            // Fallback when JSON key extraction is unavailable
            return await window.EntSupabase.apiRequest(
                `reports?select=${columns}&order=updated_at.desc&limit=500`
            );
        }
    }

    async function fetchFullMetadata(recordKey) {
        const rows = await window.EntSupabase.apiRequest(
            `reports?record_key=eq.${encodeURIComponent(recordKey)}` +
            '&select=payload&limit=1'
        );
        if (Array.isArray(rows) && rows[0] && rows[0].payload && typeof rows[0].payload === 'object') {
            return rows[0].payload;
        }
        return null;
    }

    // 1. Sync Patient Records with Supabase
    async function syncPatientRecords() {
        if (navigator.onLine === false) return { success: false, reason: 'offline' };
        if (hasOfflineSession()) return { success: false, reason: 'offline-session' };
        if (!window.EntSupabase || !window.EntSupabase.isConfigured()) return { success: false, reason: 'unconfigured' };
        if (isSyncing) return { success: false, reason: 'busy' };

        isSyncing = true;
        try {
            // v2: no clinicId. The browser does not choose its clinic; RLS
            // derives it from the caller's staff_profiles row on every query.
            const localRaw = localStorage.getItem('entPatientRecordHistoryV1');
            const localRecords = localRaw ? JSON.parse(localRaw) : [];
            const localByKey = new Map();
            localRecords.forEach(rec => { if (rec && rec.key) localByKey.set(rec.key, rec); });

            // Light stubs only - heavy payload->formData is not downloaded here.
            const remoteRows = await fetchRemoteStubs();
            const stubs = Array.isArray(remoteRows) ? remoteRows.filter(row => row && row.record_key) : [];
            const stubByKey = new Map(stubs.map(row => [row.record_key, row]));

            // Database-finalized keys: from this device and from other devices.
            const dbSavedKeys = readDbSavedKeys();
            stubs.forEach(row => { if (row.dbSaved) dbSavedKeys.add(row.record_key); });

            const recordMap = new Map();

            // Remote-only records: fetch full metadata (minus formData) so the local
            // drawer keeps names, counts and formats. Bounded per sync cycle.
            const remoteOnly = stubs.filter(row => !localByKey.has(row.record_key)).slice(0, REMOTE_ONLY_LIMIT);
            if (remoteOnly.length) {
                const results = await Promise.allSettled(
                    remoteOnly.map(row => fetchFullMetadata(row.record_key))
                );
                results.forEach((result, index) => {
                    const stub = remoteOnly[index];
                    const meta = result.status === 'fulfilled' ? result.value : null;
                    const lightMeta = meta ? stripHeavyFields(meta) : null;
                    if (lightMeta) {
                        recordMap.set(stub.record_key, { ...lightMeta, syncedAt: stub.updated_at || '' });
                    } else {
                        recordMap.set(stub.record_key, buildStub(stub));
                    }
                });
            }

            // Any other remote record gets a light stub for now (local copies win below).
            stubs.forEach(row => {
                if (!recordMap.has(row.record_key)) recordMap.set(row.record_key, buildStub(row));
            });

            // Rotate the bounded metadata-upgrade window so a few unavailable
            // records cannot permanently block older stubs from being tried.
            const cursorKey = localStorage.getItem(STUB_UPGRADE_CURSOR_KEY) || '';
            const cursorIndex = localRecords.findIndex(rec => rec && rec.key === cursorKey);
            const upgradeOrder = cursorIndex < 0
                ? localRecords
                : localRecords.slice(cursorIndex + 1).concat(localRecords.slice(0, cursorIndex + 1));
            const stubUpgrades = upgradeOrder
                .filter(rec => rec && rec.cloudStub && rec.key)
                .slice(0, STUB_UPGRADE_LIMIT);
            if (stubUpgrades.length) {
                const upgradeResults = await Promise.allSettled(
                    stubUpgrades.map(rec => fetchFullMetadata(rec.key))
                );
                let failedUpgrades = 0;
                upgradeResults.forEach((result, index) => {
                    if (result.status !== 'fulfilled' || !result.value) {
                        failedUpgrades++;
                        return;
                    }
                    const localRec = stubUpgrades[index];
                    const lightMeta = stripHeavyFields(result.value);
                    if (!lightMeta) return;
                    const keepActivity = localRec.lastActivityAt;
                    const keepSynced = localRec.syncedAt;
                    Object.assign(localRec, lightMeta);
                    if (keepActivity) localRec.lastActivityAt = keepActivity;
                    if (keepSynced) localRec.syncedAt = keepSynced;
                    delete localRec.cloudStub;
                });
                try {
                    localStorage.setItem(STUB_UPGRADE_CURSOR_KEY, stubUpgrades[stubUpgrades.length - 1].key);
                } catch (error) {
                    console.warn('Could not persist the offline metadata upgrade cursor.', error);
                }
                if (failedUpgrades) {
                    console.warn(`${failedUpgrades} cloud record metadata upgrade(s) will be retried in later sync cycles.`);
                }
            }

            // Upsert local records that changed locally and are not database-finalized.
            const recordsToPush = [];
            const pushOwner = owner();
            for (const localRec of localRecords) {
                const key = localRec.key || `${localRec.reportType}|${localRec.patientName}|${localRec.procedureDate}`;
                const remote = stubByKey.get(key);
                const localTime = new Date(localRec.lastActivityAt || 0).getTime();
                const remoteTime = remote ? new Date(remote.updated_at || 0).getTime() : 0;
                const isDbSaved = dbSavedKeys.has(key);

                /* THE OWNERSHIP GATE. This is the bug that copied one doctor's
                 * whole shelf onto a brand-new doctor's, observed live.
                 *
                 * The local history is ONE localStorage key shared by every
                 * account that has ever used this browser, and record_key is
                 * built from the PATIENT - `nasal|lavina, eezah|2026-10-02` -
                 * not from the doctor. So jess's record and the identical
                 * record_key are the same string for anybody.
                 *
                 * When larson signed in on that machine, this loop read all 29
                 * of jess's keys out of the shared history, found `remote`
                 * missing for HIS OWN shelf, decided "not in the cloud yet,
                 * push it", and POSTed every one. The trigger did exactly its
                 * job - it stamped doctor_id = the caller, larson - so the
                 * database behaved correctly and still produced 29 duplicate
                 * patients on a new doctor's shelf.
                 *
                 * The question is therefore not "is this row on my shelf?" but
                 * "was this record ever MINE?", and ownerId (stamped by
                 * patientRecords.js) is the only thing that can answer it.
                 *
                 * Two escape hatches, and the second one was WRONG:
                 *
                 *   - an account with NO id (auth stubbed, or a page where
                 *     EntAuth is absent) keeps the old behaviour rather than
                 *     silently syncing nothing;
                 *   - a record with NO ownerId. This used to be let through on
                 *     the reasoning that dropping it would delete a real
                 *     patient's reachability. It is the same mistake
                 *     draftsBrowser.js had to be corrected for, and it is WHY
                 *     deleting the duplicated rows never stuck: every local
                 *     record on that machine predates the stamp, so each page
                 *     load re-pushed them and the count climbed again -
                 *     observed live, 38 -> 69 after a clean delete.
                 *
                 * Pushing an unstamped record is not a neutral way to preserve
                 * it. The trigger stamps doctor_id = the caller, so allowing it
                 * COPIES another doctor's patient onto this account's shelf.
                 * The original is still on its owner's shelf and in the cloud,
                 * so nothing is preserved and something is duplicated. A
                 * record this account cannot attribute is not evidence that the
                 * account owns it, so it is refused. Displaying it is a
                 * separate question, answered in dashboard.js, where the bytes
                 * never leave the machine.
                 */
                const localOwner = String(localRec.ownerId || '').trim();
                const ownedByOther = pushOwner.userId && localOwner !== pushOwner.userId;

                // Belt and braces: a remote row for this key already sitting on
                // ANOTHER doctor's shelf is not ours to merge into, and
                // merge-duplicates would land the write on the caller's shelf.
                const remoteIsOther = remote && remote.doctor_id && pushOwner.doctorId
                    && remote.doctor_id !== pushOwner.doctorId;

                // THE SHARED-DRAFT GUARD. This sync can only ever write METADATA - the
                // local PatientRecords entry holds no form. A draft the
                // drafts browser already uploaded carries the whole form, and
                // an upsert here replaces the payload column wholesale
                // (resolution=merge-duplicates). So one automatic sync was
                // enough to strip the form off a perfectly good shared draft,
                // and from that moment the doctor could not open it and the
                // secretary could not either: nothing left to restore.
                //
                // Two writers, one row, is the shape of that bug. The rule
                // from here: a row the drafts browser owns is never
                // overwritten by this one. It costs nothing - this push would
                // only ever have removed information.
                const remoteIsSharedDraft = !!(remote && (remote.draftShared === true || remote.draftShared === 'true'));

                if (!ownedByOther && !remoteIsOther && !isDbSaved && !remoteIsSharedDraft
                    && (!remote || localTime > remoteTime)) {
                    // v2: clinic_id / doctor_id / created_by are NOT SENT.
                    // ent_stamp_report_ownership (0004) is a BEFORE trigger
                    // that overwrites all three from the caller's LIVE
                    // staff_profiles row, so sending them here would be
                    // decorative at best. This is the "the browser cannot
                    // choose a clinic, a doctor, or an author" guarantee.
                    //
                    // is_draft and photo_count ARE sent, and that is the whole
                    // point of this block. Both columns used to be omitted
                    // here, so a row created by an automatic background sync
                    // took `is_draft = DEFAULT FALSE` and `photo_count =
                    // DEFAULT 0`. That first one is not cosmetic: 0004 stamps
                    // saved_at whenever `NOT NEW.is_draft`, so an unfinished
                    // draft was stamped as finalized, joined the
                    // finished-reports partial index, and was counted by the
                    // dashboard as a real saved patient. Observed live.
                    //
                    // A background sync is by definition NOT a final save, so
                    // is_draft is TRUE here. "Save to Database"
                    // (dbRecords.js) is the only thing that finalizes a report,
                    // and it sends is_draft = false itself.
                    const syncedImages = localRec.formData && Array.isArray(localRec.formData.images)
                        ? localRec.formData.images.filter(Boolean).length
                        : 0;
                    recordsToPush.push({
                        record_key: key,
                        // report_type is the ent_report_type ENUM in v2 —
                        // 'unknown' is not a member and would be rejected.
                        report_type: toReportType(localRec.reportType),
                        patient_name: localRec.patientName || '',
                        patient_id: localRec.patientId || '',
                        case_number: localRec.caseNumber || '',
                        // procedure_date is a real DATE column now, so an
                        // empty string is a cast error rather than a blank.
                        procedure_date: toIsoDate(localRec.procedureDate),
                        file_name: localRec.fileName || '',
                        // An automatic sync never finalizes anything.
                        is_draft: true,
                        // Sent explicitly so the column is never filled in by
                        // the DEFAULT. extractMetadata() (patientRecords.js)
                        // keeps formData out of the local record, so this is
                        // normally 0 — and 0 is the honest answer here, not a
                        // silent gap.
                        photo_count: syncedImages,
                        // v1's `metadata` jsonb is called `payload` in v2.
                        payload: localRec,
                        updated_at: new Date().toISOString()
                    });
                }
                // Local copy wins for shared keys so this device keeps its own detail.
                recordMap.set(key, localRec);
            }

            // Push pending records up to Supabase
            if (recordsToPush.length > 0) {
                // Match the UNIQUE (clinic_id, doctor_id, record_key) constraint so
                // updates to existing rows merge instead of failing 23505 / HTTP 409.
                await window.EntSupabase.apiRequest('reports?on_conflict=clinic_id,doctor_id,record_key', {
                    method: 'POST',
                    headers: { 'Prefer': 'resolution=merge-duplicates' },
                    body: JSON.stringify(recordsToPush)
                });
            }

            // Merge back into local storage so this device shows every device's records
            const mergedList = Array.from(recordMap.values())
                .filter(Boolean)
                .sort((a, b) => String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || '')))
                .slice(0, 500);

            localStorage.setItem('entPatientRecordHistoryV1', JSON.stringify(mergedList));
            window.dispatchEvent(new CustomEvent('patientrecords:updated'));
            return { success: true, count: mergedList.length };
        } catch (err) {
            console.error('Patient record sync failed:', err);
            return { success: false, error: err.message };
        } finally {
            isSyncing = false;
            resolveIdleWaiters();
        }
    }

    /* =====================================================================
       OFFLINE MODE - PENDING-SYNC QUEUE FLUSH
       ---------------------------------------------------------------------
       offlineStore.js saves a report to IndexedDB FIRST, so the doctor can
       keep working with no signal at all. This is the other half: when the
       device finds a network again, every queued record is pushed to
       Supabase.

       Three guarantees, matching the rest of the app:

       1. DUPLICATE PREVENTION - the upsert targets the same UNIQUE
          (clinic_id, doctor_id, record_key) constraint the drafts shelf
          and "Save to Database" already use, with
          Prefer: resolution=merge-duplicates. A record pushed twice (this
          engine AND autoShareDraft racing, or a retry after a timeout
          that actually landed) MERGES into one row instead of creating a
          second one. record_key is the record's identity, built once by
          draftsBrowser.buildKey().

       2. RETRY WITH BACKOFF - a failed job stays in the queue with an
          exponential wait (15s, 30s, 60s ... capped at 5 minutes) so a
          flapping connection cannot turn into a request storm. A re-save
          of the same patient resets the counter.

       3. ERROR HANDLING - failures are classified, because the right
          reaction depends on the cause:
            * AUTH (401/403) -> the session is dead. Stop the whole
              flush; pushing more rows would fail the same way. The jobs
              stay queued and go out after the next sign-in.
            * NETWORK -> the connection dropped mid-flush. Stop, back
              off, retry on the next 'online' event or timer tick.
            * RECORD-SPECIFIC (400/413/RLS on THIS row) -> this row is
              the problem, the others are not. Back off this job and
              carry on with the next one, so one oversized form cannot
              wedge the whole queue.
       ===================================================================== */
    const OFFLINE_MAX_BACKOFF_MS = 5 * 60 * 1000;   // 5 minutes
    const OFFLINE_BASE_BACKOFF_MS = 15000;          // 15 seconds
    let offlineFlushing = false;
    let offlineFlushRequested = false;
    let syncAuthNotice = null;
    let syncAuthNoticeTimer = null;

    function offlineStore() {
        const store = window.EntOfflineStore;
        return (store && typeof store.dueJobs === 'function') ? store : null;
    }

    function offlineBackoffMs(attempts) {
        const n = Math.max(0, Number(attempts) || 0);
        return Math.min(OFFLINE_MAX_BACKOFF_MS, OFFLINE_BASE_BACKOFF_MS * Math.pow(2, n));
    }

    function hideSyncAuthNotice() {
        if (syncAuthNoticeTimer) {
            clearTimeout(syncAuthNoticeTimer);
            syncAuthNoticeTimer = null;
        }
        if (syncAuthNotice) syncAuthNotice.remove();
        syncAuthNotice = null;
    }

    function showSyncAuthNotice() {
        if (typeof document === 'undefined' || !document.body) return;
        if (!syncAuthNotice || !document.body.contains(syncAuthNotice)) {
            syncAuthNotice = document.createElement('div');
            syncAuthNotice.setAttribute('role', 'status');
            syncAuthNotice.setAttribute('aria-live', 'polite');
            Object.assign(syncAuthNotice.style, {
                position: 'fixed',
                right: '16px',
                bottom: '16px',
                zIndex: '10001',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                width: 'min(430px, calc(100vw - 32px))',
                boxSizing: 'border-box',
                padding: '14px 16px',
                border: '1px solid #f59e0b',
                borderRadius: '12px',
                background: '#fff7ed',
                color: '#431407',
                boxShadow: '0 8px 28px rgba(15, 23, 42, .22)',
                font: '500 14px/1.45 system-ui, sans-serif'
            });
            const message = document.createElement('span');
            message.textContent = 'Offline saves are waiting. Sign in online to sync them to the database.';
            message.style.flex = '1 1 auto';
            const link = document.createElement('a');
            const page = String(window.location.pathname || '').split('/').pop() || 'index.html';
            const login = window.EntPaths && typeof window.EntPaths.page === 'function'
                ? window.EntPaths.page('login.html')
                : 'login.html';
            link.href = login + '?next=' + encodeURIComponent(page);
            link.textContent = 'Sign in';
            link.style.cssText = 'color:#9a3412;font-weight:700;white-space:nowrap';
            const close = document.createElement('button');
            close.type = 'button';
            close.setAttribute('aria-label', 'Dismiss');
            close.textContent = '\u00d7';
            close.style.cssText = 'border:0;background:transparent;color:inherit;font-size:20px;cursor:pointer';
            close.addEventListener('click', hideSyncAuthNotice);
            syncAuthNotice.append(message, link, close);
            document.body.appendChild(syncAuthNotice);
        }
        if (syncAuthNoticeTimer) clearTimeout(syncAuthNoticeTimer);
        syncAuthNoticeTimer = setTimeout(hideSyncAuthNotice, 20000);
    }

    /* ------------------------------------------------------------------
       "ALL CAUGHT UP" CONFIRMATION
       When a flush actually uploaded something and the queue comes out
       EMPTY, confirm it on screen and announce it so Offline Records can
       refresh each saved row's status. A partial upload stays quiet:
       there is still something waiting.
       ------------------------------------------------------------------ */
    let syncDoneToast = null;
    let syncDoneTimer = null;

    async function announceAllOfflineSynced(pushed) {
        try {
            const store = offlineStore();
            if (!store) return;
            const left = await store.jobCount();
            if (left > 0) return;   // still waiting on something: no celebration
            if (typeof window.dispatchEvent === 'function' && typeof window.CustomEvent === 'function') {
                try {
                    window.dispatchEvent(new window.CustomEvent('ent-offline:all-synced',
                        { detail: { pushed: pushed } }));
                } catch (error) { /* a page without CustomEvent loses the redraw, not the upload */ }
            }
            if (!isOfflineWorkspacePage()) showAllSyncedToast(pushed);
        } catch (error) {
            /* a toast must never fail a completed flush */
        }
    }

    function hideAllSyncedToast() {
        if (syncDoneTimer) { clearTimeout(syncDoneTimer); syncDoneTimer = null; }
        if (syncDoneToast) syncDoneToast.classList.remove('is-visible');
    }

    function showAllSyncedToast(pushed) {
        if (typeof document === 'undefined' || !document.body) return;
        if (!syncDoneToast || !document.body.contains(syncDoneToast)) {
            syncDoneToast = document.createElement('div');
            syncDoneToast.className = 'ent-sync-done-toast';
            syncDoneToast.id = 'entSyncDoneToast';
            syncDoneToast.setAttribute('role', 'status');
            syncDoneToast.setAttribute('aria-live', 'polite');
            syncDoneToast.innerHTML =
                '<span class="ent-sync-done-mark" aria-hidden="true">&#9989;</span>' +
                '<div class="ent-sync-done-body">' +
                '<strong class="ent-sync-done-title">Offline records synced</strong>' +
                '<span class="ent-sync-done-detail"></span>' +
                '</div>' +
                '<button type="button" class="ent-sync-done-close" title="Dismiss" aria-label="Dismiss">&times;</button>';
            syncDoneToast.addEventListener('click', function (event) {
                if (event && event.target && event.target.closest &&
                    event.target.closest('.ent-sync-done-close')) {
                    hideAllSyncedToast();
                }
            });
            document.body.appendChild(syncDoneToast);
        }
        const count = Math.max(0, Number(pushed) || 0);
        const detail = syncDoneToast.querySelector('.ent-sync-done-detail');
        if (detail) {
            detail.textContent = 'You have signal right now \u2014 ' + count +
                ' offline save' + (count === 1 ? '' : 's') +
                ' uploaded. They remain in Offline Records with Synced status.';
        }
        void syncDoneToast.offsetWidth;
        syncDoneToast.classList.add('is-visible');
        if (syncDoneTimer) clearTimeout(syncDoneTimer);
        syncDoneTimer = setTimeout(hideAllSyncedToast, 14000);
    }

    // Photos never ride this path: cloudFormData() in draftsBrowser.js
    // strips them before a draft reaches the database (payload ceiling +
    // the free plan's 500 MB), and the pictures still travel through
    // "Save to Database" where they have always been sent. Same rules
    // here so an offline-pushed row looks EXACTLY like an online-pushed
    // one - the two paths must be indistinguishable in the database.
    const OFFLINE_MAX_FORM_BYTES = 1024 * 1024;      // 1 MB, as autoShareDraft
    function offlineFormData(record) {
        const form = record && record.formData;
        if (!form || typeof form !== 'object') return null;
        const clean = { ...form };
        if (Array.isArray(clean.images)) clean.images = [];
        try {
            if (JSON.stringify(clean).length > OFFLINE_MAX_FORM_BYTES) return null;
        } catch (error) {
            return null;
        }
        return clean;
    }

    // The v2 row shape, identical to autoShareDraft()'s in draftsBrowser.js.
    // Ownership columns stay OUT of the body on purpose:
    // ent_stamp_report_ownership stamps them server-side from the caller's
    // live staff_profiles row, so the browser cannot choose a clinic, a
    // doctor or an author.
    function offlineRow(record, syncId, remotePhotoCount) {
        const now = new Date().toISOString();
        return {
            record_key: record.key,
            report_type: toReportType(record.reportType),
            patient_name: record.patientName || '',
            patient_id: record.patientId || '',
            case_number: record.caseNumber || '',
            procedure_date: toIsoDate(record.procedureDate),
            file_name: record.fileName || '',
            // An offline save is WORK IN PROGRESS until "Save to Database"
            // finalises it - the same is_draft TRUE autoShareDraft sends,
            // keeping it out of the finished-report list.
            is_draft: true,
            photo_count: Math.max(0, Number(remotePhotoCount) || 0),
            payload: {
                key: record.key,
                reportType: toReportType(record.reportType),
                reportLabel: record.reportLabel || record.reportType || '',
                patientName: record.patientName || '',
                caseNumber: record.caseNumber || '',
                procedureDate: record.procedureDate || '',
                fileName: record.fileName || '',
                site: record.site || '',
                draftShared: true,
                sharedAt: now,
                offlineSyncId: syncId,
                // The queue belongs to the device, but the credit for the
                // work goes to whoever actually saved the record.
                sharedBy: record.ownerName || '',
                formData: offlineFormData(record)
            },
            updated_at: now
        };
    }

    // Push every DUE job in the pending-sync queue. Concurrent calls are
    // coalesced into one follow-up pass so a save cannot miss the active flush.
    async function flushOfflineQueue() {
        const store = offlineStore();
        if (!store) return { skipped: 'offline-store-missing' };
        if (offlineFlushing) {
            offlineFlushRequested = true;
            return { skipped: 'already-running' };
        }
        if (!navigator.onLine) return { skipped: 'offline' };
        if (hasOfflineSession()) {
            // An offline grant authorizes local work only. When connectivity
            // returns, make the required live sign-in visible instead of
            // leaving queued reports waiting with no explanation.
            showSyncAuthNotice();
            return { skipped: 'offline-session' };
        }
        if (!window.EntSupabase || !window.EntSupabase.isConfigured()) {
            return { skipped: 'not-configured' };
        }
        offlineFlushing = true;
        let pushed = 0;
        try {
            if (window.EntAuth && typeof window.EntAuth.ready === 'function') {
                await window.EntAuth.ready();
            }
            const me = owner();
            if (!me.doctorId && !me.seeAll) return { skipped: 'no-doctor-link' };
            const jobs = await store.dueJobs(Date.now());
            for (let i = 0; i < jobs.length; i++) {
                const job = jobs[i];
                const record = await store.getRecord(job.recordKey);
                if (!record) {
                    // The draft was deleted from the shelf while it waited.
                    // The delete hook normally removes the job too; this is
                    // the safety net for a job whose record vanished.
                    await store.markJobDone(job.id);
                    continue;
                }
                // OWNERSHIP GUARD (the same one mayShareDraft enforces): a
                // record stamped for another account is never pushed by this
                // one. It waits in the queue until the right account signs in.
                const ownerId = String(record.ownerId || '');
                if (ownerId && me.userId && ownerId !== me.userId) {
                    continue;
                }
                if (record.waitForCloudPush) continue;
                try {
                    const remoteRows = await window.EntSupabase.apiRequest(
                        `reports?record_key=eq.${encodeURIComponent(record.key)}` +
                        '&select=id,updated_at,is_draft,photo_count,payload&limit=1'
                    );
                    const remote = Array.isArray(remoteRows) ? remoteRows[0] : null;
                    const priorSyncId = remote && remote.payload
                        ? String(remote.payload.offlineSyncId || '')
                        : '';
                    if (remote && remote.is_draft !== true) {
                        const conflict = new Error('This report was finalized in Supabase after the local copy. Review both versions before syncing.');
                        conflict.code = 'SYNC_CONFLICT';
                        conflict.status = 409;
                        throw conflict;
                    }
                    if (remote && priorSyncId !== String(job.syncId || '')) {
                        const localVersion = String(record.baseUpdatedAt || record.sharedAt || '');
                        const remoteVersion = String(
                            (remote.payload && remote.payload.sharedAt) || remote.updated_at || ''
                        );
                        if (!localVersion || localVersion !== remoteVersion) {
                            const conflict = new Error('This report changed in Supabase after the local copy. Review both versions before syncing.');
                            conflict.code = 'SYNC_CONFLICT';
                            conflict.status = 409;
                            throw conflict;
                        }
                    }

                    const row = offlineRow(record, job.syncId, remote && remote.photo_count);
                    const savedRows = await window.EntSupabase.apiRequest(
                        'reports?on_conflict=clinic_id,doctor_id,record_key&select=id,updated_at,payload', {
                            method: 'POST',
                            headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
                            body: JSON.stringify([row])
                        });
                    const saved = Array.isArray(savedRows) ? savedRows[0] : null;
                    if (!saved || !saved.id) {
                        throw new Error('Supabase did not confirm the saved report; it remains queued for retry.');
                    }
                    const images = record.formData && Array.isArray(record.formData.images)
                        ? record.formData.images.filter(function (image) {
                            return typeof image === 'string' && image.indexOf('data:image') === 0;
                        })
                        : [];
                    const savedVersion = saved.payload && saved.payload.sharedAt
                        ? saved.payload.sharedAt
                        : saved.updated_at || row.payload.sharedAt;
                    const synced = await store.markSynced(record.key, savedVersion, images.length);
                    if (!synced) {
                        throw new Error('Supabase confirmed the report, but the local sync status could not be saved. The job remains queued for retry.');
                    }
                    await store.markJobDone(job.id);
                    pushed++;
                } catch (error) {
                    const message = (error && error.message) || String(error);
                    if (error && error.code === 'AUTH_REQUIRED') {
                        // The session is dead: every remaining job fails the
                        // same way. Keep them all and stop - the queue is
                        // flushed after the next sign-in.
                        console.warn('[EntSync] offline sync paused: please sign in again.');
                        showSyncAuthNotice();
                        return { success: false, pushed, reason: 'auth', error: message };
                    }
                    const status = Number(error && error.status) || 0;
                    if (error && (error.code === 'SYNC_CONFLICT' || error.code === 'PHOTO_CONFLICT')) {
                        await store.markJobConflict(job.id, message);
                        console.warn('[EntSync] offline sync conflict needs review:', message);
                        continue;
                    }
                    const looksLikeNetwork = !status || !navigator.onLine || status >= 500 || status === 429;
                    await store.markJobFailed(job.id, message,
                        offlineBackoffMs(job.attempts));
                    if (looksLikeNetwork) {
                        // The connection itself is the problem - the next
                        // job would fail the same way. Stop and wait for
                        // the 'online' event or the retry timer.
                        return { success: false, pushed, reason: 'network', error: message };
                    }
                    // Record-specific rejection: back this job off and move
                    // on so one bad row cannot wedge the whole queue.
                    console.warn('[EntSync] offline sync job backed off:', message);
                }
            }
            // OFFLINE MODE: a flush that actually uploaded something earns
            // the doctor one clear confirmation - and only when the queue
            // is really empty, so a partial upload stays quiet.
            if (pushed) await announceAllOfflineSynced(pushed);
            return { success: true, pushed };
        } catch (error) {
            console.error('[EntSync] offline queue flush failed:', error);
            return { success: false, pushed, reason: 'unexpected',
                     error: (error && error.message) || String(error) };
        } finally {
            offlineFlushing = false;
            if (offlineFlushRequested) {
                offlineFlushRequested = false;
                setTimeout(flushOfflineQueue, 0);
            }
        }
    }

    // Auto-sync listener when browser reconnects to internet
    window.addEventListener('online', async () => {
        if (window.EntSupabase && window.EntSupabase.isConfigured()) {
            if (!isOfflineWorkspacePage() && !hasOfflineSession()) syncPatientRecords();
            // OFFLINE MODE: everything the doctor saved while there was no
            // signal is pushed now. Awaited so a fast re-save doesn't race
            // with an in-flight flush and skip the confirmation.
            await flushOfflineQueue();
        }
    });

    // A record saved while offline announces itself on this channel; the
    // moment the device has a connection the queue is flushed.
    window.addEventListener('ent-offline:queue-changed', async () => {
        if (navigator.onLine) await flushOfflineQueue();
    });

    if (window.EntSupabase && typeof window.EntSupabase.onAuthChange === 'function') {
        window.EntSupabase.onAuthChange(function (event) {
            if (!event || (event.event !== 'SIGNED_IN' && event.event !== 'TOKEN_REFRESHED')) return;
            hideSyncAuthNotice();
            flushOfflineQueue();
        });
    }

    // Slow safety net: a laptop that slept mid-flush, or a tab that was
    // closed before the 'online' event fired, is picked up here. The tick
    // is cheap when there is nothing to do (one IndexedDB read, no network).
    setInterval(() => {
        const store = offlineStore();
        if (!store || !navigator.onLine) return;
        store.jobCount().then((count) => {
            if (count > 0) flushOfflineQueue();
        }).catch(() => { /* the next tick tries again */ });
    }, 45000);

    // OFFLINE MODE: leftovers from the previous session start uploading the
    // moment this page opens instead of waiting for the 45-second safety-net
    // tick - a doctor who just landed back on signal gets the "all offline
    // records already saved to database" confirmation immediately.
    function flushPendingOnLoad() {
        if (typeof navigator === 'undefined' || !navigator.onLine) return;
        const store = offlineStore();
        if (!store) return;
        store.jobCount().then((count) => {
            if (count > 0) flushOfflineQueue();
        }).catch(() => { /* the 45 s safety net still has it */ });
    }

    // Initial sync on app load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            if (!isOfflineWorkspacePage() && window.EntSupabase && window.EntSupabase.isConfigured()) {
                if (navigator.onLine && !hasOfflineSession()) setTimeout(syncPatientRecords, 1000);
            }
            flushPendingOnLoad();
        });
    } else {
        if (!isOfflineWorkspacePage() && window.EntSupabase && window.EntSupabase.isConfigured()) {
            setTimeout(syncPatientRecords, 1000);
        }
        flushPendingOnLoad();
    }

    window.EntSync = {
        syncPatientRecords,
        whenIdle,
        // OFFLINE MODE: the pending-sync queue drained by flushOfflineQueue.
        flushOfflineQueue
    };

})(window);
