/* =====================================================================
   OFFLINE STORE  -  IndexedDB local database + pending sync queue
   ---------------------------------------------------------------------
   The doctor must be able to WORK with no signal at all: fill a nasal,
   laryngeal or CF4 report, save it, and have it waiting when the tablet
   or phone finds a network again.

   localStorage was never going to carry that job. It is capped at about
   5 MB per origin, one endoscopy photo set fills it, and draftsBrowser
   has to STRIP PHOTOS off older drafts just to stay under the ceiling.
   IndexedDB has no such practical ceiling, survives reloads and works in
   every browser the app supports - so it is the local database here.

   TWO OBJECT STORES
     records    the offline-saved reports themselves (keyed by record key,
                the SAME key draftsBrowser builds, so a draft saved to the
                shelf and a record saved offline are the same patient).
     syncQueue  one job per record that still has to reach Supabase. The
                sync engine (syncEngine.js, flushOfflineQueue) drains it
                when the device is back online, with retry + backoff and
                the merge-duplicates upsert that makes a re-push harmless.

   NOTHING HERE THROWS AT THE CALLER. A browser that blocks IndexedDB
   (private mode, an old WebKit) silently falls back to localStorage so
   the offline buttons keep working; the only cost is the old 5 MB
   ceiling. The app must never lose a save because the database layer
   had a bad day.

   Legacy drafts already sitting in localStorage (entSavedDraftsV1) are
   migrated INTO IndexedDB once, on first use - WITHOUT being enqueued:
   those saves already went through the old flow (autoShareDraft), so
   re-uploading all of them later would surprise the doctor with a flood
   of cloud writes for patients he finished weeks ago. Only NEW saves
   join the sync queue.
   ===================================================================== */
