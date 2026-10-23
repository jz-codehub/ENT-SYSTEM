/* =====================================================================
   DRAFTS BROWSER - "Save Draft" popup.
   Two copies of the same list, deliberately:
     1. THIS DEVICE  - localStorage key entSavedDraftsV1. Written first,
        always available offline, and the only copy that can be edited
        without a connection. It wins a merge, because it is the copy
        this device actually owns.
     2. THE DATABASE - a row in `reports` (is_draft TRUE), auto-shared on
        every save by autoShareDraft(). RLS decides who sees it: a doctor
        sees his own shelf, a secretary her assigned doctor's. That copy
        is what makes a draft appear on a SECOND device, and it is what
        the paired colleague's dashboard reads.
   The list shown to the user is the MERGE of the two, deduplicated on
   `key` (= reports.record_key).
   Shared by cf4Form.html, nasalEndoscopy.html and laryngealEndoscopy.html.

   Depends on: (optional) patientRecords.js (window.PatientRecords)
   The active form page exposes window.EntFormBridge with:
       { reportType, getData(), restore(data), alert(message, title) }
   ===================================================================== */
(function (window) {
    'use strict';

    /* WHICH HOSPITAL A DRAFT BELONGS TO.
     *
     * One doctor can work at more than one hospital (Dr. Jess sees RMCI and
     * CUMC), and her secretaries work at different ones. Without that, every
     * draft from both hospitals lands in one list and there is no way to tell
     * whose work is whose.
     *
     * WHY THE TAG IS STORED, NOT DERIVED. There is no hospital column on a
     * report or a draft - reports carries clinic_id (the OWNING clinic) and
     * created_by (who wrote it), which say nothing about which building the
     * patient was seen in. The settings screen already has the distinction
     * (hospitalHeader: rever vs capitol, driving the printed letterhead), so
     * the draft borrows exactly that key rather than inventing a third one.
     * Same vocabulary, no migration, and it cannot disagree with the letterhead
     * the secretary already chose.
     *
     * The value is a SHORT CODE on purpose. A draft card is read at a glance
     * and "RMCI" says it in three letters; the full legal name does not fit
     * beside a patient name on a phone. The full name stays where it belongs,
     * on the printed form.
     */
    const SITE_REVER = 'RMCI';
    const SITE_CAPITOL = 'CUMC';
    const SITE_UNKNOWN = '';

    // Settings -> the short code. Reversed here so a future settings value
    // that is not one of these two lands on UNKNOWN and is shown honestly
    // rather than being filed under the wrong hospital.
    const SITE_BY_HEADER = { rever: SITE_REVER, capitol: SITE_CAPITOL };

    // The letters currently in use on this device, for the filter chips. Read
    // from the drafts rather than hardcoded, so a clinic that only ever works
    // at one hospital is not shown a chip for the other one.
    const SITE_LABELS = { [SITE_REVER]: 'RMCI', [SITE_CAPITOL]: 'CUMC' };

    /* Which hospital is this DEVICE set to print for right now?
     *
     * Best effort on purpose. clinicSettings.hospitalHeader is what the
     * letterhead follows, so it is the best available guess at save time - but
     * a secretary working across two hospitals may switch it between patients,
     * so the guess can be wrong. That is exactly why the tag is editable on
     * the card afterwards: a wrong guess costs one click, whereas a draft filed
     * under the wrong hospital with no way to move it costs a miscount.
     */
    function currentDeviceSite() {
        try {
            const settings = JSON.parse(window.localStorage.getItem('clinicSettings') || '{}');
            return SITE_BY_HEADER[settings.hospitalHeader] || SITE_UNKNOWN;
        } catch (error) {
            return SITE_UNKNOWN;
        }
    }

    function normaliseSite(value) {
        const raw = String(value == null ? '' : value).trim();
        if (!raw) return SITE_UNKNOWN;
        const upper = raw.toUpperCase();
        if (upper === SITE_REVER || upper === SITE_CAPITOL) return upper;
        // Tolerate the settings value or a full hospital name, so a draft
        // written by an older client - or by hand in devtools - still files
        // correctly instead of silently disappearing from every chip.
        if (/rever/i.test(raw)) return SITE_REVER;
        if (/capitol|cumc/i.test(raw)) return SITE_CAPITOL;
        return SITE_UNKNOWN;
    }

    const STORAGE_KEY = 'entSavedDraftsV1';
    // Written by dbRecords.js the moment "Save to Database" succeeds. Reused
    // here (readFinalisedKeys) to take a finished draft off the drafts shelf -
    // see the note there. Deliberately a copy of dbRecords' constant rather
    // than a shared module: draftsBrowser and dbRecords are loaded on
    // different pages (the form vs the DB panel) and there is no place both
    // can import from without adding a script tag to every page.
    const SAVED_KEYS_STORAGE = 'entDbSavedRecordKeysV1';
    const MAX_DRAFTS = 100;

    const TYPE_LABELS = {
        cf4: 'CF4 Form',
        nasal: 'Nasal Endoscopy',
        laryngeal: 'Laryngeal Endoscopy'
    };

    // Which page OWNS each form. A draft can now be opened from any form
    // page: Open takes you to this one and opens it there, instead of the
    // button being greyed out because you happened to be on the wrong page.
    //
    // Stored as bare names and turned into hrefs with Auth.pageUrl(), so a
    // jump between the form pages is built the same way everywhere. All
    // three forms live in pages/, so these resolve as siblings.
    const DRAFT_PAGES = {
        cf4: 'cf4Form.html',
        nasal: 'nasalEndoscopy.html',
        laryngeal: 'laryngealEndoscopy.html'
    };

    // The handover between those two steps. The KEY is what makes it work:
    // a shared draft can be found again on the other machine, while a draft
    // that exists only on this device has no copy to travel to.
    const DEEP_LINK_PARAM = 'ent_draft';

    function deepLinkedKey() {
        try {
            return new URLSearchParams(window.location.search || '').get(DEEP_LINK_PARAM) || '';
        } catch (e) { return ''; }
    }

    function clearDeepLink() {
        try {
            window.history.replaceState({}, document.title, window.location.pathname);
        } catch (e) { /* ignore */ }
    }

    // Called when a read lands. The draft is as often somebody ELSE's, which
    // is exactly the case that brought us here, so both lists are searched.
    function openDeepLinkedDraft() {
        const key = deepLinkedKey();
        if (!key) return false;
        if (cloudState === 'loading' || teamState === 'loading') return false;
        const draft = allDrafts().find(function (d) { return d.key === key; })
            || teamDrafts.find(function (d) { return d.key === key; })
            || null;
        clearDeepLink();
        if (!draft) {
            setStatus('That draft is no longer available on your team\'s shelf.', true);
            return false;
        }
        openDraft(draft);
        return true;
    }

    // v2 normalisers — same behaviour as dbRecords.js.
    // reports.report_type is the ENUM ('cf4'|'nasal'|'laryngeal') and
    // reports.procedure_date is a real DATE, so a stray label or an empty
    // string must be converted before the row is built: Postgres rejects
    // either at parse time, and a rejected INSERT means the draft is never
    // written at all — which then looks like an RLS problem downstream.
    const REPORT_TYPES = ['cf4', 'nasal', 'laryngeal'];

    function reportTypeOf(value) {
        const raw = String(value || '').trim().toLowerCase();
        if (REPORT_TYPES.indexOf(raw) !== -1) return raw;
        if (raw.indexOf('|') !== -1) {
            const head = raw.split('|')[0];
            if (REPORT_TYPES.indexOf(head) !== -1) return head;
        }
        return 'cf4';
    }

    function isoDateOf(value) {
        const raw = String(value == null ? '' : value).trim();
        if (!raw) return null;
        const date = new Date(raw);
        if (isNaN(date.getTime())) return null;
        return date.toISOString().slice(0, 10);
    }

    let modal = null;
    let offlineRecordsModal = null;
    let offlineRecordsSearch = '';
    let offlineRecordsPreviousOverflow = '';
    let confirmBox = null;
    let confirmResolver = null;
    let listElement = null;
    let statusElement = null;
    let searchElement = null;
    let summaryElement = null;
    let statusTimer = null;
    let searchTerm = '';
    // Which hospital's drafts the list is showing. '' = every hospital. This
    // sits ALONGSIDE the mine/team tab, not inside it: a doctor's two
    // secretaries work at different hospitals, so "mine vs team" answers who
    // wrote it and "RMCI vs CUMC" answers where - and neither question can
    // stand in for the other.
    let siteFilter = '';
    // Drafts the DATABASE knows about - the auto-shared copy - so the list is
    // the same on every device this account is signed in on. `''` means "we
    // have not looked yet", which keeps the offline case honest instead of
    // claiming the cloud list is empty.
    let cloudDrafts = [];
    let cloudState = '';   // '' | 'loading' | 'ready' | 'error' | 'offline'

    // ---- the two draft views -------------------------------------------
    // 'mine'  exactly what it always was: drafts THIS account wrote.
    // 'team'  the rest of your shelf - a doctor sees the drafts his
    //         secretaries typed, a secretary sees her doctor's. The read
    //         is unfiltered ON PURPOSE and RLS is what narrows it, so the
    //         browser cannot widen it by accident: ent_may_read_own_clinic
    //         still answers "your clinic, your shelf" and nothing else.
    let draftTab = 'mine';
    let teamDrafts = [];
    let teamState = '';    // '' | 'loading' | 'ready' | 'error' | 'offline'
    let tabsElement = null;
    let tabsMineCount = null;
    let tabsTeamCount = null;

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
        return String(value ?? '').replace(/[&<>'\"]/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '\"': '&quot;'
        })[char]);
    }

    function cleanText(value) {
        return String(value ?? '').trim();
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

    function formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
        if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    }

    function normalizeDate(raw) {
        const text = cleanText(raw);
        if (!text) return '';
        if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
        const parsed = new Date(text);
        if (Number.isNaN(parsed.getTime())) return text;
        return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
    }

    function extractMeta(reportType, formData, fileName) {
        const normalizedType = TYPE_LABELS[reportType] ? reportType : 'nasal';
        const lastName = cleanText(formData.patientLastName);
        const firstName = cleanText(formData.patientFirstName);
        const patientName = [lastName, firstName].filter(Boolean).join(', ')
            || cleanText(formData.patientName)
            || 'Unnamed patient';
        const patientId = cleanText(
            formData.patientPin || formData.mrn || formData.patientId || formData.caseNumber
        );
        const caseNumber = cleanText(formData.caseNumber);
        const procedureDate = normalizeDate(
            formData.procedureDate || formData.reportDate || formData.dateOfProcedure ||
            formData.operationDate || formData.dateAdmitted || formData.date || ''
        );
        return {
            reportType: normalizedType,
            reportLabel: TYPE_LABELS[normalizedType],
            patientName,
            patientId,
            caseNumber,
            procedureDate,
            fileName: cleanText(fileName),
            // Which hospital this patient's visit belongs to. Taken from the
            // device's current letterhead setting, and re-tagged on every save
            // rather than only on creation - so a draft left open while the
            // secretary switches hospitals still files under the one it was
            // last worked on, which is the one that matters. saveDraft() also
            // keeps any tag the doctor set by hand, so this is only the default
            // and never overwrites a deliberate choice.
            site: currentDeviceSite()
        };
    }

    function buildKey(meta) {
        return `${meta.reportType}|${meta.patientName.toLowerCase()}|${meta.procedureDate || 'no-date'}`;
    }

    // ------------------------------------------------------------------
    // Local storage (device only, quota-safe)
    // ------------------------------------------------------------------
    /* Whose drafts may this account push to the cloud?
     *
     * THE SECOND LEAK, AND THE ONE THAT ACTUALLY FIRED.
     *
     * syncEngine.js was gated, and that was not enough. There are TWO
     * independent local histories on this device and only one of them got
     * the guard:
     *
     *   entPatientRecordHistoryV1  (patientRecords.js) -> GATED
     *   entSavedDraftsV1          (this file)         -> WAS NOT GATED
     *
     * readDrafts() returns every draft in the key regardless of who saved
     * it, and autoShareDraft() POSTs them all under whoever is signed in. The
     * trigger then stamps doctor_id = the caller, so jess's drafts were
     * faithfully duplicated onto larson's shelf, then onto josh's. Observed
     * live: 29 duplicates reappearing for every new doctor, which is what
     * "99 records" was.
     *
     * The guard is `ownerId`, stamped on save by the SAME routine below, so a
     * draft this account did not create is never pushed by this account. A
     * draft with no stamp predates it and is undecidable, so it is still
     * pushed - dropping it would lose a real patient's reachability, which is
     * the far worse error.
     */
    function currentOwnerId() {
        try {
            const auth = window.EntAuth;
            const user = auth && typeof auth.currentUser === 'function' ? auth.currentUser() : null;
            return String((user && user.id) || '').trim();
        } catch (e) { return ''; }
    }

    function mayShowDraft(draft) {
        const mine = currentOwnerId();
        if (!mine) return true;
        const owner = String((draft && draft.ownerId) || '').trim();
        // Unstamped: still SHOWN. It may be this account's own pre-stamp work,
        // and hiding it would silently lose a real patient's draft from the
        // only place it exists. Displaying is safe - the person at the
        // keyboard is on their own account, and these bytes never left the
        // machine. It is the PUSH that must not happen, and that is
        // mayShareDraft's separate job below.
        if (!owner) return true;
        return owner === mine;
    }

    /* Pushing to the cloud is a WRITE that the database attributes to whoever
     * is signed in, so it needs a stricter answer than display does. */
    function mayShareDraft(draft) {
        const mine = currentOwnerId();
        // No signed-in id (a stubbed or absent auth) keeps the old behaviour
        // rather than silently sharing nothing.
        if (!mine) return true;
        const owner = String((draft && draft.ownerId) || '').trim();
        /* UNSTAMPED IS NO LONGER "LET IT THROUGH".
         *
         * That was the wrong call and it is why the deletion did not stick.
         * The drafts already on this machine predate the ownerId stamp, so
         * every one of them had no stamp, and this branch waved them all
         * through - on EVERY page load, because retryPendingShares() runs from
         * render(). Deleting the 31 rows in the database changed nothing: the
         * next hard refresh re-pushed all 29 from localStorage and the count
         * went 38 -> 69 again, observed live.
         *
         * The reasoning that produced "let it through" was: dropping it might
         * lose a real patient's draft. But an unstamped draft is not evidence
         * that the CURRENT account owns it, and it cannot be - the account may
         * be the second person ever to use this machine. Pushing it is not a
         * neutral act: the trigger stamps doctor_id = the caller, so allowing
         * it does not "preserve" the draft, it COPIES another doctor's patient
         * onto this account's shelf. The real patient's record already exists
         * on their own shelf and in the cloud; this local copy is the leak
         * itself.
         *
         * So an unstamped draft is now SHOWN (so nothing silently vanishes
         * from the only place it exists) but never SHARED. It cannot be
         * attributed, so this account declines to attribute it.
         */
        if (!owner) return false;
        return owner === mine;
    }

    /* Has this draft already been finalised into the shared database?
     *
     * "Save to Database" (dbRecords.js) marks the record key in localStorage
     * under entDbSavedRecordKeysV1 before it reports success - that list is
     * already there for the background sync, so this reuses it rather than
     * inventing a second flag that could disagree with the first.
     *
     * WHY THE DRAFT IS HIDDEN AND NOT DELETED. A finished record lives in the
     * database and stays reachable from DB Records and from the admin's
     * recycle bin, so nothing is lost by taking it off the drafts shelf - and
     * this shelf is meant to answer "what have I not finished yet?". But the
     * local copy can still hold photos the cloud never received (a failed
     * upload, or a draft saved offline and finalised from another device), and
     * deleting it on the strength of a localStorage flag would destroy those
     * silently. Hiding is reversible; deletion would not be. The storage
     * screen can still clear them for real.
     *
     * The cloud half is filtered separately, in loadCloudDrafts(), on the
     * dbSaved flag the row carries itself. Both halves are needed: this list is
     * per-device and the cloud flag is per-row, so neither one sees the other.
     */
    function readFinalisedKeys() {
        try {
            const parsed = JSON.parse(
                window.localStorage.getItem(SAVED_KEYS_STORAGE) || '[]');
            return new Set(Array.isArray(parsed) ? parsed : []);
        } catch (error) {
            // Unreadable flag: show everything rather than hide real work.
            return new Set();
        }
    }

    function isFinalisedDraft(draft) {
        if (!draft || !draft.key) return false;
        try {
            return readFinalisedKeys().has(draft.key);
        } catch (error) {
            return false;
        }
    }

    // How many drafts on this device are already in the database. Shown in the
    // status line so the list never looks like something went missing.
    function countFinalisedDrafts() {
        const keys = readFinalisedKeys();
        if (!keys.size) return 0;
        return readDrafts().filter(function (d) {
            return d && d.key && keys.has(d.key);
        }).length;
    }

    function readDrafts() {
        try {
            const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]');
            const list = Array.isArray(parsed) ? parsed.filter(draft => draft && draft.id) : [];
            return list.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
        } catch (error) {
            console.warn('Unable to read local drafts.', error);
            return [];
        }
    }

    function isQuotaError(error) {
        return Boolean(error) && (
            error.name === 'QuotaExceededError' ||
            error.code === 22 ||
            error.code === 1014
        );
    }

    function stripImages(draft) {
        if (!draft || !draft.formData || typeof draft.formData !== 'object') return null;
        const images = draft.formData.images;
        if (!Array.isArray(images) || images.length === 0) return null;
        return { ...draft, formData: { ...draft.formData, images: [] }, imagesStripped: true };
    }

    // A browser gives this device about 5 MB for everything, and one draft with
    // photos can be 1-2 MB. Rather than wait for the "storage full" error (which
    // used to lock the user out of the app), only the newest few drafts keep
    // their photos. Older drafts keep ALL of their text - nothing is deleted.
    const MAX_DRAFTS_WITH_PHOTOS = 3;

    function trimOldPhotos(keepNewest) {
        const keep = Math.max(1, Number(keepNewest) || MAX_DRAFTS_WITH_PHOTOS);
        const list = readDrafts();               // already newest first
        if (list.length <= keep) return { freed: 0, changed: 0, kept: keep };
        let changed = 0;
        const next = list.map((draft, index) => {
            if (index < keep) return draft;
            const stripped = stripImages(draft);
            if (!stripped) return draft;
            changed++;
            return stripped;
        });
        if (!changed) return { freed: 0, changed: 0, kept: keep };
        // estimateSize() works on ONE draft, so measure the whole list directly.
        const sizeOf = (list) => {
            try { return JSON.stringify(list).length; } catch (error) { return 0; }
        };
        const before = sizeOf(list);
        writeDrafts(next);
        return { freed: Math.max(0, before - sizeOf(next)), changed, kept: keep };
    }

    // The newest drafts are the ones with the latest savedAt, which is the order
    // readDrafts() already returns. Callers can hand writeDrafts() an unsorted
    // list, so the order is worked out again here before anything is dropped.
    function keepNewestIndexes(drafts, keep) {
        const order = drafts
            .map((draft, index) => ({ index, at: String((draft && draft.savedAt) || '') }))
            .sort((a, b) => b.at.localeCompare(a.at));
        return new Set(order.slice(0, keep).map(item => item.index));
    }

    function writeDrafts(drafts) {
        // Keep this device small before anything is written: only the newest few
        // drafts keep their photos, so signing in and saving never fail.
        if (drafts.length > MAX_DRAFTS_WITH_PHOTOS) {
            const keep = keepNewestIndexes(drafts, MAX_DRAFTS_WITH_PHOTOS);
            for (let i = 0; i < drafts.length; i++) {
                if (keep.has(i)) continue;
                const stripped = stripImages(drafts[i]);
                if (stripped) drafts[i] = stripped;
            }
        }
        const attempt = (list) => {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
            return list;
        };
        let working = drafts.slice(0, MAX_DRAFTS);
        try {
            return attempt(working);
        } catch (error) {
            if (!isQuotaError(error)) throw error;
        }

        // 1) Storage full: drop embedded photos from the OLDEST drafts first.
        working = drafts.slice(0, MAX_DRAFTS);
        for (let i = working.length - 1; i >= 0; i--) {
            const stripped = stripImages(working[i]);
            if (!stripped) continue;
            working[i] = stripped;
            try {
                return attempt(working);
            } catch (error) {
                if (!isQuotaError(error)) throw error;
            }
        }

        // 2) Still full: remove the oldest drafts entirely (newest kept).
        working = drafts.slice(0, MAX_DRAFTS);
        while (working.length > 1) {
            working = working.slice(0, -1);
            try {
                return attempt(working);
            } catch (error) {
                if (!isQuotaError(error)) throw error;
            }
        }

        // 3) Last resort: keep only the newest draft, without its photos.
        if (working[0]) {
            const stripped = stripImages(working[0]) ||
                (working[0].formData
                    ? { ...working[0], formData: { ...working[0].formData, images: [] }, imagesStripped: true }
                    : null);
            if (stripped) {
                working = [stripped];
                try {
                    return attempt(working);
                } catch (error) {
                    if (!isQuotaError(error)) throw error;
                }
            }
        }

        throw new Error('Local storage is full. Delete some drafts from the list and try again.');
    }

    // ------------------------------------------------------------------
    // Save / download / open / delete
    // ------------------------------------------------------------------
    /* Is there a patient to call this draft?
     *
     * extractMeta() falls back to the literal "Unnamed patient", so emptiness
     * cannot be judged on that string - it has to be judged on the FIELDS.
     * And the fallback is not merely ugly: buildKey() turns it into
     * `cf4|unnamed patient|2026-10-05`, so two different nameless patients
     * saved on the SAME DAY collide on one key and the second one silently
     * overwrites the first. Refusing here is what stops that.
     */
    function hasPatientName(formData) {
        if (!formData || typeof formData !== 'object') return false;
        return [formData.patientLastName, formData.patientFirstName, formData.patientName]
            .some(function (value) { return cleanText(value); });
    }

    function saveDraft(reportType, formData, fileName, siteOverride, options) {
        if (!formData || typeof formData !== 'object') {
            throw new Error('There is no form data to save.');
        }
        if (!hasPatientName(formData)) {
            // Refused BEFORE anything is written - not to this device, not
            // to the database. Nothing to undo later, nothing to clean up.
            showAlert(
                'This draft cannot be saved without a patient name.\n\n'
                + 'Enter a last name or a first name first. Without one, a draft '
                + 'cannot be told apart from another, and two nameless drafts '
                + 'saved on the same day would overwrite each other.',
                'Patient name needed'
            );
            return null;
        }
        const drafts = readDrafts();
        const meta = extractMeta(reportType, formData, fileName);
        const key = buildKey(meta);
        const timestamp = new Date().toISOString();

        let draft = drafts.find(item => item.key === key);
        if (draft) {
            drafts.splice(drafts.indexOf(draft), 1);
        } else {
            draft = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                key,
                createdAt: timestamp,
                saveCount: 0,
                imagesStripped: false
            };
        }
        // Keep a hospital the doctor set BY HAND; only fall back to the device
        // setting. extractMeta() re-reads the setting on every save, so trusting
        // it blindly would quietly move a draft somebody had deliberately filed
        // under the other hospital - the one case where being "consistent" is
        // exactly wrong. An explicit siteOverride (chosen in the offline save
        // popup) wins over both.
        const previousSite = normaliseSite(draft.site);
        Object.assign(draft, meta);
        draft.key = key;
        draft.site = siteOverride !== undefined ? siteOverride : (previousSite || normaliseSite(meta.site));
        // Stamp the owner on EVERY save, not only on creation. This is the
        // second half of the guard in mayShareDraft(): without it a draft has
        // no way to say whose it is, so every account on this browser shares
        // every other account's drafts to the cloud. An existing draft
        // re-saved by a different account becomes that account's from now on.
        draft.ownerId = currentOwnerId();
        const stampUser = (function () {
            try {
                const auth = window.EntAuth;
                const user = auth && typeof auth.currentUser === 'function' ? auth.currentUser() : null;
                return String((user && (user.username || user.full_name)) || '');
            } catch (e) { return ''; }
        })();
        if (stampUser) draft.ownerName = stampUser;
        draft.fileName = cleanText(fileName) || draft.fileName || '';
        draft.formData = formData;
        draft.savedAt = timestamp;
        draft.saveCount = Number(draft.saveCount || 0) + 1;
        const offlineSnapshot = Object.assign({}, draft, {
            formData: Object.assign({}, formData, {
                images: Array.isArray(formData.images) ? formData.images.slice() : []
            })
        });
        drafts.unshift(draft);

        writeDrafts(drafts);
        // Best effort: let the paired colleague see the draft straight away.
        // Silently skipped when offline; the Share button can retry later.
        const cloudPush = options && options.offlineOnly
            ? Promise.resolve(false)
            : autoShareDraft(draft).then(function (ok) {
                return ok ? { success: true, sharedAt: draft.sharedAt || '' } : false;
            });
        // OFFLINE MODE: mirror the draft into the IndexedDB offline database
        // (offlineStore.js) and put it on the pending-sync queue. The
        // autoShareDraft promise rides along so a save that already reached
        // the database clears its own queue job instead of being pushed a
        // second time by the sync engine.
        if (window.EntOfflineStore && typeof window.EntOfflineStore.recordSaved === 'function') {
            try {
                draft.offlinePersistPromise = window.EntOfflineStore.recordSaved(offlineSnapshot, cloudPush);
            } catch (error) {
                console.warn('[EntDrafts] offline store mirror failed:', error);
                draft.offlinePersistPromise = Promise.resolve({
                    saved: false,
                    queued: false,
                    error: (error && error.message) || 'Could not save to offline storage.'
                });
            }
        } else {
            draft.offlinePersistPromise = Promise.resolve({
                saved: false,
                queued: false,
                error: 'Offline storage is unavailable on this device.'
            });
        }
        return draft;
    }

    function saveOfflineDraft(reportType, formData) {
        const hasFullName = cleanText(formData && formData.patientName)
            || (cleanText(formData && formData.patientFirstName)
                && cleanText(formData && formData.patientLastName));
        if (!hasFullName) return null;
        return saveDraft(reportType, formData, '', undefined, { offlineOnly: true });
    }

    /* The database copy of a draft carries the FORM, not just the listing, so
       the same draft can be opened on another device. Photos are the
       exception and are stripped on purpose:
         * they are base64, the reports payload has a hard 20 MB ceiling
           (0004 reports_payload_ceiling) and the free plan is 500 MB;
         * the picture still travels when somebody presses "Save to Database",
           which is where images have always been sent.
       A second guard catches a form so large that even the text would put the
       INSERT at risk - that one is shared as metadata only, and the card says
       there is no form data rather than offering an Open that would fail. */
    const MAX_CLOUD_FORM_BYTES = 1024 * 1024;   // 1 MB
    function cloudFormData(draft) {
        const form = draft && draft.formData;
        if (!form || typeof form !== 'object') return null;
        const stripped = stripImages(draft) || draft;
        const clean = stripped.formData || null;
        try {
            if (!clean || JSON.stringify(clean).length > MAX_CLOUD_FORM_BYTES) return null;
        } catch (error) {
            return null;
        }
        return clean;
    }

    // Push the draft to the database with no user interface. Used after
    // every "Save Draft" so a doctor's drafts show up on the secretary's
    // dashboard (and the other way round) as soon as the device is online,
    // and so the same draft can be opened from another machine.
    // Every save re-posts on purpose: the partner then sees the newest work.
    // Returns a promise so a failure can be reported instead of swallowed.
    function autoShareDraft(draft) {
        if (!draft || !draft.reportType) return Promise.resolve(false);
        // THE GUARD. This is the writer that actually duplicated one doctor's
        // patients onto every new doctor signed in on this machine: the sweep
        // below fed it drafts belonging to somebody else, and it POSTs them all
        // under the current account, which the trigger then stamps as the
        // current doctor's. Refused before any network call.
        if (!mayShareDraft(draft)) return Promise.resolve(false);
        const supa = window.EntSupabase;
        const auth = window.EntAuth;
        if (!supa || !supa.isConfigured()) {
            return markShareProblem(draft,
                'The cloud database is not configured on this device (Settings \u2192 Cloud Sync).');
        }
        if (!navigator.onLine) {
            return markShareProblem(draft, 'No internet connection - it will be shared on your next save.');
        }
        if (!auth || typeof auth.scope !== 'function') {
            return markShareProblem(draft, 'Sign in to share drafts with your colleague.');
        }
        const scope = auth.scope() || {};
        const me = typeof auth.currentUser === 'function' ? (auth.currentUser() || {}) : {};
        if (!scope.doctorId && !scope.seeAll) {
            return markShareProblem(draft,
                'This account is not linked to a doctor yet, so the draft stays on this device.');
        }
        const now = new Date().toISOString();
        const key = draft.key || draft.id;
        // ---- v2 row shape -------------------------------------------------
        // This block used to carry the v1 columns:
        //     clinic_id : 'main_clinic'   (TEXT)   -> reports.clinic_id is uuid
        //     doctor_id : scope.doctorId   (TEXT)   -> reports.doctor_id is uuid
        //     created_by: me.username       (TEXT)   -> reports.created_by is uuid
        //     metadata  : {...}                     -> reports has NO `metadata`
        //                                               column; it is `payload`
        // Postgres rejects that INSERT while parsing it, so the BEFORE trigger
        // never ran, NO ROW WAS EVER WRITTEN, and the paired secretary's list
        // stayed empty. The failure was caught by .catch() below and surfaced
        // only as "Could not reach the cloud database", which read like a
        // network fault and, later, like an RLS problem. It was neither.
        //
        // Ownership columns are deliberately ABSENT: the BEFORE trigger
        // ent_stamp_report_ownership (0004) overwrites clinic_id, doctor_id and
        // created_by from the caller's LIVE staff_profiles row, so the browser
        // cannot choose a clinic, a doctor or an author.
        const row = {
            record_key: key,
            report_type: reportTypeOf(draft.reportType),
            patient_name: draft.patientName || '',
            patient_id: draft.patientId || '',
            case_number: draft.caseNumber || '',
            procedure_date: isoDateOf(draft.procedureDate),
            file_name: draft.fileName || '',
            // A shared draft IS a draft in v2 — a real BOOLEAN, kept out of the
            // finished report list by the partial index idx_reports_drafts.
            // Sent explicitly rather than left to the column DEFAULT so the
            // value is a decision, not an accident. DEFAULT is now TRUE
            // (0017) but this must not depend on that.
            is_draft: true,
            // A shared draft carries NO photos: cloudFormData() strips them
            // (draftsBrowser.js) because the base64 would blow the payload
            // ceiling. So 0 is not a guess here, it is the true count — but it
            // is sent explicitly, because a row created without this key took
            // DEFAULT 0 and nothing ever repaired it.
            photo_count: 0,
            payload: {
                key: key,
                reportType: draft.reportType,
                reportLabel: draft.reportLabel || draft.reportType,
                patientName: draft.patientName || '',
                caseNumber: draft.caseNumber || '',
                procedureDate: draft.procedureDate || '',
                fileName: draft.fileName || '',
                // Which hospital this visit belongs to, carried with the draft
                // so the RMCI / CUMC split survives the trip to the database
                // and back onto another device. Without it a shared draft would
                // arrive untagged and vanish from both chips. An older row has
                // no key here, which normaliseSite() turns into UNKNOWN -
                // visible under "Other", never silently misfiled.
                site: normaliseSite(draft.site),
                draftShared: true,
                sharedAt: now,
                sharedBy: me.full_name || me.username || '',
                // The whole form minus photos, so "My Drafts" opens the same
                // draft on any device. dbRecords.js already reads
                // payload.formData when a record is finally saved, so the two
                // shapes agree.
                formData: cloudFormData(draft)
            },
            updated_at: now
        };
        // Ownership columns stay out of the body on purpose (see the note
        // above); ent_stamp_report_ownership stamps them server-side.
        return supa.apiRequest('reports?on_conflict=clinic_id,doctor_id,record_key', {
            method: 'POST',
            headers: { 'Prefer': 'resolution=merge-duplicates' },
            body: JSON.stringify([row])
        }).then(function () {
            draft.sharedAt = now;
            draft.sharedBy = me.username || '';
            const list = readDrafts();
            const target = list.filter(function (item) { return item.id === draft.id; })[0];
            if (!target) return true;
            target.autoSharedAt = draft.savedAt;
            target.sharedAt = now;
            target.sharedBy = me.username || '';
            delete target.shareError;
            writeDrafts(list);
            return true;
        }).catch(function (error) {
            return markShareProblem(draft, shareFailureMessage(error));
        });
    }

    // Turn a failed share into a message that names the REAL cause. The old
    // wording ("Could not reach the cloud database") was used for EVERY
    // failure, so a rejected INSERT — a data-shape or permission problem —
    // looked like a network outage and sent people hunting the wrong bug.
    function shareFailureMessage(error) {
        const status = Number((error && error.status) || 0);
        const detail = String((error && error.message) || error || '').trim();
        if (error && error.code === 'AUTH_REQUIRED') {
            return 'Your session expired, so the draft was not shared. Sign in again — it stays on this device until then.';
        }
        if (status === 409 || /23505|duplicate key/i.test(detail)) {
            return 'The cloud already holds this draft, so it was not replaced (' + detail + ').';
        }
        if (status === 400 || status === 403 || status === 404 || status === 422 || status === 500) {
            return 'The cloud database refused the draft (HTTP ' + status + '): ' + detail;
        }
        return 'Could not reach the cloud database (' + (detail || 'no response') + ').';
    }

    // Remember why a draft is still local and say so, instead of failing quietly.
    function markShareProblem(draft, message) {
        try {
            const list = readDrafts();
            const target = list.filter(function (item) { return item.id === draft.id; })[0];
            if (target) {
                target.shareError = message;
                writeDrafts(list);
            }
            if (modal) setStatus('Draft kept on this device: ' + message, true);
            console.warn('Draft not shared:', message);
        } catch (error) { /* ignore */ }
        return Promise.resolve(false);
    }

    // ------------------------------------------------------------------
    // Share a draft with the paired colleague
    // ------------------------------------------------------------------
    // Drafts normally never leave this device. Sharing pushes a light listing
    // (patient, report type, date) into the shared database so the paired
    // doctor/secretary sees it on their dashboard under "Needs review".
    // The form itself only travels when somebody presses "Save to Database".
    async function shareDraft(draft) {
        if (!draft || !draft.reportType) return;
        // Same guard as autoShareDraft: this is the MANUAL "Send now" button,
        // and it reaches the same cloud writer. Refusing only the automatic
        // path would leave a one-click way to duplicate a whole shelf.
        if (!mayShareDraft(draft)) {
            setStatus('This draft belongs to another account on this device, so it cannot be sent from here.', true);
            return;
        }
        const supa = window.EntSupabase;
        if (!supa || !supa.isConfigured() || !navigator.onLine) {
            setStatus('Sharing needs an internet connection and a configured cloud database.', true);
            return;
        }
        const auth = window.EntAuth;
        if (!auth || typeof auth.scope !== 'function') {
            setStatus('Sign in first to share drafts.', true);
            return;
        }
        const scope = auth.scope() || {};
        const me = typeof auth.currentUser === 'function' ? (auth.currentUser() || {}) : {};
        const config = supa.getConfig();
        const now = new Date().toISOString();
        const key = draft.key || draft.id;
        const row = {
            record_key: key,
            report_type: draft.reportType,
            patient_name: draft.patientName || '',
            patient_id: draft.patientId || '',
            case_number: draft.caseNumber || '',
            procedure_date: draft.procedureDate || null,
            file_name: draft.fileName || '',
            // A shared draft IS a draft in v2: is_draft TRUE, plus a partial
            // index that keeps it out of the finished report list.
            is_draft: true,
            // Explicit, for the same reason as the auto-share path above: the
            // value must be stated, never inherited from a DEFAULT. This
            // manual share sends a listing only (no formData), so 0 is exact.
            photo_count: 0,
            payload: {
                key: key,
                reportType: draft.reportType,
                reportLabel: draft.reportLabel || draft.reportType,
                patientName: draft.patientName || '',
                caseNumber: draft.caseNumber || '',
                procedureDate: draft.procedureDate || '',
                fileName: draft.fileName || '',
                sharedAt: now,
                sharedBy: me.full_name || me.username || ''
            },
            updated_at: now
        };
        try {
            await supa.apiRequest('reports?on_conflict=clinic_id,doctor_id,record_key', {
                method: 'POST',
                headers: { 'Prefer': 'resolution=merge-duplicates' },
                body: JSON.stringify([row])
            });
            const drafts = readDrafts();
            const target = drafts.find(item => item.id === draft.id);
            if (target) {
                target.sharedAt = now;
                target.sharedBy = me.username || '';
                writeDrafts(drafts);
            }
            setStatus('Shared - your paired colleague sees it on their dashboard now.', false);
            render();
        } catch (error) {
            setStatus('Could not share this draft: ' + ((error && error.message) || error), true);
        }
    }

    // A plain, readable copy of a draft: anybody can open it, and the file can
    // still be restored later with "Open Draft" because the full data is kept
    // underneath the header.
    function buildCopyName(draft) {
        const label = String(draft.reportLabel || draft.reportType || 'Draft')
            .replace(/Endoscopy|Claim Form|Form/gi, '').replace(/[^a-z0-9]+/gi, '') || 'Report';
        const base = String(draft.patientName || '').replace(/[^a-z0-9\s-]/gi, '').trim().replace(/\s+/g, '_');
        return (base ? base + '_' : '') + label + '_Copy.txt';
    }

    // "patientLastName" -> "Patient Last Name", with the usual short forms
    // kept in caps so the copy reads like a form.
    const ACRONYMS = { mrn: 'MRN', dob: 'DOB', icd: 'ICD', php: 'PHP', mm: 'mm', cm: 'cm', kg: 'kg', bp: 'BP', id: 'ID' };
    function fieldLabel(key) {
        return String(key)
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/[_-]+/g, ' ')
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map(function (word) {
                const low = word.toLowerCase();
                if (ACRONYMS[low]) return ACRONYMS[low];
                return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
            })
            .join(' ');
    }

    function readableFields(data) {
        const out = [];
        Object.keys(data || {}).forEach(function (key) {
            const value = data[key];
            if (value === null || value === undefined || value === '' || typeof value === 'boolean') return;
            if (typeof value === 'object') {
                // Arrays of plain text are worth showing; photos stay in the JSON.
                if (Array.isArray(value) && value.length && typeof value[0] !== 'object') {
                    out.push(fieldLabel(key) + ' : ' + value.join(', '));
                }
                return;
            }
            out.push(fieldLabel(key) + ' : ' + value);
        });
        return out.slice(0, 40);
    }

    function buildCopyText(draft) {
        const lines = [
            'ENT ENDOSCOPY SYSTEM - SAVED DRAFT COPY',
            '=========================================',
            'Patient    : ' + (draft.patientName || 'Unnamed patient'),
            'Report     : ' + (draft.reportLabel || draft.reportType || 'Draft'),
            'Visit date : ' + formatDay(draft.procedureDate),
            'Saved on   : ' + formatWhen(draft.savedAt),
            'File       : ' + buildCopyName(draft),
            '',
            'This is a backup of a draft that lives on one device only.',
            'To keep editing it: open the report page -> "Open Draft" -> choose this file.',
            '',
            '--- PATIENT DETAILS -------------------------------------------'
        ];
        const fields = readableFields(draft.formData);
        lines.push(fields.length ? fields.join('\n') : '(no details yet)');
        lines.push('');
        lines.push('--- FULL DATA (needed to restore this draft) ------------------');
        lines.push(JSON.stringify(draft.formData, null, 2));
        return lines.join('\n');
    }

    function downloadDraft(draft) {
        if (!draft || !draft.formData) {
            setStatus('This draft has no form data attached.', true);
            return;
        }
        try {
            const text = buildCopyText(draft);
            const filename = buildCopyName(draft);
            const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            setStatus('Copy saved to your device: "' + filename + '"');
        } catch (error) {
            console.error('Error saving the draft copy:', error);
            setStatus(`Could not save the copy: ${error.message}`, true);
        }
    }

    function showConfirm(message, title) {
        return new Promise(resolve => {
            if (!modal) {
                resolve(window.confirm(message));
                return;
            }
            if (confirmResolver) confirmResolver(false);
            confirmBox = document.createElement('div');
            confirmBox.className = 'ent-drafts-confirm';
            confirmBox.innerHTML = `
                <div class="ent-drafts-confirm-dialog" role="alertdialog" aria-modal="true">
                    <h3 class="ent-drafts-confirm-title">${escapeHtml(title)}</h3>
                    <p class="ent-drafts-confirm-text">${escapeHtml(message)}</p>
                    <div class="ent-drafts-confirm-actions">
                        <button type="button" class="ent-drafts-confirm-no">Cancel</button>
                        <button type="button" class="ent-drafts-confirm-yes">Continue</button>
                    </div>
                </div>`;
            modal.appendChild(confirmBox);
            const settle = (value) => {
                if (confirmBox && confirmBox.parentNode) {
                    confirmBox.parentNode.removeChild(confirmBox);
                }
                confirmBox = null;
                confirmResolver = null;
                resolve(value);
            };
            confirmResolver = settle;
            confirmBox.querySelector('.ent-drafts-confirm-no').addEventListener('click', () => settle(false));
            confirmBox.querySelector('.ent-drafts-confirm-yes').addEventListener('click', () => settle(true));
        });
    }

    function showFeedbackModal(options) {
        const opts = options || {};
        const overlay = document.createElement('div');
        overlay.className = 'ent-feedback-overlay' + (opts.variant ? ' is-' + opts.variant : '');
        overlay.setAttribute('role', opts.alert ? 'alertdialog' : 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', opts.title || 'Notification');

        const card = document.createElement('section');
        card.className = 'ent-feedback-card';
        const icon = document.createElement('div');
        icon.className = 'ent-feedback-icon' + (opts.tone ? ' is-' + opts.tone : '');
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = opts.icon || '\u2713';
        const eyebrow = document.createElement('p');
        eyebrow.className = 'ent-feedback-eyebrow';
        eyebrow.textContent = opts.eyebrow || 'ENT SYSTEM';
        const title = document.createElement('h2');
        title.className = 'ent-feedback-title';
        title.textContent = opts.title || 'Done';
        const description = document.createElement('p');
        description.className = 'ent-feedback-description';
        description.textContent = opts.description || '';
        card.append(icon, eyebrow, title, description);

        if (opts.details && opts.details.length) {
            const details = document.createElement('div');
            details.className = 'ent-feedback-details';
            opts.details.forEach(function (text) {
                const line = document.createElement('p');
                line.textContent = text;
                details.appendChild(line);
            });
            card.appendChild(details);
        }

        const actions = document.createElement('div');
        actions.className = 'ent-feedback-actions';
        const buttons = Array.isArray(opts.actions) && opts.actions.length
            ? opts.actions
            : [{ label: 'Continue', value: true, primary: true }];
        let settled = false;
        let previousOverflow = '';
        let resolveResult;
        const promise = new Promise(function (resolve) { resolveResult = resolve; });
        function close(value) {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKeydown);
            overlay.remove();
            document.body.style.overflow = previousOverflow;
            resolveResult(value);
        }
        function onKeydown(event) {
            if (event.key === 'Escape') close(null);
        }
        buttons.forEach(function (item) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'ent-feedback-button' +
                (item.primary ? ' is-primary' : '') +
                (item.danger ? ' is-danger' : '');
            button.textContent = item.label || 'Continue';
            button.addEventListener('click', function () { close(item.value); });
            actions.appendChild(button);
        });
        card.appendChild(actions);
        overlay.appendChild(card);
        overlay.addEventListener('click', function (event) {
            if (event.target === overlay) close(null);
        });
        previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onKeydown);
        overlay.classList.add('is-open');
        const firstButton = actions.querySelector('button');
        if (firstButton) firstButton.focus();
        return promise;
    }

    function closeOfflineRecordsFallback() {
        if (!offlineRecordsModal) return;
        offlineRecordsModal.classList.remove('is-open');
        document.body.style.overflow = offlineRecordsPreviousOverflow;
    }

    async function renderOfflineRecordsFallback() {
        if (!offlineRecordsModal) return;
        const bridge = getBridge();
        const store = window.EntOfflineStore;
        const list = offlineRecordsModal.querySelector('.ent-drafts-list');
        const summary = offlineRecordsModal.querySelector('.ent-drafts-summary');
        if (!bridge || !store || typeof store.listRecords !== 'function') {
            list.textContent = 'Offline records are not available on this page.';
            summary.textContent = '';
            return;
        }
        try {
            const records = await store.listRecords(bridge.reportType);
            const query = offlineRecordsSearch.trim().toLowerCase();
            const filtered = records.filter(function (record) {
                return [record.patientName, record.patientId, record.caseNumber, record.fileName,
                    record.procedureDate].some(function (value) {
                    return String(value || '').toLowerCase().includes(query);
                });
            });
            list.innerHTML = '';
            if (!filtered.length) {
                const empty = document.createElement('div');
                empty.className = 'ent-drafts-empty';
                empty.textContent = query ? 'No records match this search.' : 'No offline records saved yet.';
                list.appendChild(empty);
            } else {
                filtered.forEach(function (record) {
                    const card = document.createElement('article');
                    card.className = 'ent-drafts-card';
                    const details = document.createElement('div');
                    details.className = 'ent-drafts-main';
                    const top = document.createElement('div');
                    top.className = 'ent-drafts-top';
                    const type = document.createElement('span');
                    type.className = 'ent-drafts-badge';
                    type.textContent = TYPE_LABELS[bridge.reportType] || bridge.reportType;
                    const status = document.createElement('span');
                    status.className = 'ent-drafts-state' + (record.syncStatus === 'failed' ? ' is-error' : (record.synced ? ' is-shared' : ''));
                    status.textContent = record.syncStatus === 'failed' ? 'Sync Failed' : (record.synced ? 'Synced' : 'Pending Sync');
                    top.append(type, status);
                    const name = document.createElement('h3');
                    name.className = 'ent-drafts-name';
                    name.textContent = record.patientName || 'Unnamed patient';
                    const meta = document.createElement('div');
                    meta.className = 'ent-drafts-meta';
                    const identifier = record.patientId || record.caseNumber;
                    if (identifier) {
                        const id = document.createElement('span');
                        id.className = 'ent-drafts-id';
                        id.textContent = 'ID ' + identifier;
                        meta.appendChild(id);
                    }
                    const savedAt = document.createElement('span');
                    savedAt.textContent = 'Saved ' + formatTimestamp(record.offlineSavedAt || record.savedAt || record.createdAt);
                    meta.appendChild(savedAt);
                    if (record.photosLocalOnly) {
                        const photoNote = document.createElement('span');
                        photoNote.className = 'ent-drafts-local-photo-note';
                        photoNote.textContent = 'Photos remain on this device · not synced';
                        details.append(top, name, meta, photoNote);
                    } else {
                        details.append(top, name, meta);
                    }
                    const actions = document.createElement('div');
                    actions.className = 'ent-drafts-actions is-compact';
                    [['open', 'Open'], ['delete', 'Delete']].forEach(function (action) {
                        const button = document.createElement('button');
                        button.type = 'button';
                        button.className = action[0] === 'open' ? 'ent-drafts-open' : 'ent-drafts-delete';
                        button.dataset.offlineAction = action[0];
                        button.dataset.recordKey = record.key;
                        button.textContent = action[0] === 'open' ? 'Open' : 'Delete';
                        actions.appendChild(button);
                    });
                    card.append(details, actions);
                    list.appendChild(card);
                });
            }
            summary.textContent = `${filtered.length} shown · ${records.length} ${bridge.reportType} offline record${records.length === 1 ? '' : 's'}`;
        } catch (error) {
            console.error('[EntDrafts] Could not load offline records:', error);
            list.textContent = 'Could not load offline records. Please try again.';
            summary.textContent = '';
        }
    }

    function openOfflineRecordsFallback() {
        const bridge = getBridge();
        if (!bridge || REPORT_TYPES.indexOf(bridge.reportType) === -1) {
            showAlert('Offline records are not available on this page.', 'Offline Records');
            return;
        }
        if (!offlineRecordsModal) {
            offlineRecordsModal = document.createElement('div');
            offlineRecordsModal.className = 'ent-drafts-modal no-print';
            offlineRecordsModal.id = 'offlineRecordsModal';
            offlineRecordsModal.setAttribute('role', 'dialog');
            offlineRecordsModal.setAttribute('aria-modal', 'true');
            offlineRecordsModal.setAttribute('aria-label', bridge.reportType + ' offline records');
            offlineRecordsModal.innerHTML = `
                <div class="ent-drafts-dialog" role="document">
                    <div class="ent-drafts-header">
                        <div class="ent-drafts-heading">
                            <h2>Offline Records</h2>
                            <p class="ent-drafts-subtitle">Only ${escapeHtml(TYPE_LABELS[bridge.reportType] || bridge.reportType)} records saved on this device.</p>
                        </div>
                        <button type="button" class="ent-drafts-close" aria-label="Close Offline Records">&times;</button>
                    </div>
                    <div class="ent-drafts-toolbar">
                        <input type="search" class="ent-drafts-search" placeholder="Search patient name or ID..." aria-label="Search offline records">
                    </div>
                    <div class="ent-drafts-list"></div>
                    <div class="ent-drafts-footer">
                        <span class="ent-drafts-summary"></span>
                    </div>
                </div>`;
            offlineRecordsModal.addEventListener('click', function (event) {
                if (event.target === offlineRecordsModal) closeOfflineRecordsFallback();
            });
            offlineRecordsModal.querySelector('.ent-drafts-close').addEventListener('click', closeOfflineRecordsFallback);
            offlineRecordsModal.querySelector('.ent-drafts-search').addEventListener('input', function (event) {
                offlineRecordsSearch = event.target.value;
                renderOfflineRecordsFallback();
            });
            offlineRecordsModal.querySelector('.ent-drafts-list').addEventListener('click', async function (event) {
                const button = event.target.closest('button[data-offline-action]');
                if (!button) return;
                const store = window.EntOfflineStore;
                const key = button.dataset.recordKey;
                if (button.dataset.offlineAction === 'delete') {
                    if (!window.confirm('Delete this offline record?')) return;
                    if (!store || typeof store.deleteRecord !== 'function' || !(await store.deleteRecord(key))) {
                        showAlert('Could not delete this offline record.', 'Delete Failed');
                        return;
                    }
                    await renderOfflineRecordsFallback();
                    return;
                }
                const record = store && typeof store.getRecord === 'function' ? await store.getRecord(key) : null;
                const currentBridge = getBridge();
                if (!record || !currentBridge) {
                    showAlert('This offline record is no longer available.', 'Offline Record');
                    await renderOfflineRecordsFallback();
                    return;
                }
                try {
                    currentBridge.restore(record.formData || record);
                    if (window.PatientRecords && typeof window.PatientRecords.recordOpen === 'function') {
                        window.PatientRecords.recordOpen(record.reportType, record.formData || record, {
                            format: 'Draft',
                            fileName: record.fileName
                        });
                    }
                    closeOfflineRecordsFallback();
                    await showFeedbackModal({
                        eyebrow: 'READY TO CONTINUE',
                        title: 'Record opened',
                        description: `${record.patientName || 'The saved record'} is now loaded in the form.`,
                        details: [TYPE_LABELS[record.reportType] || record.reportType, 'Continue editing, then save your changes.'],
                        actions: [{ label: 'Continue editing', value: true, primary: true }]
                    });
                } catch (error) {
                    console.error('[EntDrafts] Could not open offline record:', error);
                    showAlert('Could not open this offline record: ' + error.message, 'Open Failed');
                }
            });
            document.addEventListener('keydown', function (event) {
                if (event.key === 'Escape' && offlineRecordsModal.classList.contains('is-open')) {
                    closeOfflineRecordsFallback();
                }
            });
            document.body.appendChild(offlineRecordsModal);
        }
        offlineRecordsSearch = '';
        offlineRecordsModal.querySelector('.ent-drafts-search').value = '';
        offlineRecordsPreviousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        offlineRecordsModal.classList.add('is-open');
        renderOfflineRecordsFallback();
        offlineRecordsModal.querySelector('.ent-drafts-search').focus();
    }

    async function openDraft(draft) {
        const bridge = getBridge();
        if (!bridge) {
            showAlert('This page cannot restore drafts.', 'ERROR');
            return;
        }
        if (!draft.formData) {
            setStatus(draft.authorName
                ? `The form itself was never uploaded with this draft, so there is nothing to open here. Ask ${draft.authorName} to open it and save it again.`
                : 'The form itself was never uploaded with this draft, so there is nothing to open here.', true);
            return;
        }
        if (draft.reportType !== bridge.reportType) {
            // Not a dead end any more. A shared draft is found by its key on
            // whichever page owns that form, so Open walks the doctor or the
            // secretary there and opens it. A draft with no shared copy has
            // nothing to travel with, so that one still needs its own page.
            const page = DRAFT_PAGES[draft.reportType];
            if (page && draft.key) {
                const auth = window.EntAuth;
                const href = (auth && typeof auth.pageUrl === 'function')
                    ? auth.pageUrl(page)
                    : page;
                window.location.href = href + '?' + DEEP_LINK_PARAM + '=' + encodeURIComponent(draft.key);
                return;
            }
            showAlert(
                `This is a ${draft.reportLabel || 'different report'} draft and cannot be opened on this page.\n\n` +
                `Open it from the ${draft.reportLabel || 'matching report'} page to continue editing.`,
                'DIFFERENT REPORT'
            );
            return;
        }
        const confirmed = await showFeedbackModal({
            icon: '\u21bb',
            eyebrow: 'OPEN SAVED WORK',
            title: 'Replace the current form?',
            description: `Open ${draft.patientName || 'this saved draft'} in the form?`,
            details: ['Current entries and attached images will be replaced.', draft.reportLabel || 'Saved draft'],
            tone: 'warning',
            actions: [
                { label: 'Keep current form', value: false },
                { label: 'Open saved draft', value: true, primary: true }
            ]
        });
        if (!confirmed) return;
        try {
            bridge.restore(draft.formData);
            if (window.PatientRecords && typeof window.PatientRecords.recordOpen === 'function') {
                window.PatientRecords.recordOpen(draft.reportType, draft.formData, { format: 'Draft', fileName: draft.fileName });
            }
            closeModal();
            await showFeedbackModal({
                eyebrow: 'READY TO CONTINUE',
                title: 'Draft opened',
                description: `${draft.patientName || 'The saved draft'} is now loaded in the form.`,
                details: [draft.reportLabel || 'Saved draft', 'Continue editing, then save your changes.'],
                actions: [{ label: 'Continue editing', value: true, primary: true }]
            });
        } catch (error) {
            console.error('Could not open local draft:', error);
            setStatus(`Could not open draft: ${error.message}`, true);
            showAlert('COULD NOT OPEN DRAFT\n\n' + error.message, 'ERROR');
        }
    }

    /* Delete a draft.
     *
     * Two copies, two actions, and the order matters:
     *
     *   1. the CLOUD copy is soft-deleted first. 0026 marks the row with
     *      deleted_at rather than erasing it, so an administrator can put it
     *      back - that is the whole reason the delete exists.
     *
     *   2. only then is the DEVICE copy removed, because that one IS
     *      irreversible: localStorage has no recycle bin. If the cloud call
     *      fails we stop there and change nothing locally, so a draft can
     *      never be half-deleted - lost from the shelf but still on the
     *      doctor's other device, or the reverse.
     *
     * The confirmation says so in words. "This cannot be undone" would be a
     * lie about the cloud copy and would train people to click through it.
     */
    async function softDeleteCloudRow(key) {
        const supa = window.EntSupabase;
        const auth = window.EntAuth;
        if (!supa || typeof supa.apiRequest !== 'function') return false;
        const me = auth && typeof auth.currentUser === 'function' ? auth.currentUser() : null;
        if (!me || !me.id) return false;
        if (!navigator.onLine) {
            setStatus('You are offline. Reconnect to delete this draft everywhere.', true);
            return false;
        }
        // The write is an ordinary UPDATE, not a DELETE, and not a special RPC:
        // 0026's reports_update_owner decides who may set deleted_at, and the
        // same policy decides who may clear it again for an administrator.
        const res = await supa.apiRequest(
            'reports?record_key=eq.' + encodeURIComponent(key)
            + '&deleted_at=is.null',
            {
                method: 'PATCH',
                headers: { 'Prefer': 'return=representation' },
                body: JSON.stringify({
                    deleted_at: new Date().toISOString(),
                    deleted_by: me.id,
                    deleted_reason: 'Deleted from My Drafts'
                })
            });
        return Array.isArray(res) && res.length > 0;
    }

    async function deleteDraft(draft) {
        const where = draft.fromCloud === true
            ? 'It is removed from this device. The shared copy in the database is left as it is.'
            : 'It is removed from this device.';
        const confirmed = await showConfirm(
            `Remove the saved draft for "${draft.patientName}"? ${where}`,
            'Remove Draft'
        );
        if (!confirmed) return;
        try {
            // A draft is WORK IN PROGRESS, so removing it is a REMOVE from
            // this device - NOT the database delete. The database delete
            // (soft-delete into the Recycle Bin) belongs to DB RECORDS only,
            // where a finished patient lives and an admin may need to restore
            // a mistaken deletion. A draft has no such standing, and leaning
            // on the DB-records delete policy here is what produced the 403.
            // So: remove the local copy and the in-memory cloud list. A
            // database draft this device does not own is never in readDrafts(),
            // so nothing of anyone else's shelf is touched.
            writeDrafts(readDrafts().filter(item => item.id !== draft.id));
            cloudDrafts = cloudDrafts.filter(function (d) { return d.id !== draft.id; });
            // OFFLINE MODE: the IndexedDB copy (and its pending-sync job) is
            // removed with it, or the sync engine would re-upload a record
            // the doctor just threw away.
            if (window.EntOfflineStore && typeof window.EntOfflineStore.deleteRecord === 'function' && draft.key) {
                window.EntOfflineStore.deleteRecord(draft.key).catch(function (error) {
                    console.warn('[EntDrafts] offline delete failed:', error);
                });
            }
            render();
            setStatus('Draft removed from this device.');
        } catch (error) {
            console.error('Could not remove draft:', error);
            setStatus(`Could not remove: ${error.message}`, true);
        }
    }

    async function deleteAllDrafts() {
        const total = readDrafts().length;
        if (!total) return;
        const confirmed = await showConfirm(
            `Delete ALL ${total} saved draft(s) from this device? This cannot be undone.`,
            'Delete All Drafts'
        );
        if (!confirmed) return;
        try {
            writeDrafts([]);
            // OFFLINE MODE: clearing this device clears the offline database
            // and its pending-sync queue as well.
            if (window.EntOfflineStore && typeof window.EntOfflineStore.clearAll === 'function') {
                window.EntOfflineStore.clearAll().catch(function (error) {
                    console.warn('[EntDrafts] offline clear failed:', error);
                });
            }
            render();
            // Clearing this device is NOT deleting the drafts: the copy in the
            // database survives it, so those rows come straight back into the
            // list. Saying "deleted" would be false, and a nurse who thought
            // she had removed a patient would not look again.
            const kept = allDrafts().length;
            setStatus(kept
                ? `Cleared this device. ${kept} draft(s) kept in your database are still listed - they were never removed.`
                : 'All drafts deleted from this device.');
        } catch (error) {
            console.error('Could not delete drafts:', error);
            setStatus(`Could not delete: ${error.message}`, true);
        }
    }

    // ------------------------------------------------------------------
    // Modal UI
    // ------------------------------------------------------------------
    function setStatus(message, isError) {
        if (!modal || !statusElement) return;
        if (statusTimer) {
            clearTimeout(statusTimer);
            statusTimer = null;
        }
        statusElement.textContent = message || '';
        statusElement.classList.toggle('is-error', Boolean(isError));
        statusElement.hidden = !message;
        if (message) {
            statusTimer = setTimeout(() => {
                statusElement.textContent = '';
                statusElement.hidden = true;
                statusElement.classList.remove('is-error');
                statusTimer = null;
            }, 6000);
        }
    }

    /* ---------------------------------------------------------------------
       THE DATABASE COPY
       ---------------------------------------------------------------------
       The device list alone could only ever answer "what was saved on THIS
       machine", which made a draft disappear the moment the person sat down
       at another computer - or after clearing a browser. These two helpers
       read the auto-shared row back so the list is the same everywhere.

       TWO SELECTS, ONE PER VIEW. The "My Drafts" read keeps its
       `created_by = <me>` filter, which is NOT a security decision - RLS
       already decides who may read which row - and that filter is what
       narrows "every draft I may see" down to "every draft I WROTE".

       The Team Drafts read drops that ONE filter and lets RLS answer
       "whose shelf is this", which is the whole feature: the doctor sees
       his secretaries' unfinished work, the secretary sees her doctor's,
       and a doctor in another clinic is still invisible because
       ent_may_read_own_clinic never widened (0020).

       created_by_name (0028) is the server-stamped author's name. The
       second constant is the fallback for a database without that column:
       identical rows minus the name, and the author is then read from
       payload.sharedBy, which the sharer stamped at save time.
       --------------------------------------------------------------------- */
    const CLOUD_DRAFTS_BASE = 'record_key,report_type,patient_name,patient_id,'
        + 'case_number,procedure_date,file_name,created_by,created_at,updated_at';
    const CLOUD_DRAFTS_SELECT = CLOUD_DRAFTS_BASE + ',created_by_name,payload';
    const CLOUD_DRAFTS_SELECT_NO_NAME = CLOUD_DRAFTS_BASE + ',payload';

    function fromCloudRow(row) {
        const payload = (row && row.payload) || {};
        return {
            // `key` is the merge key on both sides (reports.record_key).
            key: row.record_key || '',
            // Cloud rows are addressed by key, not by the local id, so a card
            // can never be mistaken for a draft this device owns.
            id: 'cloud-' + (row.record_key || ''),
            reportType: payload.reportType || row.report_type || '',
            reportLabel: payload.reportLabel || TYPE_LABELS[row.report_type] || row.report_type || 'Draft',
            patientName: payload.patientName || row.patient_name || '',
            patientId: row.patient_id || '',
            caseNumber: payload.caseNumber || row.case_number || '',
            procedureDate: payload.procedureDate || row.procedure_date || '',
            fileName: payload.fileName || row.file_name || '',
            // Which hospital, carried in the payload by autoShareDraft(). See
            // the note there. An untagged row is UNKNOWN, not a default - see
            // normaliseSite().
            site: normaliseSite(payload.site),
            // Present only for rows shared by a client that uploaded the form
            // (see autoShareDraft). An older row is metadata only, and the card
            // says so rather than offering an Open that would do nothing.
            formData: (payload.formData && typeof payload.formData === 'object') ? payload.formData : null,
            savedAt: row.updated_at || row.created_at || '',
            createdAt: row.created_at || '',
            sharedAt: payload.sharedAt || row.updated_at || '',
            sharedBy: payload.sharedBy || '',
            // WHO WROTE IT. created_by_name (0028) is server-stamped and
            // cannot be forged; payload.sharedBy is the name the sharer put
            // in the payload at save time, and is what a database without
            // 0028 still has. Either way this is display-only. isMine is
            // settled in loadCloudDrafts(), which is the only place that
            // knows who is asking.
            createdBy: row.created_by || '',
            authorName: row.created_by_name || payload.sharedBy || '',
            // WHO LAST TOUCHED IT, and when. Every re-save stamps sharedBy +
            // sharedAt into the payload, so a card can say "Tara drafted this,
            // Jess continued it" - the question a shared draft always raises.
            lastEditedBy: payload.sharedBy || '',
            lastEditedAt: payload.sharedAt || row.updated_at || row.created_at || '',
            isMine: false,
            fromCloud: true,
            // A row can still say is_draft = TRUE after it was saved, if it was
            // written by a client that never cleared the flag. The save marker
            // is the honest answer, so the list filters on this.
            dbSaved: payload.dbSaved === true || String(payload.dbSaved) === 'true',
            imagesStripped: !payload.formData
        };
    }

    async function loadCloudDrafts() {
        const supa = window.EntSupabase;
        const auth = window.EntAuth;
        if (!supa || typeof supa.isConfigured !== 'function' || !supa.isConfigured()) {
            cloudState = '';
            teamState = '';
            return;
        }
        const me = typeof auth === 'object' && auth && typeof auth.currentUser === 'function'
            ? auth.currentUser() : null;
        if (!me || !me.id) { cloudState = ''; teamState = ''; return; }
        if (!navigator.onLine) { cloudState = 'offline'; teamState = 'offline'; return; }
        // One request pair at a time: openModal() can fire twice quickly
        // (button, then the toast), and two overlapping fetches would let
        // the slower one overwrite the newer result.
        if (cloudState === 'loading') return;

        const myId = String(me.id || '').trim();
        const query = (select, mine) => 'reports?select=' + select
            + '&is_draft=eq.true'
            + (mine ? '&created_by=eq.' + encodeURIComponent(myId) : '')
            + '&order=updated_at.desc&limit=100';

        cloudState = 'loading';
        teamState = 'loading';
        try {
            // ---- MINE. The same read as always; a failure keeps its old
            // meaning (this device only, with the reason on screen).
            let mineRows;
            try {
                mineRows = await supa.apiRequest(query(CLOUD_DRAFTS_SELECT, true));
            } catch (noName) {
                mineRows = await supa.apiRequest(query(CLOUD_DRAFTS_SELECT_NO_NAME, true));
            }
            cloudDrafts = (Array.isArray(mineRows) ? mineRows : [])
                .map(function (row) {
                    const d = fromCloudRow(row);
                    d.isMine = String(d.createdBy || '') === myId;
                    return d;
                })
                .filter(function (d) {
                    // A finished record is not a draft, even if an older client
                    // left is_draft = TRUE on the row.
                    return Boolean(d.key) && d.dbSaved !== true && isOpenableDraft(d);
                });
            cloudState = 'ready';
        } catch (error) {
            // Whatever the cause - a lost connection, a policy, a schema the
            // client does not know yet - the LOCAL drafts stay on screen. A
            // bad request must never empty a list somebody was reading.
            cloudState = 'error';
            console.warn('[EntDrafts] Could not read drafts from the database:',
                (error && error.message) || error);
        }
        // ---- TEAM. The SAME shelf without the author filter, so RLS alone
        // decides whose it is. It has its own state on purpose: a failure
        // here must not disturb the list people are reading, and it must
        // be able to say "team drafts need the internet" without lying
        // about your own drafts.
        try {
            let teamRows;
            try {
                teamRows = await supa.apiRequest(query(CLOUD_DRAFTS_SELECT, false));
            } catch (noName) {
                teamRows = await supa.apiRequest(query(CLOUD_DRAFTS_SELECT_NO_NAME, false));
            }
            teamDrafts = (Array.isArray(teamRows) ? teamRows : [])
                .map(function (row) {
                    const d = fromCloudRow(row);
                    d.isMine = String(d.createdBy || '') === myId;
                    return d;
                })
                .filter(function (d) {
                    // The team view is the OTHER half of the shelf: never
                    // my own rows again, never a finished record, and never
                    // a formless row nobody could open.
                    return Boolean(d.key) && d.dbSaved !== true && !d.isMine
                        && isOpenableDraft(d);
                });
            teamState = 'ready';
        } catch (error) {
            teamState = 'error';
            console.warn('[EntDrafts] Could not read your team\'s drafts:',
                (error && error.message) || error);
        }
        if (modal && modal.classList.contains('is-open')) render();
        // A draft handed over from another form page arrives as
        // ?ent_draft=<key>; now that the row can actually be found, open it.
        openDeepLinkedDraft();
    }

    /* Both lists as one, newest first. The LOCAL row wins a collision: it is
       the copy this device owns, it is never older than the share that was
       just sent from here, and it is the one that is guaranteed to hold the
       form contents. */
    function allDrafts() {
        const byKey = new Map();
        cloudDrafts.forEach(function (d) { if (d && d.key) byKey.set(d.key, d); });
        // The LOCAL half is filtered by owner. readDrafts() returns every
        // draft in the shared key, so without this a second account signing in
        // on the same machine would still be SHOWN another doctor's patients -
        // by name, with their dates - even though the sharing guard now stops
        // them being copied to the database. Pushing them was the loud half of
        // the bug; displaying them is the quiet half, and it is the same leak.
        //
        // An unstamped draft is still shown: it predates the stamp, and hiding
        // it would silently lose a real patient's draft from the only place it
        // exists. mayShowDraft() returns true for exactly that case, which is
        // why display and sharing are two separate questions: an unstamped
        // draft stays visible but is no longer pushed.
        //
        // The owner filter and the finalised filter are separate passes on
        // purpose. mayShowDraft answers "is this mine to see"; isFinalised
        // answers "has this already been saved to the database". A draft can
        // fail either, for unrelated reasons, and folding them into one
        // predicate would make it impossible to say which rule hid what.
        readDrafts()
            .filter(mayShowDraft)
            .filter(function (d) { return !isFinalisedDraft(d); })
            .forEach(function (d) { if (d && d.key) byKey.set(d.key, d); });
        return Array.from(byKey.values()).sort(function (a, b) {
            return String(b.savedAt || '').localeCompare(String(a.savedAt || ''));
        });
    }

    /* What the current tab shows. The team tab is the DATABASE half only:
       a draft that lives on this device is always yours, so it can never
       appear as somebody else's work. */
    function draftsForTab() {
        return draftTab === 'team' ? teamDrafts : allDrafts();
    }

    /* A card is looked up by id when it is opened, copied or deleted - and on
       the team tab that card is NOT in the "mine" merge. Both lists, or the
       buttons on a team card would do nothing and say nothing. */
    function findDraft(id) {
        return allDrafts().find(function (d) { return d.id === id; })
            || teamDrafts.find(function (d) { return d.id === id; })
            || null;
    }

    function getFilteredDrafts() {
        const query = searchTerm.trim().toLowerCase();
        return draftsForTab().filter(draft => {
            // The hospital filter. A draft saved before this existed, or by a
            // client that did not tag it, is UNKNOWN - and it is shown under
            // "All" and "Other", never folded into RMCI. Filing an untagged
            // draft under a specific hospital would be a guess presented as a
            // fact, and the whole point of the split is to know which is which.
            if (siteFilter && normaliseSite(draft.site) !== siteFilter) return false;
            if (!query) return true;
            return [draft.patientName, draft.patientId, draft.caseNumber, draft.fileName,
                draft.reportLabel, draft.procedureDate, draft.authorName]
                .some(value => String(value || '').toLowerCase().includes(query));
        });
    }

    /* The hospital chips, and only the ones worth showing.
     *
     * Derived from the drafts actually on screen rather than hardcoded, so a
     * clinic that only ever works at one hospital is not shown an empty chip
     * for the other. "All" appears once there is more than one hospital in
     * play; with a single hospital the filter would be a control with exactly
     * one setting, which is just noise.
     */
    function siteChips(drafts) {
        const counts = new Map();
        drafts.forEach(function (d) {
            const s = normaliseSite(d && d.site);
            counts.set(s, (counts.get(s) || 0) + 1);
        });
        const known = [SITE_REVER, SITE_CAPITOL].filter(function (s) { return counts.get(s); });
        const unknown = counts.get(SITE_UNKNOWN) || 0;
        const chips = [{ value: '', label: 'All', count: drafts.length }];
        known.forEach(function (s) {
            chips.push({ value: s, label: SITE_LABELS[s] || s, count: counts.get(s) });
        });
        if (unknown) {
            chips.push({
                value: SITE_UNKNOWN,
                label: 'Untagged',
                count: unknown,
                title: 'Saved before the hospital tag existed, or from a device '
                    + 'that had no letterhead set. Move these with the button on '
                    + 'the card.'
            });
        }
        // One hospital and nothing untagged: there is nothing to choose.
        return chips.length > 2 ? chips : chips.slice(0, 1);
    }

    function estimateSize(draft) {
        try {
            return JSON.stringify(draft.formData || {}).length;
        } catch (error) {
            return 0;
        }
    }

    // Compact date helpers so the cards stay on one tidy line each.
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function formatDay(value) {
        const raw = String(value || '').trim().slice(0, 10);
        const parts = raw.split('-');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw || 'No date';
        return parts[2] + ' ' + (MONTHS[Number(parts[1]) - 1] || '') + ' ' + parts[0];
    }
    function formatWhen(value) {
        const date = new Date(value);
        if (isNaN(date.getTime())) return 'unknown';
        const hours = date.getHours();
        const minutes = date.getMinutes();
        const ampm = hours < 12 ? 'AM' : 'PM';
        const h12 = hours % 12 === 0 ? 12 : hours % 12;
        return date.getDate() + ' ' + (MONTHS[date.getMonth()] || '') + ', '
            + h12 + ':' + (minutes < 10 ? '0' + minutes : minutes) + ' ' + ampm;
    }

    /* This account's own name, for the "last edited by" test: a chip that said
       "last edited by <my own name>" would be noise, not information. */
    /* What counts as a draft on these screens.
     *
     * The background sync writes is_draft = TRUE rows as well - one per local
     * record, carrying patient metadata and NO form, because patientRecords
     * deliberately keeps only metadata. There is nothing in a row like that to
     * open, edit or continue, so putting it on this screen only ever read as
     * "drafts are broken": the Team tab showed twenty dead cards beside the
     * three real ones, and the card explained nothing.
     *
     * A row has to CARRY A FORM to be a draft here. Your own device-only
     * drafts are unaffected - those come from this device's own copy and are
     * merged in below, form and all. */
    function isOpenableDraft(draft) {
        return Boolean(draft && draft.formData);
    }

    function currentAccountName() {
        try {
            const auth = window.EntAuth;
            const user = auth && typeof auth.currentUser === 'function' ? (auth.currentUser() || {}) : {};
            return String(user.full_name || user.username || '').trim();
        } catch (e) { return ''; }
    }

    function createCard(draft, bridge) {
        const card = document.createElement('article');
        card.className = 'ent-drafts-card';
        const hasData = Boolean(draft.formData);
        const sameType = Boolean(bridge) && draft.reportType === bridge.reportType;
        const identifier = draft.patientId || draft.caseNumber || '';
        const sizeNote = draft.imagesStripped ? ' · photos removed' : '';
        const shared = Boolean(draft.sharedAt);
        const shareBroken = !shared && Boolean(draft.shareError);
        // A row that only exists in the database is not owned by this device,
        // so it gets its own label instead of pretending it was shared a
        // moment ago - and it has no local copy for the bin icon to remove.
        const cloudOnly = draft.fromCloud === true;
        const stateChip = cloudOnly
            ? '<span class="ent-drafts-state is-shared" title="Held in the database rather than on this device, so it opens on every computer you sign in on.">&#9729;&#65039; From your database</span>'
            : (shareBroken
                ? '<span class="ent-drafts-state is-error" title="' + escapeHtml(draft.shareError) + '">&#9888; Not shared</span>'
                : (shared
                    ? '<span class="ent-drafts-state is-shared" title="A confirmed copy was shared with your paired doctor or secretary.">&#9989; Shared</span>'
                    : '<span class="ent-drafts-state" title="This draft is only on this device and has not been confirmed in the cloud.">&#128228; On this device</span>'));
        // A doctor and his/her secretary are one team, so sharing is automatic:
        // there is no Share button on a healthy draft. It only shows when the
        // team copy is missing (failed send, or a draft from before it was
        // automatic), because that is the one case where a retry is useful.
        const shareTitle = shareBroken
            ? escapeHtml(draft.shareError)
            : 'Send this draft to your team now';
        // No Share button on a healthy draft (sharing is automatic), and none
        // at all on somebody else's: re-sending their draft would push THEIR
        // form under MY account's name.
        const shareButton = (shared || draft.isMine === false) ? '' : `
                <button type="button" class="ent-drafts-share${shareBroken ? ' is-error' : ''}" data-draft-action="share" data-draft-id="${escapeHtml(draft.id)}" title="${shareTitle}">&#128260; ${shareBroken ? 'Retry' : 'Send now'}</button>`;
        // WHO WROTE IT - shown only on somebody ELSE's card, because on your own
        // draft it would only repeat your own name back at you.
        const authorChip = (draft.isMine === false)
            ? `<span class="ent-drafts-author" title="Written by another member of your team. You can open it and continue the work; the record is still theirs until it is saved.">&#128100; ${escapeHtml(draft.authorName || 'A team member')}</span>`
            : '';
        /* WHO LAST TOUCHED IT. Every re-save stamps sharedBy + sharedAt, so a
           card can say "Tara drafted this, Jess carried it on" - which is the
           question a shared draft raises the moment two people are in it.
           It appears only when the last editor is somebody OTHER than the
           author and other than me: otherwise it would just repeat a name
           already on the card. */
        const lastEditor = String(draft.lastEditedBy || '').trim();
        const authorName = String(draft.authorName || '').trim();
        const editedBySomebodyElse = Boolean(lastEditor)
            && lastEditor.toLowerCase() !== authorName.toLowerCase()
            && lastEditor.toLowerCase() !== currentAccountName().toLowerCase();
        const editedChip = editedBySomebodyElse
            ? '<span class="ent-drafts-edited" title="Somebody else opened this draft and saved their changes over it.">&#9998; last edited by '
                + escapeHtml(lastEditor)
                + (draft.lastEditedAt ? ' \u00b7 ' + escapeHtml(formatWhen(draft.lastEditedAt)) : '')
                + '</span>'
            : '';
        /* WHICH HOSPITAL. The tag the draft carries, shown as a short code so
         * it fits on the same line as the patient name.
         *
         * It is shown on EVERY card, not only when a filter is on. A doctor
         * with two secretaries at two hospitals needs to know which building a
         * patient is from before she opens the draft, not after noticing the
         * wrong letterhead on the print preview.
         *
         * An untagged draft says so plainly rather than borrowing a colour -
         * "Untagged" with a move button is a question the answer is one click
         * away from, whereas a confident wrong hospital is not recoverable by
         * looking. */
        const site = normaliseSite(draft.site);
        const siteChip = site
            ? `<span class="ent-drafts-site-badge is-${site.toLowerCase()}" title="This patient's visit belongs to ${escapeHtml(site)}.">${escapeHtml(site)}</span>`
            : '<span class="ent-drafts-site-badge is-untagged" title="No hospital recorded. Saved before this was tracked, or from a device with no letterhead set &mdash; choose the right one below.">Untagged</span>';
        /* Move it to the other hospital.
         *
         * Only on cards this account owns, and only when there is somewhere to
         * move it TO. It exists because the tag is a best guess at save time
         * from the device's letterhead setting, and a secretary working across
         * two hospitals will sometimes have it set to the wrong one. A tag that
         * cannot be corrected is worse than no tag at all. */
        const otherSite = site === SITE_REVER ? SITE_CAPITOL
            : (site === SITE_CAPITOL ? SITE_REVER : SITE_REVER);
        const moveButton = (draft.isMine === false) ? '' : `
                <button type="button" class="ent-drafts-site-move" data-draft-action="moveSite" data-draft-id="${escapeHtml(draft.id)}" title="This visit is filed under ${escapeHtml(site || 'no hospital')}. Click to file it under ${escapeHtml(otherSite)} instead.">${escapeHtml(otherSite)} &rarr; move</button>`;
        // Delete stays with the author. 0029 lets a secretary remove a draft
        // SHE wrote, and the row's own doctor may still dispose of anything on
        // his shelf - but the Team view does not OFFER it: one accidental tap
        // here would delete somebody else's unfinished work.
        const deleteButton = (draft.isMine === false) ? '' : `
                <button type="button" class="ent-drafts-delete" data-draft-action="delete" data-draft-id="${escapeHtml(draft.id)}" title="${cloudOnly ? 'Delete this draft. An administrator can restore it.' : 'Delete this draft from this device, and from the shared copy.'}" aria-label="Delete draft">&#128465;</button>`;
        // Where Open will actually take you. Only a shared draft can travel,
        // so the label promises the jump ONLY when the key exists.
        const openLabel = (hasData && !sameType && draft.key && DRAFT_PAGES[draft.reportType])
            ? `&#128194; Open on ${draft.reportLabel || 'that page'}`
            : '&#128194; Open';
        card.innerHTML = `
            <div class="ent-drafts-main">
                <div class="ent-drafts-top">
                    <span class="ent-drafts-badge">${escapeHtml(draft.reportLabel || draft.reportType || 'Draft')}</span>
                    ${siteChip}
                    <span class="ent-drafts-date">&#128197; ${escapeHtml(formatDay(draft.procedureDate))}</span>
                    ${stateChip}
                    ${authorChip}
                    ${editedChip}
                </div>
                <h3 class="ent-drafts-name">${escapeHtml(draft.patientName || 'Unnamed patient')}</h3>
                <div class="ent-drafts-meta">
                    ${identifier ? `<span class="ent-drafts-id">ID ${escapeHtml(identifier)}</span>` : ''}
                    <span>${escapeHtml(formatBytes(estimateSize(draft)) + sizeNote)}</span>
                    <span>Saved ${escapeHtml(formatWhen(draft.savedAt))}</span>
                    ${moveButton}
                </div>
                ${draft.fileName ? `<div class="ent-drafts-file" title="${escapeHtml(draft.fileName)}">&#128196; ${escapeHtml(draft.fileName)}</div>` : ''}
            </div>
            <div class="ent-drafts-actions${shared ? ' is-compact' : ''}">
                <button type="button" class="ent-drafts-open" data-draft-action="open" data-draft-id="${escapeHtml(draft.id)}" title="Load this draft back into the form">${openLabel}</button>
                <button type="button" class="ent-drafts-download" data-draft-action="download" data-draft-id="${escapeHtml(draft.id)}" title="Save a copy of this draft as a readable file on this device (use Open to load it back later)">&#128190; Save copy</button>${shareButton}${deleteButton}
            </div>`;

        const openButton = card.querySelector('.ent-drafts-open');
        if (!hasData) {
            openButton.disabled = true;
            // Say WHAT to do about it. This draft was shared before the form
            // itself travelled with it, so there is nothing here to restore -
            // but the reader is not stuck: the machine that wrote it still
            // has it, and so does its author.
            openButton.title = 'The form itself was never uploaded with this draft'
                + (draft.authorName ? ` - ask ${draft.authorName} to open it and save again` : ' - ask the person who wrote it to save it again')
                + '.';
        } else if (!sameType) {
            if (draft.key && DRAFT_PAGES[draft.reportType]) {
                // Enabled ON PURPOSE. A greyed-out button on a card the reader
                // can plainly see reads as "these drafts cannot be opened" -
                // which is exactly the question the team view raised. It opens
                // on the page that owns this form.
                openButton.title = `Opens on the ${draft.reportLabel || 'matching'} page.`;
            } else {
                openButton.disabled = true;
                openButton.title = `This is a ${draft.reportLabel || 'different report'} draft with no shared copy yet — open it from that page.`;
            }
        }
        const downloadButton = card.querySelector('.ent-drafts-download');
        if (!hasData) {
            downloadButton.disabled = true;
            downloadButton.title = 'This draft has no form data attached.';
        }
        return card;
    }

    // Anything the team has not received yet is retried: a failed send, and also
    // a draft saved before sharing became automatic. This is what keeps the
    // doctor/secretary team in sync without anyone pressing a button.
    let lastShareSweep = 0;
    function retryPendingShares() {
        if (!navigator.onLine) return;
        const now = Date.now();
        if (now - lastShareSweep < 60000) return;
        lastShareSweep = now;
        const pending = readDrafts().filter(function (d) { return !d.sharedAt; });
        // Filter by owner HERE as well as inside autoShareDraft(). This sweep
        // is what turned one doctor's unshared drafts into a brand-new doctor's
        // 29 duplicated patients, because it took every unstamped draft in the
        // shared key and re-posted it under whoever happened to be signed in.
        // Filtering here keeps another account's drafts out of the queue
        // entirely, so they are not merely refused later - they are not even
        // considered this account's work.
        const shareable = pending.filter(mayShareDraft);
        shareable.slice(0, 5).forEach(function (d) { autoShareDraft(d); });
    }

    /* The tab strip is part of the truth of the screen: which view is open
       and how many are waiting behind it. The counts ignore the search box
       on purpose - "3 waiting behind this tab" is more useful than "1
       matching". An en dash instead of 0 when the team read is impossible
       right now, so nobody counts an unread shelf as an empty one. */
    function updateTabs() {
        if (!tabsElement) return;
        if (tabsMineCount) tabsMineCount.textContent = String(allDrafts().length);
        if (tabsTeamCount) {
            tabsTeamCount.textContent = teamState === 'offline' ? '\u2013' : String(teamDrafts.length);
        }
        Array.prototype.forEach.call(tabsElement.querySelectorAll('[data-draft-tab]'), function (btn) {
            const on = btn.getAttribute('data-draft-tab') === draftTab;
            btn.classList.toggle('is-active', on);
            btn.setAttribute('aria-selected', on ? 'true' : 'false');
        });
    }

    function render() {
        if (!modal || !listElement) return;
        retryPendingShares();
        const bridge = getBridge();
        const drafts = getFilteredDrafts();
        // Everything the user can see, plus how much of it THIS device owns -
        // the Clear button only ever empties the local copy, so it must be
        // measured against the local list rather than the merged one.
        const total = draftTab === 'team' ? teamDrafts.length : allDrafts().length;
        const local = readDrafts();
        const where = cloudState === 'ready'
            ? 'this device + your database'
            : (cloudState === 'loading'
                ? 'this device \u00b7 reading your database\u2026'
                : (cloudState === 'error'
                    ? 'this device \u00b7 database copy unavailable'
                    : (cloudState === 'offline'
                        ? 'this device \u00b7 offline'
                        : 'this device')));
        listElement.innerHTML = '';

        // ---- Hospital chips (RMCI / CUMC) --------------------------------
        // Built from the UNFILTERED list for this tab, so the counts on each
        // chip stay true while you are looking at one of them. Filtering the
        // list first and then counting it would make every other chip read 0
        // the moment you picked one.
        const siteBar = modal.querySelector('.ent-drafts-sites');
        if (siteBar) {
            const chips = siteChips(draftsForTab());
            const wanted = chips.length > 1;
            siteBar.hidden = !wanted;
            siteBar.innerHTML = '';
            if (wanted) {
                chips.forEach(function (chip) {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'ent-drafts-site';
                    if (siteFilter === chip.value) btn.classList.add('is-active');
                    btn.textContent = chip.label + ' ' + chip.count;
                    if (chip.title) btn.title = chip.title;
                    else {
                        btn.title = chip.value
                            ? 'Show only ' + chip.label + ' drafts.'
                            : 'Show drafts from every hospital.';
                    }
                    btn.setAttribute('aria-pressed', String(siteFilter === chip.value));
                    btn.addEventListener('click', function () {
                        siteFilter = chip.value;
                        render();
                    });
                    siteBar.appendChild(btn);
                });
            } else if (siteFilter) {
                // The drafts were retagged or deleted while a filter was on, so
                // there is nothing left to choose between. Show everything
                // rather than an empty list with no way back.
                siteFilter = '';
            }
        }

        // The team tab carries its OWN empties. "No drafts yet" would be a
        // lie in three different ways there: there may be plenty, this device
        // may simply be unable to see them without a connection, and the read
        // may have failed. Only a real, complete answer says "none yet".
        if (draftTab === 'team' && !drafts.length) {
            const teamEmpty = document.createElement('div');
            teamEmpty.className = 'ent-drafts-empty';
            teamEmpty.textContent = teamState === 'offline'
                ? 'Team drafts need an internet connection. Your own drafts on this device still open without one.'
                : (teamState === 'error'
                    ? 'Your team\'s drafts could not be read just now. Your own drafts are unaffected.'
                    : (teamState === 'loading'
                        ? 'Reading your team\u2019s drafts\u2026'
                        : 'No drafts from the rest of your team yet. When your secretary saves one it shows up here \u2014 and the other way round.'));
            listElement.appendChild(teamEmpty);
            if (summaryElement) {
                summaryElement.textContent = teamState === 'ready'
                    ? `your team \u00b7 ${teamDrafts.length} unfinished`
                    : 'your team \u00b7 not read yet';
            }
            // "Delete All" empties THIS device's local copies, which have
            // nothing to do with the team shelf. Offering it here would be an
            // invitation to delete the wrong thing.
            const teamClear = modal.querySelector('.ent-drafts-clear');
            if (teamClear) { teamClear.hidden = true; teamClear.disabled = true; }
            updateTabs();
            return;
        }
        if (!drafts.length) {
            const empty = document.createElement('div');
            empty.className = 'ent-drafts-empty';
            // Say WHY the list is empty when the reason is that the work was
            // finished. "No saved drafts yet" after saving six patients to the
            // database reads as data loss, and makes the doctor re-check
            // whether the save worked.
            const finished = countFinalisedDrafts();
            empty.textContent = total
                ? 'No drafts match this search.'
                : (finished
                    ? `No unfinished drafts left. ${finished} on this device ${finished === 1 ? 'has' : 'have'} already been saved to the database - find ${finished === 1 ? 'it' : 'them'} under "DB Records".`
                    : 'No saved drafts yet. Click "Save Draft" (💾) to keep your work on this device.');
            listElement.appendChild(empty);
        } else {
            drafts.forEach(draft => listElement.appendChild(createCard(draft, bridge)));
        }

        if (summaryElement) {
            // The team tab must NOT borrow the device wording ("this device")
            // - it is looking at the clinic's shelf, not at this machine.
            const finished = draftTab === 'mine' ? countFinalisedDrafts() : 0;
            const finishedNote = finished
                ? ` \u00b7 ${finished} saved`
                : '';
            summaryElement.textContent = draftTab === 'team'
                ? (teamState === 'ready'
                    ? `your team \u00b7 ${drafts.length} shown \u00b7 ${teamDrafts.length} unfinished`
                    : 'your team \u00b7 not read yet')
                : `${drafts.length} shown \u00b7 ${total} total${finishedNote} \u00b7 ${where}`;
        }
        // Coming back from the team tab, put "Delete All" back - it only
        // ever emptied this device's local copies, which is what this tab
        // is about.
        const clearButton = modal.querySelector('.ent-drafts-clear');
        if (clearButton) {
            clearButton.hidden = false;
            clearButton.disabled = local.length === 0;
        }
        updateTabs();
    }

    function handleListClick(event) {
        const button = event.target.closest('button[data-draft-action]');
        if (!button || button.disabled) return;
        const draft = findDraft(button.dataset.draftId);
        if (!draft) {
            render();
            setStatus('That draft is no longer available.', true);
            return;
        }
        const action = button.dataset.draftAction;
        if (action === 'open') {
            openDraft(draft);
        } else if (action === 'download') {
            downloadDraft(draft);
        } else if (action === 'share') {
            shareDraft(draft);
        } else if (action === 'delete') {
            deleteDraft(draft);
        } else if (action === 'moveSite') {
            moveDraftToOtherSite(draft);
        }
    }

    /* File a draft under the other hospital.
     *
     * Two writes, in this order, because they can disagree. The local copy is
     * changed FIRST and is the one that decides what the doctor sees, so a
     * failed share degrades to "the badge is right here and the other device
     * will catch up" rather than to a card that claims a hospital the database
     * has never heard of.
     *
     * The share is then re-sent with the new tag. The key does NOT change: the
     * hospital is not part of record_key, so moving a draft must not fork it
     * into a second row that would show up as a second patient. That is also
     * why a mis-tag is fixed by moving the existing draft rather than by
     * saving it again - saving under a new tag would leave the old copy behind.
     */
    function moveDraftToOtherSite(draft) {
        const from = normaliseSite(draft.site);
        const to = from === SITE_REVER ? SITE_CAPITOL
            : (from === SITE_CAPITOL ? SITE_REVER : SITE_REVER);
        const drafts = readDrafts();
        const local = drafts.find(function (d) { return d.id === draft.id; });
        if (local) {
            local.site = to;
            writeDrafts(drafts);
        }
        // The in-memory copy drives the card that is on screen, so it is updated
        // whether or not this device happened to hold the draft.
        draft.site = to;
        // Put it back where it belongs if a filter is hiding the new hospital.
        siteFilter = '';
        render();
        setStatus(`Moved to ${to}.`, false);
        // Now tell the team, best effort. A failure here is not a lost draft:
        // the copy is saved, the tag is right on this device, and the next
        // share retry carries it.
        const shareable = draft.isMine !== false && !draft.fromCloud;
        if (shareable && typeof shareDraft === 'function') {
            shareDraft(draft).catch(function () { /* retried by retryPendingShares */ });
        }
    }

    function handleKeydown(event) {
        if (event.key !== 'Escape' || !modal || !modal.classList.contains('is-open')) return;
        if (confirmBox) return; // let the confirm dialog handle its own keys
        closeModal();
    }

    function buildModal() {
        if (modal) return modal;
        modal = document.createElement('div');
        modal.className = 'ent-drafts-modal no-print';
        modal.id = 'localDraftsModal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-label', 'Saved drafts on this device');
        modal.innerHTML = `
            <div class="ent-drafts-dialog" role="document">
                <div class="ent-drafts-header">
                    <div class="ent-drafts-heading">
                        <h2>🗂️ Saved Drafts</h2>
                        <p class="ent-drafts-subtitle">Drafts are kept on this device. A cloud/team copy is shown only after Supabase confirms it. Use "Open" to continue editing, or "Save copy" to keep a file. <strong>Team Drafts</strong> is the same shelf seen from your side: what your doctor \u2014 or your secretary \u2014 is working on.</p>
                    </div>
                    <button type="button" class="ent-drafts-close" title="Close saved drafts" aria-label="Close saved drafts">&times;</button>
                </div>
                <div class="ent-drafts-toolbar">
                    <input type="search" class="ent-drafts-search" placeholder="Search patient name, ID, report..." aria-label="Search saved drafts">
                </div>
                <!-- Two views of the same shelf, not two lists of things. "My
                     Drafts" is unchanged and still only ever shows what THIS
                     account wrote. "Team Drafts" is the rest of your shelf -
                     a doctor sees what his secretaries are working on, a
                     secretary what her doctor is - and it can never cross a
                     clinic, because RLS still owns that question. -->
                <div class="ent-drafts-tabs" role="tablist" aria-label="Draft view">
                    <button type="button" class="ent-drafts-tab is-active" data-draft-tab="mine" role="tab" aria-selected="true" title="Drafts you wrote, on this device and in your database.">&#128193; My Drafts <span class="ent-drafts-tabcount" data-draft-count="mine"></span></button>
                    <button type="button" class="ent-drafts-tab" data-draft-tab="team" role="tab" aria-selected="false" title="Drafts written by the rest of your team \u2014 your doctor, or your secretary. Your clinic only.">&#128101; Team Drafts <span class="ent-drafts-tabcount" data-draft-count="team"></span></button>
                </div>
                <!-- Hospital filter. Hidden unless there is more than one
                     hospital in play (see siteChips) - a clinic that only works
                     at RMCI is not shown a CUMC button that could only ever be
                     empty. Built by render() so the chips carry live counts. -->
                <div class="ent-drafts-sites" role="group" aria-label="Filter by hospital" hidden></div>
                <div class="ent-drafts-status" hidden></div>
                <div class="ent-drafts-list"></div>
                <div class="ent-drafts-footer">
                    <span class="ent-drafts-summary"></span>
                    <button type="button" class="ent-drafts-clear">🗑 Delete All</button>
                </div>
            </div>`;
        document.body.appendChild(modal);

        listElement = modal.querySelector('.ent-drafts-list');
        statusElement = modal.querySelector('.ent-drafts-status');
        searchElement = modal.querySelector('.ent-drafts-search');
        summaryElement = modal.querySelector('.ent-drafts-summary');

        modal.addEventListener('click', (event) => {
            if (event.target === modal) closeModal();
        });
        modal.querySelector('.ent-drafts-close').addEventListener('click', closeModal);
        modal.querySelector('.ent-drafts-clear').addEventListener('click', deleteAllDrafts);
        searchElement.addEventListener('input', () => {
            searchTerm = searchElement.value;
            render();
        });
        tabsElement = modal.querySelector('.ent-drafts-tabs');
        if (tabsElement) {
            tabsMineCount = tabsElement.querySelector('[data-draft-count="mine"]');
            tabsTeamCount = tabsElement.querySelector('[data-draft-count="team"]');
            tabsElement.addEventListener('click', (event) => {
                const btn = event.target.closest('[data-draft-tab]');
                if (!btn) return;
                const next = btn.getAttribute('data-draft-tab') === 'team' ? 'team' : 'mine';
                if (next === draftTab) return;
                draftTab = next;
                render();
                // Opening the team tab for the first time - or after a read
                // that failed or never ran because the machine was offline -
                // asks again, so nobody has to close and reopen the modal.
                if (draftTab === 'team' && teamState !== 'ready') loadCloudDrafts();
            });
        }
        listElement.addEventListener('click', handleListClick);
        document.addEventListener('keydown', handleKeydown);
        return modal;
    }

    function openModal() {
        buildModal();
        searchTerm = '';
        if (searchElement) searchElement.value = '';
        modal.classList.add('is-open');
        document.body.style.overflow = 'hidden';
        // Show what this device already has immediately - nobody should wait
        // on a request to see their own drafts - then fill in the copy that
        // lives in the database and re-render when it lands.
        render();
        loadCloudDrafts();
    }

    function closeModal() {
        if (!modal) return;
        if (confirmBox && confirmResolver) confirmResolver(false);
        modal.classList.remove('is-open');
        document.body.style.overflow = '';
    }

    // ------------------------------------------------------------------
    // "Draft saved" confirmation popup (toast)
    // ------------------------------------------------------------------
    let toastElement = null;
    let toastTimer = null;
    let toastDraftId = null;

    function buildToast() {
        if (toastElement && document.body.contains(toastElement)) return toastElement;
        toastElement = document.createElement('div');
        toastElement.id = 'entDraftsToast';
        toastElement.className = 'ent-saved-toast';
        toastElement.setAttribute('role', 'status');
        toastElement.setAttribute('aria-live', 'polite');
        toastElement.innerHTML = `
            <span class="ent-saved-toast-mark" aria-hidden="true">&#10003;</span>
            <div class="ent-saved-toast-body">
                <strong class="ent-saved-toast-title">Draft saved on this device</strong>
                <span class="ent-saved-toast-detail"></span>
            </div>
            <div class="ent-saved-toast-actions">
                <button type="button" class="ent-saved-toast-btn is-primary" data-toast-action="view" title="Open this draft in the form right now">Open it</button>
                <button type="button" class="ent-saved-toast-btn" data-toast-action="drafts" title="See every draft stored on this device">All drafts</button>
                <button type="button" class="ent-saved-toast-btn" data-toast-action="json" title="Download this draft as a .json backup">.json</button>
                <button type="button" class="ent-saved-toast-btn is-quiet" data-toast-action="close" title="Keep working" aria-label="Keep working">&times;</button>
            </div>`;
        toastElement.addEventListener('click', (event) => {
            const button = event.target.closest('[data-toast-action]');
            if (!button) return;
            const action = button.getAttribute('data-toast-action');
            const draft = readDrafts().find(item => item.id === toastDraftId) || null;
            if (action === 'close') {
                hideToast();
            } else if (action === 'drafts') {
                hideToast();
                openModal();
            } else if (action === 'json') {
                if (draft) downloadDraft(draft);
            } else if (action === 'view') {
                hideToast();
                if (draft) openDraft(draft);
            }
        });
        document.body.appendChild(toastElement);
        return toastElement;
    }

    function hideToast() {
        if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
        if (toastElement) toastElement.classList.remove('is-visible');
    }

    function showSavedToast(draft, offlineResult) {
        if (!draft) return;
        const toast = buildToast();
        toastDraftId = draft.id || null;
        const title = toast.querySelector('.ent-saved-toast-title');
        const detail = toast.querySelector('.ent-saved-toast-detail');
        const when = new Date(draft.savedAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const who = `${draft.patientName || 'Untitled patient'} · ${draft.reportLabel || 'Draft'} · ${when}`;
        // OFFLINE MODE: distinguish a locally persisted save from a confirmed
        // cloud save; connectivity returning does not guarantee synchronization.
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        if (offline) {
            toast.classList.add('is-offline');
            const queued = !!(offlineResult && offlineResult.queued);
            if (title) title.textContent = queued
                ? '\uD83D\uDCE5 Saved Locally · Pending Sync'
                : '\uD83D\uDCE5 Saved Locally · Sync Failed';
            if (detail) detail.textContent = queued
                ? `${who} · Supabase sync will be confirmed only after the server accepts it`
                : `${who} · sync queue unavailable; this report is not confirmed in Supabase`;
        } else {
            toast.classList.remove('is-offline');
            if (title) title.textContent = 'Draft saved on this device';
            if (detail) detail.textContent = `${who} · cloud sharing is confirmed separately`;
        }
        toast.classList.add('is-visible');
        if (toastTimer) clearTimeout(toastTimer);
        // The offline wording is the one that has to be believed before the
        // doctor keeps working with no signal, so it stays up a bit longer.
        toastTimer = setTimeout(() => {
            toast.classList.remove('is-visible');
            toastTimer = null;
        }, offline ? 16000 : 12000);
    }

    // Confirm the local save and queue state without claiming a cloud save.
    function showSaveFeedbackModal(draft, queued) {
        const online = typeof navigator === 'undefined' || navigator.onLine !== false;
        const savedAt = new Date(draft.savedAt || Date.now()).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });
        const status = queued
            ? (online ? 'Sync will continue automatically while online.' : 'Pending sync. It will upload when you reconnect and sign in online.')
            : 'The local copy is safe, but the sync queue could not be created.';
        showFeedbackModal({
            variant: 'save',
            icon: queued ? '\u2713' : '!',
            eyebrow: queued ? 'SAVED ON THIS DEVICE' : 'SAVED LOCALLY',
            title: queued ? 'Saved to Offline Mode' : 'Saved, but sync needs attention',
            description: `${draft.patientName || 'This report'} is saved on this device.`,
            details: [draft.reportLabel || 'Patient report', `Saved at ${savedAt}`, status],
            tone: queued ? 'success' : 'warning',
            actions: [
                { label: 'Offline Records', value: 'offline-records' },
                { label: 'My Drafts', value: 'my-drafts' },
                { label: 'Continue editing', value: 'continue', primary: true }
            ]
        }).then(function (action) {
            if (action === 'offline-records') {
                if (window.EntOfflineViewer) window.EntOfflineViewer.open();
                else openOfflineRecordsFallback();
            } else if (action === 'my-drafts') {
                openModal();
            }
        });
    }

    // Brief "✓ Saved" pulse on the Save Draft button itself.
    function flashSaveButton() {
        const button = document.getElementById('saveDataBtn');
        if (!button) return;
        button.classList.remove('is-saved');
        void button.offsetWidth;            // restart the animation
        button.classList.add('is-saved');
        setTimeout(() => button.classList.remove('is-saved'), 2400);
    }

    // Save the draft on this device, then confirm it with a small popup.
    // A refused save (no patient name) gets NONE of that: no "Saved" pulse
    // and no confirmation toast, because nothing was saved.
    // OFFLINE MODE: when the hospital feature is on (Dr. Jardin's clinic),
    // asks which hospital (RMCI / CUMC) the patient was seen at BEFORE saving,
    // so the offline record is tagged with the right hospital from the start.
    async function saveAndOpen(reportType, formData, fileName) {
        let siteOverride;
        // OFFLINE MODE: hospital site selection before saving. Mirrors the
        // online saveToDatabase() flow (resolveHospitalFeature + askSaveSite)
        // so an offline save carries the same payload.site tag and files under
        // the right tab in DB Records when it syncs.
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            const EntDbRecords = window.EntDbRecords;
            if (EntDbRecords && typeof EntDbRecords.resolveHospitalFeature === 'function' &&
                await EntDbRecords.resolveHospitalFeature()) {
                if (typeof EntDbRecords.askSaveSite === 'function') {
                    siteOverride = await EntDbRecords.askSaveSite({ move: false });
                    if (!siteOverride) return null; // cancelled - nothing saved
                }
            }
        }
        const draft = saveDraft(reportType, formData, fileName, siteOverride);
        if (!draft) return null;
        const offlineResult = await draft.offlinePersistPromise;
        if (!offlineResult || !offlineResult.saved) {
            await showFeedbackModal({
                icon: '!',
                eyebrow: 'SAVE NOT CONFIRMED',
                title: 'Could not save offline',
                description: 'Keep this page open and retry before leaving.',
                details: [(offlineResult && offlineResult.error) || 'Offline storage did not confirm this save.'],
                tone: 'warning',
                actions: [{ label: 'Continue editing', value: true, primary: true }]
            });
            setStatus('Offline save failed. Keep this page open and retry.', true);
            return null;
        }
        document.dispatchEvent(new Event('formDataSaved'));
        flashSaveButton();
        showSaveFeedbackModal(draft, offlineResult.queued);
        return draft;
    }


    // ------------------------------------------------------------------
    // Button wiring
    // ------------------------------------------------------------------
    function bindButtons() {
        const browseButton = document.getElementById('localDraftsBtn');
        if (browseButton && browseButton.dataset.draftsBound !== 'true') {
            browseButton.dataset.draftsBound = 'true';
            // OFFLINE MODE: on the nasal / laryngeal pages, index.js's
            // IndexedDB offline viewer (EntOfflineViewer) also binds this
            // button. It loads AFTER this script, so a bind-time check of
            // its offlineBound flag can never see it - the old check here
            // bound anyway and BOTH modals opened on one click. The
            // ownership decision therefore happens at CLICK time: when the
            // offline viewer owns the button, stay out of its way. CF4 uses
            // this fallback viewer because it does not load index.js.
            browseButton.addEventListener('click', () => {
                if (browseButton.dataset.offlineBound) return;
                openOfflineRecordsFallback();
            });
        }
        // Handed over from another form page (?ent_draft=<key>): read the
        // shelf even though nobody pressed the button, or the draft could
        // never be found and the link would look like a dead end.
        if (deepLinkedKey()) loadCloudDrafts();
    }

    window.EntDrafts = {
        saveDraft,
        saveOfflineDraft,
        saveAndOpen,
        openModal,
        openOfflineRecords: openOfflineRecordsFallback,
        showSavedToast,
        showFeedbackModal,
        readDrafts,
        downloadDraft,
        shareDraft,
        autoShareDraft,
        trimOldPhotos,
        MAX_DRAFTS_WITH_PHOTOS
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindButtons, { once: true });
    } else {
        bindButtons();
    }

})(window);
