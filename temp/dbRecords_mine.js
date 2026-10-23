/* =====================================================================
   DATABASE RECORDS - Supabase final save & in-form record browser
   Shared by cf4Form.html, nasalEndoscopy.html and laryngealEndoscopy.html.
   Depends on: supabaseClient.js (window.EntSupabase),
                syncEngine.js (window.EntSync),
                patientRecords.js (window.PatientRecords)
   The active form page exposes window.EntFormBridge with:
       { reportType, getData(), restore(data), alert(message, title) }
   ===================================================================== */
(function (window) {
    'use strict';

    const SAVED_KEYS_STORAGE = 'entDbSavedRecordKeysV1';
    // The list is NOT capped at a page: it pages until the server returns a
    // short page. These only bound the paging loop (a runaway guard, never a
    // UI limit) and size one request. 500/request keeps every round trip small
    // while MAX_LIST_RECORDS means "the list shows every row up to 50k".
    const MAX_LIST_RECORDS = 50000;
    const LIST_PAGE_SIZE = 500;

    const TYPE_LABELS = {
        cf4: 'CF4 Form',
        nasal: 'Nasal Endoscopy',
        laryngeal: 'Laryngeal Endoscopy'
    };

    let modal = null;
    let confirmBox = null;
    let confirmResolver = null;
    let listElement = null;
    let statusElement = null;
    let searchElement = null;
    let currentRecords = [];
    let hiddenDrafts = 0;
    // The dialog has two views: the records list (default) and the recycle
    // bin (admin + secretary only - RLS hides deleted rows from every other
    // read, so the bin's SECURITY DEFINER function is the only door).
    let trashMode = false;
    let trashRows = [];
    let trashButton = null;
    let saving = false;
    // Per-patient totals behind the "N records · N visits" chip, keyed by
    // patientStatsKey(). null = not counted yet (query failed or not run),
    // which simply means no chip - a wrong count would be worse than none.
    let patientStats = null;
    // RMCI / CUMC hospital tabs + save prompt - FEATURE FLAGGED (see the
    // resolveHospitalFeature() section below). siteFilter is the browse
    // modal's active tab ('' = All); siteFeatureState is '' until the flag
    // has been resolved, and '' is deliberately treated as OFF everywhere
    // so an unresolved flag can only ever mean "today's behaviour".
    let siteFilter = '';
    let siteFeatureState = '';
    let siteTabsElement = null;
    // Which order the list is arranged in: 'date' (default - the freshest
    // saved patient is always on top) or 'name' (A-Z). NOT feature-flagged:
    // sorting is basic list hygiene for every clinic.
    let sortMode = 'date';
    let sortBarElement = null;

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    function getBridge() {
        const bridge = window.EntFormBridge;
        if (!bridge || typeof bridge.getData !== 'function' || typeof bridge.restore !== 'function') {
            return null;
        }
        return bridge;
    }

    function showAlert(message, title) {
        const bridge = getBridge();
        if (bridge && typeof bridge.alert === 'function') {
            bridge.alert(message, title);
        } else {
            window.alert(message);
        }
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        })[char]);
    }

    function formatDate(value) {
        if (!value) return 'Date not set';
        const parsed = new Date(`${value}T00:00:00`);
        if (Number.isNaN(parsed.getTime())) return value;
        return new Intl.DateTimeFormat(undefined, {
            year: 'numeric', month: 'short', day: '2-digit'
        }).format(parsed);
    }

    function formatTimestamp(value) {
        if (!value) return 'Not yet';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return 'Unknown';
        return new Intl.DateTimeFormat(undefined, {
            year: 'numeric', month: 'short', day: '2-digit',
            hour: '2-digit', minute: '2-digit'
        }).format(date);
    }

    // A row counts as a real database record when it is not a draft.
// v2 replaced v1's `draftShared` jsonb flag with a real `is_draft` BOOLEAN
// column, so this is now a plain boolean read instead of a shape-guess
// across three possible representations. `metadata` is now `payload`.
    function isDatabaseRecord(row) {
        if (!row) return false;
        // PostgREST names a JSON-extracted field after its LAST key, so the
        // live API answers { dbSaved: "true" } for select=payload->>dbSaved -
        // the same convention syncEngine.js (row.dbSaved) and dashboard.js
        // already rely on. The literal expression key is kept as a fallback
        // for in-memory rows and older fixtures.
        const dbSaved = (row.dbSaved !== undefined) ? row.dbSaved : row['payload->>dbSaved'];
        if (String(dbSaved || '') === 'true') return true;
        if (row.is_draft === true || row.is_draft === 'true') return false;
        return true;
    }

    // --- final-saved status -------------------------------------------------
    // The "final saved" check mark is universal: a row where the database
    // already holds a finished save. The edit button is Jardin-only - it is
    // the only place where Dr. Jardin's screen diverges from the other
    // clinics, and exactly where the RMCI/CUMC tabs and the Set/Move flow
    // already make clinic-specific UI for Dr. Jesus Jardin's team.
    function isFinalSaved(row) {
        if (!row) return false;
        // The flag tier carries it plainly (payload->>dbSaved was selected).
        if (row.dbSaved !== undefined) return String(row.dbSaved || '') === 'true';
        // Older or fixture rows may keep it inside the payload object.
        const p = row.payload;
        if (p && typeof p === 'object') return String(p.dbSaved || '') === 'true';
        return false;
    }
    // The hospital tag rides on the payload, same convention as dbSaved.
    function recordSite(row) {
        if (!row) return '';
        if (row.site !== undefined) return String(row.site);
        const p = row.payload;
        if (p && typeof p === 'object') return String(p.site || '');
        return String(row['payload->>site'] || '');
    }

    // ------------------------------------------------------------------
    // Who saved it?
    // created_by is a server-stamped UUID (0004/0018). The display name
    // rides beside it in created_by_name (0028), stamped from the same
    // live profile row at the same instant - the browser cannot resolve
    // a uuid itself, because profiles_select_self (0008) hands it only
    // its own row and readUserCache() is a retired no-op. The old code
    // rendered the uuid and called it a name ("Saved by 94978594-...",
    // avatar letter "9"); every branch below refuses to do that.
    // ------------------------------------------------------------------
    const SMALL_WORDS = { de: 1, del: 1, dela: 1, la: 1, van: 1, von: 1, of: 1, the: 1, y: 1 };

    function prettyName(name) {
        return String(name || '').trim().split(/\s+/).filter(Boolean).map(function (word, i) {
            const low = word.toLowerCase();
            if (i > 0 && SMALL_WORDS[low]) return low;
            return low.charAt(0).toUpperCase() + low.slice(1);
        }).join(' ');
    }

    function currentUsername() {
        if (!window.EntAuth || typeof window.EntAuth.currentUser !== 'function') return '';
        const user = window.EntAuth.currentUser() || {};
        return String(user.username || '').trim();
    }

    // Role/id of the signed-in member. Used only to decide which buttons to
    // DRAW - the database is still the thing that decides what is allowed
    // (0030's policy over ent_may_soft_delete, with 0034's secretary arm and
    // 0039's cross-clinic secretary arm, answers that question, not this one).
    function currentUserRole() {
        if (!window.EntAuth || typeof window.EntAuth.currentUser !== 'function') return '';
        const user = window.EntAuth.currentUser() || {};
        return String(user.role || '').trim().toLowerCase();
    }

    function currentUserId() {
        if (!window.EntAuth || typeof window.EntAuth.currentUser !== 'function') return '';
        const user = window.EntAuth.currentUser() || {};
        return String(user.id || '').trim();
    }

    // Who may OPEN the bin. 0039 widened ent_deleted_reports() to three
    // readers - an active admin over his own clinic, a secretary over every
    // doctor she is assigned to, and a doctor over his OWN shelf - so the
    // toggle is drawn for all three. This still only decides what is DRAWN:
    // the function is the thing that decides what is RETURNED, and it
    // re-reads staff_profiles on every call, so a stale role cached in the
    // session cannot widen anything. A doctor now sees the rows he removed
    // himself instead of being told to ask an administrator for his own
    // mistake; he still sees nothing from another shelf or another clinic.
    function mayReadRecycleBin() {
        const role = currentUserRole();
        return role === 'admin' || role === 'secretary' || role === 'doctor';
    }

    function userDisplayName(username) {
        const name = String(username || '').trim();
        if (!name) return 'Someone';
        const users = (window.EntAuth && typeof window.EntAuth.readUserCache === 'function'
            ? window.EntAuth.readUserCache() : []) || [];
        const hit = users.filter(function (u) {
            return u && String(u.username || '').trim().toLowerCase() === name.toLowerCase();
        })[0];
        return prettyName((hit && (hit.full_name || hit.username)) || name);
    }

    function currentUserId() {
        if (!window.EntAuth || typeof window.EntAuth.currentUser !== 'function') return '';
        const user = window.EntAuth.currentUser() || {};
        return String(user.id || '').trim();
    }

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // "You" for the signed-in user (by ID on v2 rows, by username on v1
    // rows that predate the uuid stamp), the person's real name for
    // everybody else, and NEVER a bare uuid.
    function savedByLabel(record) {
        const raw = String((record && record.created_by) || '').trim();
        const stamped = String((record && record.created_by_name) || '').trim();
        if (!raw && !stamped) return 'Unknown';
        const meId = currentUserId();
        const meName = currentUsername();
        if (raw && meId && raw.toLowerCase() === meId.toLowerCase()) return 'You';
        if (raw && meName && raw.toLowerCase() === meName.toLowerCase()) return 'You';
        if (stamped) return prettyName(stamped);
        // A v1 row's created_by IS a username - pretty it. A v2 uuid with
        // no name on file (row predates 0028 and missed the backfill) has
        // nothing human to show, so say Unknown rather than print the id.
        if (raw && !UUID_RE.test(raw)) return userDisplayName(raw);
        return 'Unknown';
    }

    // ------------------------------------------------------------------
    // Doctor scoping - decides which rows this user may read or write.
    //   doctor    -> only his/her own rows
    //   secretary -> rows of the doctor she is assigned to
    //   admin     -> every row of the clinic
    // With no signed-in user (file:// preview, older cached page) it falls
    // back to the pre-auth behaviour: clinic-wide, unassigned owner.
    // ------------------------------------------------------------------
    function actor() {
        const auth = window.EntAuth;
        if (!auth || typeof auth.scope !== 'function') {
            return { doctorId: '', seeAll: true, username: 'unassigned' };
        }
        const scoped = auth.scope() || {};
        const user = typeof auth.currentUser === 'function' ? (auth.currentUser() || {}) : {};
        return {
            doctorId: scoped.doctorId || '',
            seeAll: !!scoped.seeAll,
            username: user.username || 'unknown',
            role: user.role || ''
        };
    }

    /* ------------------------------------------------------------------
   v2 coercion helpers, shared with syncEngine's contract.

   report_type is the ent_report_type ENUM ('cf4','nasal','laryngeal') in
   v2; v1 had free text and wrote 'unknown', which Postgres now rejects.
   procedure_date is a real DATE; v1's '' for "not recorded" is a cast
   error now, so an unusable value becomes NULL.
   ------------------------------------------------------------------ */
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

    function toIsoDate(value) {
        const raw = String(value == null ? '' : value).trim();
        if (!raw) return null;
        const d = new Date(raw);
        if (isNaN(d.getTime())) return null;
        return d.toISOString().slice(0, 10);
    }