(function (window) {
    'use strict';

    const DB_NAME = 'ent-offline-db';
    const DB_VERSION = 1;
    const REC_STORE = 'records';
    const QUEUE_STORE = 'syncQueue';
    const MIGRATED_FLAG = 'entOfflineStoreMigratedV1';
    const LEGACY_DRAFTS_KEY = 'entSavedDraftsV1';
    const FALLBACK_RECORDS = 'entOfflineRecordsV1';
    const FALLBACK_QUEUE = 'entOfflineQueueV1';
    // Same three report types the rest of the app accepts. Anything else
    // becomes 'cf4' - the same lenient rule reportTypeOf() applies in
    // draftsBrowser.js and syncEngine.js, so a key built one way is never
    // filed another way here.
    const REPORT_TYPES = ['cf4', 'nasal', 'laryngeal'];
    // A queue larger than this means something is very wrong with the
    // network or with the server; the cap keeps a broken device from
    // building an unbounded to-do list nobody will ever read.
    const QUEUE_LIMIT = 500;

    let dbPromise = null;
    let migrated = false;

    /* ------------------------------------------------------------------
       Small helpers
       ------------------------------------------------------------------ */
    function reportTypeOf(value) {
        const raw = String(value || '').trim().toLowerCase();
        if (REPORT_TYPES.indexOf(raw) !== -1) return raw;
        if (raw.indexOf('|') !== -1) {
            const head = raw.split('|')[0];
            if (REPORT_TYPES.indexOf(head) !== -1) return head;
        }
        return 'cf4';
    }

    function nowIso() { return new Date().toISOString(); }

    function queueChanged() {
        try {
            window.dispatchEvent(new CustomEvent('ent-offline:queue-changed'));
        } catch (error) { /* a page without CustomEvent loses nothing */ }
    }

    function idbAvailable() {
        try { return typeof indexedDB !== 'undefined' && indexedDB !== null; }
        catch (error) { return false; }
    }


    /* ------------------------------------------------------------------
       IndexedDB plumbing. Every path resolves (never rejects) with the
       database or with null - null means "use the localStorage fallback".
       ------------------------------------------------------------------ */
    function openDb() {
        if (!idbAvailable()) return Promise.resolve(null);
        if (dbPromise) return dbPromise;
        dbPromise = new Promise(function (resolve) {
            let request;
            try {
                request = indexedDB.open(DB_NAME, DB_VERSION);
            } catch (error) {
                resolve(null);
                return;
            }
            request.onupgradeneeded = function () {
                const db = request.result;
                if (!db.objectStoreNames.contains(REC_STORE)) {
                    const records = db.createObjectStore(REC_STORE, { keyPath: 'key' });
                    records.createIndex('reportType', 'reportType', { unique: false });
                }
                if (!db.objectStoreNames.contains(QUEUE_STORE)) {
                    const queue = db.createObjectStore(QUEUE_STORE, { keyPath: 'id' });
                    queue.createIndex('recordKey', 'recordKey', { unique: false });
                    queue.createIndex('status', 'status', { unique: false });
                }
            };
            request.onsuccess = function () {
                const db = request.result;
                // Another tab upgrading the schema must not leave this one
                // holding a stale connection open forever.
                db.onversionchange = function () {
                    try { db.close(); } catch (error) { /* ignore */ }
                    dbPromise = null;
                };
                resolve(db);
            };
            request.onerror = function () { resolve(null); };
            request.onblocked = function () { resolve(null); };
        });
        return dbPromise;
    }

    function reqToPromise(request) {
        return new Promise(function (resolve, reject) {
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () {
                reject(request.error || new Error('IndexedDB request failed.'));
            };
        });
    }

    /* ------------------------------------------------------------------
       localStorage fallback - the same operations, one dimension down.
       Used only when IndexedDB cannot be opened.
       ------------------------------------------------------------------ */
    function lsRead(key) {
        try {
            const list = JSON.parse(window.localStorage.getItem(key) || '[]');
            return Array.isArray(list) ? list : [];
        } catch (error) { return []; }
    }

    function lsWrite(key, list) {
        try {
            window.localStorage.setItem(key, JSON.stringify(list));
            return true;
        } catch (error) {
            console.warn('[EntOfflineStore] localStorage fallback is full:', error);
            return false;
        }
    }

    /* ------------------------------------------------------------------
       Low-level record / job operations. Each one tries IndexedDB first
       and falls back to localStorage, so callers never care which engine
       is actually live on this browser.
       ------------------------------------------------------------------ */
    function putRecord(record) {
        return openDb().then(function (db) {
            if (!db) {
                const list = lsRead(FALLBACK_RECORDS)
                    .filter(function (item) { return item && item.key !== record.key; });
                list.unshift(record);
                lsWrite(FALLBACK_RECORDS, list.slice(0, QUEUE_LIMIT));
                return record;
            }
            return new Promise(function (resolve, reject) {
                let tx;
                try { tx = db.transaction(REC_STORE, 'readwrite'); }
                catch (error) { reject(error); return; }
                tx.objectStore(REC_STORE).put(record);
                tx.oncomplete = function () { resolve(record); };
                tx.onerror = function () { reject(tx.error || new Error('record write failed')); };
                tx.onabort = function () { reject(tx.error || new Error('record write aborted')); };
            });
        });
    }

    function getRecord(key) {
        return openDb().then(function (db) {
            if (!db) {
                const found = lsRead(FALLBACK_RECORDS)
                    .filter(function (item) { return item && item.key === key; })[0];
                return found || null;
            }
            return reqToPromise(
                db.transaction(REC_STORE, 'readonly').objectStore(REC_STORE).get(key)
            ).catch(function () { return null; });
        }).catch(function () { return null; });
    }

    function allRecords() {
        return openDb().then(function (db) {
            if (!db) return lsRead(FALLBACK_RECORDS).filter(Boolean);
            return reqToPromise(
                db.transaction(REC_STORE, 'readonly').objectStore(REC_STORE).getAll()
            ).then(function (list) { return Array.isArray(list) ? list.filter(Boolean) : []; })
             .catch(function () { return []; });
        }).catch(function () { return []; });
    }

    function removeRecord(key) {
        return openDb().then(function (db) {
            if (!db) {
                lsWrite(FALLBACK_RECORDS, lsRead(FALLBACK_RECORDS)
                    .filter(function (item) { return item && item.key !== key; }));
                return true;
            }
            return new Promise(function (resolve, reject) {
                let tx;
                try { tx = db.transaction(REC_STORE, 'readwrite'); }
                catch (error) { reject(error); return; }
                tx.objectStore(REC_STORE).delete(key);
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { reject(tx.error || new Error('record delete failed')); };
            });
        }).catch(function () { return false; });
    }

    function putJob(job) {
        return openDb().then(function (db) {
            if (!db) {
                const list = lsRead(FALLBACK_QUEUE)
                    .filter(function (item) { return item && item.id !== job.id; });
                list.unshift(job);
                lsWrite(FALLBACK_QUEUE, list.slice(0, QUEUE_LIMIT));
                return job;
            }
            return new Promise(function (resolve, reject) {
                let tx;
                try { tx = db.transaction(QUEUE_STORE, 'readwrite'); }
                catch (error) { reject(error); return; }
                tx.objectStore(QUEUE_STORE).put(job);
                tx.oncomplete = function () { resolve(job); };
                tx.onerror = function () { reject(tx.error || new Error('queue write failed')); };
            });
        });
    }

    function allJobs() {
        return openDb().then(function (db) {
            if (!db) return lsRead(FALLBACK_QUEUE).filter(Boolean);
            return reqToPromise(
                db.transaction(QUEUE_STORE, 'readonly').objectStore(QUEUE_STORE).getAll()
            ).then(function (list) { return Array.isArray(list) ? list.filter(Boolean) : []; })
             .catch(function () { return []; });
        }).catch(function () { return []; });
    }

    function removeJob(id) {
        return openDb().then(function (db) {
            if (!db) {
                lsWrite(FALLBACK_QUEUE, lsRead(FALLBACK_QUEUE)
                    .filter(function (item) { return item && item.id !== id; }));
                return true;
            }
            return new Promise(function (resolve, reject) {
                let tx;
                try { tx = db.transaction(QUEUE_STORE, 'readwrite'); }
                catch (error) { reject(error); return; }
                tx.objectStore(QUEUE_STORE).delete(id);
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { reject(tx.error || new Error('queue delete failed')); };
            });
        }).catch(function () { return false; });
    }


    /* ------------------------------------------------------------------
       One-time migration: drafts saved under the OLD localStorage regime
       become offline records too, so the local database is complete from
       the first run. They are NOT enqueued (see the header note).
       ------------------------------------------------------------------ */
    function migrateLegacyDrafts() {
        if (migrated) return Promise.resolve(true);
        migrated = true;
        let flag = null;
        try { flag = window.localStorage.getItem(MIGRATED_FLAG); } catch (error) { /* ignore */ }
        if (flag) return Promise.resolve(true);

        let legacy = [];
        try {
            const parsed = JSON.parse(window.localStorage.getItem(LEGACY_DRAFTS_KEY) || '[]');
            legacy = Array.isArray(parsed) ? parsed.filter(Boolean) : [];
        } catch (error) { legacy = []; }

        const stampFlag = function () {
            try { window.localStorage.setItem(MIGRATED_FLAG, '1'); } catch (error) { /* ignore */ }
        };
        if (!legacy.length) {
            stampFlag();
            return Promise.resolve(true);
        }

        const jobs = legacy.map(function (draft) {
            const key = String((draft && draft.key) || '');
            if (!key) return Promise.resolve(false);
            return getRecord(key).then(function (existing) {
                if (existing) return false;             // already migrated
                return putRecord(Object.assign({}, draft, {
                    reportType: reportTypeOf(draft.reportType),
                    offlineSavedAt: draft.savedAt || draft.createdAt || nowIso(),
                    synced: false,
                    migrated: true,
                    lastSyncError: ''
                }));
            });
        });
        return Promise.all(jobs).then(function () {
            stampFlag();
            console.log('[EntOfflineStore] migrated ' + legacy.length +
                ' legacy draft(s) into the offline database.');
            return true;
        }).catch(function (error) {
            // The flag is only stamped on success, so a half-finished
            // migration is retried on the next page load - once, not on
            // every click.
            migrated = false;
            console.warn('[EntOfflineStore] legacy migration failed:', error);
            return false;
        });
    }

    /* ------------------------------------------------------------------
       PUBLIC API
       ------------------------------------------------------------------ */

    // Called once per page load; kicks the migration off in the background.
    function init() {
        return migrateLegacyDrafts().catch(function () { return false; });
    }


    /* Save a report to the OFFLINE DATABASE and queue it for the cloud.
       `draft` is the object draftsBrowser.saveDraft() just built (same key,
       same fields), so the shelf and the offline database never disagree
       about who a patient is. `cloudPush` is optional: when the caller
       already fired the immediate online push (autoShareDraft), its
       promise is handed over so a successful push clears the queue job
       instead of being uploaded twice. */
    function recordSaved(draft, cloudPush) {
        if (!draft || !draft.key) return Promise.resolve(null);
        const record = Object.assign({}, draft, {
            reportType: reportTypeOf(draft.reportType),
            offlineSavedAt: nowIso(),
            synced: false,
            lastSyncError: ''
        });
        return putRecord(record).then(function () {
            return enqueue(record.key);
        }).then(function () {
            if (cloudPush && typeof cloudPush.then === 'function') {
                cloudPush.then(function (ok) {
                    if (ok) markSynced(record.key).catch(function () { /* queue keeps it */ });
                }).catch(function () { /* offline: the queue keeps the job */ });
            }
            return record;
        }).catch(function (error) {
            console.warn('[EntOfflineStore] could not save offline:', error);
            return null;
        });
    }

    // One job per record key: a re-save refreshes the SAME job (attempts
    // reset) rather than stacking a second one for the same patient.
    function enqueue(recordKey) {
        const key = String(recordKey || '');
        if (!key) return Promise.resolve(null);
        return allJobs().then(function (jobs) {
            const existing = jobs.filter(function (item) {
                return item && item.recordKey === key;
            })[0];
            if (existing) {
                existing.status = 'pending';
                existing.attempts = 0;
                existing.nextRetryAt = 0;
                existing.lastError = '';
                existing.updatedAt = nowIso();
                return putJob(existing).then(function (saved) {
                    queueChanged();
                    return saved;
                });
            }
            if (jobs.length >= QUEUE_LIMIT) {
                console.warn('[EntOfflineStore] sync queue is full (' + QUEUE_LIMIT +
                    '); the newest save is kept locally but not queued.');
                return null;
            }
            const job = {
                id: 'q|' + key,
                recordKey: key,
                status: 'pending',
                attempts: 0,
                nextRetryAt: 0,
                lastError: '',
                createdAt: nowIso(),
                updatedAt: nowIso()
            };
            return putJob(job).then(function (saved) {
                queueChanged();
                return saved;
            });
        }).catch(function (error) {
            console.warn('[EntOfflineStore] could not queue for sync:', error);
            return null;
        });
    }

    // Jobs the sync engine may attempt RIGHT NOW: pending, and past their
    // backoff window, oldest first so a patient saved first syncs first.
    function dueJobs(now) {
        const at = typeof now === 'number' ? now : Date.now();
        return allJobs().then(function (jobs) {
            return jobs
                .filter(function (job) {
                    return job && job.status === 'pending' && Number(job.nextRetryAt || 0) <= at;
                })
                .sort(function (a, b) {
                    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
                });
        });
    }


    // A job that reached the cloud is removed, not marked: an empty queue
    // is the honest state of a device with nothing left to send.
    function markJobDone(id) {
        return removeJob(id).then(function () { queueChanged(); return true; });
    }

    function markJobFailed(id, message, delayMs) {
        return allJobs().then(function (jobs) {
            const job = jobs.filter(function (item) { return item && item.id === id; })[0];
            if (!job) return null;
            job.attempts = Number(job.attempts || 0) + 1;
            job.lastError = String(message || 'sync failed');
            job.nextRetryAt = Date.now() + (Number(delayMs) > 0 ? Number(delayMs) : 15000);
            job.updatedAt = nowIso();
            return putJob(job);
        }).catch(function () { return null; });
    }

    // The record made it to Supabase. The flag lives on the record (for
    // the UI and for diagnostics); the job is removed by markJobDone.
    function markSynced(key) {
        return getRecord(key).then(function (record) {
            if (!record) return null;
            record.synced = true;
            record.syncedAt = nowIso();
            record.lastSyncError = '';
            return putRecord(record);
        }).catch(function () { return null; });
    }

    function listRecords(reportType) {
        const wanted = reportType ? reportTypeOf(reportType) : '';
        return allRecords().then(function (records) {
            return records
                .filter(function (record) {
                    if (!wanted) return true;
                    return reportTypeOf(record.reportType) === wanted;
                })
                .sort(function (a, b) {
                    return String(b.offlineSavedAt || b.savedAt || '')
                        .localeCompare(String(a.offlineSavedAt || a.savedAt || ''));
                });
        });
    }

    // Deleting a draft on the shelf deletes its offline copy AND its
    // pending job - otherwise the flush engine would re-upload a record
    // the doctor has just thrown away.
    function deleteRecord(key) {
        const k = String(key || '');
        if (!k) return Promise.resolve(false);
        return allJobs().then(function (jobs) {
            const job = jobs.filter(function (item) { return item && item.recordKey === k; })[0];
            return job ? removeJob(job.id) : null;
        }).then(function () {
            return removeRecord(k);
        }).then(function () { queueChanged(); return true; })
          .catch(function () { return false; });
    }

    // "Delete All Drafts" on the shelf clears the offline database too.
    function clearAll() {
        return Promise.all([
            removeAllOf(REC_STORE, FALLBACK_RECORDS),
            removeAllOf(QUEUE_STORE, FALLBACK_QUEUE)
        ]).then(function () { queueChanged(); return true; })
          .catch(function () { return false; });
    }

    function removeAllOf(storeName, fallbackKey) {
        return openDb().then(function (db) {
            if (!db) {
                try { window.localStorage.removeItem(fallbackKey); } catch (error) { /* ignore */ }
                return true;
            }
            return new Promise(function (resolve, reject) {
                let tx;
                try { tx = db.transaction(storeName, 'readwrite'); }
                catch (error) { reject(error); return; }
                tx.objectStore(storeName).clear();
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { reject(tx.error || new Error('clear failed')); };
            });
        }).catch(function () { return false; });
    }

    function jobCount() {
        return allJobs().then(function (jobs) {
            return jobs.filter(function (job) {
                return job && job.status === 'pending';
            }).length;
        }).catch(function () { return 0; });
    }

    // One snapshot for diagnostics: how many records live on this device,
    // how many still owe the cloud an upload, and which engine is in
    // charge of the storage on this browser.
    function stats() {
        return Promise.all([allRecords(), allJobs()]).then(function (parts) {
            const records = parts[0] || [];
            const jobs = parts[1] || [];
            const pending = jobs.filter(function (job) { return job && job.status === 'pending'; });
            return {
                engine: idbAvailable() ? 'indexeddb' : 'localstorage-fallback',
                records: records.length,
                pending: pending.length,
                unsynced: records.filter(function (record) { return record && !record.synced; }).length
            };
        }).catch(function () {
            return { engine: 'unavailable', records: 0, pending: 0, unsynced: 0 };
        });
    }

    function isSupported() { return idbAvailable(); }

    window.EntOfflineStore = {
        init,
        isSupported,
        recordSaved,
        enqueue,
        dueJobs,
        markJobDone,
        markJobFailed,
        markSynced,
        listRecords,
        getRecord,
        deleteRecord,
        clearAll,
        jobCount,
        stats,
        // Exposed for diagnostics and tests.
        DB_NAME,
        REPORT_TYPES
    };

    // Kick the migration off as soon as the module loads on a form page,
    // but never before the DOM is interactive: the form itself comes first.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { init(); }, { once: true });
    } else {
        init();
    }

})(window);