// v2: the doctor filter is GONE from the read path on purpose.
//
// In v1 the browser narrowed every query itself with `doctor_id=eq.<me>`.
// That was the ONLY thing standing between a secretary and another
// doctor's patients, and it lived in code anyone could edit in DevTools.
//
// In v2 ent_may_touch_report() decides that, inside every RLS policy, and
// it re-reads staff_profiles on each request. So the honest query is an
// unfiltered one, and the database returns exactly the rows this person
// may see. Filtering again in JS would be redundant at best and would
// quietly re-introduce a client-side trust boundary at worst.
function doctorFilter() {
    return '';
}

    function logActivity(action, detail) {
        if (window.EntAuth && typeof window.EntAuth.logActivity === 'function') {
            window.EntAuth.logActivity(action, detail).catch(() => {});
        }
    }

    // Records finalized to the database are flagged locally so the background
    // sync never overwrites the cloud copy's embedded form payload.
    function readSavedKeys() {
        try {
            const parsed = JSON.parse(localStorage.getItem(SAVED_KEYS_STORAGE) || '[]');
            return new Set(Array.isArray(parsed) ? parsed : []);
        } catch (error) {
            console.warn('Unable to read database save flags.', error);
            return new Set();
        }
    }

    function markKeySaved(key) {
        try {
            const keys = readSavedKeys();
            keys.add(key);
            localStorage.setItem(SAVED_KEYS_STORAGE, JSON.stringify(Array.from(keys).slice(-2000)));
        } catch (error) {
            console.warn('Unable to remember database save flag.', error);
        }
    }

    // The hospital tag is also stamped onto THIS device's local record
    // history. The background sync uploads a history entry as a whole
    // payload (syncEngine sends payload = localRec), so without this stamp
    // a later sync of an unmarked key would quietly drop payload.site.
    // Best-effort only: a storage hiccup must never fail a save that
    // already succeeded, and the flag OFF path never calls this.
    function stampLocalHistorySite(key, site) {
        if (!key || !site) return;
        try {
            const raw = localStorage.getItem('entPatientRecordHistoryV1');
            if (!raw) return;
            const list = JSON.parse(raw);
            if (!Array.isArray(list)) return;
            let touched = false;
            list.forEach(function (entry) {
                if (entry && entry.key === key) {
                    entry.site = site;
                    touched = true;
                }
            });
            if (touched) localStorage.setItem('entPatientRecordHistoryV1', JSON.stringify(list));
        } catch (error) {
            console.warn('Could not stamp the local record history with the hospital.', error);
        }
    }

    // ------------------------------------------------------------------
    // Save current form to Supabase (final save)
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // Possible existing patient (same last name / full name)
    // ------------------------------------------------------------------
    // A patient may come back several times, so the same name is not an error.
    // Before saving we show what already exists and let the user decide:
    // update an existing record, or keep this one as a new visit.
    const MAX_DUP_MATCHES = 8;

    async function findSimilarPatients(formData) {
        const last = String(formData.patientLastName || '').trim();
        const first = String(formData.patientFirstName || '').trim();
        const needle = (last || first).toLowerCase();
        if (!needle) return [];

        const found = new Map();

        // 1) records saved on this device
        const local = (window.PatientRecords && typeof window.PatientRecords.getAll === 'function')
            ? window.PatientRecords.getAll() : [];
        (Array.isArray(local) ? local : []).forEach(function (rec) {
            const name = String((rec && rec.patientName) || '');
            if (name.toLowerCase().indexOf(needle) === -1) return;
            const key = (rec && rec.key) || [rec.reportType, name, rec.procedureDate].join('|');
            found.set(key, {
                key: key, name: name,
                date: String(rec.procedureDate || '').slice(0, 10),
                type: (rec && rec.reportType) || '',
                who: (rec && (rec.createdBy || rec.updatedBy)) || 'this device',
                cloud: false
            });
        });

        // 2) the shared database
        if (window.EntSupabase && window.EntSupabase.isConfigured()) {
            try {
                // v2: no clinic filter and no doctor filter. RLS decides
                // which rows this caller may see; the query is unfiltered
                // on purpose so the DATABASE is the thing saying no.
                const rows = await window.EntSupabase.apiRequest(
                    'reports'
                    + '?patient_name=ilike.*' + encodeURIComponent(needle) + '*'
                    + '&select=record_key,patient_name,procedure_date,report_type,created_by,updated_at'
                    + '&order=updated_at.desc&limit=' + (MAX_DUP_MATCHES * 3)
                );
                (Array.isArray(rows) ? rows : []).forEach(function (row) {
                    const name = String((row && row.patient_name) || '');
                    if (name.toLowerCase().indexOf(needle) === -1) return;
                    found.set(row.record_key, {
                        key: row.record_key, name: name,
                        date: String(row.procedure_date || '').slice(0, 10),
                        type: row.report_type || '',
                        who: row.created_by || 'cloud',
                        cloud: true
                    });
                });
            } catch (error) {
                // Never block the save because the check could not run.
                console.warn('Could not check for an existing patient:', error);
            }
        }

        return Array.from(found.values())
            .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); })
            .slice(0, MAX_DUP_MATCHES);
    }

    // ------------------------------------------------------------------
    // 0041 · THE PATIENT-ID PATH — the one identifier two different
    // people cannot share. A NAME is not unique ("Juan Dela Cruz" can be
    // two patients), so a name match only ever produces the prompt
    // above - a human decides. A hospital ID match is different: same
    // number + same report type + same date on this shelf IS the same
    // visit, and the database now refuses a second row for it anyway
    // (0041's uniq_reports_patient_day). This lookup runs BEFORE the
    // write so the save can adopt the existing row's record_key and
    // MERGE into it, instead of tripping the constraint and surfacing
    // as an error.
    //
    // Scoping: RLS decides which rows are visible (no clinic or doctor
    // filter is sent - same convention as findSimilarPatients), drafts
    // are excluded (a draft must never swallow a final save), deleted
    // rows are already invisible through RLS, and only the exact report
    // date matches (a different date is a normal repeat visit and must
    // stay a separate row).
    // ------------------------------------------------------------------
    // The same first-value chain patientRecords.extractMetadata reads
    // (patientPin / mrn / patientId / caseNumber). Duplicated on
    // purpose: the two modules share no import point - see the note on
    // SITE_BY_HEADER above.
    const PATIENT_ID_KEYS = ['patientPin', 'mrn', 'patientId', 'caseNumber'];

    function patientIdentityOf(formData) {
        for (let i = 0; i < PATIENT_ID_KEYS.length; i++) {
            const raw = String((formData && formData[PATIENT_ID_KEYS[i]]) || '').trim();
            if (raw) return raw;
        }
        return '';
    }

    async function findSameIdentityRecord(reportType, formData, dateStr) {
        const idKey = patientIdentityOf(formData).toLowerCase();
        if (!idKey || !dateStr) return null;
        const rows = await window.EntSupabase.apiRequest(
            'reports?report_type=eq.' + encodeURIComponent(reportType)
            + '&is_draft=eq.false'
            + '&procedure_date=eq.' + encodeURIComponent(String(dateStr).slice(0, 10))
            + '&select=id,record_key,patient_id,patient_name,procedure_date'
            + '&limit=200'
        );
        const hit = (Array.isArray(rows) ? rows : []).filter(function (r) {
            return String((r && r.patient_id) || '').trim().toLowerCase() === idKey;
        })[0];
        return (hit && hit.record_key) ? hit.record_key : null;
    }

    function dupDateLabel(value) {
        const raw = String(value || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return 'No date on file';
        const parts = raw.split('-');
        const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
            'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(parts[1]) - 1] || '';
        return parts[2] + ' ' + month + ' ' + parts[0];
    }

    // The report date lives under a different id on each form, so accept any
    // of the keys patientRecords.js already knows.
    const DATE_KEYS = ['procedureDate', 'dateAdmitted', 'dateOfProcedure',
        'operationDate', 'reportDate', 'dateDischarged', 'date'];

    // Last name, first name and the date are required for a final save: the
    // name identifies the patient, the date keeps every visit countable.
    function missingForFinalSave(formData, reportType) {
        const lastName = String(formData.patientLastName || '').trim();
        const firstName = String(formData.patientFirstName || '').trim();
        const combined = String(formData.patientName || '').trim();
        const hasCombined = combined.indexOf(',') > 0;      // "Last, First"
        const dateKey = DATE_KEYS.filter(function (k) {
            return String(formData[k] || '').trim();
        })[0] || '';
        const rawDate = dateKey ? String(formData[dateKey] || '').trim() : '';
        const dateOk = /^\d{4}-\d{2}-\d{2}/.test(rawDate) && !isNaN(new Date(rawDate).getTime());

        const missing = [];
        if (!(lastName && firstName) && !hasCombined) {
            if (!lastName && !hasCombined) missing.push({ id: 'patientLastName', label: 'Last Name' });
            if (!firstName && !hasCombined) missing.push({ id: 'patientFirstName', label: 'First Name' });
        }
        if (!dateOk) {
            missing.push({ id: reportType === 'cf4' ? 'dateAdmitted' : 'procedureDate', label: 'Date' });
        }
        return { missing: missing, dateKey: dateOk ? dateKey : '', reportDate: dateOk ? rawDate.slice(0, 10) : '' };
    }

    // Point at the field that needs attention instead of only complaining.
    function flashField(id) {
        const el = document.getElementById(id);
        if (!el) return null;
        el.classList.add('ent-field-missing');
        setTimeout(function () { el.classList.remove('ent-field-missing'); }, 2800);
        return el;
    }
    function highlightField(id) {
        const el = flashField(id);
        if (!el) return;
        try { el.focus(); } catch (e) { /* ignore */ }
    }

    // Small icons/labels so the dialog speaks the same language as the form.
    const FIELD_META = {
        patientLastName: { icon: '\uD83D\uDC64', label: 'Last Name', hint: 'e.g. Dela Cruz' },
        patientFirstName: { icon: '\uD83D\uDC64', label: 'First Name', hint: 'e.g. Juan' },
        procedureDate: { icon: '\uD83D\uDCC5', label: 'Date', hint: 'the day of this visit' },
        dateAdmitted: { icon: '\uD83D\uDCC5', label: 'Date admitted', hint: 'the day of this visit' }
    };

    // A tidy "please complete the patient details" dialog: tap a row to jump
    // straight to that field, or keep the work as a draft.
    function showMissingFields(missing) {
        return new Promise(function (resolve) {
            const box = document.createElement('div');
            box.className = 'modal-overlay ent-miss-modal no-print';
            const list = missing.length === 1 ? 'field is' : 'fields are';

            const rows = missing.map(function (m, i) {
                const meta = FIELD_META[m.id] || { icon: '\u26A0\uFE0F', label: m.label, hint: '' };
                return '<li><button type="button" class="ent-miss-row' + (i === 0 ? ' is-first' : '') + '"'
                    + ' data-miss-id="' + escapeHtml(m.id) + '">'
                    + '<span class="ent-miss-icon" aria-hidden="true">' + meta.icon + '</span>'
                    + '<span class="ent-miss-text"><b>' + escapeHtml(meta.label) + '</b>'
                    + '<small>' + escapeHtml(meta.hint) + '</small></span>'
                    + '<span class="ent-miss-go">Fill this in \u2192</span>'
                    + '</button></li>';
            }).join('');

            box.innerHTML = `
                <div class="ent-miss-dialog" role="dialog" aria-modal="true" aria-label="Complete the patient details">
                    <div class="ent-miss-banner">
                        <span class="ent-miss-mark" aria-hidden="true">&#9888;&#65039;</span>
                        <div>
                            <h2>Complete the patient details</h2>
                            <p>These ${list} needed before this report can be saved to the database.</p>
                        </div>
                        <button type="button" class="ent-miss-close" aria-label="Close">&times;</button>
                    </div>
                    <ul class="ent-miss-list">${rows}</ul>
                    <p class="ent-miss-note">
                        <b>Why:</b> the name identifies the patient, and the date keeps every visit
                        counted separately - so a returning patient is never lost.
                    </p>
                    <div class="ent-miss-foot">
                        <button type="button" class="ent-miss-draft">&#128190; Save Draft instead</button>
                        <button type="button" class="ent-miss-ok">OK, I&rsquo;ll fill it in</button>
                    </div>
                </div>`;
            document.body.appendChild(box);

            function finish() {
                if (box.parentNode) box.parentNode.removeChild(box);
                document.removeEventListener('keydown', onKey);
                resolve();
            }
            function onKey(event) { if (event.key === 'Escape') finish(); }

            box.addEventListener('click', function (event) {
                const row = event.target.closest('[data-miss-id]');
                if (row) { finish(); highlightField(row.getAttribute('data-miss-id')); return; }
                if (event.target.closest('.ent-miss-draft')) {
                    finish();
                    const draftBtn = document.getElementById('saveDataBtn');
                    if (draftBtn) { flashField('saveDataBtn'); try { draftBtn.focus(); } catch (e) { /* ignore */ } }
                    return;
                }
                if (event.target === box || event.target.closest('.ent-miss-ok')
                    || event.target.closest('.ent-miss-close')) finish();
            });
            document.addEventListener('keydown', onKey);
        });
    }

    // ------------------------------------------------------------------
    // RMCI / CUMC hospital tagging - FEATURE FLAGGED
    // ------------------------------------------------------------------
    // A report has no hospital column; the short code lives inside
    // payload.site, exactly where draftsBrowser stores draft.site, so the
    // two browsers share one vocabulary and no migration is needed.
    const SITE_RMCI = 'RMCI';
    const SITE_CUMC = 'CUMC';
    // Settings -> short code. Deliberately a copy of draftsBrowser's
    // SITE_BY_HEADER (same reasoning as SAVED_KEYS_STORAGE below): the two
    // modules load on different pages and share no import point. A custom
    // hospitalHeader value lands on '' and is shown honestly rather than
    // being filed under the wrong hospital.
    const SITE_BY_HEADER = { rever: SITE_RMCI, capitol: SITE_CUMC };

    /* The whole feature - the browse tabs AND the save prompt - is for
     * Dr. Jesus Jardin's clinic/team only. The clinic's NAME is the source
     * of truth: RLS clinics_read_member lets any member read their own
     * clinics row, so one small cached read covers doctors, secretaries
     * and the clinic admin alike. The identity fallback exists for accounts
     * without a clinic_id (and after a failed clinic read) and requires
     * BOTH "jesus" AND "jardin" on purpose: Dr. Monique Jardin-Quing runs
     * a separate clinic and must never trip this flag. */
    function isJesusJardin(name) {
        const text = String(name || '').toLowerCase();
        return text.indexOf('jesus') !== -1 && text.indexOf('jardin') !== -1;
    }

    // Cached for the page's lifetime: '' = not resolved yet (treated as
    // OFF), 'on', 'off'. A failed clinic read answers OFF for now but
    // leaves '' behind, so the next open retries instead of remembering
    // a network hiccup as policy. Never rejects: the save path must not
    // be breakable by this read.
    async function resolveHospitalFeature() {
        if (siteFeatureState) return siteFeatureState === 'on';
        let user = null;
        try {
            const auth = window.EntAuth;
            user = (auth && typeof auth.currentUser === 'function') ? auth.currentUser() : null;
        } catch (error) {
            user = null;
        }
        user = user || {};
        if (!user.id && !user.username) {
            siteFeatureState = 'off';
            return false;
        }

        if (user.clinic_id && window.EntSupabase && typeof window.EntSupabase.apiRequest === 'function') {
            try {
                const rows = await window.EntSupabase.apiRequest(
                    'clinics?select=name&id=eq.' + encodeURIComponent(user.clinic_id));
                const clinicName = (Array.isArray(rows) && rows[0] && String(rows[0].name)) || '';
                if (clinicName) {
                    siteFeatureState = /jardin/i.test(clinicName) ? 'on' : 'off';
                    return siteFeatureState === 'on';
                }
            } catch (error) {
                return false;               // unresolved (''), retried later
            }
        }

        siteFeatureState = (isJesusJardin(user.full_name)
            || (user.role === 'secretary' && isJesusJardin(user.assigned_doctor_name)))
            ? 'on' : 'off';
        return siteFeatureState === 'on';
    }

    function hospitalFeatureEnabled() {
        return siteFeatureState === 'on';
    }

    // Which hospital this DEVICE is set to print for right now - the same
    // best-effort guess draftsBrowser makes. A pre-selection only: the
    // choice is always confirmed, never silently taken.
    function currentDeviceSite() {
        try {
            const settings = JSON.parse(window.localStorage.getItem('clinicSettings') || '{}');
            return SITE_BY_HEADER[settings.hospitalHeader] || '';
        } catch (error) {
            return '';
        }
    }

    function normaliseSite(value) {
        const raw = String(value == null ? '' : value).trim();
        if (!raw) return '';
        const upper = raw.toUpperCase();
        if (upper === SITE_RMCI || upper === SITE_CUMC) return upper;
        // Tolerate the settings value or a full hospital name, so a row
        // written by an older client still files correctly instead of
        // silently vanishing from every tab.
        if (/rever/i.test(raw)) return SITE_RMCI;
        if (/capitol|cumc/i.test(raw)) return SITE_CUMC;
        return '';
    }

    /* Reading the hospital tag back off a list row. PostgREST names a
     * JSON-extracted field after its LAST key: `select=payload->>site`
     * answers { site: "RMCI" } - the same convention syncEngine.js
     * (row.dbSaved) and dashboard.js already rely on for dbSaved. Reading
     * the literal expression key instead returned undefined on EVERY fresh
     * load, which is what made the badge vanish on refresh while the
     * in-memory write still showed it. The expression key stays accepted
     * (in-memory rows / older fixtures), as does a full payload object. */
    function siteOf(row) {
        if (!row) return '';
        const raw = (row.site !== undefined) ? row.site
            : (row['payload->>site'] !== undefined) ? row['payload->>site']
            : (row['payload->site'] !== undefined) ? row['payload->site']
            : (row.payload && typeof row.payload === 'object') ? row.payload.site
            : '';
        return normaliseSite(raw);
    }

    async function saveToDatabase() {
        if (saving) return;

        const bridge = getBridge();
        if (!bridge) {
            showAlert('The current form is not ready yet. Please try again in a moment.', 'Not Ready');
            return;
        }
        if (!window.EntSupabase || !window.EntSupabase.isConfigured()) {
            showAlert('The cloud database is not configured yet.\n\nOpen Settings \u2192 Cloud Sync to add your Supabase credentials.', 'Database Not Configured');
            return;
        }

        let formData;
        try {
            formData = bridge.getData();
        } catch (error) {
            console.error('Could not read form data:', error);
            showAlert('COULD NOT READ THE FORM\n\n' + error.message, 'ERROR');
            return;
        }
        if (!formData || !Object.keys(formData).length) {
            showAlert('The form is empty - there is nothing to save yet.', 'Empty Form');
            return;
        }

        // ---- Required before a final save -------------------------------
        // Last name, first name and the report date. No bypass: a record in the
        // shared database must always say who the patient is and when.
        const check = missingForFinalSave(formData, bridge.reportType);
        if (check.missing.length) {
            await showMissingFields(check.missing);
            // Afterwards every empty field is flagged, and the first one focused.
            check.missing.forEach(function (m, i) {
                if (i === 0) highlightField(m.id); else flashField(m.id);
            });
            return;
        }

        // The duplicate prompt is about ONE thing: this save overwriting an
        // existing row. That only happens when the other record has the SAME
        // report type AND the same date - record_key is `type|patient|date`,
        // so a cf4 and a nasal of the same patient on the same day are two
        // different rows that never touch each other, and asking about a
        // cross-type record would be a false alarm whose "Open & update"
        // button would even load the wrong form. Same type on a DIFFERENT
        // day is a normal repeat visit: save it straight away and mention it
        // afterwards, so nobody is surprised by the counter.
        let matches = [];
        try {
            matches = await findSimilarPatients(formData);
        } catch (error) {
            matches = [];                       // never block the save
        }
        const today = check.reportDate;
        // ---- 0041: exact patient-ID + type + date already on file? ----
        // When the hospital number, the report type AND the date all match
        // a live final row, this save UPDATES that row: the record_key is
        // adopted further down so the upsert merges, and the name prompt
        // (which would only repeat what the ID already proved) is skipped.
        // A failure here never blocks the save - the unique index is the
        // backstop; this is only the friendly path around it.
        let adoptedKey = '';
        try {
            adoptedKey = (await findSameIdentityRecord(bridge.reportType, formData, today)) || '';
        } catch (error) {
            adoptedKey = '';
        }
        const typeMatches = matches.filter(function (m) {
            return m.type === bridge.reportType;
        });
        const sameDay = typeMatches.filter(function (m) { return today && m.date === today; });
        const repeats = typeMatches.filter(function (m) { return m.date !== today; });

        if (!adoptedKey && sameDay.length) {
            const answer = await askAboutDuplicates(formData, typeMatches, today, bridge.reportType);
            if (answer === 'cancel') return;
            if (answer && answer.open) {
                const target = matches.filter(function (m) { return m.key === answer.open; })[0];
                const open = await showConfirm(
                    'Open "' + ((target && target.name) || 'that record') + '" in the form now?\n\n'
                    + 'Nothing will be saved yet - you can edit it and press "Save to Database" again.',
                    'Open Existing Record'
                );
                if (open) {
                    await openRecordFromCloud({
                        record_key: answer.open,
                        patient_name: (target && target.name) || '',
                        created_by: (target && target.who) || ''
                    }, bridge);
                }
                return;
            }
        }

        // ---- Which hospital? -------------------------------------------
        // Asked LAST, after the duplicate check, so cancelling here loses
        // no work - and before anything is written, so Cancel really means
        // nothing was saved. Feature-flagged: clinics other than Dr.
        // Jardin's resolve OFF and never reach this line, keeping byte-
        // identical saves with no payload.site key.
        let siteChoice = '';
        if (await resolveHospitalFeature()) {
            siteChoice = await askSaveSite();
            if (!siteChoice) return;
        }

        // ---- Follow-up date? -------------------------------------------
        // Asked AFTER the hospital pick and BEFORE anything is written, so a
        // Cancel here (or "No follow-up") still saves nothing - the same
        // guarantee the site prompt gives. NOT feature-gated: every clinic
        // gets the reminder, because it is a plain payload key and costs a
        // clinic without the hospital feature nothing to have. The date rides
        // on payload.followUpDate (no migration), and the dashboard + admin
        // console turn it into a reminder.
        let followUpChoice = '';
        {
            followUpChoice = await askFollowUp({});
        }

        const saveButton = document.getElementById('saveToDbBtn');
        const mainLabel = saveButton ? saveButton.querySelector('.btn-main') : null;
        const originalLabel = mainLabel ? mainLabel.textContent : '';
        saving = true;
        if (saveButton) saveButton.disabled = true;
        if (mainLabel) mainLabel.textContent = 'Saving...';

        try {
            const record = window.PatientRecords
                ? window.PatientRecords.recordSave(bridge.reportType, formData,
                    // 0041: an adopted identity key becomes the carried key,
                    // so recordSave files this save UNDER the existing row
                    // (the same mechanism as reopening a cloud record) and
                    // the upsert below merges instead of inserting a twin.
                    adoptedKey ? { format: 'Database', recordKey: adoptedKey } : { format: 'Database' })
                : null;
            if (!record) {
                throw new Error('Could not build the record entry for this report type.');
            }

            // Let any background sync finish first so the final payload
            // (with the editable form data) is always the last write.
            if (window.EntSync && typeof window.EntSync.whenIdle === 'function') {
                await window.EntSync.whenIdle();
            }

            const config = window.EntSupabase.getConfig();
            const now = new Date().toISOString();
            const owner = actor();
            // ------------------------------------------------------------------
            // PHOTO + RECORD ORDER  -  this is the part that used to be wrong.
            //
            // A report's photos have two possible homes:
            //   * INSIDE payload.formData as base64 - the default, and what
            //     happens while the server's `photo_storage` flag is off; or
            //   * in Storage, described by a report_photos row - only when the
            //     server says the capability is on.
            //
            // The row is written FIRST and the photos are uploaded SECOND.
            // That order is not a preference. report_photos.report_id is
            // NOT NULL REFERENCES reports(id), and the upload is authorized by
            // RLS against the report itself - so uploading before the row
            // exists can only ever be refused. The old code uploaded first and
            // asked the Edge Function for a report that did not exist yet, and
            // handed it a record_key where a uuid was expected.
            // ------------------------------------------------------------------
            const baseRow = {
                record_key: record.key,
                report_type: toReportType(record.reportType),
                patient_name: record.patientName || '',
                patient_id: record.patientId || '',
                case_number: record.caseNumber || '',
                procedure_date: toIsoDate(record.procedureDate),
                file_name: record.fileName || '',
                // 0037 CROSS-CLINIC SECRETARY. The stamp trigger normally
                // derives doctor_id from the caller's live profile, so for a
                // doctor and an admin we still send nothing (see the note by
                // the final write). A SECRETARY is different: she may be
                // shelved under a doctor other than her primary, and the only
                // way to say so is to name that doctor here. The trigger
                // (ent_stamp_report_ownership) accepts NEW.doctor_id on INSERT
                // only when ent_is_my_doctor() agrees - her primary OR a
                // secretary_assignments row - and otherwise falls back to her
                // primary, so a forged id cannot reach another clinic. scope()
                // supplies the working doctor (or her primary when she picked
                // none), so this is always a doctor she may legitimately file
                // under; the server re-checks it anyway.
                ...(owner.role === 'secretary' && owner.doctorId
                    ? { doctor_id: owner.doctorId }
                    : {}),
                // Held as a draft for now, so that a save which stops half way
                // (photos uploaded, payload not yet written) leaves an honestly
                // unfinished row instead of a final one. Cleared below.
                is_draft: true,
                updated_at: now
            };

            let photoPaths = [];
            const inlineImages = Array.isArray(formData.images) ? formData.images.filter(Boolean) : [];
            // photo_count used to be a running local (`photoCount`) seeded from
            // inlineImages and patched in two places below. It is now derived
            // once, from storedFormData, further down — so the number that is
            // written is the number of photos the STORED payload actually
            // holds. Keeping a separate counter here is what let the column and
            // the payload disagree, so there is deliberately only one source.
            const store = window.EntPhotoStore;
            // Only worth a round trip when there is something to upload. The
            // SERVER decides whether photo storage is on; the localStorage
            // switch is a convenience and controls nothing. A failed probe
            // leaves the answer as it was, so the inline path is kept and a
            // save is never blocked by a network hiccup.
            if (inlineImages.length && store && typeof store.refreshCapability === 'function') {
                try { await store.refreshCapability(); } catch (error) { /* keep inline photos */ }
            }
            if (store && typeof store.uploadAll === 'function' && store.isEnabled()) {
                const images = inlineImages;
                if (images.length) {
                    // The parent row must exist before a single byte moves.
                    const seeded = await window.EntSupabase.apiRequest(
                        'reports?on_conflict=clinic_id,doctor_id,record_key&select=id',
                        {
                            method: 'POST',
                            headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
                            body: JSON.stringify([baseRow])
                        }
                    );
                    const reportId = Array.isArray(seeded) && seeded[0] ? seeded[0].id
                        : (seeded && seeded.id) || '';
                    if (!reportId) {
                        throw new Error('The record could not be created, so its photos were not uploaded.');
                    }
                    if (mainLabel) mainLabel.textContent = 'Uploading photos...';
                    const upload = await store.uploadAll(images, reportId, function (done, total) {
                        if (mainLabel) mainLabel.textContent = 'Uploading photos ' + done + '/' + total + '...';
                    });
                    if (!upload.ok) {
                        // The server has photo storage switched off - a state an
                        // administrator can change at any moment. That is NOT a
                        // failure of this report: keep the photos inline, exactly
                        // as if the feature had never been on, and save normally.
                        // Only a real error stops the save.
                        if (upload.skipped || upload.code === 'PHOTO_STORAGE_DISABLED') {
                            photoPaths = [];
                            if (mainLabel) mainLabel.textContent = originalLabel;
                        } else {
                            const failure = new Error(upload.error || 'The photos could not be uploaded.');
                            failure.photoUploadFailed = true;
                            failure.photoDetails = upload.details || null;
                            throw failure;
                        }
                    } else {
                        // Only a real upload sets the paths. Without this the
                        // values below would overwrite the inline fallback set
                        // in the "switched off" branch with undefined.
                        photoPaths = upload.paths;
                    }
                }
            }

            // With the photos in Storage the payload holds only references, so
            // records stay small. Without Storage the base64 images stay in the
            // payload - which is exactly why a report still opens with its
            // pictures on any device today.
            const storedFormData = photoPaths.length ? { ...formData, images: [] } : formData;

            // photo_count must describe THE ROW WE ARE WRITING, not the form we
            // were handed. Those differ exactly once: when the photos went to
            // Storage, the stored payload holds references rather than base64,
            // so the honest count is what the server confirmed (photoPaths).
            // Deriving it from storedFormData rather than trusting the earlier
            // local means the column cannot drift away from the payload that
            // ships with it — which is how two rows ended up carrying two real
            // JPEGs each while reporting photo_count = 0.
            const storedImageCount = photoPaths.length
                ? photoPaths.length
                : (Array.isArray(storedFormData.images) ? storedFormData.images.filter(Boolean).length : 0);

            // v2 column shape. Changes from v1, and why each one matters:
            //   clinic_id / created_by — NOT SENT. The BEFORE
            //     trigger ent_stamp_report_ownership (0004) overwrites them
            //     from the caller's LIVE profile, so the browser cannot
            //     choose a clinic or an author.
            //   doctor_id — NOT SENT for a doctor or an admin (the trigger
            //     stamps it from the live profile). A SECRETARY now sends it
            //     (0037) so she can file under a doctor she is assigned to
            //     who may sit in another clinic; the trigger validates it with
            //     ent_is_my_doctor() and falls back to her primary when it is
            //     not one of hers. See the note in baseRow above.
            //   metadata      -> payload        (renamed; no duplicate identity
            //                                          columns inside the jsonb)
            //   photo_paths / photos_uploaded -> GONE. Photos live in
            //     report_photos + a Storage bucket; only photo_count remains
            //     here, as a real column.
            //   procedure_date is a DATE now, so '' must become null.
            // The final write. baseRow already carries the column shape, and
            // was written once above when the photos needed a parent report.
            // The upsert target is identical, so this is either the ONLY write
            // (no Storage) or a merge that fills in the payload of the row
            // just created.
            const row = {
                ...baseRow,
                photo_count: storedImageCount,
                // The record has been SAVED, so it is no longer a draft.
                // Clearing the flag is what stamps `saved_at` (0004) and moves
                // the row into the finished-reports partial index
                // (`... WHERE NOT is_draft`). Leaving it TRUE left a real
                // record wearing a draft's label, and the "My Drafts" list -
                // which reads `is_draft = true` - then showed a finished
                // patient as if it were still unfinished.
                is_draft: false,
                payload: { ...record, formData: storedFormData, dbSaved: true, savedToDbAt: now,
                    // The hospital tag, when the feature asked for one.
                    // Omitted otherwise so every other clinic's payload is
                    // exactly what it was before this feature existed.
                    ...(siteChoice ? { site: siteChoice } : {}),
                    // The follow-up date, when one was chosen. Also omitted
                    // when blank so a save with no follow-up is unchanged -
                    // and the dashboard only lists a record whose payload
                    // actually carries this key (payload.followUpDate).
                    ...(followUpChoice ? { followUpDate: followUpChoice } : {}) },
                updated_at: now
            };

            // reports has UNIQUE (clinic_id, doctor_id, record_key); without an
            // explicit conflict target PostgREST resolves only on the primary
            // key, so re-saving raised 23505 (409). The target is unchanged in v2.
            let racedWinner = '';
            try {
                await window.EntSupabase.apiRequest('reports?on_conflict=clinic_id,doctor_id,record_key', {
                    method: 'POST',
                    headers: { 'Prefer': 'resolution=merge-duplicates' },
                    body: JSON.stringify([row])
                });
            } catch (saveError) {
                // 0041 RACE RECOVERY: two devices passed the pre-check and
                // both inserted; uniq_reports_patient_day (or its
                // case_number twin) refused the second one with 23505.
                // Re-query the winning row - it now exists - and merge THIS
                // payload into IT, so the race ends with one row: not two,
                // and not an error the user has to interpret.
                const msg = String((saveError && saveError.message) || '');
                const raced = /uniq_reports_patient|uniq_reports_case_number|23505|duplicate key/i.test(msg);
                racedWinner = raced
                    ? ((await findSameIdentityRecord(record.reportType, formData, today)) || '')
                    : '';
                if (!racedWinner || racedWinner === record.key) throw saveError;
                await window.EntSupabase.apiRequest('reports?on_conflict=clinic_id,doctor_id,record_key', {
                    method: 'POST',
                    headers: { 'Prefer': 'resolution=merge-duplicates' },
                    body: JSON.stringify([{ ...row, record_key: racedWinner }])
                });
            }

            markKeySaved(record.key);
            if (racedWinner && racedWinner !== record.key) markKeySaved(racedWinner);
            // Same condition as payload.site on the row: the tag exists
            // only for the flagged clinic and only when the prompt was
            // answered. Mirrors it into the local history (see
            // stampLocalHistorySite for why that matters to sync).
            if (siteChoice) stampLocalHistorySite(record.key, siteChoice);
            // No PHI in the audit trail - report_type only, never the
            // patient's name. See the OPEN_RECORD note and DEC-07: the
            // audit detail is read by every clinic admin and must not
            // carry patient-identifying text.
            logActivity('SAVE_RECORD', `Record saved (${record.reportType})`);

            const label = TYPE_LABELS[record.reportType] || record.reportType;
            const who = record.patientName ? ` for ${record.patientName}` : '';
            // 0041: say plainly WHICH record was written when the duplicate
            // guard decided this save was an update, so nobody hunts for a
            // "missing" second row that was never meant to exist.
            const mergeBit = adoptedKey
                ? '\n\nThis patient already had this report on this date (matched by patient ID), so the EXISTING record was updated \u2014 no duplicate was created.'
                : (racedWinner && racedWinner !== record.key)
                    ? '\n\nAn identical save had just landed from another device; THIS save updated that record \u2014 no duplicate was created.'
                    : '';
            if (repeats.length) {
                // Saved straight away (new date) - just point out the repeat.
                const shown = repeats.slice(0, 4);
                const total = repeats.length + 1;
                showAlert(
                    'SAVED TO DATABASE\n\n' +
                    label + who + ' is now in the shared cloud database.\n\n' +
                    '\u26A0\uFE0F HEADS UP - REPEAT ' + label.toUpperCase() + '\n\n' +
                    'This patient now has ' + total + ' ' + label + ' record' + (total === 1 ? '' : 's') + ':\n' +
                    shown.map(m => '  \u2022 ' + dupDateLabel(m.date) + (m.cloud ? '' : ' (only on this device)')).join('\n') +
                    (repeats.length > shown.length ? '\n  \u2022 ...' : '') + '\n\n' +
                    'Every visit is counted separately, so the patient counters stay right.' + mergeBit,
                    'Repeat Report'
                );
            } else {
                showAlert(
                    'SAVED TO DATABASE!\n\n' +
                    label + who + ' was saved to the shared cloud database.\n\n' +
                    'You can reopen it anytime from the "DB Records" button in the header.' + mergeBit,
                    'SUCCESS'
                );
            }
        } catch (error) {
            console.error('Save to database failed:', error);
            const conflict = /\(409\)|23505|on_conflict|ON CONFLICT/.test(String(error.message || ''));
            // A failed photo upload gets its own message: nothing was written,
            // the report is still on screen, and the local draft is untouched.
            if (error.photoUploadFailed) {
                const detail = error.photoDetails && Array.isArray(error.photoDetails.failed)
                    ? '\n\n' + error.photoDetails.failed
                        .map((f) => '  \u2022 Photo ' + f.index + ': ' + f.reason).join('\n')
                    : '';
                showAlert(
                    'NOT SAVED \u2014 PHOTOS COULD NOT BE UPLOADED\n\n' +
                    'The patient record was NOT saved, so nothing is half-finished in the database.\n\n' +
                    'Your report and its photos are still here, and your saved draft was not changed.' +
                    detail + '\n\nWhat to do: check the internet connection, then press "Save to Database" again.',
                    'ERROR'
                );
                return;
            }
        } finally {
            saving = false;
            if (saveButton) saveButton.disabled = false;
            if (mainLabel) mainLabel.textContent = originalLabel;
        }
    }

    // Resolves 'new' | 'cancel' | { open: '<record_key>' }
    // Only shown when the form falls on a day this patient already has a
    // record OF THIS REPORT TYPE - the caller (saveToDatabase) has already
    // narrowed matches to the current type, so every row here is a row this
    // save could really overwrite, and the "Open & update" button can never
    // load a foreign form. reportDate comes from the caller as well: a CF4's
    // date lives under dateAdmitted, not procedureDate, and the dialog must
    // still highlight the matching day.
    function askAboutDuplicates(formData, matches, reportDate, reportType) {
        return new Promise(function (resolve) {
            const box = document.createElement('div');
            box.className = 'modal-overlay ent-dup-modal no-print';
            const today = String(reportDate || formData.procedureDate || '').slice(0, 10);
            const who = String(formData.patientLastName || formData.patientFirstName || '').trim();
            const sameDay = matches.filter(function (m) { return today && m.date === today; });
            const typeLabel = TYPE_LABELS[reportType] || reportType || '';
            const typeBit = typeLabel ? typeLabel + ' ' : '';

            const rows = matches.map(function (m) {
                const sameDay = !!(today && m.date && today === m.date);
                return '<li class="ent-dup-row' + (sameDay ? ' is-sameday' : '') + '">'
                    + '<div class="ent-dup-main">'
                    + '<b>' + escapeHtml(m.name || 'Unnamed patient') + '</b>'
                    + '<span>' + escapeHtml(dupDateLabel(m.date))
                    + ' \u00b7 ' + escapeHtml(TYPE_LABELS[m.type] || m.type || 'Report')
                    + ' \u00b7 by ' + escapeHtml(m.who) + '</span>'
                    + (sameDay
                        ? '<em class="ent-dup-warn">&#9888; Same date \u2014 saving now updates this record</em>'
                        : '')
                    + (m.cloud ? '' : '<em class="ent-dup-local">Only on this device</em>')
                    + '</div>'
                    + (m.cloud
                        ? '<button type="button" class="ent-dup-open" data-dup-open="'
                            + escapeHtml(m.key) + '">&#9998; Open &amp; update this record</button>'
                        : '')
                    + '</li>';
            }).join('');

            box.innerHTML = `
                <div class="ent-dup-dialog" role="dialog" aria-modal="true" aria-label="Possible existing patient">
                    <div class="ent-dup-header">
                        <h2>&#128100; Already a record on this date</h2>
                        <p class="ent-dup-subtitle"><b>${escapeHtml(who)}</b> already has ${matches.length}
                            ${escapeHtml(typeBit)}record${matches.length === 1 ? '' : 's'}${sameDay.length ? ', including one on <b>' + escapeHtml(dupDateLabel(today)) + '</b>' : ''}.</p>
                    </div>
                    <ul class="ent-dup-list">${rows}</ul>
                    <p class="ent-dup-note">This form falls on a day this patient already has a record of the same
                        type, so saving replaces it. Change the <b>Date</b> field to keep both as separate visits.</p>
                    <div class="ent-dup-foot">
                        <button type="button" class="ent-dup-new">&#128190; Replace the record of this date</button>
                        <button type="button" class="ent-dup-cancel">&#10005; Cancel</button>
                    </div>
                </div>`;
            document.body.appendChild(box);

            function finish(value) {
                if (box.parentNode) box.parentNode.removeChild(box);
                document.removeEventListener('keydown', onKey);
                resolve(value);
            }
            function onKey(event) { if (event.key === 'Escape') finish('cancel'); }

            box.addEventListener('click', function (event) {
                const open = event.target.closest('[data-dup-open]');
                if (open) { finish({ open: open.getAttribute('data-dup-open') }); return; }
                if (event.target.closest('.ent-dup-new')) { finish('new'); return; }
                if (event.target === box || event.target.closest('.ent-dup-cancel')) finish('cancel');
            });
            document.addEventListener('keydown', onKey);
        });
    }

    /* WHICH HOSPITAL - the dialog. Two callers:
     *
     *   saveToDatabase: only when resolveHospitalFeature() said ON (it
     *   checks first), so every other clinic never sees this dialog and
     *   never gets a payload.site key written. Resolves 'RMCI' | 'CUMC' |
     *   '' (cancelled - nothing is saved).
     *
     *   startSiteMove: the Set/Move button beside a card's patient name,
     *   same flag. Passes { move: true, current } so the copy speaks
     *   about an EXISTING record; resolves the new site, or '' to leave
     *   it alone.
     *
     * The device's letterhead is pre-selected but never trusted: a
     * secretary may work across both buildings, and a record filed under
     * the wrong hospital costs a miscount. Re-saving re-asks every time,
     * so a record can be moved by saving it again - or from its card. */
    function askSaveSite(options) {
        const opts = options || {};
        const move = !!opts.move;
        const current = normaliseSite(opts.current || '');
        return new Promise(function (resolve) {
            const guess = current || currentDeviceSite();
            const title = move
                ? (current ? 'Move this record to another hospital?' : 'Which hospital does this patient belong to?')
                : 'Which hospital is this visit?';
            const blurb = move
                ? (current
                    ? 'Now filed under <b>' + escapeHtml(current) + '</b>. Pick the hospital the patient was really seen at - the tabs in DB Records follow this, and the change is written immediately.'
                    : 'This record has no hospital yet - saved before this was tracked, or from a device with no letterhead. Pick the right one now and it lands under that tab in DB Records.')
                : 'File it where the patient was actually seen - this picks the tab the record shows under in DB Records, so each hospital\'s count stays right. '
                    + (guess ? 'The hospital this device prints for (<b>' + escapeHtml(guess) + '</b>) is pre-selected; change it if that is wrong.' : '');
            const cancelLabel = move ? '&#10005; Cancel (no change)' : '&#10005; Cancel save';
            const box = document.createElement('div');
            box.className = 'modal-overlay ent-site-modal no-print';

            function finish(value) {
                if (box.parentNode) box.parentNode.removeChild(box);
                document.removeEventListener('keydown', onKey);
                resolve(value);
            }
            function onKey(event) { if (event.key === 'Escape') finish(''); }

            box.innerHTML = `
                <div class="ent-site-dialog" role="dialog" aria-modal="true" aria-label="Choose the hospital for this record">
                    <div class="ent-site-head">
                        <h2>&#127970; ${title}</h2>
                        <p>${blurb}</p>
                    </div>
                    <div class="ent-site-choices">
                        <button type="button" class="ent-site-choice is-rmci${guess === SITE_RMCI ? ' is-guess' : ''}" data-site-choice="RMCI">RMCI<span>Rever Medical Center Inc.</span></button>
                        <button type="button" class="ent-site-choice is-cumc${guess === SITE_CUMC ? ' is-guess' : ''}" data-site-choice="CUMC">CUMC<span>Capitol University Medical Center</span></button>
                    </div>
                    <div class="ent-site-foot">
                        <button type="button" class="ent-site-cancel">${cancelLabel}</button>
                    </div>
                </div>`;
            document.body.appendChild(box);

            box.addEventListener('click', function (event) {
                const choice = event.target.closest('[data-site-choice]');
                if (choice) {
                    finish(choice.getAttribute('data-site-choice') === SITE_CUMC ? SITE_CUMC : SITE_RMCI);
                    return;
                }
                if (event.target === box || event.target.closest('.ent-site-cancel')) finish('');
            });
            document.addEventListener('keydown', onKey);
        });
    }

    /* FOLLOW-UP DATE — an OPTIONAL "come back on this day" set at save time.
     * Deliberately its own small dialog rather than a field bolted onto the
     * site picker: the hospital question is about WHERE, this is about WHEN,
     * and mixing them makes both harder to answer. Resolves a YYYY-MM-DD
     * string, or '' for "no follow-up" (skip or cancel) - the caller writes
     * the key only when a date came back, so a record saved without one is
     * byte-identical to before. No migration: it rides on payload.followUpDate
     * exactly like payload.site, and the dashboard + admin tracker read it.
     *
     * The input is capped at today+365 so a typo cannot promise a visit years
     * out (the follow-up card ignores anything past a year anyway). */
    function askFollowUp(options) {
        const opts = options || {};
        const current = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.current || ''))
            ? String(opts.current) : '';
        const today = new Date();
        const iso = function (d) {
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
                + '-' + String(d.getDate()).padStart(2, '0');
        };
        const max = new Date(today.getTime() + 365 * 86400000);
        return new Promise(function (resolve) {
            const box = document.createElement('div');
            box.className = 'modal-overlay ent-site-modal no-print';

            function finish(value) {
                if (box.parentNode) box.parentNode.removeChild(box);
                document.removeEventListener('keydown', onKey);
                resolve(value);
            }
            function onKey(event) { if (event.key === 'Escape') finish(''); }

            box.innerHTML = `
                <div class="ent-site-dialog" role="dialog" aria-modal="true" aria-label="Set a follow-up date">
                    <div class="ent-site-head">
                        <h2>&#128197; When should this patient come back?</h2>
                        <p>Optional. Pick the date you want to see them again and it will appear as a reminder on the dashboard and the admin console. Leave it blank if there is no follow-up.</p>
                    </div>
                    <div class="ent-followup-field">
                        <label for="entFollowUpDate">Follow-up date</label>
                        <input type="date" id="entFollowUpDate" value="${current}"
                               min="${iso(today)}" max="${iso(max)}" />
                        <span class="ent-hint">Today or later, up to a year out.</span>
                    </div>
                    <div class="ent-site-foot">
                        <button type="button" class="ent-site-save" data-followup-save>Save date</button>
                        <button type="button" class="ent-site-cancel">&#10005; No follow-up</button>
                    </div>
                </div>`;
            document.body.appendChild(box);
            const input = box.querySelector('#entFollowUpDate');
            if (input) setTimeout(function () { input.focus(); }, 30);

            box.addEventListener('click', function (event) {
                if (event.target.closest('[data-followup-save]')) {
                    const val = input && input.value ? String(input.value) : '';
                    finish(/^\d{4}-\d{2}-\d{2}$/.test(val) ? val : '');
                    return;
                }
                if (event.target === box || event.target.closest('.ent-site-cancel')) finish('');
            });
            document.addEventListener('keydown', onKey);
        });
    }

    /* Assign or MOVE a saved record's hospital from its card in DB
     * Records - the button beside the patient's name, for the records
     * that have no hospital yet (and for changing a wrong one) without
     * reopening and re-saving the whole form.
     *
     * The button only exists when hospitalFeatureEnabled() built the
     * card's site zone; the check here too, so a stray call can never
     * write a tag for a clinic without the feature.
     *
     * Writes payload.site on EVERY row the caller can see for this
     * record_key, each patched with its OWN payload MERGED - payload
     * holds formData and photos, so a bare { site } would delete them.
     * Resolves true only when at least one row took the change; on
     * failure the list is untouched and the alert says how to do it the
     * long way round (open + Save to Database, which also asks). */
    async function startSiteMove(record) {
        if (!hospitalFeatureEnabled() || !record || !record.record_key) return false;
        if (!window.EntSupabase || !window.EntSupabase.isConfigured()) {
            showAlert('The cloud database is not configured yet.\n\nOpen Settings \u2192 Cloud Sync to add your Supabase credentials.', 'Database Not Configured');
            return false;
        }
        const current = siteOf(record);
        const choice = await askSaveSite({ move: true, current: current });
        if (!choice || choice === current) return false;
        setStatus('Moving this record to ' + choice + '...', true, false);
        try {
            const rows = await window.EntSupabase.apiRequest(
                'reports?record_key=eq.' + encodeURIComponent(record.record_key)
                + '&select=id,payload');
            if (!Array.isArray(rows) || !rows.length) {
                throw new Error('No database row was found for this record.');
            }
            let updated = 0;
            let lastError = null;
            for (const row of rows) {
                if (!row || row.id == null) continue;
                try {
                    await window.EntSupabase.apiRequest('reports?id=eq.' + encodeURIComponent(row.id), {
                        method: 'PATCH',
                        headers: { 'Prefer': 'return=representation' },
                        body: JSON.stringify({ payload: { ...(row.payload || {}), site: choice } })
                    });
                    updated += 1;
                } catch (error) {
                    lastError = error;               // other rows may still take it
                }
            }
            if (!updated) throw lastError || new Error('The database refused the update.');
            // The list renders from its own rows: tag them all (same
            // record_key) so the badge is truthful immediately, without
            // waiting for a full reload.
            const touch = function (row) {
                if (row && row.record_key === record.record_key) {
                    // Both key shapes, so the immediate re-render and ANY
                    // reader agree until the next fresh load.
                    row.site = choice;
                    row['payload->>site'] = choice;
                }
            };
            touch(record);
            (currentRecords || []).forEach(touch);
            renderList(currentRecords);
            setStatus('This record now belongs to ' + choice + '.', false, false);
            return true;
        } catch (error) {
            console.error('Could not change the hospital:', error);
            setStatus('Could not change the hospital: ' + (error.message || error), false, true);
            showAlert(
                'COULD NOT MOVE THIS RECORD\n\n'
                + (error.message || error) + '\n\n'
                + 'The list was not changed. Alternative: open the record and press\n'
                + '"Save to Database" - it asks which hospital before saving.',
                'Move Failed'
            );
            return false;
        }
    }
    async function toggleFinalSaved(record) {
         if (!record || !record.record_key) return false;
         if (!window.EntSupabase || !window.EntSupabase.isConfigured()) {
             showAlert('The cloud database is not configured yet.\n\nOpen Settings \u2192 Cloud Sync to add your Supabase credentials.', 'Database Not Configured');
             return false;
         }
         const now = new Date().toISOString();
         const flip = !isFinalSaved(record);
         // A row is "final saved" when the database holds dbSaved=true; a draft
         // is dbSaved=false (or missing) and is_draft=true. Toggling flips
         // dbSaved, and is_draft flips the other way so the row always states
         // one truth: finished or still-editable.
         const stamp = flip ? now : (record.savedToDbAt || record.updated_at || now);
         setStatus(flip ? 'Marking this record as final-saved in the database...' : 'Marking this record back to editable...', true, false);
         try {
             // reports.id is a UUID PK while record_key is TEXT (legacy rows
             // carry composite keys like "nasal|id:1306280|2026-08-25"), so
             // id=eq.<record_key> bounces off postgres with 22P02. Resolve
             // the real row ids first, then patch each with ITS OWN payload
             // merged - the same proven path startSiteMove uses above.
             const rows = await window.EntSupabase.apiRequest(
                 'reports?record_key=eq.' + encodeURIComponent(record.record_key)
                 + '&select=id,payload');
             if (!Array.isArray(rows) || !rows.length) {
                 throw new Error('No database row was found for this record.');
             }
             let updated = 0;
             let lastError = null;
             for (const row of rows) {
                 if (!row || row.id == null) continue;
                 try {
                     await window.EntSupabase.apiRequest('reports?id=eq.' + encodeURIComponent(row.id), {
                         method: 'PATCH',
                         headers: { 'Prefer': 'return=representation' },
                         body: JSON.stringify({
                             // THE COLUMN, not just the payload copy -
                             // written FALSE in BOTH directions. is_draft
                             // is the honest "this reached the database"
                             // marker (0017), and the list admits a row
                             // only through or=(is_draft.eq.false,...):
                             // setting it TRUE on "back to editable" would
                             // pull the record OUT of DB Records on the
                             // next load and into the owner-gated My
                             // Drafts, where whoever toggled it may not
                             // even see it - the record vanishes, which is
                             // the exact bug being fixed here. Finished vs
                             // editable lives in payload.dbSaved (the check
                             // mark), so THAT is what flips. The old write
                             // patched only payload.is_draft, leaving the
                             // column free to disagree with the row's real
                             // state.
                             is_draft: false,
                             payload: {
                                 ...(row.payload || {}),
                                 dbSaved: flip ? true : false,
                                 is_draft: flip ? false : true,
                                 savedToDbAt: stamp
                             }
                         })
                     });
                     updated += 1;
                 } catch (error) {
                     lastError = error;               // other rows may still take it
                 }
             }
             if (!updated) throw lastError || new Error('The database refused the update.');
             // Mutate the local copy too, so the check icon + button on this card
             // update immediately without waiting for a full refresh.
             if (!record.payload || typeof record.payload !== 'object') record.payload = {};
             const patch = record.payload;
             patch.dbSaved = flip ? true : false;
             patch.is_draft = flip ? false : true;
             record.dbSaved = flip ? true : false;
             record.is_draft = false;        // see the PATCH comment: never TRUE here
             (currentRecords || []).forEach(function (r) {
                 if (r && r.record_key === record.record_key) {
                     r.is_draft = false;
                     if (r.payload && typeof r.payload === 'object') {
                         r.payload.dbSaved = flip ? true : false;
                         r.payload.is_draft = flip ? false : true;
                         r.dbSaved = flip ? true : false;
                     } else {
                         r.dbSaved = flip ? true : false;
                     }
                     if (!r['payload->>dbSaved']) r['payload->>dbSaved'] = String(flip ? 'true' : 'false');
                 }
             });
             renderList(currentRecords);
             setStatus(flip ? 'Status: final saved \u2014 open in the form to keep working.' : 'Status: editable \u2014 open in the form to edit again.', false, false);
             return true;
         } catch (error) {
             console.error('Could not toggle final saved:', error);
             setStatus('Could not change status: ' + (error.message || error), false, true);
             showAlert('COULD NOT CHANGE THE STATUS\n\n' + (error.message || error) + '\n\nThe list was not changed.', 'Status Change Failed');
             return false;
         }
     }

    // ------------------------------------------------------------------
    // Database records modal (browse / search / open for editing)
    // ------------------------------------------------------------------
    function setStatus(message, isLoading, isError) {
        if (!statusElement) return;
        statusElement.textContent = message || '';
        statusElement.classList.toggle('is-loading', Boolean(isLoading));
        statusElement.classList.toggle('is-error', Boolean(isError));
        statusElement.hidden = !message;
    }

    function closeModal() {
        // Next open starts on the records view, never on a stale bin.
        trashMode = false;
        trashRows = [];
        if (trashButton) trashButton.textContent = '🗑 Recycle bin';
        if (modal) modal.style.display = 'none';
    }

    // The hospital tabs. Fixed order - All | CUMC Records | RMCI Records -
    // built as a string (not left in the dialog template) so the active
    // tab can be re-stamped cheaply and read back by the tests.
    const SITE_TABS = [
        { value: '', label: 'All' },
        { value: 'CUMC', label: 'CUMC Records' },
        { value: 'RMCI', label: 'RMCI Records' }
    ];

    function renderSiteTabs() {
        if (!siteTabsElement) return;
        siteTabsElement.innerHTML = SITE_TABS.map(function (tab) {
            const active = tab.value === siteFilter;
            return '<button type="button" class="ent-db-site' + (active ? ' is-active' : '') + '"'
                + ' data-site-tab="' + tab.value + '">' + tab.label + '</button>';
        }).join('');
    }

    // Show/hide the bar once the flag is known; a flag that resolves OFF
    // also falls back to All so no list can stay stuck on a hidden tab.
    function syncSiteTabs() {
        const on = hospitalFeatureEnabled();
        if (siteTabsElement) siteTabsElement.hidden = !on;
        if (!on && siteFilter) siteFilter = '';
        renderSiteTabs();
        renderList(currentRecords);
    }

    // Called by the tab clicks (and by the tests, directly).
    function setSiteFilter(site) {
        siteFilter = normaliseSite(site);
        renderSiteTabs();
        renderList(currentRecords);
    }

    // The sort bar. Fixed order - Latest (default) | A-Z - built as a
    // string like the hospital tabs so the active chip can be re-stamped
    // cheaply and read back by the tests.
    const SORT_MODES = [
        { value: 'date', label: 'Latest' },
        { value: 'name', label: 'A&ndash;Z' }
    ];

    function renderSortBar() {
        if (!sortBarElement) return;
        sortBarElement.innerHTML = '<span class="ent-db-sortlabel">Sort</span>'
            + SORT_MODES.map(function (mode) {
                const active = mode.value === sortMode;
                return '<button type="button" class="ent-db-sort' + (active ? ' is-active' : '') + '"'
                    + ' data-sort-mode="' + mode.value + '"'
                    + ' title="' + (mode.value === 'date'
                        ? 'Most recently saved patient first'
                        : 'Patient name from A to Z') + '">'
                    + mode.label + '</button>';
            }).join('');
    }

    // Called by the bar's clicks (and by the tests, directly). Anything
    // unknown falls back to 'date', so a malformed value can never strand
    // the list in an order the UI does not show as active.
    function setSortMode(mode) {
        sortMode = mode === 'name' ? 'name' : 'date';
        renderSortBar();
        renderList(currentRecords);
    }

    // Latest first: updated_at DESC (what the server query already orders
    // by), then created_at DESC, then the name - fully deterministic, so a
    // tie never shuffles between renders.
    function byRecency(a, b) {
        const da = String(a.updated_at || a.created_at || '');
        const db = String(b.updated_at || b.created_at || '');
        if (da !== db) return da > db ? -1 : 1;
        const ca = String(a.created_at || '');
        const cb = String(b.created_at || '');
        if (ca !== cb) return ca > cb ? -1 : 1;
        return byPatientName(a, b);
    }

    // A-Z by patient name, case-insensitive, unnamed rows LAST - an empty
    // string would otherwise sort first and bury every named patient
    // under a wall of "Unnamed patient".
    function byPatientName(a, b) {
        const na = String(a.patient_name || '').trim().toLowerCase();
        const nb = String(b.patient_name || '').trim().toLowerCase();
        if (!na && !nb) return 0;
        if (!na) return 1;
        if (!nb) return -1;
        return na < nb ? -1 : (na > nb ? 1 : 0);
    }

    function ensureModal() {
        if (modal) return modal;

        modal = document.createElement('div');
        modal.id = 'entDbRecordsModal';
        modal.className = 'modal-overlay ent-db-modal no-print';
        modal.style.display = 'none';
        modal.innerHTML = `
            <div class="ent-db-dialog" role="dialog" aria-modal="true" aria-label="Cloud database records">
                <div class="ent-db-header">
                    <div class="ent-db-heading">
                        <h2>&#9729;&#65039; Database Records</h2>
                        <p class="ent-db-subtitle">Saved in the shared cloud database (Supabase) &mdash; visible to your whole team, not just this device</p>
                    </div>
                    <button type="button" class="ent-db-close" aria-label="Close database records">&times;</button>
                </div>
                <div class="ent-db-toolbar">
                    <input type="search" class="ent-db-search" placeholder="Search patient, MRN/PIN, case no., or who saved it..." aria-label="Search database records">
                    <button type="button" class="ent-db-refresh" title="Reload records from the database">&#8635; Refresh</button>
                    <button type="button" class="ent-db-trashbtn" hidden title="Deleted records - restore them from here">&#128465; Recycle bin</button>
                </div>
                <div class="ent-db-sortbar" role="group" aria-label="Sort records"></div>
                <div class="ent-db-sites" hidden></div>
                <div class="ent-db-status" role="status" hidden></div>
                <div class="ent-db-list"></div>
            </div>
        `;
        document.body.appendChild(modal);

        listElement = modal.querySelector('.ent-db-list');
        statusElement = modal.querySelector('.ent-db-status');
        searchElement = modal.querySelector('.ent-db-search');
        siteTabsElement = modal.querySelector('.ent-db-sites');
        sortBarElement = modal.querySelector('.ent-db-sortbar');
        renderSiteTabs();
        renderSortBar();

        modal.querySelector('.ent-db-close').addEventListener('click', closeModal);
        modal.querySelector('.ent-db-refresh').addEventListener('click', () => {
            if (trashMode) loadTrashRows();
            else loadRecords();
        });
        // Recycle bin toggle (admin, secretary and the row's own doctor).
        // It is a VIEW of this dialog, not a separate page. Entering it
        // swaps the list for the bin's rows; leaving it reloads the records,
        // because a restore performed inside the bin has changed them.
        trashButton = modal.querySelector('.ent-db-trashbtn');
        if (trashButton) {
            trashButton.hidden = !mayReadRecycleBin();
            trashButton.addEventListener('click', toggleTrashMode);
        }
        searchElement.addEventListener('input', () => {
            if (trashMode) renderTrashList();
            else renderList(currentRecords);
        });
        modal.addEventListener('click', event => {
            // Sort chip (delegated like the tabs below).
            const sortBtn = event.target && event.target.closest
                ? event.target.closest('[data-sort-mode]') : null;
            if (sortBtn) {
                if (trashMode) return;   // the bin has its own order
                setSortMode(sortBtn.getAttribute('data-sort-mode') || 'date');
                return;
            }
            // Hospital tab (delegated so one listener covers the whole bar).
            const tab = event.target && event.target.closest
                ? event.target.closest('[data-site-tab]') : null;
            if (tab && siteTabsElement && !siteTabsElement.hidden) {
                if (trashMode) return;   // the bin is not narrowed by hospital
                setSiteFilter(tab.getAttribute('data-site-tab') || '');
                return;
            }
            // Restore button inside the recycle-bin view (delegated like the
            // sort chips above - renderTrashList() rebuilds the list).
            const restoreBtn = event.target && event.target.closest
                ? event.target.closest('[data-trash-restore]') : null;
            if (restoreBtn) {
                restoreTrashRow(restoreBtn.getAttribute('data-trash-restore'), restoreBtn);
                return;
            }
            if (event.target === modal) closeModal();
        });
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            if (confirmBox && confirmBox.style.display === 'flex') { finishConfirm(false); return; }
            if (modal && modal.style.display !== 'none') closeModal();
        });

        return modal;
    }

    function openRecordsModal() {
        const bridge = getBridge();
        if (!bridge) {
            showAlert('This page does not have an open form to load records into.', 'Not Available');
            return;
        }
        ensureModal();
        modal.style.display = 'flex';
        loadRecords();
        // The hospital tabs are feature-flagged. The clinic read is one
        // small cached query, and the list re-filters the moment the
        // answer lands - never worth delaying the records themselves for.
        resolveHospitalFeature().then(syncSiteTabs).catch(() => syncSiteTabs());
    }



    // ------------------------------------------------------------------
    // Read the WHOLE result set, page by page. Supabase/PostgREST always
    // caps one response (a plain GET tops out well below "every row a
    // shelf owns"), so a single fixed limit silently TRUNCATED the DB
    // Records list: older finished rows fell below the newest-N window
    // and the panel read "No saved patients yet" for saved patients.
    //
    // The loop asks for LIST_PAGE_SIZE rows at a time with a growing
    // offset and stops on the honest "no more rows" signal: a page that
    // came back SHORT of what was requested. Two guards keep it safe:
    //   - a page that contributed zero NEW rows (a server ignoring
    //     offset would repeat page 1 forever) breaks immediately, and
    //   - MAX_LIST_RECORDS is a runaway ceiling, never a display limit:
    //     in practice a shelf finishes long before it.
    // dedupe: listRowKey(row) de-duplicates ACROSS pages, because rows can
    // shift between requests when something is saved mid-paging.
    // ------------------------------------------------------------------
    function listRowKey(row) {
        if (row && row.record_key) return `${row.record_key}|${row.updated_at || ''}`;
        return null;
    }

    async function fetchAllPages(requestPage) {
        const collected = [];
        const seen = new Set();
        for (let offset = 0; offset < MAX_LIST_RECORDS; offset += LIST_PAGE_SIZE) {
            const page = await requestPage(offset);
            const rows = Array.isArray(page) ? page : [];
            let fresh = 0;
            rows.forEach((row, index) => {
                const key = listRowKey(row) || `@${offset}:${index}`;
                if (seen.has(key)) return;
                seen.add(key);
                collected.push(row);
                fresh += 1;
            });
            if (rows.length < LIST_PAGE_SIZE) break; // short page = last page
            if (!fresh) break;                       // same rows again
        }
        return collected;
    }

    async function loadRecords() {
        const bridge = getBridge();
        if (!bridge) return;

        if (!window.EntSupabase || !window.EntSupabase.isConfigured()) {
            currentRecords = [];
            renderList([]);
            setStatus('Cloud database is not configured. Open Settings \u2192 Cloud Sync first.', false, true);
            return;
        }

        setStatus('Loading records from the database...', true, false);
        try {
            // created_by / created_at tell WHO saved the patient and WHEN;
            // created_by_name (0028) is that author's display name beside
            // the uuid. THREE tiers, so a database that has not run 0028
            // yet keeps today's exact behaviour instead of losing the
            // draft filter to a 400: name+flags -> flags -> plain. The
            // hospital tag (payload->>site) rides on the flag tier; a
            // pre-payload database simply has no tags and those rows
            // live under the All tab only.
            //
            // is_draft=eq.false (now the three-clause or= filter) runs ON THE
            // SERVER for the two flag tiers - it admits the same rows
            // isDatabaseRecord() accepts (false, NULL, or payload-saved).
            // The list used to pull the newest 200 rows of ANY kind and only
            // then throw drafts away in the browser: once a shelf held 200+
            // newer drafts, every finished record fell below the limit and
            // the list read "No saved patients yet" for patients that were
            // saved long ago (reported for a secretary's CF4 shelf). It also
            // stopped at 200 rows flat, so even a clean shelf showed only the
            // newest 200 - now it pages until the server runs dry and shows
            // every saved row. The plain tier is the pre-0017 fallback -
            // flagUnknown means it has no is_draft column to filter on, so it
            // stays unfiltered.
            // id is selected on purpose: it is the reports PRIMARY KEY, and
            // the list de-duplicates on it (see the One CARD note below).
            // Without it the browser could only key on record_key, which is
            // NOT unique across rows - so a secretary's two real CF4 rows
            // (a re-save, a doctor reassignment, or a pre-0017 writer that
            // landed twice) shared one record_key and the OLDER one was
            // silently dropped from the list while the counter still said
            // "2 records". id makes every distinct row survive.
            const baseSelect = 'id,record_key,report_type,patient_name,patient_id,case_number,procedure_date'
                + ',created_by,created_at,updated_at';
            const flagSelect = baseSelect + ',doctor_id,is_draft,payload->>dbSaved,payload->>site';
            const nameSelect = flagSelect + ',created_by_name';
            // No clinic filter, no doctor filter: RLS decides. An unfiltered
            // query is the honest one — the database is the thing saying no.
            //
            // v33af sent `is_draft=eq.false` and it was TOO STRICT: SQL says
            // NULL ≠ false, so a legacy row with no flag never came back, and
            // a row whose column still reads TRUE while payload.dbSaved says
            // it was SAVED (a pre-0017 writer that omitted the column, or a
            // toggle flip stored only in payload) was dropped too — the exact
            // "secretary sees 1 CF4 record" report. The server filter now
            // admits EXACTLY the rows isDatabaseRecord() accepts below:
            //   · is_draft = false       — a writer finalized it
            //   · is_draft IS NULL       — flag never written (legacy row)
            //   · payload->>dbSaved=true — the payload says it was saved;
            //     dbSaved is checked FIRST in isDatabaseRecord, so it wins
            //     over a wrong TRUE column. Drafts (TRUE + no saved payload)
            //     still match none of these and stay in "My Drafts".
            const DRAFT_FILTER = '&or=(is_draft.eq.false,is_draft.is.null,'
                + 'payload->>dbSaved.eq.true)';
            // ONE page of the list. Server order is updated_at desc with id
            // desc as the tie-break: without it, two rows updated in the same
            // second could swap places between page requests and a row would
            // either repeat or get skipped while paging.
            const query = (select, withDraftFilter, offset) => `reports`
                + `?report_type=eq.${encodeURIComponent(toReportType(bridge.reportType))}`
                + (withDraftFilter ? DRAFT_FILTER : '')
                + `&select=${select}`
                + `&order=updated_at.desc,id.desc`
                + `&limit=${LIST_PAGE_SIZE}&offset=${offset}`;
            // Page until the server hands back a SHORT page - that is the
            // honest "no more rows" signal - so the list shows EVERY saved
            // record no matter how many rows the shelf holds.
            const fetchAll = (select, withDraftFilter) => fetchAllPages(
                offset => window.EntSupabase.apiRequest(query(select, withDraftFilter, offset)));
            let rows;
            let flagKnown = true;
            try {
                rows = await fetchAll(nameSelect, true);
            } catch (nameError) {
                try {
                    rows = await fetchAll(flagSelect, true);
                } catch (flagError) {
                    console.warn('Falling back to the plain record list.', flagError);
                    rows = await fetchAll(baseSelect, false);
                    flagKnown = false;
                }
            }
            const all = Array.isArray(rows) ? rows : [];
            // Drafts are NOT database records: a shared draft is only a listing
            // and lives in "My Drafts" until somebody presses "Save to Database".
            const savedRows = flagKnown ? all.filter(isDatabaseRecord) : all;
            hiddenDrafts = flagKnown ? all.length - savedRows.length : 0;
            // One CARD per REAL ROW, keyed on the primary key `id`.
            //
            // The old code de-duplicated on `record_key` alone, and that is
            // exactly what hid a secretary's saved patient: record_key is
            // `type|patient|date`, so it is NOT unique across table rows.
            // When Lilian re-saved the same CF4 patient (or a row was written
            // twice by a retry / before the clinic_id,doctor_id,record_key
            // upsert target existed), the database held TWO real rows with
            // the SAME record_key. The list arrives ordered updated_at desc,
            // so the dedup kept only the FIRST (= newest) and threw the
            // OLDER row away - the counter still counted both ("2 records")
            // while the list showed one. Two real saves must be two cards.
            //
            // id is the PRIMARY KEY, so two rows with the same id are
            // literally the same row (only possible from a page repeat,
            // which fetchAllPages already guards). Keying on id means every
            // distinct saved row survives. record_key stays as a fallback
            // ONLY for a row that somehow arrived without an id.
            const seenIds = new Set();
            const seenKeys = new Set();
            currentRecords = savedRows.filter(row => {
                const id = String(row.id || '').trim();
                if (id) {
                    if (seenIds.has(id)) return false;
                    seenIds.add(id);
                    return true;
                }
                const key = String(row.record_key || '').trim();
                if (!key) return true;
                if (seenKeys.has(key)) return false;
                seenKeys.add(key);
                return true;
            });
            // Visit counts are a separate, lighter read (loadPatientStats);
            // they must never break the list, so a failure leaves
            // patientStats null and the cards simply show no chip.
            patientStats = await loadPatientStats();
            renderList(currentRecords);
        } catch (error) {
            console.error('Could not load database records:', error);
            currentRecords = [];
            patientStats = null;
            renderList([]);
            setStatus(`Could not load records: ${error.message}`, false, true);
        }
    }

    // ------------------------------------------------------------------
    // How many records does this patient have on file, and on how many
    // different days? The DB Records list is one report type at a time,
    // so the counts come from their own lightweight all-types read (no
    // payload) - that is what makes "9 records · 4 visits" true for the
    // clinic's whole record of this patient, not just this form.
    //
    // Identity: patient_id when the row has one, otherwise the trimmed,
    // case-folded name. RACOMA, ALLOY has no ID on file, so a name key
    // is the only key that finds him; a patient recorded both with and
    // without an id would count as two - the same trade-off the
    // dashboard's counters already make.
    //
    // "Visits" = distinct dates: procedure_date, falling back to the day
    // the record was saved. Soft-deleted rows never arrive (0026 hides
    // them in RLS for EVERY caller) and drafts are excluded twice: by the
    // three-clause or= filter in the query, and again by isDatabaseRecord here.
    // ------------------------------------------------------------------
    function patientStatsKey(row) {
        const pid = String((row && row.patient_id) || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const name = String((row && row.patient_name) || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (pid) return 'id:' + pid;
        return name ? 'name:' + name : '';
    }

    async function loadPatientStats() {
        // Same paging contract as the list (fetchAllPages): the clinic's
        // whole record counts as visits, so a fixed newest-5000 window
        // would quietly undercount a busy shelf. `id.desc` is only the
        // order tie-break so pages cannot reshuffle between requests.
        const base = 'reports?select=patient_name,patient_id,procedure_date,created_at'
            + ',is_draft,payload->>dbSaved';
        const plainBase = 'reports?select=patient_name,patient_id,procedure_date,created_at,is_draft';
        // Same admission rule as the list (see DRAFT_FILTER in loadRecords):
        // false, NULL, or payload.dbSaved=true - a legacy row with no flag
        // still counts toward "9 records · 4 visits". plainBase predates the
        // jsonb path, so its filter can only carry the column clauses.
        const savedFilter = '&or=(is_draft.eq.false,is_draft.is.null,'
            + 'payload->>dbSaved.eq.true)';
        const plainSavedFilter = '&or=(is_draft.eq.false,is_draft.is.null)';
        const pageQuery = (selectPrefix, filter) => offset => selectPrefix
            + filter + '&order=created_at.desc,id.desc'
            + `&limit=${LIST_PAGE_SIZE}&offset=${offset}`;
        let rows;
        try {
            rows = await fetchAllPages(
                offset => window.EntSupabase.apiRequest(pageQuery(base, savedFilter)(offset)));
        } catch (first) {
            try {
                // Older API without the jsonb path: is_draft alone still
                // separates drafts from saved records (0017 made both honest),
                // and IS NULL is kept - a missing flag is NOT a draft.
                rows = await fetchAllPages(
                    offset => window.EntSupabase.apiRequest(pageQuery(plainBase, plainSavedFilter)(offset)));
            } catch (second) {
                console.warn('Patient visit counts unavailable.', second);
                return null;
            }
        }
        const totals = new Map();
        (Array.isArray(rows) ? rows : []).forEach(function (row) {
            if (!isDatabaseRecord(row)) return;
            const key = patientStatsKey(row);
            if (!key) return;
            const day = String(row.procedure_date || String(row.created_at || '').slice(0, 10) || '')
                .slice(0, 10);
            const hit = totals.get(key) || { records: 0, days: new Set() };
            hit.records += 1;
            if (day) hit.days.add(day);
            totals.set(key, hit);
        });
        const out = new Map();
        totals.forEach(function (v, k) {
            out.set(k, { records: v.records, visits: Math.max(1, v.days.size) });
        });
        return out;
    }

    function renderList(records) {
        if (!listElement) return;
        const query = String((searchElement && searchElement.value) || '').toLowerCase().trim();
        const filtered = (records || []).filter(record => {
            if (!query) return true;
            return [record.patient_name, record.patient_id, record.case_number, record.record_key,
                record.created_by, record.created_by_name]
                .some(value => String(value || '').toLowerCase().includes(query));
        });
        // Hospital tab (feature-flagged): only an ACTIVE tab narrows the
        // list - "All" shows tagged and untagged rows exactly as before.
        const shown = (siteFilter && hospitalFeatureEnabled())
            ? filtered.filter(record => siteOf(record) === siteFilter)
            : filtered;
        // Sort LAST: search and the hospital tabs narrow the set, then the
        // chosen order arranges it. 'date' (default) makes the server's own
        // updated_at DESC explicit - the freshest saved patient is always
        // on top; 'name' is A-Z with unnamed rows last. A fresh load
        // re-applies the mode (loadRecords never resets it), so the order
        // a user picked survives Refresh.
        const rows = shown.slice().sort(sortMode === 'name' ? byPatientName : byRecency);

        listElement.innerHTML = '';
        if (!rows.length) {
            const empty = document.createElement('div');
            empty.className = 'ent-db-empty';
            empty.textContent = (records && records.length)
                ? (siteFilter
                    ? 'No ' + siteFilter + ' records match' + (query ? ' this search.' : ' this report type.')
                        + ' Records with no hospital show under "All" - press "Set" beside a name to file one.'
                    : 'No records match this search.')
                : 'No saved patients yet for this report type.\n\nPress "Save to Database" (\u2601\uFE0F) in the header once a visit is finished.\nDrafts are not listed here - open "My Drafts" (\uD83D\uDCC2) for those.';
            listElement.appendChild(empty);
            if (records && records.length) setStatus(`${records.length} record(s) - none match ${siteFilter ? siteFilter + ' records' : (query ? 'the search' : 'this view')}.`, false, false);
            return;
        }

        rows.forEach(record => listElement.appendChild(buildCard(record)));
        const suffix = query ? ` (filtered from ${records.length})` : '';
        const scope = siteFilter ? ` \u00B7 ${siteFilter}` : '';
        const draftNote = hiddenDrafts
            ? ` \u00B7 ${hiddenDrafts} shared draft${hiddenDrafts === 1 ? '' : 's'} hidden (see My Drafts)`
            : '';
        setStatus(`${rows.length} saved patient${rows.length === 1 ? '' : 's'}${scope}${suffix}${draftNote}`, false, false);
    }

    // ------------------------------------------------------------------
    // The recycle bin, inside this dialog
    // ------------------------------------------------------------------
    // RLS hides deleted rows from EVERY reader (0026), so the only door is
    // the SECURITY DEFINER function ent_deleted_reports(): an active admin
    // sees every deleted row of a clinic he owns, a secretary sees the
    // shelf of every doctor she is assigned to (0034, widened cross-clinic
    // by 0039), and a doctor sees the deleted rows of his OWN shelf (0039).
    // Each scope is decided inside the function from staff_profiles, never
    // from what this dialog sent.
    //
    // Restore is deliberately an ordinary PATCH of deleted_at back to NULL,
    // not a special RPC: the UPDATE policies already answer "who may undo
    // this" (0026's admin arm, 0030's predicate with 0034's shelf arm and
    // 0039's cross-clinic arm), and one answer kept in one place cannot
    // drift from a second copy.
    //
    // There is NO "Delete forever" here. That button lives in the Admin
    // Console's Deleted-records panel and nowhere else - the final erase is
    // admin-only and only ever over an already-soft-deleted row (0026).
    function toggleTrashMode() {
        trashMode = !trashMode;
        if (trashButton) {
            trashButton.textContent = trashMode ? '⏻ Back to records' : '🗑 Recycle bin';
        }
        // The sort chips belong to the records list; the bin has its own
        // order (newest deletion first, decided by the server).
        if (sortBarElement) sortBarElement.hidden = trashMode;
        if (trashMode) {
            loadTrashRows();
        } else {
            // A restore inside the bin changed the list below, so reload it
            // rather than redraw a stale cache.
            loadRecords();
        }
    }

    async function loadTrashRows() {
        setStatus('Loading the recycle bin...', true, false);
        try {
            // POST because ent_deleted_reports takes a named argument.
            const rows = await window.EntSupabase.apiRequest(
                'rpc/ent_deleted_reports',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ p_limit: 200 })
                });
            trashRows = Array.isArray(rows) ? rows : [];
            renderTrashList();
        } catch (error) {
            const msg = String((error && error.message) || error);
            trashRows = [];
            renderTrashList();
            setStatus(
                'Could not read the recycle bin: ' + msg
                + (/404|PGRST202|could not find/i.test(msg)
                    ? ' (The database needs migrations 0026/0034.)' : ''),
                false, true
            );
        }
    }

    // Scoped to THIS dialog's report type, exactly like the records list
    // above: a deleted CF4 belongs to the CF4 page's bin. The Admin Console
    // shows every type at once for the whole clinic.
    function trashTypeRows() {
        const bridge = getBridge();
        const type = bridge ? toReportType(bridge.reportType) : '';
        return trashRows.filter(r => !type || String(r.report_type || '') === type);
    }

    function renderTrashList() {
        if (!listElement) return;
        const rows = trashTypeRows();
        listElement.innerHTML = '';
        if (!rows.length) {
            const empty = document.createElement('div');
            empty.className = 'ent-db-empty';
            empty.textContent = trashRows.length
                ? 'No deleted records of this report type.\nOther types show in the bin on their own report page.'
                : 'Nothing in the recycle bin.\nDeleted records wait here until they are restored - or erased for good from the Admin Console.';
            listElement.appendChild(empty);
            setStatus(`${trashRows.length} deleted record(s) in total`, false, false);
            return;
        }
        rows.forEach(r => listElement.appendChild(buildTrashCard(r)));
        setStatus(
            `${rows.length} deleted record${rows.length === 1 ? '' : 's'} · Restore puts a record back exactly where it was.`,
            false, false
        );
    }

    function buildTrashCard(r) {
        const card = document.createElement('article');
        card.className = 'ent-db-card ent-db-trashcard';
        const label = TYPE_LABELS[r.report_type] || r.report_type || 'Report';
        const who = r.deleted_who || 'someone';
        const when = r.deleted_at ? formatTimestamp(r.deleted_at) : '';
        card.innerHTML = `
            <div class="ent-db-card-main">
                <div class="ent-db-card-topline">
                    <span class="ent-db-badge">${escapeHtml(label)}</span>
                    <span class="ent-db-card-id" title="When this record was deleted">Deleted ${escapeHtml(when)}</span>
                </div>
                <h4 class="ent-db-card-name">${escapeHtml(r.patient_name || 'Unnamed patient')}</h4>
                <div class="ent-db-card-meta">
                    <span>&#9212; by ${escapeHtml(who)}</span>
                    ${r.deleted_reason ? `<span>${escapeHtml(r.deleted_reason)}</span>` : ''}
                </div>
            </div>
            <button type="button" class="ent-db-open ent-db-restore" data-trash-restore="${escapeHtml(String(r.id || ''))}" title="Put this record back where it was">&#9650; Restore</button>
        `;
        return card;
    }

    async function restoreTrashRow(id) {
        if (!id) return;
        setStatus('Restoring...', true, false);
        try {
            // deleted_at=not.null: the UPDATE can only ever name a row the
            // bin already marked, so a repeat click on a restored row marks
            // nothing instead of touching a live one.
            const res = await window.EntSupabase.apiRequest(
                'reports?id=eq.' + encodeURIComponent(id) + '&deleted_at=not.null',
                {
                    method: 'PATCH',
                    headers: { 'Prefer': 'return=representation' },
                    body: JSON.stringify({ deleted_at: null, deleted_by: null, deleted_reason: '' })
                });
            if (!Array.isArray(res) || !res.length) {
                throw new Error('the server refused the restore - you may not have access to this record');
            }
            trashRows = trashRows.filter(r => String(r.id) !== String(id));
            renderTrashList();
            setStatus('Record restored - it is back in the list with its photos and history intact.', false, false);
            // Not logged as an activity action: the allow-list in auth.js
            // holds no RESTORE_* action, and logActivity() refuses anything
            // it does not know rather than inventing a row.
        } catch (error) {
            setStatus('Could not restore: ' + String((error && error.message) || error), false, true);
        }
    }

    function buildCard(record) {
        const card = document.createElement('article');
        card.className = 'ent-db-card';
        const label = TYPE_LABELS[record.report_type] || record.report_type || 'Report';
        const idNumber = record.patient_id || record.case_number || '';
        const idChip = idNumber
            ? `<span class="ent-db-card-id" title="Patient ID">ID ${escapeHtml(idNumber)}</span>`
            : '<span class="ent-db-card-id is-empty" title="This record has no patient ID or case number">No ID on file</span>';
        // Returning patient? Counts come from loadPatientStats() and cover
        // ALL report types - the clinic's whole record for this patient,
        // not just the list this page shows. One record says nothing about
        // returning, so no chip then.
        const stats = patientStats ? patientStats.get(patientStatsKey(record)) : null;
        const visitsChip = (stats && stats.records > 1)
            ? `<span class="ent-db-card-visits" title="On file: ${stats.records} saved record(s) across ${stats.visits} visit date(s)">&#8635; ${stats.records} records &middot; ${stats.visits} visit${stats.visits === 1 ? '' : 's'}</span>`
            : '';
        // The hospital zone sits on the RIGHT of the patient's NAME - the
        // one place the clinic asked to read it (it used to hide in the
        // top line beside the ID, where nobody looked). Flagged twice:
        // hospitalFeatureEnabled() keeps every other clinic's card exactly
        // as it was, and normaliseSite() never guesses - an untagged row
        // SAYS it has no hospital and offers the button that files it,
        // instead of showing nothing at all. The badge classes are the
        // drafts' (auth.css), re-scoped under the card in
        // patient-records.css so they survive without that sheet.
        const featureOn = hospitalFeatureEnabled();
        const site = featureOn ? siteOf(record) : '';
        const siteZone = !featureOn
            ? ''
            : `<div class="ent-db-card-site">`
                + (site
                    ? `<span class="ent-drafts-site-badge is-${site.toLowerCase()}" title="This visit was saved to ${escapeHtml(site)}.">${escapeHtml(site)}</span>`
                    : `<span class="ent-db-site-none" title="No hospital recorded - saved before this was tracked, or from a device with no letterhead set.">No hospital</span>`)
                + `<button type="button" class="ent-db-site-move" title="${site ? 'Move this record to the other hospital' : 'Set the hospital for this record'}">${site ? 'Move' : 'Set'}</button>`
                + `<button type="button" class="ent-db-final-saved" title="Toggle this record status to final saved (or back to editable)">${isFinalSaved(record) ? 'Editable' : 'Final Saved'}</button>`
                + `</div>`;
        // Wrapped in the name row only while the feature is ON, so a flag
        // OFF clinic's card keeps its plain <h4> - byte for byte.
        const nameRow = siteZone
            ? `<div class="ent-db-card-namerow"><h4 class="ent-db-card-name">${escapeHtml(record.patient_name || 'Unnamed patient')}</h4>${siteZone}</div>`
            : `<h4 class="ent-db-card-name">${escapeHtml(record.patient_name || 'Unnamed patient')}</h4>`;
        // Only finished database saves reach this list - shared drafts are
        // filtered out in loadRecords(), so no draft chip is needed here.
        const who = savedByLabel(record);
        // Use the first real letter for the avatar, so "Dr. Ben dela Cruz" shows B.
        const avatar = escapeHtml(who.replace(/^(dr|doc|mr|mrs|ms|md|prof)\.?\s+/i, '').charAt(0).toUpperCase() || '?');
        const savedAt = record.created_at || record.updated_at || '';
        const editedAt = record.updated_at || '';
        const touched = editedAt && savedAt && Math.abs(new Date(editedAt) - new Date(savedAt)) > 60000;
        const finalSaved = isFinalSaved(record);
        const statusChip = finalSaved
            ? '<span class="ent-db-card-check" title="Final saved in the database">&#10003;</span>'
            : '<span class="ent-db-card-editable" title="Not final saved yet - still editable">Editable</span>';
        card.innerHTML = `
            <div class="ent-db-card-main">
                <div class="ent-db-card-topline">
                    <span class="ent-db-badge">${escapeHtml(label)}</span>
                    ${idChip}
                    ${statusChip}
                    ${visitsChip}
                </div>
                ${nameRow}
                <div class="ent-db-card-by" title="Saved in the shared database by ${escapeHtml(who)}">
                    <span class="ent-db-card-avatar" aria-hidden="true">${avatar}</span>
                    <span>Saved by <strong>${escapeHtml(who)}</strong></span>
                </div>
                <div class="ent-db-card-meta">
                    <span>&#128197; ${escapeHtml(formatDate(record.procedure_date))}</span>
                    <span>saved ${escapeHtml(formatTimestamp(savedAt))}</span>
                    ${touched ? `<span>edited ${escapeHtml(formatTimestamp(editedAt))}</span>` : ''}
                </div>
            </div>
            <button type="button" class="ent-db-open" title="Open this record in the form">Open</button>
            <button type="button" class="ent-db-del" title="Move this record to the recycle bin - an administrator or the shelf's secretary can restore it">&#128465; Delete</button>
        `;
        card.querySelector('.ent-db-open').addEventListener('click', () => confirmAndOpen(record));
        // Soft delete only. The button asks first; the DATABASE decides -
        // 0030's policy calls ent_may_soft_delete, whose fourth arm (0034)
        // admits a secretary on her assigned doctor's shelf. A refusal
        // reaches the user as a message, never as a vanished row.
        card.querySelector('.ent-db-del').addEventListener('click', () => confirmAndDelete(record));
        // The Set/Move hospital button only exists while the feature is ON
        // (siteZone ''), so a flag OFF clinic never wires - or sees - it.
        if (siteZone) {
            const moveBtn = card.querySelector('.ent-db-site-move');
            if (moveBtn) moveBtn.addEventListener('click', () => startSiteMove(record));
            // Final-saved / editable toggle: built into siteZone above and
            // wired here exactly like every other card button.
            const fsBtn = card.querySelector('.ent-db-final-saved');
            if (fsBtn) fsBtn.addEventListener('click', () => toggleFinalSaved(record));
        }
        // Status beside the ID chip: green check (is-shown) while the record
        // is final saved; the amber "Editable" pill is what renders instead
        // when it is not, so the state reads at a glance without any click.
        const checkEl = card.querySelector('.ent-db-card-check');
        if (checkEl) {
            if (finalSaved) checkEl.classList.add('is-shown');
            else checkEl.classList.remove('is-shown');
        }
        return card;
    }

    // ------------------------------------------------------------------
    // Confirm dialog (promise based)
    // ------------------------------------------------------------------
    function finishConfirm(result) {
        if (!confirmBox) return;
        confirmBox.style.display = 'none';
        if (confirmResolver) {
            const resolve = confirmResolver;
            confirmResolver = null;
            resolve(result);
        }
    }

    function showConfirm(message, title) {
        if (!confirmBox) {
            confirmBox = document.createElement('div');
            confirmBox.className = 'modal-overlay ent-db-confirm no-print';
            confirmBox.style.display = 'none';
            confirmBox.innerHTML = `
                <div class="ent-db-confirm-dialog" role="dialog" aria-modal="true">
                    <h3 class="ent-db-confirm-title"></h3>
                    <p class="ent-db-confirm-text"></p>
                    <div class="ent-db-confirm-actions">
                        <button type="button" class="ent-db-confirm-no">Cancel</button>
                        <button type="button" class="ent-db-confirm-yes">Yes, open it</button>
                    </div>
                </div>
            `;
            document.body.appendChild(confirmBox);
            confirmBox.querySelector('.ent-db-confirm-no').addEventListener('click', () => finishConfirm(false));
            confirmBox.querySelector('.ent-db-confirm-yes').addEventListener('click', () => finishConfirm(true));
            confirmBox.addEventListener('click', event => { if (event.target === confirmBox) finishConfirm(false); });
        }
        confirmBox.querySelector('.ent-db-confirm-title').textContent = title || 'Confirm';
        confirmBox.querySelector('.ent-db-confirm-text').textContent = message;
        confirmBox.style.display = 'flex';
        confirmBox.querySelector('.ent-db-confirm-yes').focus();
        return new Promise(resolve => { confirmResolver = resolve; });
    }

    // ------------------------------------------------------------------
    // Open a cloud record into the current form
    // ------------------------------------------------------------------
    /* Delete on a saved patient record - SOFT delete, into the recycle bin.
     *
     * The button used to be here and was removed while the database side
     * was broken (the UPDATE's WITH CHECK refused the marked row - fixed by
     * migration 0030). It comes back now because the ask is explicit: admin
     * or secretary deletes a record, but SOFT delete only, and the recycle
     * bin is where the real, final delete lives.
     *
     * So this writes deleted_at and nothing else - no DELETE statement
     * exists anywhere in this file, on purpose. The row, its payload and
     * its photos all survive; RLS stops returning the row (0026), it waits
     * in the bin (visible to an admin, or to the secretary on this shelf),
     * and only the Admin Console's "Delete forever" - admin-only, over an
     * already-deleted row - erases it for good.
     *
     * deleted_by is sent from the session but NOT trusted: 0034's stamp
     * trigger overwrites it from the JWT, the same way the ownership stamp
     * owns clinic_id and doctor_id. */
    async function confirmAndDelete(record) {
        const display = record.patient_name || record.record_key || 'this record';
        const confirmed = await showConfirm(
            `Move "${display}" to the recycle bin? It disappears from every list. ` +
            `An administrator - or the secretary of this doctor's shelf - can restore it.`,
            'Delete Record'
        );
        if (!confirmed) return;
        setStatus('Deleting ' + display + '...', true, false);
        try {
            // Target the PRIMARY KEY when we have it: one patient can hold
            // two rows with the same record_key (the duplicate-save case the
            // list was fixed for), and keying on record_key would mark
            // whichever row the server liked. deleted_at=is.null means only
            // a LIVE row can be marked - a repeat click marks nothing.
            const target = record.id
                ? 'id=eq.' + encodeURIComponent(record.id)
                : 'record_key=eq.' + encodeURIComponent(record.record_key);
            const res = await window.EntSupabase.apiRequest(
                'reports?' + target + '&deleted_at=is.null',
                {
                    method: 'PATCH',
                    headers: { 'Prefer': 'return=representation' },
                    body: JSON.stringify({
                        deleted_at: new Date().toISOString(),
                        deleted_by: currentUserId() || null,
                        deleted_reason: 'Deleted from DB Records'
                    })
                });
            // An empty array is PostgREST's "no row matched" - the policy
            // said no (or the row was already deleted). Saying "deleted"
            // over that would be a lie the user discovers later.
            if (!Array.isArray(res) || !res.length) {
                throw new Error('the server refused the delete - you may not have access to this record');
            }
            // No PHI in the audit trail (DEC-07): the id is in the row; the
            // patient's name is deliberately NOT logged.
            logActivity('DELETE_RECORD', `Record moved to recycle bin (${record.report_type})`);
            setStatus('Record moved to the recycle bin. It can be restored from the Recycle bin button above.', false, false);
            await loadRecords();
        } catch (error) {
            const msg = String((error && error.message) || error);
            setStatus('Could not delete: ' + msg, false, true);
            showAlert(
                'Could not delete this record:\n\n' + msg + '\n\n' +
                'Nothing was removed - the record is still in the database.',
                'Delete Failed'
            );
        }
    }


    function confirmAndOpen(record) {
        const bridge = getBridge();
        if (!bridge) {
            showAlert('This page does not have an open form to load records into.', 'Not Available');
            return;
        }

        const display = record.patient_name || record.record_key || 'this record';
        showConfirm(
            `Opening "${display}" will replace the current form contents (including images). Continue?`,
            'Open Database Record'
        ).then(confirmed => {
            if (!confirmed) return;
            openRecordFromCloud(record, bridge);
        });
    }

    async function openRecordFromCloud(record, bridge) {
        setStatus(`Opening ${record.patient_name || record.record_key}...`, true, false);
        try {
            // v2: no clinic filter, no doctor filter. `metadata` is now `payload`, and
            // the v1 photo columns are gone — photo_count is a real column and
            // the objects themselves live in Storage behind report_photos.
            //
            // Target the row by its PRIMARY KEY when we have it. A single
            // patient can legitimately hold TWO real rows with the SAME
            // record_key (the duplicate save this whole list was fixed for),
            // and a `record_key=eq.X&limit=1` query would pick whichever the
            // server returned first - NOT necessarily the card that was
            // clicked. id=eq.<id> opens exactly that row. record_key is the
            // fallback only for a card that somehow arrived without an id.
            const target = record.id
                ? `id=eq.${encodeURIComponent(record.id)}`
                : `record_key=eq.${encodeURIComponent(record.record_key)}`;
            const rows = await window.EntSupabase.apiRequest(
                `reports` +
                `?${target}` +
                '&select=id,record_key,payload,report_type,updated_at,photo_count' +
                '&limit=1'
            );
            const row = Array.isArray(rows) ? rows[0] : null;
            const rawFormData = row && row.payload ? row.payload.formData : null;

            if (!rawFormData || typeof rawFormData !== 'object') {
                // Drafts that were only shared as a listing have no payload yet.
                throw new Error(
                    'This one is not in the shared database yet \u2014 only its details are visible here.\n\n' +
                    (record.created_by
                        ? 'Ask ' + userDisplayName(record.created_by) + ' to open it and press "Save to Database" to make it editable from any device.'
                        : 'Ask the author to press "Save to Database" to make it editable from any device.')
                );
            }
            if (row.report_type !== bridge.reportType) {
                throw new Error('This record belongs to a different report type and cannot be opened on this page.');
            }

            // ---- bring the photos back in ----------------------------------
            // Two shapes must both open. A report saved while Storage was off
            // carries its photos INSIDE payload.formData as base64, so it is
            // already complete and needs nothing. A report saved with Storage
            // on carries only report_photos rows, so the paths are resolved
            // through the Edge Function (which re-checks access per path) and
            // the bytes come back as base64 - exactly what the form, the PDF
            // and the print code already expect.
            //
            // The old code read `row.photo_paths`. v2's reports table has no
            // such column - 0004 dropped it - so that branch could never run,
            // and the list query did not even ask for it.
            let formData = rawFormData;
            const inline = Array.isArray(rawFormData.images) ? rawFormData.images.filter(Boolean) : [];
            const store = window.EntPhotoStore;
            if (!inline.length && row.id && store && typeof store.listPaths === 'function') {
                if (typeof store.refreshCapability === 'function') {
                    try { await store.refreshCapability(); } catch (error) { /* stay inline */ }
                }
                if (store.isEnabled()) {
                    setStatus('Loading photos...', true, false);
                    const paths = await store.listPaths(row.id);
                    if (paths.length) {
                        const images = await store.downloadAsBase64(paths);
                        if (!images.length) {
                            throw new Error('The photos for this report could not be loaded. Please try again.');
                        }
                        formData = { ...rawFormData, images, photosFromStorage: true };
                    }
                }
            }

            bridge.restore(formData);
            // No PHI in the audit trail. The row's report_type is kept for
            // context; the patient's name is deliberately NOT logged here.
            // audit_select_admin reads every audit row in the clinic, and
            // activity_logs.detail must reference reports by id, never by
            // patient name (DEC-07). Before, this carried the name in
            // plain text, which the audit_no_patient_name CHECK (which only
            // matches the JSON-key form) let straight through.
            logActivity('OPEN_RECORD', `Record opened (${row.report_type})`);
            if (window.PatientRecords && typeof window.PatientRecords.recordOpen === 'function') {
                // Carry the row's stable identity forward so the next
                // "Save to Database" updates THIS row - even if the user then
                // edits its admit/discharge dates - instead of minting a
                // duplicate. row.record_key is the freshly fetched row;
                // record.record_key is the clicked card (same value).
                window.PatientRecords.recordOpen(row.report_type, formData, {
                    format: 'Database',
                    recordKey: row.record_key || record.record_key
                });
            }

            closeModal();
            setStatus('', false, false);
            showAlert(
                '\u2601\uFE0F  RECORD LOADED!\n\n' +
                (record.patient_name || 'The record') + ' is now open in the form.\n\n' +
                'Next steps:\n' +
                '  \u2713  Review the entries and photos\n' +
                '  \u2601\uFE0F  Press "Save to Database" to\n' +
                '     send your changes to the cloud',
                'SUCCESS'
            );
        } catch (error) {
            console.error('Could not open database record:', error);
            setStatus(`Could not open record: ${error.message}`, false, true);
            showAlert('COULD NOT OPEN RECORD\n\n' + error.message, 'ERROR');
        }
    }




    // ------------------------------------------------------------------
    // Deep link from the dashboard team queue
    //   <form page>?ent_record=<record_key>&ent_patient=..&ent_author=..
    // Lets a doctor open a secretary's saved record (and a secretary open a
    // doctor's) on the matching report page.
    // ------------------------------------------------------------------
    async function openFromDeepLink() {
        let params;
        try { params = new URLSearchParams(window.location.search || ''); } catch (e) { return; }
        const key = params.get('ent_record');
        if (!key) return;
        const patient = params.get('ent_patient') || '';
        const author = params.get('ent_author') || '';

        // A refresh must not re-open the record.
        try { window.history.replaceState({}, document.title, window.location.pathname); } catch (e) { /* ignore */ }

        const bridge = getBridge();
        if (!bridge) {
            showAlert('This page has no open form to load the record into.', 'Not Available');
            return;
        }
        showConfirm(
            'Open "' + (patient || 'this record') + '"' + (author ? ' (started by ' + author + ')' : '') + '?\n\n' +
            'It will replace whatever is currently in the form, including images.',
            'Open Team Record'
        ).then(function (confirmed) {
            if (!confirmed) return;
            openRecordFromCloud({ record_key: key, patient_name: patient, created_by: author }, bridge);
        });
    }

    // The bridge is published by the page script, so it may appear a tick later.
    function waitForDeepLinkBridge(triesLeft) {
        if (!getBridge()) {
            if (triesLeft > 0) { setTimeout(function () { waitForDeepLinkBridge(triesLeft - 1); }, 250); return; }
            return;
        }
        openFromDeepLink();
    }

    // ------------------------------------------------------------------
    // Button wiring
    // ------------------------------------------------------------------
    function bindButtons() {
        const saveButton = document.getElementById('saveToDbBtn');
        if (saveButton && saveButton.dataset.dbRecordsBound !== 'true') {
            saveButton.dataset.dbRecordsBound = 'true';
            saveButton.addEventListener('click', () => { saveToDatabase(); });
        }
        const browseButton = document.getElementById('dbRecordsBtn');
        if (browseButton && browseButton.dataset.dbRecordsBound !== 'true') {
            browseButton.dataset.dbRecordsBound = 'true';
            browseButton.addEventListener('click', () => { openRecordsModal(); });
        }
        waitForDeepLinkBridge(20);
    }

    window.EntDbRecords = {
        saveToDatabase,
        openRecordsModal,
        markKeySaved,
        readSavedKeys,
        // Feature-flagged hospital tabs: setSiteFilter mirrors exactly
        // what a tab click does, and the gate itself is exported so the
        // tests can assert who sees the feature.
        setSiteFilter,
        // The sort bar (Latest | A-Z). Exported for the same reason as
        // setSiteFilter: the tiny test DOM cannot click a button it never
        // parsed, so the mode must be drivable directly.
        setSortMode,
        resolveHospitalFeature,
        // The card's Set/Move hospital button. Exported like setSiteFilter
        // so the tests can drive the dialog directly - the tiny test DOM
        // cannot click a button it never parsed. buildCard wires the real
        // button to it.
        startSiteMove,
        // The Final Saved <-> Editable status button beside Set/Move, for
        // exactly the same reason: the test drives it directly, and this
        // is where the record_key -> row id resolution gets locked down.
        toggleFinalSaved
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindButtons, { once: true });
    } else {
        bindButtons();
    }

})(window);
