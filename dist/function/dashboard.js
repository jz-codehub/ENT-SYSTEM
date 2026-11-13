/* =====================================================================
   DOCTOR / SECRETARY DASHBOARD  (index.html)
   ---------------------------------------------------------------------
   - Quick actions: start a Nasal / Laryngeal endoscopy report or a CF4
     form in one tap - always available, online or offline.
   - Counters: how many PATIENTS this account handled today / this week /
     this month / this year. One patient is counted once, no matter how
     many reports were made.
   - Doctors also see which secretaries are linked to their account.
   - Counting is scoped exactly like function/dbRecords.js:
       doctor    -> rows whose doctor_id is his/her own id
       secretary -> selected assigned doctor, or all assigned doctors in the dashboard's all-doctors view
       admin     -> whole clinic (admins normally live in admin.html)
   - Cloud first (patient_records). If the cloud cannot be reached the
     counters fall back to this device's local record history so the
     numbers never silently read zero.
   Depends on: supabaseClient.js, auth.js, patientRecords.js, syncEngine.js
   ===================================================================== */
(function (window) {
    'use strict';

    const Auth = window.EntAuth;
    if (!Auth) {
        document.body.insertAdjacentHTML('afterbegin',
            '<p style="padding:20px;color:#e74c3c;">auth.js failed to load \u2014 the dashboard cannot run.</p>');
        return;
    }

    const ADMIN_PREVIEW_KEY = 'entDashAdminPreview';
    const LOOKBACK_DAYS = 365;      // how far back the counters look
    const ROW_LIMIT = 3000;         // bounded rows for recent/detail panels
    const EXPORT_PAGE_SIZE = 250;
    const MAX_MONTHLY_EXPORT_ROWS = 50000;
    const MAX_MONTHLY_EXPORT_BYTES = 150 * 1024 * 1024;
    const MONTHLY_EXPORT_STORAGE_KEY = 'entMonthlyRecordsExportV1';
    const CHART_DAYS = 7;
    const RECENT_PAGE_SIZE_DEFAULT = 10;
    const RECENT_PAGE_SIZES = [10, 50, 100];
    // FREE-PLAN DISCIPLINE. Every refresh pulls the whole in-scope row window
    // from Postgres, which is EGRESS against the 5 GB/month cap - and an open
    // browser tab is a tab that keeps polling. These were 60s/45s; tripled to
    // 180s/120s on purpose. Nothing on screen is a live feed (the counters,
    // charts and follow-ups are all "as of the last load"), so a three-minute
    // cadence is invisible to the user but cuts the dashboard's share of the
    // clinic's egress by two thirds. The manual Refresh button is always there
    // for the "I just saved something, show me now" moment. See also the admin
    // console's ANALYTICS_REFRESH_MS, tuned the same way.
    const REFRESH_MS = 180000;      // background auto-refresh (3 min)
    const STALE_MS = 120000;        // refresh at once when the tab comes back
    const SYNC_WAIT_MS = 7000;      // max wait for the pending-upload push

    /* Every page except index.html moved into pages/. These names are used
     * as hrefs, so they are resolved through EntPaths rather than written
     * as bare filenames - a bare "admin.html" only resolves from a page
     * that happens to sit next to it. The dashboard only ever runs on the
     * root index.html, but going through the same helper as the rest of the
     * app means this file cannot be the thing that breaks if that changes. */
    const pageUrl = (typeof Auth.pageUrl === 'function')
        ? Auth.pageUrl
        : (window.EntPaths && typeof window.EntPaths.page === 'function'
            ? window.EntPaths.page
            : function (name) { return name; });

    const TYPES = {
        nasal: { label: 'Nasal Endoscopy', short: 'Nasal', page: pageUrl('nasalEndoscopy.html'), icon: '\uD83D\uDD2C' },
        laryngeal: { label: 'Laryngeal Endoscopy', short: 'Laryngeal', page: pageUrl('laryngealEndoscopy.html'), icon: '\uD83D\uDD0D' },
        cf4: { label: 'CF4 Claim Form', short: 'CF4', page: pageUrl('cf4Form.html'), icon: '\uD83D\uDCCB' },
        abstract: { label: 'Clinical Abstract', short: 'Abstract', page: pageUrl('abstract.html'), icon: '\uD83D\uDCC4' },
        medicalCertificate: {
            label: 'Medical Certificate',
            short: 'Medical Certificate',
            page: pageUrl('medicalCertificate.html'),
            icon: '\uD83D\uDCC4'
        }
    };
    const TYPE_ORDER = ['nasal', 'laryngeal', 'cf4', 'abstract', 'medicalCertificate'];
    let medicalDocumentsAvailable = false;

    async function canUseMedicalDocuments(user) {
        if (user && user.role === 'secretary' && user.is_super_secretary === true) return true;
        const clinicId = String(user && user.clinic_id || '').trim();
        const username = String(user.username || '').trim().toLowerCase();
        const fullName = String(user.full_name || '').trim().toLowerCase();
        const assignedDoctor = String(user.assigned_doctor_name || '').trim().toLowerCase();
        if (clinicId.toLowerCase() === '00000000-0000-4000-8000-00000000c11c' ||
            username === 'jess' ||
            /jess|jesus/i.test(fullName) ||
            /jess|jesus/i.test(assignedDoctor)) {
            return true;
        }
        if (user.role === 'secretary' && typeof Auth.fetchAssignedDoctors === 'function') {
            const doctors = await Auth.fetchAssignedDoctors(true);
            if (doctors.some(function (doctor) {
                return /jess|jesus/i.test(String(doctor.doctor_name || '')) ||
                    /jess|jesus/i.test(String(doctor.clinic_name || ''));
            })) {
                return true;
            }
        }
        if (user.role === 'secretary' && !/jess|jesus/i.test(assignedDoctor)) {
            try {
                const doctorName = await api('rpc/my_assigned_doctor_name', {
                    method: 'POST',
                    body: '{}'
                });
                if (typeof doctorName === 'string' && /jess|jesus/i.test(doctorName)) return true;
            } catch (error) {
                console.warn('[Dashboard] Could not verify the secretary assigned doctor:', error);
            }
        }
        if (!clinicId) return false;
        const clinics = await api('clinics?select=id,code,name&id=eq.' + encodeURIComponent(clinicId));
        const clinic = Array.isArray(clinics)
            ? clinics.find(function (row) { return String(row.id || '') === clinicId; })
            : null;
        return !!clinic && (
            String(clinic.code || '').toLowerCase() === 'main_clinic' ||
            String(clinic.code || '').toLowerCase() === 'jess' ||
            /^ent clinic doc jess$/i.test(String(clinic.name || '').trim()) ||
            String(clinic.name || '').trim().toLowerCase() === 'doc jess'
        );
    }
// Weekday names for the chart column labels - every activity chart (the
// month grid and the three split charts) prints a three-letter day under
// each bar, or "Today" on today's column.
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    // Full month names for the Activity Growth period dropdown - "October"
    // reads as a month at a glance; the old "10" did not.
    const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];

    let me = null;               // signed-in user
    let scopeInfo = null;        // EntAuth.scope()
    let assignedDoctorRows = [];
    let myName = '';             // lowercased username, for "made by me"
    let growthPeriod = null;     // Activity Growth month the user picked
                                 // ({ y: '2026', m: '10' }); survives the
                                 // 60s refresh, which would otherwise snap
                                 // the dropdown back to the live month.
    let rows = [];               // normalised record rows (newest first)
    let cloudSummary = null;      // exact, small aggregate returned by migration 0048
    let summaryError = '';
    let activitySummaryError = '';
    let activitySummaryRequestId = 0;
    let reportMixPeriod = 'month';
    let reportMixRequestId = 0;
    let reportMixSummaryError = '';
    let reportMixSummaryCache = Object.create(null);
    let dashboardData = null;
    let monthlyExportBusy = false;
    let notificationCenterWired = false;
    let notificationPanelOpen = false;
    let recentPage = 0;
    let recentPageSize = RECENT_PAGE_SIZE_DEFAULT;
    let offlineStats = null;
    let outOfScope = 0;         // rows the server returned that are NOT this
                                 // account's shelf. Should always be 0; when it
                                 // is not, the hint says so instead of the
                                 // numbers quietly looking plausible.
    let source = 'loading';      // 'cloud' | 'device' | 'none'
    let loadError = '';
    let lastLoadedAt = 0;
    let busy = false;
    // The doctor's own secretaries, for the "Your secretaries" card.
    // null = no answer from the cloud yet; [] = a real answer of "none".
    // In memory only, never localStorage: auth.js deliberately stopped
    // caching the account table in the browser (a cached ROLE is the
    // stale-claim problem PRIV-04 tests), and this list must not become
    // a second copy of it.
    let teamRows = null;
    let teamError = '';
    let teamBusy = false;

    /* -------------------------------- utils ------------------------- */
    function byId(id) { return document.getElementById(id); }
    function esc(value) { return Auth.escapeHtml(value); }
    function api(endpoint, options) { return window.EntSupabase.apiRequest(endpoint, options); }

    // Clinic names (admin view): resolved once per browser session and cached so
    // the per-clinic latest-patients card never re-fetches. `clinics` is a real
    // DB table and an active admin may read every row, so this is the single
    // source of truth; if a clinic has no name yet, fall back to its id label.
    let clinicNameMap = {};
    async function loadClinicNames() {
        if (Object.keys(clinicNameMap).length) return clinicNameMap;
        try {
            const rows = await api('clinics?select=id,name,code,is_active&order=name');
            const map = {};
            (Array.isArray(rows) ? rows : []).forEach(function (r) {
                if (!r || !r.id) return;
                const id = String(r.id).trim();
                map[id] = {
                    name: (r.name || '').trim(),
                    code: (r.code || '').trim(),
                    active: r.is_active !== false,
                    raw: r
                };
            });
            clinicNameMap = map;
        } catch (e) {
            // A clinic directory that cannot be read must never break the card.
            clinicNameMap = {};
        }
        return clinicNameMap;
    }
    function clinicName(id) {
        const map = clinicNameMap;
        const key = String(id || '');
        const name = map[key] && map[key].name;
        if (name) return name;
        const code = map[key] && map[key].code;
        const label = code || key.slice(0, 8);
        // An empty id reaches here only for device-fallback rows with no
        // clinic stamped: "Clinic" alone is the honest head for those.
        return label ? 'Clinic ' + label : 'Clinic';
    }
    function isAdminView() {
        return !!(me && (me.role === 'admin' || (scopeInfo && scopeInfo.seeAll)));
    }

    /* WHICH HOSPITAL a record belongs to: RMCI (Rever) or CUMC (Capitol).
     * The tag lives in payload.site, written by DB Records and the drafts
     * browser from the device's letterhead - it says WHERE the patient was
     * actually seen, which is a different fact from the clinic the row is
     * counted under. PostgREST names a JSON-extracted field after its LAST
     * key, so select=payload->>site arrives on the row as `site`. */
    const SITE_NAMES = {
        RMCI: 'Rever Medical Center Inc.',
        CUMC: 'Capitol University Medical Center'
    };
    function siteOf(row) {
        if (!row) return '';
        const raw = String(
            row.site !== undefined ? row.site
                : row['payload->>site'] !== undefined ? row['payload->>site']
                    : (row.payload && typeof row.payload === 'object') ? row.payload.site
                        : ''
        ).trim().toUpperCase();
        return SITE_NAMES[raw] ? raw : '';
    }

    /* FOLLOW-UP DATE — "come back and see me on this day" (ENT work is
     * follow-up heavy: a scope today, a re-scope in two weeks). It rides on
     * the payload exactly like `site`, so it needs NO migration and no new
     * column: `payload->>followUpDate` is a plain YYYY-MM-DD string. It is
     * deliberately NOT the visit date - it is a future promise about when the
     * patient should return, and a record saved without one simply has none.
     *
     * Every reader below is defensive: a bad or absent date reads as "no
     * follow-up" and draws nothing, so one malformed payload can never break
     * the dashboard. */
    const FOLLOW_UP_KEY = 'followUpDate';
    function followUpOf(row) {
        if (!row) return '';
        const raw = String(
            row.followUpDate !== undefined ? row.followUpDate
                : row['payload->>' + FOLLOW_UP_KEY] !== undefined ? row['payload->>' + FOLLOW_UP_KEY]
                    : (row.payload && typeof row.payload === 'object') ? row.payload[FOLLOW_UP_KEY]
                        : ''
        ).trim();
        return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
    }
    // Whole days from today to the follow-up, local midnight to local
    // midnight (so "today" is 0 regardless of the hour). Negative = overdue.
    // The small chip drawn beside a record. Nothing is drawn when the record
    // has no hospital tag (saved before this was tracked, or from a device
    // with no letterhead) - a chip that says nothing is worse than none.
    function siteBadge(row) {
        const site = siteOf(row);
        if (!site) return '';
        return '<span class="ent-site-chip is-' + site.toLowerCase()
            + '" title="' + esc(SITE_NAMES[site]) + '">' + site + '</span>';
    }

    let staffProfileMap = null;
    async function loadStaffProfiles() {
        if (staffProfileMap !== null) return staffProfileMap;
        try {
            const rows = await api('staff_profiles?select=id,role,username,full_name');
            const map = {};
            (Array.isArray(rows) ? rows : []).forEach(function (r) {
                if (!r || !r.id) return;
                const id = String(r.id).trim();
                map[id] = {
                    role: String((r.role || '').trim().toLowerCase()),
                    full_name: String((r.full_name || '').trim()),
                    username: String((r.username || '').trim())
                };
            });
            staffProfileMap = map;
        } catch (e) {
            staffProfileMap = {};
        }
        return staffProfileMap;
    }

    /* The per-clinic card needs two directories the browser only ever reads
     * in the admin view: clinic names (so the head says "ENT Clinic Doc Jess"
     * instead of a uuid) and staff profiles (so the author can be labelled
     * Doctor or Secretary). Both loaders memoise themselves, so this costs
     * one extra request pair per session - and because renderAll() has almost
     * certainly already drawn by the time they land, the card is redrawn. */
    let directoryTriedAt = 0;
    function loadDirectory() {
        if (!isAdminView()) return;
        const now = Date.now();
        if (directoryTriedAt && now - directoryTriedAt < 60000) return;
        directoryTriedAt = now;
        Promise.all([loadClinicNames(), loadStaffProfiles()]).then(function () {
            renderRecent();                 // redraw with the real names
        }, function () {
            // A denied read (RLS) simply keeps the readable fallback: the
            // loaders already swallow their own errors, so this arm exists
            // only so a rejection can never surface as an unhandled one.
        });
    }

    function pad(n) { return n < 10 ? '0' + n : '' + n; }

    function startOfDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
    function addDays(date, n) { const d = new Date(date.getTime()); d.setDate(d.getDate() + n); return d; }
    function weekStart(date) {                     // Monday-based, like admin.js
        const d = startOfDay(date);
        return addDays(d, -(((d.getDay() + 6) % 7)));
    }
    function monthStart(date) { return new Date(date.getFullYear(), date.getMonth(), 1); }
    function reportMixRange(period, now) {
        const today = startOfDay(now);
        const end = addDays(today, 1);
        if (period === '7days') {
            return {
                key: 'week',
                start: startOfDay(addDays(today, -6)),
                end: end,
                label: 'Last 7 days'
            };
        }
        if (period === 'year') {
            return {
                key: 'year',
                start: new Date(now.getFullYear(), 0, 1),
                end: end,
                label: 'This year'
            };
        }
        return {
            key: 'month',
            start: monthStart(now),
            end: end,
            label: 'This month'
        };
    }
    function dayKeyOf(date) {
        return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
    }
    function dayLabel(key) {
        const p = String(key).split('-');
        const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
        return isNaN(d.getTime()) ? key
            : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    }
    function fmtTime(iso) {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '\u2014';
        return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }
    function relTime(ms) {
        if (!ms) return 'never';
        const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
        if (secs < 60) return 'just now';
        if (secs < 3600) return Math.round(secs / 60) + ' min ago';
        if (secs < 86400) return Math.round(secs / 3600) + ' h ago';
        return Math.round(secs / 86400) + ' d ago';
    }
    // Time-of-day hello with a mood emoji, so the hero feels alive.
    function greetingFor(date) {
        const h = date.getHours();
        if (h < 5) return { text: 'Good night', emoji: '\uD83C\uDF19' };
        if (h < 12) return { text: 'Good morning', emoji: '\u2600\uFE0F' };
        if (h < 17) return { text: 'Good afternoon', emoji: '\uD83C\uDF24\uFE0F' };
        if (h < 21) return { text: 'Good evening', emoji: '\uD83C\uDF06' };
        return { text: 'Good night', emoji: '\uD83C\uDF19' };
    }

    // The cheerful second line: time of day + what has been done today.
    function moodLine(date, bucket) {
        const h = date.getHours();
        const reports = (bucket && bucket.reports) || 0;
        const people = (bucket && bucket.patientCount) || 0;
        const tally = reports
            ? reports + (reports === 1 ? ' report' : ' reports') + ' from '
                + people + (people === 1 ? ' patient' : ' patients') + ' today'
            : 'no reports logged yet today';
        const cap = function (t) { return t.charAt(0).toUpperCase() + t.slice(1); };
        if (h < 5) return '\uD83D\uDECC It\u2019s ' + (h < 10 ? '0' : '') + h
            + ':00 already \u2014 ' + tally + '. Please rest soon.';
        if (h < 9) return '\uD83C\uDF05 Early bird! A fresh start \u2014 ' + tally + '.';
        if (h < 12) return '\u2600\uFE0F Great start! ' + cap(tally) + '.';
        if (h < 14) return '\uD83C\uDF72 Lunch break? ' + cap(tally) + '.';
        if (h < 17) return '\uD83D\uDCAA Keep it going! ' + cap(tally) + '.';
        if (h < 21) return '\uD83C\uDF06 Almost done for today \u2014 ' + tally + '. Nice work!';
        return '\uD83C\uDF19 Evening shift \u2014 ' + tally + '. Don\u2019t forget to sign out.';
    }

    /* -------------------------- row helpers -------------------------- */
    // Names in the database may be typed in any case ("joy pineda"), so every
    // name the user reads is tidied up first: first letter always capitalised.
    const SMALL_WORDS = {
        de: 1, del: 1, la: 1, van: 1, von: 1, bin: 1, san: 1,
        y: 1, ng: 1, of: 1, and: 1, the: 1
    };
    function prettyName(name) {
        return String(name || '').trim().split(/\s+/).filter(Boolean).map(function (word, i) {
            const low = word.toLowerCase();
            if (i > 0 && SMALL_WORDS[low]) return low;      // "de la Cruz" stays tidy
            return low.charAt(0).toUpperCase() + low.slice(1);
        }).join(' ');
    }
    // Doctors are greeted as "Doc Ben" - the formal "Dr." is dropped.
    const HONORIFIC = /^(dr|doc|mr|mrs|ms|md|prof|atty)\.?\s+/i;
    function greetingName(user) {
        const u = user || {};
        const full = prettyName(u.full_name || u.username || 'there');
        const bits = full.replace(HONORIFIC, '').split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
        if (u.role === 'doctor') return 'Doc ' + (bits || full || 'there');
        return bits || full || 'there';
    }
    // One "patient" = the same person saved on the same day. The dashboard
    // counts DATABASE SAVES (created_at), so every finished record saved
    // this month shows up this month - including backfilled Sept/Aug visits
    // that were only typed in October.
    function encounterDay(row) {
        const created = String((row && (row.created_at || row.updated_at)) || '').trim().slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(created)) return created;
        const explicit = String((row && row.procedure_date) || '').trim().slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
        return 'nodate';
    }
    function identityOf(row) {
        const pid = String(row.patient_id || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const name = String(row.patient_name || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const file = String(row.file_name || '').trim().toLowerCase();
        let who;
        if (pid) who = 'id:' + pid;
        else if (name) who = 'nm:' + name;
        else if (file) who = 'fl:' + file;
        else who = 'row:' + String(row.created_at || '');
        return who + '|d:' + encounterDay(row);
    }
    function displayNameOf(row) {
        return prettyName(row.patient_name)
            || String(row.file_name || '').trim()
            || 'Untitled record';
    }
    function typeKey(row) { return TYPES[row.report_type] ? row.report_type : 'other'; }

    function emptyBucket() {
        return {
            seen: Object.create(null),
            seenEndo: Object.create(null),
            seenCf4: Object.create(null),
            patientCount: 0,
            endoCount: 0,
            cf4Count: 0,
            reports: 0,
            mine: 0,
            types: { nasal: 0, laryngeal: 0, cf4: 0, other: 0 }
        };
    }
    // Endoscopy = the two scope procedures (same family). CF4 is a claim
    // form, counted on its own so backfilled claims never read as scopes.
    function groupOf(row) {
        const t = typeKey(row);
        if (t === 'cf4') return 'cf4';
        if (t === 'nasal' || t === 'laryngeal') return 'endo';
        return 'other';
    }
    function addToBucket(bucket, row) {
        bucket.reports += 1;
        const id = identityOf(row);
        if (!bucket.seen[id]) { bucket.seen[id] = 1; bucket.patientCount += 1; }
        const g = groupOf(row);
        if (g === 'endo' && !bucket.seenEndo[id]) { bucket.seenEndo[id] = 1; bucket.endoCount += 1; }
        if (g === 'cf4' && !bucket.seenCf4[id]) { bucket.seenCf4[id] = 1; bucket.cf4Count += 1; }
        const t = typeKey(row);
        bucket.types[t] = (bucket.types[t] || 0) + 1;
        if (myName && String(row.created_by || '').trim().toLowerCase() === myName) bucket.mine += 1;
    }
    // One bucket per day per group: the same rows, filtered to endo or cf4.
    function seriesFor(group) {
        const now = new Date();
        const list = [];
        for (let i = CHART_DAYS - 1; i >= 0; i--) {
            const day = addDays(startOfDay(now), -i);
            const from = day.getTime();
            const bucket = emptyBucket();
            for (let k = 0; k < rows.length; k++) {
                const ts = rows[k]._ts;
                if (ts >= from && ts < from + 86400000 && groupOf(rows[k]) === group) {
                    addToBucket(bucket, rows[k]);
                }
            }
            list.push({ key: dayKeyOf(day), bucket: bucket });
        }
        return list;
    }
    function bucketBetween(fromMs, toMs) {
        const bucket = emptyBucket();
        for (let i = 0; i < rows.length; i++) {
            const ts = rows[i]._ts;
            if (ts >= fromMs && ts < toMs) addToBucket(bucket, rows[i]);
        }
        return bucket;
    }

    function dashboardSummaryWindows(now) {
        const end = now.getTime() + 1000;
        const today = startOfDay(now);
        const week = weekStart(now);
        const month = monthStart(now);
        const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const rangeStart = new Date(end - LOOKBACK_DAYS * 86400000);
        const windows = [
            { key: 'today', start: today.getTime(), end: end },
            { key: 'yesterday', start: today.getTime() - 86400000, end: today.getTime() },
            { key: 'week', start: week.getTime(), end: end },
            { key: 'lastWeek', start: week.getTime() - 604800000,
                end: Math.min(end, week.getTime() - 604800000 + (end - week.getTime())) },
            { key: 'weekFull', start: week.getTime() - 604800000, end: week.getTime() },
            { key: 'month', start: month.getTime(), end: end },
            { key: 'prevMonth', start: previousMonth.getTime(), end: month.getTime() },
            { key: 'year', start: rangeStart.getTime(), end: end }
        ];
        const selectedYear = Number(growthPeriod && growthPeriod.y || now.getFullYear());
        const selectedMonth = Number(growthPeriod && growthPeriod.m || now.getMonth() + 1);
        if (selectedMonth >= 1 && selectedMonth <= 12) {
            const selectedStart = new Date(selectedYear, selectedMonth - 1, 1);
            const selectedEnd = new Date(selectedYear, selectedMonth, 1);
            if (selectedStart.getTime() <= now.getTime()
                && selectedEnd.getTime() > rangeStart.getTime()) {
                const days = new Date(selectedYear, selectedMonth, 0).getDate();
                for (let day = 1; day <= days; day++) {
                    const start = new Date(selectedYear, selectedMonth - 1, day);
                    const dayEnd = new Date(selectedYear, selectedMonth - 1, day + 1);
                    if (start.getTime() >= end || dayEnd.getTime() <= rangeStart.getTime()) continue;
                    windows.push({
                        key: dayKeyOf(start),
                        start: Math.max(start.getTime(), rangeStart.getTime()),
                        end: Math.min(dayEnd.getTime(), end)
                    });
                }
            }
        }
        const unique = new Map();
        windows.forEach(function (window) {
            unique.set(window.key, window);
        });
        return Array.from(unique.values()).map(function (window) {
            return {
                bucket_key: window.key,
                starts_at: new Date(window.start).toISOString(),
                ends_at: new Date(window.end).toISOString()
            };
        });
    }

    async function requestDashboardSummary(windows) {
        const result = await api('rpc/ent_dashboard_summary', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                p_windows: windows,
                p_doctor_id: scopeInfo && !scopeInfo.allAssigned && scopeInfo.doctorId || null,
                p_scope_all: !!(scopeInfo && (scopeInfo.seeAll || scopeInfo.role === 'admin'
                    || scopeInfo.allAssigned)),
                p_username: myName || null
            })
        });
        if (!Array.isArray(result)) {
            throw new Error('The database returned an invalid dashboard summary.');
        }
        const summary = Object.create(null);
        result.forEach(function (row) {
            if (!row || typeof row.bucket_key !== 'string') return;
            const values = {
                reports: Number(row.reports),
                patientCount: Number(row.patient_count),
                endoCount: Number(row.endo_count),
                cf4Count: Number(row.cf4_count),
                nasal: Number(row.nasal_reports),
                laryngeal: Number(row.laryngeal_reports),
                cf4: Number(row.cf4_reports),
                other: Number(row.other_reports),
                mine: Number(row.mine)
            };
            if (Object.keys(values).some(function (key) {
                return !Number.isSafeInteger(values[key]) || values[key] < 0;
            })) {
                throw new Error('The database returned invalid dashboard counts.');
            }
            summary[row.bucket_key] = values;
        });
        if (windows.some(function (window) { return !summary[window.bucket_key]; })) {
            throw new Error('The database returned an incomplete dashboard summary.');
        }
        return summary;
    }

    async function loadCloudSummary() {
        return requestDashboardSummary(dashboardSummaryWindows(new Date()));
    }

    function bucketFromSummary(summary, key) {
        const value = summary && summary[key];
        if (!value) return null;
        return {
            seen: Object.create(null),
            seenEndo: Object.create(null),
            seenCf4: Object.create(null),
            patientCount: value.patientCount,
            endoCount: value.endoCount,
            cf4Count: value.cf4Count,
            reports: value.reports,
            mine: value.mine,
            types: {
                nasal: value.nasal,
                laryngeal: value.laryngeal,
                cf4: value.cf4,
                other: value.other
            }
        };
    }

    function activitySummaryWindows(year, month) {
        const y = Number(year);
        const m = Number(month);
        if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return [];
        const monthStart = new Date(y, m - 1, 1);
        if (monthStart.getTime() > Date.now()) return [];
        const rangeEnd = Date.now() + 1000;
        const rangeStart = rangeEnd - LOOKBACK_DAYS * 86400000;
        const days = new Date(y, m, 0).getDate();
        const windows = [];
        for (let day = 1; day <= days; day++) {
            const start = new Date(y, m - 1, day);
            const end = new Date(y, m - 1, day + 1);
            if (start.getTime() >= rangeEnd || end.getTime() <= rangeStart) continue;
            windows.push({
                bucket_key: dayKeyOf(start),
                starts_at: new Date(Math.max(start.getTime(), rangeStart)).toISOString(),
                ends_at: new Date(Math.min(end.getTime(), rangeEnd)).toISOString()
            });
        }
        return windows;
    }

    function applyActivitySummary(data) {
        if (source !== 'cloud' || !cloudSummary) return data;
        const apply = function (item) {
            return {
                key: item.key,
                bucket: bucketFromSummary(cloudSummary, item.key) || item.bucket
            };
        };
        data.monthSeries = data.monthSeries.map(apply);
        data.series = data.series.map(apply);
        return data;
    }

    /* --------------------------- data load --------------------------- */
    function encounterMs(row) {
        /* WHEN THE RECORD WAS SAVED TO THE DATABASE - not the visit date.
         *
         * Every finished save (is_draft = false) counts in the period it was
         * SAVED, so backfilled Sept/Aug visits that were typed in October show
         * up in October: the clinic's encoding output for the month, which is
         * what the Report Mix and Activity tiles report. procedure_date stays
         * on the row for display (Latest patients still shows the visit date),
         * but it no longer decides the bucket - a missing or future visit
         * date must never hide a real database save from the counters.
         */
        const typed = Date.parse(String((row && (row.created_at || row.updated_at)) || ''));
        if (!isNaN(typed)) return typed;
        const explicit = String((row && row.procedure_date) || '').trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) {
            const seen = new Date(explicit + 'T00:00:00');     // local midnight
            if (!isNaN(seen.getTime())) return seen.getTime();
        }
        return 0;
    }
    function normalise(list) {
        return (Array.isArray(list) ? list : [])
            .map(function (row) {
                return {
                    created_at: (row && (row.created_at || row.updated_at)) || '',
                    // The LAST save moment, carried only so the "Saved hh:mm"
                    // line in Latest patients can say when the record was
                    // actually written (a record edited later moves this).
                    // The charts do NOT use it - their bucketing stays on _ts,
                    // which is the save date encounterMs() derives below.
                    updated_at: (row && row.updated_at) || '',
                    created_by: (row && row.created_by) || '',
                    // Carried through so keepInScope() can check the owner.
                    doctor_id: (row && row.doctor_id) || '',
                    clinic_id: (row && row.clinic_id) || '',
                    report_type: (row && row.report_type) || '',
                    patient_name: (row && row.patient_name) || '',
                    patient_id: (row && row.patient_id) || '',
                    case_number: (row && row.case_number) || '',
                    file_name: (row && row.file_name) || '',
                    procedure_date: (row && row.procedure_date) || '',
                    // Who saved it (0028 stamps the name beside the uuid) and
                    // which hospital the patient was seen at (payload.site).
                    // Both ride on the row so "Latest patients" can say them
                    // without a second round trip per record.
                    created_by_name: (row && row.created_by_name) || '',
                    site: siteOf(row),
                    // The follow-up promise (payload.followUpDate), read the
                    // same defensive way as site so a missing or malformed one
                    // is simply '' and the follow-up card ignores the row.
                    followUpDate: followUpOf(row),
                    // The save moment, not the visit - see encounterMs() above.
                    _ts: encounterMs(row)
                };
            })
            .sort(function (a, b) { return b._ts - a._ts; });
    }

    function isValidVisitDate(value) {
        const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
        if (!parts) return false;
        const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
        return !isNaN(date.getTime())
            && date.getFullYear() === Number(parts[1])
            && date.getMonth() === Number(parts[2]) - 1
            && date.getDate() === Number(parts[3]);
    }

    function refreshOfflineStats() {
        const store = window.EntOfflineStore;
        if (!store || typeof store.stats !== 'function') {
            offlineStats = { engine: 'unavailable', records: 0, pending: 0, unsynced: 0 };
            renderActionSummary();
            return;
        }
        store.stats().then(function (stats) {
            offlineStats = stats && typeof stats === 'object'
                && typeof stats.engine === 'string'
                && typeof stats.pending === 'number' && isFinite(stats.pending)
                && typeof stats.unsynced === 'number' && isFinite(stats.unsynced)
                ? stats
                : { engine: 'unavailable', records: 0, pending: 0, unsynced: 0 };
            renderActionSummary();
        }, function (error) {
            console.warn('[Dashboard] Could not read offline sync status:', error);
            offlineStats = { engine: 'unavailable', records: 0, pending: 0, unsynced: 0 };
            renderActionSummary();
        });
    }

    // Same scoping as dbRecords.js: never read another doctor's rows.
    async function loadCloudRows() {
        if (!window.EntSupabase || !window.EntSupabase.isConfigured()) {
            throw new Error('Cloud database is not configured on this device.');
        }
        // v2: no clinic filter and no doctor filter. Both used to be built here in
        // the browser, which meant the BROWSER decided what this person could
        // see. In v2 ent_may_touch_report() does that inside every policy, so
        // the honest query is unfiltered and the database returns exactly the
        // rows this caller is entitled to.
        //
        // doctor_id and clinic_id ARE selected even though nothing filters on
        // them here. They are not for access control - that is still RLS, and
        // this file never gets to widen it. They are selected so keepInScope()
        // below can tell whether the database handed back rows belonging to
        // somebody else, and say so out loud instead of quietly counting them.
        // Without them a too-wide RLS response is indistinguishable from a real
        // total, which is exactly how a brand-new doctor ends up looking at
        // 17 patients they have never treated.
        const from = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
        // is_draft = false is not a nicety here, it is the whole difference
        // between a true number and a lie. A shared DRAFT is a row in this
        // table, and this query used to read every row: the dashboard then
        // counted unfinished work as patients handled, which is how one
        // clinic day read "14 patients" while three people had actually been
        // through the clinic. 0017 made is_draft=false the honest "this
        // reached the database" marker, so the counters follow it. Drafts are
        // not lost by this - they have their own screens (My Drafts, Team
        // Drafts) and the queue below still wants them.
        const base = 'created_at,updated_at,created_by,doctor_id,clinic_id,report_type'
            + ',patient_name,patient_id,case_number,file_name,procedure_date';
        // THREE tiers, exactly as dbRecords.js does it. "Latest patients" now
        // wants two columns on top of the counters: created_by_name (0028) -
        // the secretary or doctor who saved the record, without which a v2
        // uuid has no readable name at all - and payload->>site, the hospital
        // the patient was seen at (RMCI / CUMC). PostgREST names a JSON-
        // extracted field after its LAST key, so `payload->>site` arrives as
        // `site`. A database that has not run 0028 answers 400 for the first
        // request; the second drops only the name and the third asks for
        // nothing extra, so the card still loads (author "Someone", no
        // hospital chip) instead of the whole dashboard failing to render.
        // payload->>followUpDate rides along the same way for the follow-up
        // card - a JSON field, so it costs no migration and a 400 on it only
        // costs the follow-up list, never the counters.
        const query = function (extra) {
            return 'reports?created_at=gte.' + encodeURIComponent(from)
                + '&is_draft=eq.false&select=' + base + extra
                + '&order=created_at.desc&limit=' + ROW_LIMIT;
        };
        let result;
        try {
            result = await api(query(',created_by_name,payload->>site,payload->>' + FOLLOW_UP_KEY));
        } catch (e) {
            try {
                result = await api(query(',payload->>site,payload->>' + FOLLOW_UP_KEY));
            } catch (e2) {
                try {
                    result = await api(query(',payload->>site'));
                } catch (e3) {
                    result = await api(query(''));
                }
            }
        }
        return Array.isArray(result) ? result : [];
    }

    /* Which rows this account is supposed to be counting.
     *
     * RLS is the access control; this is the COUNTING rule, and it is a second
     * opinion rather than a replacement. A doctor counts his own shelf, a
     * secretary her assigned doctor's shelf, an admin the whole clinic.
     *
     * Rows with no doctor_id are this DEVICE's own history (loadDeviceRows
     * stamps them with the local username), and they are kept - they were
     * made here and are nobody else's business. A row with a doctor_id that is
     * not this account's is dropped and counted, because counting somebody
     * else's patients is the bug this function exists to stop. */
    function keepInScope(row) {
        const scope = scopeInfo || {};
        if (scope.seeAll || scope.role === 'admin') return true;   // admins see the clinic
        const owner = String((row && row.doctor_id) || '').trim();
        if (!owner) return true;         // a device-local row
        if (scope.allAssigned) {
            const assigned = Array.isArray(scope.assignedDoctorIds) ? scope.assignedDoctorIds : [];
            return assigned.indexOf(owner) !== -1;
        }
        const mine = String(scope.doctorId || '').trim();
        if (!mine) return true;          // nothing to compare against; trust RLS
        return owner === mine;
    }

    function splitByScope(list) {
        const kept = [];
        let dropped = 0;
        for (let i = 0; i < list.length; i++) {
            if (keepInScope(list[i])) kept.push(list[i]);
            else dropped += 1;
        }
        return { kept, dropped };
    }

    function monthlyExportMonth() {
        const now = new Date();
        return now.getFullYear() + '-' + pad(now.getMonth() + 1);
    }

    function monthlyExportState() {
        if (!me || (me.role !== 'doctor' && me.role !== 'secretary') || !me.id) return {};
        const key = MONTHLY_EXPORT_STORAGE_KEY + ':' + String(me.id);
        try {
            const raw = window.localStorage.getItem(key);
            if (!raw) return {};
            const state = JSON.parse(raw);
            return state && typeof state === 'object' ? state : {};
        } catch (error) {
            console.warn('[Dashboard] Could not read monthly export reminder status:', error);
            return {};
        }
    }

    function saveMonthlyExportState(state) {
        if (!me || !me.id) return false;
        const key = MONTHLY_EXPORT_STORAGE_KEY + ':' + String(me.id);
        try {
            window.localStorage.setItem(key, JSON.stringify(state));
            return true;
        } catch (error) {
            console.warn('[Dashboard] Could not save monthly export reminder status:', error);
            return false;
        }
    }

    function monthlyExportIsDue() {
        if (!me || (me.role !== 'doctor' && me.role !== 'secretary') || !me.id) return false;
        const state = monthlyExportState();
        if (state.completedMonth === monthlyExportMonth()) return false;
        return !(Number(state.snoozedUntil) > Date.now());
    }

    function snoozeMonthlyExport() {
        const state = monthlyExportState();
        state.snoozedUntil = Date.now() + 7 * 86400000;
        if (saveMonthlyExportState(state)) renderNotices();
    }

    function completeMonthlyExport() {
        const state = monthlyExportState();
        state.completedMonth = monthlyExportMonth();
        delete state.snoozedUntil;
        if (saveMonthlyExportState(state)) renderNotices();
        else {
            renderNotices();
            window.alert('The download started, but this browser could not remember it. The monthly reminder may appear again.');
        }
    }

    // Device history (written by patientRecords.js) - the offline safety net.
    //
    // SCOPED, deliberately. This is one localStorage key shared by every account
    // that ever used this browser, and a new doctor signing in on a machine that
    // an older doctor used would otherwise be handed that doctor's local records
    // and shown them as their own patients. patientRecords.js now stamps
    // ownerId on every write; records written before that carry no stamp, and
    // they are EXCLUDED rather than assumed - an unowned record has no evidence
    // of belonging to the person now looking at it, and the dashboard falling
    // back to the cloud is a far smaller problem than inventing ownership.
    /* Is this device record FINISHED work, or only a draft of it?
     patientRecords stamps a format on every write - 'Draft' when someone
     pressed Save Draft, 'Database' on a real save, 'PDF' on a print - and
     keeps the list in savedFormats. A record whose only formats are 'Draft'
     is unfinished, and counting it here is the same lie the cloud query
     just stopped telling.
     
     A record with NO format at all predates this tracking. It is kept:
     inventing doubt about an old real patient - and quietly dropping a
     count - is worse than counting one legacy row. */
    function finishedDeviceRecord(rec) {
        const list = Array.isArray(rec && rec.savedFormats) && rec.savedFormats.length
            ? rec.savedFormats
            : (rec && rec.format ? [rec.format] : []);
        if (!list.length) return true;
        return list.some(function (f) { return /^(database|pdf)$/i.test(String(f).trim()); });
    }

    // Load offline records from IndexedDB (EntOfflineStore)
    async function loadOfflineRows() {
        if (!window.EntOfflineStore || typeof window.EntOfflineStore.listRecords !== 'function') {
            return [];
        }
        const meId = String((me && me.id) || '').trim();
        if (!meId) return [];
        
        try {
            const offlineRecords = await window.EntOfflineStore.listRecords();
            return offlineRecords
                .filter(function (rec) {
                    // Only count records that belong to this account
                    return String(rec.ownerId || '').trim() === meId;
                })
                .map(function (rec) {
                    return {
                        created_at: rec.offlineSavedAt || rec.savedAt || rec.createdAt || '',
                        created_by: (me && me.username) || 'me',
                        doctor_id: String(rec.ownerId || '').trim(),
                        clinic_id: '',
                        report_type: rec.reportType || '',
                        patient_name: rec.patientName || '',
                        patient_id: rec.patientId || '',
                        case_number: rec.caseNumber || '',
                        file_name: rec.fileName || '',
                        procedure_date: rec.procedureDate || '',
                        site: rec.site || ''
                    };
                });
        } catch (e) {
            console.warn('[Dashboard] Failed to load offline records:', e);
            return [];
        }
    }

    function loadDeviceRows() {
        const local = (window.PatientRecords && typeof window.PatientRecords.getAll === 'function')
            ? window.PatientRecords.getAll() : [];
        const meId = String((me && me.id) || '').trim();
        return local.filter(finishedDeviceRecord).map(function (rec) {
            return {
                created_at: rec.lastActivityAt || rec.createdAt || '',
                created_by: (me && me.username) || 'me',
                // The OWNER, not the viewer: this is what the scope filter reads.
                doctor_id: String(rec.ownerId || '').trim(),
                clinic_id: '',
                report_type: rec.reportType || '',
                patient_name: rec.patientName || '',
                patient_id: rec.patientId || '',
                case_number: rec.caseNumber || '',
                file_name: rec.fileName || '',
                procedure_date: rec.procedureDate || '',
                // The device keeps the hospital tag beside the rest of the
                // draft metadata, so a record that has not reached the cloud
                // yet still knows which building it belongs to.
                site: rec.site || ''
            };
        }).filter(function (r) {
            // Keep only records this account stamped for itself.
            if (!meId) return false;
            return r.doctor_id === meId;
        });
    }

    // Push whatever is still only on this device before counting, so a
    // report saved minutes ago is not missing from the totals.
    async function pushPendingRecords() {
        if (!navigator.onLine || !window.EntSync ||
            typeof window.EntSync.syncPatientRecords !== 'function') return;
        try {
            await Promise.race([
                window.EntSync.syncPatientRecords(),
                new Promise(function (resolve) { setTimeout(resolve, SYNC_WAIT_MS); })
            ]);
        } catch (e) { /* the counters still fall back to the device copy */ }
    }

    /* ---------------------------- refresh ---------------------------- */
    function setBusy(on) {
        busy = !!on;
        const btn = byId('dashRefreshBtn');
        if (btn) {
            btn.dataset.busy = on ? '1' : '0';
            btn.textContent = on ? '\u27F3 Counting\u2026' : '\u27F3 Refresh';
        }
    }

    async function refresh(options) {
        const opts = options || {};
        if (busy) return;
        activitySummaryRequestId += 1;
        reportMixRequestId += 1;
        reportMixSummaryCache = Object.create(null);
        reportMixSummaryError = '';
        setBusy(true);
        try {
            if (opts.push) await pushPendingRecords();
            if (navigator.onLine && window.EntSupabase && window.EntSupabase.isConfigured()) {
                try {
                    const summaryRequest = loadCloudSummary().then(
                        function (summary) { return { summary: summary }; },
                        function (error) { return { error: error }; }
                    );
                    // Scoped BEFORE anything is counted. This is the fix for a
                    // new doctor seeing the whole database: RLS is supposed to
                    // hand back only their own rows, and if it ever does not,
                    // the counters must not quietly add those rows up.
                    const split = splitByScope(normalise(await loadCloudRows()));
                    rows = split.kept;
                    outOfScope = split.dropped;
                    source = 'cloud';
                    loadError = '';
                    const summaryResult = await summaryRequest;
                    if (summaryResult.error) {
                        cloudSummary = null;
                        activitySummaryError = '';
                        const message = String(summaryResult.error && summaryResult.error.message
                            || summaryResult.error || '');
                        summaryError = /404|PGRST202|function .* does not exist/i.test(message)
                            ? 'Apply migration 0048; until then, counts use only the newest '
                                + ROW_LIMIT.toLocaleString() + ' loaded records.'
                            : 'The summary request failed; check the connection and refresh. Until it succeeds, counts use only the newest '
                                + ROW_LIMIT.toLocaleString() + ' loaded records.';
                        console.warn('[Dashboard] Exact count summary unavailable; using the bounded row counts.',
                            summaryResult.error);
                    } else {
                        cloudSummary = summaryResult.summary;
                        summaryError = '';
                        activitySummaryError = '';
                    }
                } catch (error) {
                    cloudSummary = null;
                    summaryError = '';
                    activitySummaryError = '';
                    loadError = (error && error.message) || 'Could not reach the cloud database.';
                    // Fallback to device + offline records
                    const device = normalise(loadDeviceRows());
                    const offline = normalise(await loadOfflineRows());
                    rows = [...device, ...offline];
                    outOfScope = 0;
                    source = rows.length ? 'device+offline' : 'none';
                }
            } else {
                // Offline or not configured: load from device localStorage AND IndexedDB
                cloudSummary = null;
                summaryError = '';
                activitySummaryError = '';
                const device = normalise(loadDeviceRows());
                const offline = normalise(await loadOfflineRows());
                rows = [...device, ...offline];
                outOfScope = 0;
                source = rows.length ? 'device+offline' : 'none';
                loadError = navigator.onLine
                    ? 'The cloud database is not configured on this device.'
                    : 'No internet connection right now. Showing offline records.';
            }
        } finally {
            lastLoadedAt = Date.now();
            setBusy(false);
            renderAll();
            refreshOfflineStats();
            refreshQueue();
            // The admin's per-clinic card reads two directories the regular
            // dashboard never asks for. Kicked here (not awaited) so a slow
            // or denied directory read can never delay the counters, and the
            // card redraws itself when they land.
            loadDirectory();
        }
    }

    /* --------------------------- computing --------------------------- */
    function computeAll() {
        const now = new Date();
        const end = now.getTime() + 1000;                      // include "now"
        const t0 = startOfDay(now).getTime();
        const w0 = weekStart(now).getTime();
        const m0 = monthStart(now).getTime();
        const pm0 = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
        const earliest = end - LOOKBACK_DAYS * 86400000;

        const series = [];
        for (let i = CHART_DAYS - 1; i >= 0; i--) {
            const day = addDays(startOfDay(now), -i);
            const from = day.getTime();
            series.push({ key: dayKeyOf(day), bucket: bucketBetween(from, from + 86400000) });
        }

        const data = {
            now: now,
            today: bucketBetween(t0, end),
            yesterday: bucketBetween(t0 - 86400000, t0),
            week: bucketBetween(w0, end),
            lastWeek: bucketBetween(w0 - 604800000, Math.min(end, w0 - 604800000 + (end - w0))),
            weekFull: bucketBetween(w0 - 604800000, w0),
            month: bucketBetween(m0, end),
            prevMonth: bucketBetween(pm0, m0),
            year: bucketBetween(earliest, end),
            series: series,
            seriesEndo: seriesFor('endo'),
            seriesCf4: seriesFor('cf4')
        };
        if (source === 'cloud' && cloudSummary) {
            ['today', 'yesterday', 'week', 'lastWeek', 'weekFull', 'month', 'prevMonth', 'year']
                .forEach(function (key) {
                    const bucket = bucketFromSummary(cloudSummary, key);
                    if (bucket) data[key] = bucket;
                });
            data.series = data.series.map(function (item) {
                return {
                    key: item.key,
                    bucket: bucketFromSummary(cloudSummary, item.key) || item.bucket
                };
            });
        }
        return data;
    }

    /* --------------------------- rendering --------------------------- */
    function renderHero(data) {
        const user = me || {};
        const first = greetingName(user);
        const greetEl = byId('dashGreeting');
        if (greetEl) {
            const hello = greetingFor(data.now);
            // The emoji stays on the MOOD pill below instead: a sunset
            // before "Good evening" AND a sunset before "Almost done for
            // today" printed the same sky twice in one glance.
            greetEl.textContent = hello.text + ', ' + first;
        }
        const moodEl = byId('dashMood');
        if (moodEl) moodEl.textContent = moodLine(data.now, data.today);

        const roleEl = byId('dashRoleLine');
        if (roleEl) {
            roleEl.textContent = user.role === 'secretary'
                ? (scopeInfo && scopeInfo.allAssigned
                    ? 'All patients for your ' + assignedDoctorRows.length
                        + ' assigned doctors are included. New reports still file under your selected doctor.'
                    : 'You work under Dr. ' + (prettyName(user.assigned_doctor_name) || 'your assigned doctor')
                        + ' \u2014 only this doctor\u2019s patients are counted here.')
                : (user.role === 'admin'
                    ? 'Administrator preview \u2014 these counters cover every doctor of this clinic.'
                    : 'Your own patients: nasal & laryngeal endoscopy reports and CF4 claims.');
        }

        const pill = byId('dashScopePill');
        if (pill) {
            pill.className = 'ent-dash-scope role-' + (user.role || '');
            // ROLE ONLY. The doctor's name is already the subject of the
            // role line right below, and it was in the header tagline too -
            // three "Dr. Jesus Jardin" mentions on one screen is noise.
            pill.textContent = user.role === 'secretary'
                ? (user.is_super_secretary
                    ? (scopeInfo && scopeInfo.allAssigned ? 'Super Secretary \u00b7 All clinics' : 'Super Secretary')
                    : (scopeInfo && scopeInfo.allAssigned ? 'Secretary \u00b7 All doctors' : 'Secretary'))
                : (user.role === 'admin' ? 'Admin' : 'Doctor');
        }
        const scopeToggle = byId('dashDoctorScopeToggle');
        if (scopeToggle && user.role === 'secretary' && assignedDoctorRows.length > 1) {
            scopeToggle.hidden = false;
            scopeToggle.setAttribute('aria-pressed', scopeInfo && scopeInfo.allAssigned ? 'true' : 'false');
            scopeToggle.textContent = scopeInfo && scopeInfo.allAssigned
                ? 'Show selected doctor only'
                : 'Show all ' + assignedDoctorRows.length + ' assigned doctors';
        }

        /* The header tagline used to be one hardcoded sentence for everyone:
         * "Quick actions and your OWN patient counts". That is simply false
         * for an admin, whose counters cover every doctor in the clinic, and
         * for a secretary it quietly implied the counts were hers when they
         * are her assigned doctor's.
         *
         * Each role now gets a line that is actually true for it. The
         * doctor's own counts stay the default wording.
         *
         * The line is written to BOTH taglines - the one under the header
         * title and the one in the hero below - because they are the same
         * sentence in two places. Writing only the hero's left the header
         * copy frozen on the doctor wording, so an admin still read "your
         * own patient counts" under a "Clinic-wide preview" pill.
         */
        const dr = prettyName(user.assigned_doctor_name);
        const tagText = user.role === 'admin'
            ? 'Clinic-wide preview \u2014 every doctor, every count'
            : (user.role === 'secretary'
                ? (scopeInfo && scopeInfo.allAssigned
                    ? 'All assigned doctors \u2014 nasal, laryngeal and CF4 records'
                    : dr
                    ? 'Quick actions and the patient counts for Dr. ' + dr
                    : 'Quick actions and your assigned doctor\u2019s patient counts')
                : 'Quick actions and your own patient counts');
        ['dashTagline', 'headerTagline'].forEach(function (tid) {
            const tagEl = byId(tid);
            if (tagEl) tagEl.textContent = tagText;
        });

        // The initials avatar with a role ring. Two letters from the display
        // name (or the username), coloured by role. Pure decoration, but it
        // is the one thing that makes the dashboard feel like HIS - so it is
        // worth the few lines. Falls back to "?" if there is no name at all.
        const avatar = byId('dashAvatar');
        if (avatar) {
            const name = prettyName(user.full_name || user.username || '');
            const initials = name.split(/\s+/).filter(Boolean).slice(0, 2)
                .map(function (w) { return w.charAt(0).toUpperCase(); }).join('') || '?';
            avatar.textContent = initials;
            avatar.className = 'ent-dash-avatar role-' + (user.role || '');
            avatar.title = (user.role === 'doctor' ? 'Dr. ' : '') + (name || 'there');
        }

        const latest = rows[0];
        const latestEl = byId('dashLatest');
        if (latestEl) {
            latestEl.textContent = latest
                ? 'Last entry: ' + displayNameOf(latest) + ' \u00b7 ' + relTime(latest._ts)
                : 'No report yet in this period \u2014 start one with a quick action below.';
        }
        // Streak line: consecutive days with a saved record. ALWAYS visible
        // for doctor/secretary (requested: show even at zero - "No streak
        // yet" instead of hiding). Zero is a real state, not a missing one.
        const streakEl = byId('dashStreak');
        if (streakEl) {
            const streak = computeStreak();
            streakEl.hidden = false;
            if (streak >= 1) {
                streakEl.innerHTML = '&#128293; <b>' + streak + '-day streak</b> &middot; at least one patient saved every day. Keep it going!';
            } else {
                streakEl.innerHTML = '&#128293; <b>No streak yet</b> &middot; save your first patient today to start one!';
            }
        }
    }

    function tickClock() {
        const now = new Date();
        const dateEl = byId('dashDate');
        const timeEl = byId('dashTime');
        if (dateEl) {
            dateEl.textContent = now.toLocaleDateString(undefined,
                { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        }
        if (timeEl) {
            // The wall clock. How FRESH the numbers are ("synced just now")
            // is the sync pill's job right beside it - printing "Updated
            // just now, from the cloud database" here AND "Live, synced
            // just now" there said one thing twice.
            timeEl.textContent = now.toLocaleTimeString(undefined,
                { hour: 'numeric', minute: '2-digit' });
        }
        // LAST-SYNC STATUS. A single coloured dot + short line that answers
        // "is what I'm looking at live?" at a glance. Reads only lastLoadedAt
        // and source - both already in memory - so it is zero-risk. Green =
        // fresh cloud, amber = a little stale, blue = this device, grey = none.
        const syncEl = byId('dashSync');
        if (syncEl) {
            const age = lastLoadedAt ? (Date.now() - lastLoadedAt) : Infinity;
            let cls = 'is-stale', text = 'Not synced yet';
            if (lastLoadedAt && source === 'cloud') {
                if (age < 120000) { cls = 'is-live'; text = 'Live \u00b7 synced just now'; }
                else { cls = 'is-stale'; text = 'Cloud \u00b7 updated ' + relTime(lastLoadedAt); }
            } else if (source === 'device') {
                cls = 'is-local'; text = 'On this device \u00b7 not synced';
            }
            syncEl.className = 'ent-dash-sync ' + cls;
            syncEl.innerHTML = '<span class="ent-dash-sync-dot"></span>' + esc(text);
        }
    }

    /* A streak: how many consecutive days up to today have at least one
     * saved record. Pure maths over the rows already loaded (encounterDay),
     * so it is zero-risk. A small motivational line for the doctor/secretary
     * that never blocks anything - it simply shows nothing with no data. */
    function computeStreak() {
        const days = new Set();
        rows.forEach(function (r) { const d = encounterDay(r); if (d && d !== 'nodate') days.add(d); });
        if (!days.size) return 0;
        let streak = 0;
        const cursor = new Date();
        // Count today; if nothing was saved yet today it still counts when
        // yesterday had a record, so the streak does not vanish at 00:01
        // before the day's first save.
        for (let i = 0; i < 400; i++) {
            const key = dayKeyOf(cursor);
            if (days.has(key)) { streak++; cursor.setDate(cursor.getDate() - 1); }
            else if (i === 0) { cursor.setDate(cursor.getDate() - 1); }
            else break;
        }
        return streak;
    }

    function renderNotices() {
        const box = byId('dashNotices');
        const notificationCenter = byId('dashNotificationCenter');
        function positionNotificationPanel() {
            if (!notificationPanelOpen || !notificationCenter) return;
            const toggle = notificationCenter.querySelector('.ent-notification-toggle');
            const panel = byId('dashNotificationPanel');
            if (!toggle || !panel) return;
            const panelWidth = Math.min(420, Math.max(0, window.innerWidth - 24));
            const toggleRect = toggle.getBoundingClientRect();
            const center = Math.max(panelWidth / 2 + 12,
                Math.min(window.innerWidth - panelWidth / 2 - 12,
                    toggleRect.left + toggleRect.width / 2));
            const panelTop = Math.max(12, Math.round(toggleRect.bottom + 10));
            panel.style.setProperty('--ent-notification-panel-top', panelTop + 'px');
            panel.style.setProperty('--ent-notification-panel-left', Math.round(center) + 'px');
            panel.style.setProperty('--ent-notification-panel-max-height',
                Math.max(120, window.innerHeight - panelTop - 12) + 'px');
        }
        if (!notificationCenterWired) {
            notificationCenterWired = true;
            if (notificationCenter) {
                notificationCenter.addEventListener('click', function (event) {
                    const target = event.target && typeof event.target.closest === 'function'
                        ? event.target.closest('[data-notification-toggle], [data-monthly-export-action]')
                        : null;
                    const clicked = target || (event && event.target);
                    if (!clicked || !clicked.dataset) return;
                    if (clicked.dataset.notificationToggle !== undefined) {
                        notificationPanelOpen = !notificationPanelOpen;
                        renderNotices();
                        const toggle = notificationCenter.querySelector('.ent-notification-toggle');
                        if (toggle && typeof toggle.focus === 'function') toggle.focus();
                        return;
                    }
                    if (clicked.dataset.monthlyExportAction === 'download') {
                        return exportMonthlyRecords(clicked);
                    }
                    if (clicked.dataset.monthlyExportAction === 'later') {
                        return snoozeMonthlyExport();
                    }
                });
                window.addEventListener('resize', positionNotificationPanel);
                window.addEventListener('scroll', positionNotificationPanel, true);
            }
            document.addEventListener('keydown', function (event) {
                if (event.key === 'Escape' && notificationPanelOpen) {
                    notificationPanelOpen = false;
                    renderNotices();
                }
            });
            document.addEventListener('click', function (event) {
                if (!notificationPanelOpen || !notificationCenter) return;
                const target = event.target;
                if (target && typeof target.closest === 'function') {
                    if (target.closest('[data-notification-toggle]')) return;
                    const monthlyAction = target.closest('[data-monthly-export-action]');
                    if (monthlyAction) {
                        if (monthlyAction.dataset.monthlyExportAction === 'download') {
                            return exportMonthlyRecords(monthlyAction);
                        }
                        if (monthlyAction.dataset.monthlyExportAction === 'later') {
                            return snoozeMonthlyExport();
                        }
                    }
                    if (target.closest('[data-notification-id]')) {
                        notificationPanelOpen = false;
                        renderNotices();
                        return;
                    }
                }
                const panel = byId('dashNotificationPanel');
                const insideCenter = notificationCenter.contains
                    && notificationCenter.contains(target);
                const insidePanel = panel && panel.contains && panel.contains(target);
                if (!insideCenter && !insidePanel) {
                    notificationPanelOpen = false;
                    renderNotices();
                }
            });
            document.addEventListener('ent:notifications-updated', renderNotices);
        }
        const notices = [];
        const notifications = [];
        const params = new URLSearchParams(window.location.search || '');

        if (params.get('denied')) {
            notices.push({ kind: 'is-bad', html: '<strong>Access denied.</strong> That page is reserved for another role.' });
        }
        if (me && me.role === 'secretary' && !scopeInfo.doctorId) {
            notices.push({
                kind: 'is-bad',
                html: '<strong>No doctor assigned to this account yet.</strong> Ask the administrator to link '
                    + 'your account to a doctor \u2014 the counters stay empty until then.'
            });
        }
        if (source === 'device') {
            notices.push({
                kind: 'is-info',
                html: '<strong>Showing this device\u2019s records.</strong> ' + esc(loadError)
                    + ' The totals may differ from the clinic\u2019s once you are online again.'
            });
        }
        if (source === 'none') {
            notices.push({
                kind: 'is-info',
                html: '<strong>Nothing to count yet.</strong> ' + esc(loadError)
                    + ' Reports created on this device show up here immediately.'
            });
        }
        if (outOfScope > 0) {
            // This should be impossible: RLS is supposed to return only this
            // account's rows, and the counters above have already excluded the
            // extras. Showing it is the point - a silent mismatch would just
            // look like a real total, and the next question would be "why does
            // this number keep changing". Naming it turns a mystery into a
            // diagnosable report: the server handed back rows that are not this
            // account's shelf.
            notices.push({
                kind: 'is-warn',
                html: '<strong>Hidden ' + outOfScope + ' record'
                    + (outOfScope === 1 ? '' : 's') + ' that are not yours.</strong> '
                    + 'These belong to another doctor and are not counted above. '
                    + 'If you can see them at all, tell your administrator.'
            });
        }
        if (summaryError) {
            notifications.push({
                kind: 'is-warn',
                html: '<strong>Counts may be incomplete.</strong> ' + esc(summaryError)
            });
        }
        if (activitySummaryError) {
            notifications.push({
                kind: 'is-warn',
                html: '<strong>Activity chart may be incomplete.</strong> ' + esc(activitySummaryError)
            });
        }
        if (reportMixSummaryError) {
            notifications.push({
                kind: 'is-warn',
                html: '<strong>Report type counts may be incomplete.</strong> ' + esc(reportMixSummaryError)
            });
        }
        if (source === 'cloud' && cloudSummary && rows.length >= ROW_LIMIT) {
            notices.push({
                kind: 'is-info',
                html: '<strong>Long history.</strong> Summary counts use all matching records. '
                    + 'Recent-patient and follow-up panels show the newest '
                    + ROW_LIMIT.toLocaleString() + ' records.'
            });
        } else if (rows.length >= ROW_LIMIT && !cloudSummary && !summaryError) {
            notices.push({
                kind: 'is-info',
                html: '<strong>Long history.</strong> The counters cover the newest '
                    + ROW_LIMIT.toLocaleString() + ' records of the last ' + LOOKBACK_DAYS + ' days.'
            });
        }
        if (monthlyExportIsDue()) {
            const canDownload = source === 'cloud' && !monthlyExportBusy;
            notifications.push({
                kind: 'is-info',
                html: '<strong>Monthly records download.</strong> Save a dated copy of the saved reports '
                    + 'your account can access. This JSON is sensitive patient data; store it securely. '
                    + 'It does not include deleted reports, separately stored photo files, or account data. '
                    + 'It is not a full system backup.',
                actions: '<div class="ent-notification-actions">'
                    + '<button type="button" class="ent-btn is-primary" data-monthly-export-action="download"'
                    + (canDownload ? '' : ' disabled')
                    + '>' + (monthlyExportBusy ? 'Preparing download\u2026'
                        : (source === 'cloud' ? 'Download monthly records' : 'Connect to download')) + '</button>'
                    + '<button type="button" class="ent-btn ent-dash-ghost" data-monthly-export-action="later">'
                    + 'Remind me in 7 days</button></div>'
            });
        }
        if (box) {
            box.innerHTML = notices.map(function (n) {
                return '<div class="ent-dash-notice ' + n.kind + '"><span>' + n.html + '</span></div>';
            }).join('');
        }
        if (notificationCenter) {
            const storedNotifications = window.EntNotificationCenter
                ? window.EntNotificationCenter.getItems() : [];
            const unreadStored = window.EntNotificationCenter
                ? window.EntNotificationCenter.getUnreadCount() : 0;
            const count = notifications.length + unreadStored;
            const dashboardItems = notifications.map(function (n) {
                return Object.assign({ isStored: false }, n);
            });
            storedNotifications.forEach(function (n) {
                const href = window.EntNotificationCenter.getHref(n);
                dashboardItems.push({
                    kind: 'is-info' + (n.read_at ? '' : ' is-unread'),
                    html: '<strong>' + esc(n.title) + '</strong> ' + esc(n.body),
                    actions: '<div class="ent-notification-actions"><a class="ent-btn ent-dash-ghost"'
                        + ' href="' + esc(href) + '" data-notification-id="' + esc(n.id) + '">Open</a></div>',
                    isStored: true
                });
            });
            const notificationItems = dashboardItems.length
                ? dashboardItems.map(function (n) {
                    return '<article class="ent-notification-item ' + n.kind
                        + (n.actions ? ' is-monthly' : '') + '" role="status">'
                        + '<div>' + n.html + '</div>' + (n.actions || '') + '</article>';
                }).join('')
                : '<p class="ent-notification-empty">You\u2019re all caught up.</p>';
            const existingPanel = byId('dashNotificationPanel');
            if (existingPanel && existingPanel.parentNode) {
                existingPanel.parentNode.removeChild(existingPanel);
            }
            notificationCenter.innerHTML = '<button type="button" class="ent-notification-toggle"'
                + ' data-notification-toggle aria-label="Notifications'
                + (count ? ', ' + count + ' active' : '') + '"'
                + ' aria-expanded="' + (notificationPanelOpen ? 'true' : 'false') + '"'
                + ' aria-controls="dashNotificationPanel" title="Notifications">'
                + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
                + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
                + '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>'
                + '</svg>'
                + (count ? '<span class="ent-notification-count" aria-hidden="true">'
                    + count + '</span>' : '')
                + '</button>'
                + '<section class="ent-notification-panel" id="dashNotificationPanel"'
                + ' aria-label="Notifications"' + (notificationPanelOpen ? '' : ' hidden') + '>'
                + '<div class="ent-notification-heading"><h2>Notifications</h2>'
                + '<button type="button" data-notification-read-all'
                + (unreadStored ? '' : ' disabled') + '>Mark all read</button></div>'
                + '<div class="ent-notification-list">'
                + notificationItems + '</div></section>';
            const notificationPanel = notificationCenter.querySelector('.ent-notification-panel');
            if (notificationPanel) document.body.appendChild(notificationPanel);
            positionNotificationPanel();
        }
    }

    // Plain and simple: one number per period, one patient counted once -
    // plus the per-type split (Endoscopy vs CF4) so the mix is visible
    // without opening the Report types card.
    function tileSub(bucket) {
        const endo = bucket.endoCount || 0;
        const cf4 = bucket.cf4Count || 0;
        const other = Math.max(0, (bucket.patientCount || 0) - endo - cf4);
        let s = 'Endo ' + endo + ' \u00b7 CF4 ' + cf4;
        if (other > 0) s += ' \u00b7 Other ' + other;
        return s;
    }
    /* Week-over-week trend chip for the This-Week tile. Pure maths on two
     * buckets that are already computed (no query), so it is zero-risk.
     *   · both zero      → nothing (there is no story to tell)
     *   · up vs last week→ green  ▲ +N%
     *   · down           → red    ▼ -N%
     *   · equal          → grey   · no change
     * The percentage is against last week's patient count; a rise from 0 is
     * shown as a plain "+N" rather than an infinite percentage. */
    function trendChip(week, lastWeek) {
        const now = (week && week.patientCount) || 0;
        const before = (lastWeek && lastWeek.patientCount) || 0;
        if (now === 0 && before === 0) return '';
        if (before === 0) {
            return '<span class="ent-trend is-up" title="Last week had no patients">'
                + '&#9650; +' + now + ' vs last week</span>';
        }
        const pct = Math.round(((now - before) / before) * 100);
        if (pct > 0) {
            return '<span class="ent-trend is-up" title="' + now + ' this week vs ' + before + ' last week">'
                + '&#9650; +' + pct + '% vs last week</span>';
        }
        if (pct < 0) {
            return '<span class="ent-trend is-down" title="' + now + ' this week vs ' + before + ' last week">'
                + '&#9660; ' + pct + '% vs last week</span>';
        }
        return '<span class="ent-trend is-flat" title="Same as last week">&middot; same as last week</span>';
    }

    /* A tiny count-up so a tile number rolls to its value instead of
     * snapping. requestAnimationFrame only (no library), honours
     * prefers-reduced-motion, and cancels any previous run on the same node
     * so a fast refresh never leaves two loops fighting. Presentational
     * only - it reads the number already computed and animates toward it.
     *
     * rAF / performance are resolved from `window` with a setTimeout(16ms)
     * fallback so a non-browser host (the node test sandbox, an ancient
     * WebView) degrades to a plain set instead of THROWING - an unguarded
     * requestAnimationFrame here took out renderTiles, which took out
     * renderAll, which took out the whole dashboard boot including the
     * queue card that has nothing to do with animation. */
    const countUpTimers = new WeakMap();
    const raf = (window.requestAnimationFrame && typeof window.requestAnimationFrame === 'function')
        ? function (fn) { return window.requestAnimationFrame(fn); }
        : function (fn) { return setTimeout(function () { fn(performanceNow()); }, 16); };
    const cancelRaf = (window.cancelAnimationFrame && typeof window.cancelAnimationFrame === 'function')
        ? function (id) { window.cancelAnimationFrame(id); }
        : function (id) { clearTimeout(id); };
    function performanceNow() {
        return (window.performance && typeof window.performance.now === 'function')
            ? window.performance.now() : Date.now();
    }
    function countUp(el, target) {
        if (!el) return;
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const from = parseInt(el.getAttribute('data-count') || '0', 10) || 0;
        el.setAttribute('data-count', String(target));
        if (reduce || from === target) { el.textContent = String(target); return; }
        const prev = countUpTimers.get(el);
        if (prev) cancelRaf(prev);
        const dur = 550, t0 = performanceNow();
        (function step(t) {
            const k = Math.min(1, (t - t0) / dur);
            const eased = 1 - Math.pow(1 - k, 3);          // ease-out cubic
            el.textContent = String(Math.round(from + (target - from) * eased));
            if (k < 1) countUpTimers.set(el, raf(step));
            else countUpTimers.delete(el);
        })(t0);
    }

    function renderTiles(data) {
        const box = byId('dashTiles');
        if (!box) return;
        const tiles = [
            { cls: 'ent-tile-today', icon: '📅', label: 'Today', bucket: data.today, key: 'today' },
            { cls: 'ent-tile-week', icon: '📈', label: 'This Week', bucket: data.week, key: 'week' },
            { cls: 'ent-tile-month', icon: '📊', label: 'This Month', bucket: data.month, key: 'month' },
            { cls: 'ent-tile-year', icon: '🏆', label: 'This Year', bucket: data.year, key: 'year' }
        ];
        box.innerHTML = tiles.map(function (tile) {
            const n = tile.bucket.patientCount;
            return '<div class="ent-tile ' + tile.cls + '">'
                + '<div class="ent-tile-top">'
                + '<span class="ent-tile-icon" aria-hidden="true">' + tile.icon + '</span>'
                + '<span class="ent-tile-label">' + esc(tile.label) + '</span>'
                + '</div>'
                + '<div class="ent-tile-n"><span class="ent-tile-num">' + n + '</span>'
                + '<small>' + (n === 1 ? 'patient' : 'patients') + '</small></div>'
                + '<div class="ent-tile-sub">' + esc(tileSub(tile.bucket)) + '</div>'
                // Week-over-week trend, on the This-Week tile only - the one
                // number where "vs last week" is the obvious question. Reads
                // data.lastWeek (already computed, no extra query). Shown as a
                // coloured chip: up = green, down = red, equal = neutral grey.
                // Nothing is drawn when last week was empty (a 0 → 5 jump is
                // not a meaningful percentage and would just shout "new!").
                + (tile.key === 'week' ? trendChip(data.week, data.lastWeek) : '')
                + '</div>';
        }).join('');

        // Count-up the big numbers (presentational only). data-count holds the
        // target; countUp() rolls the visible text toward it and stores it back
        // so the next refresh animates from where it landed.
        raf(function () {
            const numEls = box.querySelectorAll('.ent-tile-n');
            tiles.forEach(function (tile, i) {
                const span = numEls[i] ? numEls[i].querySelector('.ent-tile-num') : null;
                if (span) countUp(span, tile.bucket.patientCount);
            });
        });

        const foot = byId('dashStatsFoot');
        if (foot) {
            const m = data.month;
            foot.textContent = 'This month: ' + m.patientCount
                + (m.patientCount === 1 ? ' saved record' : ' saved records')
                + ' from ' + m.reports + (m.reports === 1 ? ' report' : ' reports')
                + ' \u00b7 counted by SAVE date, so every finished save shows up when it was saved'
                + ' \u00b7 a returning patient saved again is counted again.';
        }
    }


    // Render one per-type daily chart. Each day carries its date in the
    // tooltip, while weekend and today styling keep the calendar readable.
    function renderChartInto(chartId, hintId, series, valueOf, color, colorDim, hintLabel, periodLabel) {
        const chart = byId(chartId);
        if (!chart) return;
        const todayKey = dayKeyOf(new Date());
        let max = 1;
        series.forEach(function (s) { max = Math.max(max, valueOf(s.bucket)); });
        chart.innerHTML = series.map(function (s) {
            const value = valueOf(s.bucket);
            const height = value ? Math.max(4, Math.round((value / max) * 150)) : 3;
            const isToday = s.key === todayKey;
            const bar = isToday ? color : colorDim;
            // Day-of-week under the day number. "Today" wins the label on
            // today's column - the one day worth naming outright.
            const dow = new Date(
                Number(s.key.slice(0, 4)),
                Number(s.key.slice(5, 7)) - 1,
                Number(s.key.slice(8, 10))
            ).getDay();
            const weekend = (dow === 0 || dow === 6) ? ' is-weekend' : '';
            const dayClass = 'ent-chart-col' + (isToday ? ' is-today' : '') + weekend;
            return '<div class="' + dayClass + '" title="' + esc(dayLabel(s.key))
                + ' \u00b7 ' + value
                + ' patient(s) \u00b7 ' + s.bucket.reports + ' report(s)">'
                + '<span class="ent-chart-val">' + (value || '') + '</span>'
                + '<div class="ent-chart-stack" style="height:' + height + 'px">'
                + '<span class="ent-chart-seg" style="height:100%;background:' + bar + '"></span>'
                + '</div>'
                + '<span class="ent-chart-x">' + esc(s.key.slice(8)) + '</span>'
                + '<span class="ent-chart-dow' + (isToday ? ' is-today-dow' : '') + '">'
                + (isToday ? 'Today' : WEEKDAY[dow]) + '</span>'
                + '</div>';
        }).join('');
        const hint = byId(hintId);
        if (hint) {
            if (periodLabel) {
                hint.textContent = periodLabel + ' \u00b7 ' + series.length + ' days';
            } else {
                const total = series.reduce(function (sum, s) { return sum + valueOf(s.bucket); }, 0);
                hint.textContent = hintLabel + ' \u00b7 ' + total + ' in the shown ' + CHART_DAYS + ' days';
            }
        }
    }
    function renderChart(series) {
        // Legacy single-chart entry: renders the combined view when the new
        // split containers are absent (older cached index.html).
        renderChartInto('dashChart', 'dashChartHint', series,
            function (b) { return b.patientCount; },
            'var(--primary-color)', 'rgba(14, 165, 233, 0.45)',
            'Distinct patients per day');
    }
    function activityBuckets(rows, fromMs, toMs) {
        const buckets = {};
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const t = typeKey(row);
            if (t !== 'nasal' && t !== 'laryngeal' && t !== 'cf4') continue;
            const ts = row._ts;
            if (ts >= fromMs && ts < toMs) {
                const day = dayKeyOf(new Date(ts));
                if (!buckets[day]) buckets[day] = { types: { nasal: 0, laryngeal: 0, cf4: 0 }, reports: 0 };
                buckets[day].types[t] = (buckets[day].types[t] || 0) + 1;
                buckets[day].reports += 1;
            }
        }
        return buckets;
    }
    // Last 7 days of nasal / laryngeal / cf4, newest first.
    function getActivityDays(rows) {
        const now = new Date();
        const start = startOfDay(addDays(now, -6));
        const from = start.getTime();
        const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
        const buckets = activityBuckets(rows, from, to);
        const list = [];
        for (let i = 6; i >= 0; i--) {
            const day = addDays(startOfDay(now), -i);
            const key = dayKeyOf(day);
            const b = buckets[key] || { types: { nasal: 0, laryngeal: 0, cf4: 0 }, reports: 0 };
            list.push({ key: key, bucket: b });
        }
        return list;
    }
    // Filter ENT report types AND a calendar month/year, for the growth chart.
    // month is 1-based (1 = January) while new Date() months are 0-based, so
    // the window is month-1 .. month - written the other way round, picking
    // October quietly selected the rows saved in November.
    function activityRowsForPeriod(rows, year, month) {
        const y = Number(year);
        const m = Number(month);
        if (isNaN(y) || isNaN(m)) return [];
        const start = new Date(y, m - 1, 1).getTime();
        const end = new Date(y, m, 1).getTime();
        return (rows || []).filter(function (r) {
            const t = typeKey(r);
            if (t !== 'nasal' && t !== 'laryngeal' && t !== 'cf4') return false;
            const ts = r._ts;
            return ts >= start && ts < end;
        });
    }
    // "MM/YYYY" values shown as "October 2026" - the value keeps the compact
    // form the change handler splits, the label says which month it is.
    function buildPeriodOptions(year, month, currentYear, currentMonth) {
        const opts = [];
        const cy = Number(currentYear || new Date().getFullYear());
        const cm = Number(currentMonth || new Date().getMonth());
        for (let y = cy - 1; y <= cy + 1; y++) {
            for (let m = 1; m <= 12; m++) {
                const value = m + '/' + y;
                const active = y === Number(year) && m === Number(month);
                opts.push('<option value="' + value + '"' + (active ? ' selected' : '') + '>'
                    + MONTH_NAMES[m - 1] + ' ' + y + '</option>');
            }
        }
        return opts.join('');
    }
    // Attach the month/year selector to the Activity Growth card head;
    // changing it redraws the whole-month grid + the cloud counters and
    // per-type charts for that period. The Report types card
    // keeps to the live calendar month.
    function renderActivitySelector(year, month) {
        const host = byId('dashPeriod');
        if (!host) return;
        const currentYear = new Date().getFullYear();
        const currentMonth = new Date().getMonth() + 1;
        // Restore the month the user picked before a refresh re-entered here
        // with the live period - a picker that snaps back after 60 seconds
        // is a picker nobody dares to use.
        if (growthPeriod) { year = growthPeriod.y; month = growthPeriod.m; }
        // The <select> MUST have its own id: reusing the host div's
        // "dashPeriod" made getElementById return the DIV (first match in
        // document order), so el.value was undefined - the initial "fire
        // once" skipped, leaving the 7-day fallback painted with no month
        // grid, and the change handler threw on div.value.split, which
        // killed the picker. Unique id => the element is really the select.
        host.innerHTML = '<label for="dashPeriodSelect">Month</label>'
            + '<select id="dashPeriodSelect">' + buildPeriodOptions(year, month, currentYear, currentMonth) + '</select>';
        const el = byId('dashPeriodSelect');
        if (!el) return;
        // The 60s refresh re-runs renderAll with the live month; keep the
        // one the user actually picked instead of snapping back to "now".
        el.addEventListener('change', function () {
            const parts = el.value.split('/');
            growthPeriod = { y: parts[1], m: parts[0] };
            renderActivityPeriod(parts[1], parts[0]);
        });
        // Fire once so the initial selection is rendered.
        if (el.value) {
            const parts = el.value.split('/');
            renderActivityPeriod(parts[1], parts[0]);
        }
    }
    function renderActivityPeriod(year, month) {
        const filtered = activityRowsForPeriod(rows, year, month);
        const draw = function () {
            renderActivityCharts(applyActivitySummary(
                computeActivityData(filtered, year, month)
            ));
        };
        draw();
        if (source !== 'cloud') return;

        const windows = activitySummaryWindows(year, month).filter(function (window) {
            return !cloudSummary || !cloudSummary[window.bucket_key];
        });
        if (!windows.length) return;
        const requestId = ++activitySummaryRequestId;
        activitySummaryError = '';
        requestDashboardSummary(windows).then(function (summary) {
            if (requestId !== activitySummaryRequestId || source !== 'cloud') return;
            cloudSummary = cloudSummary || Object.create(null);
            Object.keys(summary).forEach(function (key) { cloudSummary[key] = summary[key]; });
            activitySummaryError = '';
            draw();
            renderNotices();
        }).catch(function (error) {
            if (requestId !== activitySummaryRequestId) return;
            activitySummaryError = 'Activity Growth could not load exact counts for the selected month.';
            console.warn('[Dashboard] Exact activity-month summary unavailable.', error);
            renderNotices();
        });
    }
    // Activity data for BOTH views: `series` remains the compact 7-day
    // fallback, and `monthSeries` is EVERY day of the selected month -
    // 28/29/30/31 columns - used by the activity charts and Activity Growth.
    // Everything is
    // scoped to the selected month, so choosing October shows October, not
    // today's dates rendered all-zero through a month filter.
    function computeActivityData(rows, year, month) {
        const now = new Date();
        const y = Number(year);
        const m = Number(month);
        const hasPeriod = !isNaN(y) && !isNaN(m) && m >= 1 && m <= 12;
        const selY = hasPeriod ? y : now.getFullYear();
        const selM = hasPeriod ? m : now.getMonth() + 1;
        const monthStart = new Date(selY, selM - 1, 1).getTime();
        const monthEdge = new Date(selY, selM, 1).getTime();    // exclusive
        const daysInMonth = new Date(selY, selM, 0).getDate();  // 28..31
        const emptyDay = function () {
            return { types: { nasal: 0, laryngeal: 0, cf4: 0 }, reports: 0 };
        };
        // The whole month, day 1 to the last - used by all activity charts.
        const monthBuckets = activityBuckets(rows, monthStart, monthEdge);
        const monthSeries = [];
        for (let d = 1; d <= daysInMonth; d++) {
            const key = dayKeyOf(new Date(selY, selM - 1, d));
            monthSeries.push({ key: key, bucket: monthBuckets[key] || emptyDay() });
        }
        // Retain a 7-day fallback for legacy callers without a month picker.
        const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
        let to;                                    // exclusive upper bound
        if (monthStart >= tomorrow) to = new Date(selY, selM - 1, 8).getTime();
        else if (monthEdge <= tomorrow) to = monthEdge;
        else to = tomorrow;
        const from = startOfDay(addDays(new Date(to), -7)).getTime();
        const weekBuckets = activityBuckets(rows, from, to);
        const lastDay = addDays(new Date(to), -1);
        const series = [];
        for (let i = 6; i >= 0; i--) {
            const day = addDays(lastDay, -i);
            const key = dayKeyOf(day);
            series.push({ key: key, bucket: weekBuckets[key] || emptyDay() });
        }
        // The period's save total is what the mix tile shows.
        const keep = rows.filter(function (r) {
            if (typeKey(r) !== 'nasal' && typeKey(r) !== 'laryngeal' && typeKey(r) !== 'cf4') return false;
            const ts = r._ts;
            return ts >= monthStart && ts < monthEdge;
        });
        return {
            series: series,
            monthSeries: monthSeries,
            month: { now: keep, patientCount: 0, reports: keep.length }
        };
    }
    function renderActivityCharts(data) {
        // One full-month chart per report type, in the same order and hues as
        // the Report types card: nasal = sky, laryngeal = indigo, CF4 = green. Nasal and
        // laryngeal used to share one combined chart - split, a quiet week on
        // one form can no longer hide a busy one on the other.
        const monthSeries = data.monthSeries || data.series;
        const firstKey = monthSeries[0] && monthSeries[0].key;
        const periodLabel = firstKey
            ? MONTH_NAMES[Number(firstKey.slice(5, 7)) - 1] + ' ' + firstKey.slice(0, 4)
            : '';
        renderChartInto('dashChartNasal', 'dashChartHintNasal', monthSeries,
            function (b) { return b.types.nasal; },
            'var(--primary-color)', 'rgba(14, 165, 233, 0.45)', 'Nasal patients per day', periodLabel);
        renderChartInto('dashChartLaryngeal', 'dashChartHintLaryngeal', monthSeries,
            function (b) { return b.types.laryngeal; },
            '#6366f1', 'rgba(99, 102, 241, 0.45)', 'Laryngeal patients per day', periodLabel);
        renderChartInto('dashChartCf4', 'dashChartHintCf4', monthSeries,
            function (b) { return b.types.cf4; },
            'var(--success-color)', 'rgba(39, 174, 96, 0.45)', 'CF4 patients per day', periodLabel);
        // The combined Activity Growth card draws the WHOLE selected month:
        // one stacked column per day (28..31) in the three type hues, with
        // the cloud counters above totalling the same month. monthSeries
        // is absent only on the pre-selector paint (computeAll data), where
        // the 7-day series stands in until the picker fires.
        renderGrowthStats(monthSeries);
        renderGrowthChart({ series: monthSeries });
    }

    // Cloud counters + the month's HEADLINE over the same month the chart
    // draws. The three chips were the whole story before: three equal-weight
    // numbers with no total, so "how big was October?" meant adding them in
    // your head. The summary reads as one statement (big total, then the two
    // facts that give it a scale - a per-day rate and the strongest day) and
    // the chips follow as its legend. No rows yet still reads as a calm
    // zero summary, not an empty box.
    function renderGrowthStats(series) {
        const host = byId('dashGrowthStats');
        if (!host) return;
        const totals = { nasal: 0, laryngeal: 0, cf4: 0 };
        let total = 0;
        let best = null;                       // { n, key }
        series.forEach(function (s) {
            const types = (s.bucket && s.bucket.types) || {};
            TYPE_ORDER.forEach(function (t) { totals[t] += types[t] || 0; });
            const n = (s.bucket && s.bucket.reports) || 0;
            total += n;
            if (!best || n > best.n) best = { n: n, key: s.key };
        });
        // Only days the month has PASSED are a fair denominator: averaging
        // October's total over 31 days on the 11th would drag the rate down
        // for days that have not happened yet. A future month (the picker
        // offers them) has no passed days at all - fall back to the series
        // length so the number never divides by zero.
        const today = dayKeyOf(new Date());
        const passed = series.filter(function (s) { return s.key <= today; }).length;
        const denom = passed || series.length || 1;
        const perDay = total ? Math.round((total / denom) * 10) / 10 : 0;
        const cloud = '<svg class="ent-growth-cloud" viewBox="0 0 24 24"'
            + ' aria-hidden="true" focusable="false">'
            + '<path fill="currentColor" d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
        // The headline. "Best day" is 0 when nothing was saved - reporting
        // "best day: the 1st" for an empty month would be a small lie.
        const bestLine = (total && best)
            ? 'Best day ' + esc(best.key.slice(8)) + ' (' + best.n + ')'
            : 'Nothing saved yet';
        const summary = '<div class="ent-growth-total">'
            + '<span class="ent-growth-total-n">' + total + '</span>'
            + '<span class="ent-growth-total-meta">'
            + '<span class="ent-growth-total-label">records this month</span>'
            + '<span class="ent-growth-total-sub">' + perDay + '/day average'
            + ' \u00b7 ' + esc(bestLine) + '</span>'
            + '</span></div>';
        host.innerHTML = summary + TYPE_ORDER.map(function (t) {
            return '<div class="ent-growth-stat is-' + t + '" title="' + esc(TYPES[t].label)
                + ' saved in the shown month">'
                + cloud
                + '<b>' + totals[t] + '</b>'
                + '<span>' + esc(TYPES[t].short) + '</span>'
                + '</div>';
        }).join('');
    }

    // The Activity Growth chart: one column per day of the SELECTED month
    // (28..31 of them), STACKED by report type so the same three hues the
    // split charts use (sky = nasal, indigo = laryngeal, green = CF4) show
    // which form drove the day. The tooltip breaks the day down per type;
    // today's column keeps a lit background.
    function renderGrowthChart(data) {
        const chart = byId('dashChart');
        if (!chart) return;
        const todayKey = dayKeyOf(new Date());
        const hues = { nasal: '#0ea5e9', laryngeal: '#6366f1', cf4: '#27ae60' };
        let max = 1;
        let totalAll = 0;
        data.series.forEach(function (s) {
            const reports = (s.bucket && s.bucket.reports) || 0;
            max = Math.max(max, reports);
            totalAll += reports;
        });
        chart.innerHTML = data.series.map(function (s) {
            const b = s.bucket || {};
            const types = b.types || {};
            const total = b.reports || 0;
            const height = total ? Math.max(4, Math.round((total / max) * 150)) : 3;
            // Share of the COLUMN, not of the scale - the segments add up
            // to the bar's own height whatever the maximum is.
            const segs = TYPE_ORDER.map(function (t) {
                const v = types[t] || 0;
                if (!v) return '';
                return '<span class="ent-chart-seg" style="height:'
                    + ((v / total) * 100) + '%;background:' + hues[t] + '"></span>';
            }).join('');
            const title = dayLabel(s.key) + ' \u00b7 ' + total + ' report(s)'
                + ' \u00b7 Nasal ' + (types.nasal || 0)
                + ' \u00b7 Laryngeal ' + (types.laryngeal || 0)
                + ' \u00b7 CF4 ' + (types.cf4 || 0);
            // Day-of-week under the day number: a month grid is only
            // readable as a CALENDAR when you can see where the weekends
            // fall, and Sat/Sun columns are tinted to match - the clinic's
            // rhythm (busy weekdays, quiet weekends) becomes the shape of
            // the chart instead of noise the reader has to decode.
            const dow = new Date(
                Number(s.key.slice(0, 4)),
                Number(s.key.slice(5, 7)) - 1,
                Number(s.key.slice(8, 10))
            ).getDay();
            const weekend = (dow === 0 || dow === 6) ? ' is-weekend' : '';
            const isToday = s.key === todayKey;
            const cls = 'ent-chart-col' + (isToday ? ' is-today' : '') + weekend;
            return '<div class="' + cls + '" title="' + esc(title) + '">'
                + '<span class="ent-chart-val">' + (total || '') + '</span>'
                + '<div class="ent-chart-stack" style="height:' + height + 'px">' + segs + '</div>'
                + '<span class="ent-chart-x">' + esc(s.key.slice(8)) + '</span>'
                // The weekday label is a separate line so the day number
                // stays in its old slot - nothing about the column widths
                // or the value line moves.
                + '<span class="ent-chart-dow' + (isToday ? ' is-today-dow' : '') + '">'
                + (isToday ? 'Today' : WEEKDAY[dow]) + '</span>'
                + '</div>';
        }).join('');
        // EMPTY MONTH. A row of 28..31 three-pixel stubs reads as a broken
        // chart, not as "no records". The label says what the picture means;
        // the columns stay so the axis (and the layout) is unchanged. The
        // stale copy is removed FIRST - this block runs on every 180s
        // refresh, so inserting without clearing would stack one message
        // per paint.
        const staleEmpty = byId('dashChartEmpty');
        if (staleEmpty) staleEmpty.remove();
        if (!totalAll) {
            chart.insertAdjacentHTML('afterend',
                '<div class="ent-chart-empty" id="dashChartEmpty">'
                + 'No records saved in this month yet.</div>');
        }
        const hint = byId('dashChartHint');
        if (hint && data.series.length) {
            const first = dayLabel(data.series[0].key);
            const last = dayLabel(data.series[data.series.length - 1].key);
            hint.textContent = first + ' \u2013 ' + last
                + ' \u00b7 ' + totalAll + ' saved';
        }
    }
    // The main 14-day chart tiles stay on the counters (today/week/month/year)
    // and are not filtered by the activity period selector - only the ENT
    // growth charts respect it.
    function renderSplitCharts(data) {
        renderActivityCharts(data);
    }

    function renderMix(bucket, periodLabel) {
        const box = byId('dashMix');
        if (!box) return;
        // One hue per report type - the same sky / indigo / green the
        // activity charts and the header scope chips already use. Kept as
        // literal hex so the tinted icon badge can carry the same colour.
        const colors = {
            nasal: '#0ea5e9',
            laryngeal: '#6366f1',
            cf4: '#27ae60',
            abstract: '#f59e0b',
            medicalCertificate: '#64748b'
        };
        const tints = {
            nasal: 'rgba(14, 165, 233, 0.15)',
            laryngeal: 'rgba(99, 102, 241, 0.15)',
            cf4: 'rgba(39, 174, 96, 0.15)',
            abstract: 'rgba(245, 158, 11, 0.15)',
            medicalCertificate: 'rgba(100, 116, 139, 0.13)'
        };
        const types = bucket.types || {};
        // The shares add
        // up over their own sum - not over bucket.reports, which also
        // carries "other" rows this dashboard has no tile for.
        const total = TYPE_ORDER.reduce(function (s, t) { return s + (types[t] || 0); }, 0);
        const hint = byId('dashMixHint');
        if (hint) {
            hint.textContent = periodLabel + ' \u00b7 ' + total
                + ' report' + (total === 1 ? '' : 's');
        }
        if (!total) {
            box.innerHTML = '<p class="ent-empty">No reports saved ' + esc(periodLabel.toLowerCase()) + ' yet.</p>';
            return;
        }
        // Proportion bar first: one glance shows the month's SHAPE (mostly
        // laryngeal? balanced?) before the eye commits to reading the
        // individual cards. Same hues as the bars below, so the summary and
        // the detail are visibly the same data.
        const mixBar = '<div class="ent-mix-summary" title="Share of ' + esc(periodLabel.toLowerCase()) + ' reports">'
            + TYPE_ORDER.filter(function (t) { return (types[t] || 0) > 0; }).map(function (t) {
                return '<span class="ent-mix-summary-seg" style="flex:' + (types[t] || 0)
                    + ';background:' + colors[t] + '"></span>';
            }).join('')
            + '</div>';
        box.innerHTML = mixBar + TYPE_ORDER.map(function (t) {
            const n = types[t] || 0;
            const pct = Math.round((n / total) * 100);
            // The type's own hue rides along as --ent-hue so CSS can tint
            // the hover and the % badge without a class per type.
            return '<div class="ent-mix-item' + (n ? '' : ' is-empty') + '" style="--ent-hue:' + colors[t] + ';--ent-tint:'
                + tints[t] + '">'
                + '<div class="ent-mix-head">'
                + '<span class="ent-mix-ic" style="background:' + tints[t]
                + ';color:' + colors[t] + '">' + TYPES[t].icon + '</span>'
                + '<span class="ent-mix-label">' + esc(TYPES[t].label) + '</span>'
                + '</div>'
                + '<div class="ent-mix-stats">'
                + '<span class="ent-mix-val"><b>' + n + '</b><small>reports</small></span>'
                + '<i class="ent-mix-share">' + pct + '%</i>'
                + '</div>'
                + '<div class="ent-mix-bar"><span style="width:' + pct
                + '%;background:' + colors[t] + '"></span></div>'
                + '</div>';
        }).join('') + '<div class="ent-mix-note">Counted by save date.</div>';
    }

    function renderReportMixPeriod(period) {
        const selected = period === '7days' || period === 'year' ? period : 'month';
        reportMixPeriod = selected;
        const select = byId('dashMixPeriod');
        if (select) select.value = selected;
        const requestId = ++reportMixRequestId;
        reportMixSummaryError = '';
        const range = reportMixRange(selected, new Date());
        const localBucket = selected === 'month' && dashboardData
            ? dashboardData.month
            : bucketBetween(range.start.getTime(), range.end.getTime());
        const label = range.label;

        if (selected === 'month' && source === 'cloud' && cloudSummary) {
            renderMix(bucketFromSummary(cloudSummary, 'month') || localBucket, label);
            return;
        }
        if (reportMixSummaryCache[selected]) {
            renderMix(reportMixSummaryCache[selected], label);
            return;
        }
        renderMix(localBucket, label);
        if (source !== 'cloud') return;

        requestDashboardSummary([{
            bucket_key: range.key,
            starts_at: range.start.toISOString(),
            ends_at: range.end.toISOString()
        }]).then(function (summary) {
            if (requestId !== reportMixRequestId || selected !== reportMixPeriod) return;
            const exact = bucketFromSummary(summary, range.key);
            if (!exact) throw new Error('The database returned no report type counts for the selected period.');
            reportMixSummaryCache[selected] = exact;
            reportMixSummaryError = '';
            renderMix(exact, label);
            renderNotices();
        }).catch(function (error) {
            if (requestId !== reportMixRequestId || selected !== reportMixPeriod) return;
            reportMixSummaryError = 'The exact counts could not be loaded. Showing counts from the newest '
                + ROW_LIMIT.toLocaleString() + ' loaded records.';
            console.warn('[Dashboard] Exact report type summary unavailable.', error);
            renderMix(localBucket, label);
            renderNotices();
        });
    }

    // Patients list (dashRecent): one visual row per patient, and up to
    // three database records are wrapped in a single row when they belong
    // to the same patient and report type - the common case where a visit
    // produced a nasal + laryngeal + cf4 set on the same day.
    function patientKey(row) {
        const pid = String(row.patient_id || '').trim();
        const name = String(row.patient_name || '').trim().toLowerCase();
        const file = String(row.file_name || '').trim().toLowerCase();
        if (pid) return 'id:' + pid;
        if (name) return 'nm:' + name;
        if (file) return 'fl:' + file;
        return 'row:' + String(row.created_at || '');
        return 'row:' + String(row.created_at || '');
    }
    function reportTypeLabel(row) {
        const t = typeKey(row);
        return TYPES[t] ? TYPES[t].label : 'Other report';
    }
    function groupKey(row) {
        return patientKey(row) + '|' + typeKey(row);
    }
    function buildGroupedRows(rows) {
        const groups = [];
        const bucket = { rows: [], key: null };
        const flush = function () {
            if (bucket.rows.length) {
                groups.push({
                    key: bucket.key,
                    rows: bucket.rows.slice(),
                    patient: patientKey(bucket.rows[0])
                });
            }
            bucket.rows = [];
            bucket.key = null;
        };
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const k = groupKey(row);
            if (bucket.rows.length && k !== bucket.key) flush();
            if (!bucket.rows.length) bucket.key = k;
            bucket.rows.push(row);
            if (bucket.rows.length === 3) flush();
        }
        flush();
        return groups;
    }
    /* WHEN THIS RECORD WAS SAVED - the small right-hand line of a Latest
       patients row, so a doctor or secretary can see at a glance how fresh
       the entry is without opening it.

       Two shapes reach here: cloud rows carry ISO strings in created_at /
       updated_at, device rows carry epoch MILLISECONDS (PatientRecords
       stamps Date.now(), so Date.parse() would return NaN on them - the
       number path is not a nicety, it is the only one that works offline).
       updated_at wins when present: it is the LAST save. An empty string
       means there is no honest timestamp - the badge is then omitted
       entirely rather than inventing a 12:00 AM. */
    function toMs(v) {
        if (typeof v === 'number' && isFinite(v)) return v;
        if (typeof v === 'string' && v.trim()) {
            if (/^\d+$/.test(v.trim())) {
                const n = Number(v.trim());
                if (isFinite(n)) return n;
            }
            const t = Date.parse(v);
            if (!isNaN(t)) return t;
        }
        return 0;
    }
    /* Structured ENTRY stamp for the redesigned row: date on one line,
       clock + relative age on the second, full stamp in the title.
       One shape serves both the flat list and the admin per-clinic rows
       so "when was this entered?" reads identically everywhere. */
    function entryStamp(row) {
        const ms = toMs(row && (row.updated_at || row.created_at));
        if (!ms) return null;
        const d = new Date(ms);
        if (isNaN(d.getTime())) return null;
        const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        const clock = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        return {
            ms: ms,
            date: date,
            clock: clock,
            rel: relTime(ms),
            title: 'Entered ' + d.toLocaleString(undefined, {
                month: 'short', day: 'numeric', year: 'numeric',
                hour: 'numeric', minute: '2-digit'
            })
        };
    }

    /* The VISIT date, labelled and humanised. The card shows TWO days per
       row - the visit and the save - and a raw ISO "2026-10-05" printed in
       the meta line read like a second save stamp right beside "Saved Oct
       5, 3:42 PM". Nobody could tell which day was which. Prefixing the
       word "Visit" and printing "Oct 5, 2026" makes the two unmistakable,
       so the save stamp on the right is finally the only thing that answers
       "when was this entered?". An unrecognised shape is returned as-is
       rather than dropped: a date the form stored oddly is still worth
       seeing, never silently hidden. */
    function visitDateLabel(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
        if (!m) return raw;
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        if (isNaN(d.getTime())) return raw;
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function recentFilterState() {
        const search = String((byId('dashRecentSearch') || {}).value || '').trim().toLowerCase();
        const from = String((byId('dashRecentFrom') || {}).value || '').trim();
        const to = String((byId('dashRecentTo') || {}).value || '').trim();
        const type = String((byId('dashRecentType') || {}).value || '').trim();
        const site = String((byId('dashRecentSite') || {}).value || '').trim();
        const active = !!(search || from || to || type || site);
        const filtered = rows.filter(function (row) {
            const name = String(row.patient_name || '').toLowerCase();
            const id = String(row.patient_id || '').toLowerCase();
            const rawDate = String(row.procedure_date || '').slice(0, 10);
            const visitDate = isValidVisitDate(rawDate) ? rawDate : '';
            return (!search || name.indexOf(search) !== -1 || id.indexOf(search) !== -1)
                && (!from || (visitDate && visitDate >= from))
                && (!to || (visitDate && visitDate <= to))
                && (!type || typeKey(row) === type)
                && (!site || siteOf(row) === site);
        });
        return { active: active, filtered: filtered };
    }

    function renderRecent() {
        const box = byId('dashRecent');
        if (!box) return;
        const result = recentFilterState();
        const matching = result.filtered;
        const adminView = isAdminView();
        const displayItems = adminView ? matching : buildGroupedRows(matching);
        const pageCount = Math.max(1, Math.ceil(displayItems.length / recentPageSize));
        recentPage = Math.min(recentPage, pageCount - 1);
        const start = recentPage * recentPageSize;
        const list = displayItems.slice(start, start + recentPageSize);
        const end = start + list.length;
        const unit = adminView ? 'reports' : 'patient rows';
        const pageInfo = byId('dashRecentPageInfo');
        if (pageInfo) {
            pageInfo.textContent = displayItems.length
                ? (start + 1) + '\u2013' + end + ' of ' + displayItems.length + ' ' + unit + ' \u00b7 Page '
                    + (recentPage + 1) + ' of ' + pageCount
                : '0 ' + unit;
        }
        const previous = byId('dashRecentPrev');
        const next = byId('dashRecentNext');
        if (previous) previous.disabled = recentPage === 0;
        if (next) next.disabled = recentPage >= pageCount - 1;
        const resultLabel = byId('dashRecentResult');
        if (resultLabel) {
            resultLabel.textContent = result.active
                ? matching.length + ' matching report(s)'
                : rows.length
                    ? matching.length + ' report(s)'
                    : 'No reports loaded';
        }
        if (!list.length) {
            box.innerHTML = result.active
                ? '<div class="ent-empty">No reports match these filters. Try changing or clearing the filters.</div>'
                : '<div class="ent-empty">No patient yet. Start a report with a quick action above and it shows up here right away.</div>';
            return;
        }
        // The avatar's is-<type> class carries the report-type hue now, so
        // this map is retired with the old dot style.

        // Admin mode shows a per-clinic breakdown: one headed block per clinic
        // (clinic name, patient count, hospital) followed by THAT CLINIC'S
        // records - each row naming the patient, the report, the save time and
        // the secretary or doctor who created it. Non-admins keep the flat
        // "latest records" list (single clinic), so their view is unchanged.
        if (adminView) {
            // Group by clinic_id in first-seen order (rows are newest first, so
            // the first row of each clinic is that clinic's newest patient).
            // Rows with no clinic at all (the device fallback stamps none) are
            // gathered under '' - the head then reads "Clinic" rather than a
            // uuid slice, which is still more honest than an empty card.
            const order = [];
            const byClinic = new Map();
            for (const row of list) {
                const id = String(row.clinic_id || '').trim();
                if (!byClinic.has(id)) {
                    byClinic.set(id, []);
                    order.push(id);
                }
                byClinic.get(id).push(row);
            }
            const clinics = order.map(function (id) {
                const rows = byClinic.get(id);
                const latest = rows[0];
                const latestIndex = list.indexOf(latest);
                return { id: id, rows: rows, latest: latest, order: latestIndex };
            }).sort(function (a, b) { return a.order - b.order; });

            box.innerHTML = '<div class="ent-recent-group">' + clinics.map(function (c) {
                const members = c.rows;
                const latest = c.latest;
                const creator = latest ? authorLabel(latest) : 'Someone';
                const role = isAdminView() ? creatorRole(latest) : '';
                // The hospital the newest patient was actually seen at (RMCI /
                // CUMC). A clinic is a team, a hospital is a building - an
                // admin needs both to answer "where was this patient seen".
                const site = siteBadge(latest);
                return '<div class="ent-clinic-head">'
                    + '<span class="ent-clinic-name">' + esc(clinicName(c.id)) + '</span>'
                    + '<span class="ent-clinic-count">' + members.length + ' patient' + (members.length === 1 ? '' : 's') + '</span>'
                    + (site ? '<span class="ent-clinic-site">' + site + '</span>' : '')
                    + '<span class="ent-clinic-makers">' + (role ? esc(role) + ' ' : '') + '<b>saved by ' + esc(creator) + '</b></span>'
                    + '</div>'
                    // EVERY record of this clinic, not only the newest one:
                    // the point of the card is knowing who saved WHICH
                    // patient, so each row carries its own save time and its
                    // own author - the second-oldest entry would otherwise be
                    // invisible behind the first.
                    + '<div class="ent-recent">'
                    + members.map(function (member) {
                        const stamp = entryStamp(member);
                        const memberCreator = authorLabel(member);
                        const memberRole = creatorRole(member);
                        // The VISIT day lives ONLY here as a dim "Visit ..."
                        // sub-line - the ENTRY stamp on the right is the only
                        // thing that answers "when was this entered?".
                        const memberVisit = visitDateLabel(member.procedure_date);
                        const memberMeta = reportTypeLabel(member)
                            + (memberVisit ? ' \u00b7 Visit ' + memberVisit : '');
                        const t = typeKey(member);
                        const who = isMine(member) ? 'Me' : memberCreator;
                        return '<div class="ent-clinic-row is-' + esc(t) + '"'
                            + (stamp ? ' title="' + esc(stamp.title) + ' · saved by ' + esc(who) + '"' : '') + '>'
                            + '<span class="ent-recent-av is-' + esc(t) + '">'
                            + esc(initialsOf(String(displayNameOf(member) || '?').replace(HONORIFIC, ''))) + '</span>'
                            + '<span class="ent-clinic-main"><span class="ent-clinic-name">'
                            + esc(displayNameOf(member)) + '</span>'
                            + '<span class="ent-clinic-pts">' + esc(memberMeta) + '</span>'
                            + '<span class="ent-clinic-by">Entered by ' + esc(who)
                            + (memberRole ? ' · ' + esc(memberRole) : '')
                            + '</span></span>'
                            + (siteBadge(member) ? '<span class="ent-clinic-site">' + siteBadge(member) + '</span>' : '')
                            + (stamp ? '<span class="ent-recent-entry"><span class="ent-recent-entry-label">Entered</span><span class="ent-recent-entry-date">'
                            + esc(stamp.date) + '</span><span class="ent-recent-entry-time">'
                            + esc(stamp.clock) + ' \u00b7 ' + esc(stamp.rel) + '</span></span>' : '')
                            + '</div>';
                    }).join('')
                    + '</div>';
            }).join('') + '</div>';
            return;
        }

        const groups = list;
        box.innerHTML = groups.map(function (g) {
            const members = g.rows;
            const t = typeKey(members[0]);
            // Same patient + same type share one row, so the names and
            // report labels are de-duplicated: "Juan, Juan, Juan" and
            // "Nasal, Nasal, Nasal" were the old confusing read.
            const uniqNames = [];
            members.forEach(function (m) {
                const n = displayNameOf(m);
                if (uniqNames.indexOf(n) === -1) uniqNames.push(n);
            });
            const names = uniqNames.map(function (n) { return esc(n); }).join('<br>');
            const uniqTypes = [];
            members.forEach(function (m) {
                const l = reportTypeLabel(m);
                if (uniqTypes.indexOf(l) === -1) uniqTypes.push(l);
            });
            const reportTypes = uniqTypes.join(', ');
            // The VISIT day lives ONLY in this dim sub-line - the ENTRY
            // stamp on the right is the only thing that answers
            // "when was this entered?".
            const visit = visitDateLabel(members[0].procedure_date);
            const meta = reportTypes + (visit ? ' \u00b7 Visit ' + visit : '');
            // members[0] is the newest of the group (rows are sorted newest
            // first), so its timestamp is the group's last save.
            const stamp = entryStamp(members[0]);
            const whoRaw = authorLabel(members[0]);
            const who = isMine(members[0]) ? 'Me' : whoRaw;
            const role = creatorRole(members[0]);
            // Which hospital this patient was seen at (RMCI / CUMC), when the
            // record carries the tag at all. This flat list is what a doctor
            // or secretary sees on index.html, so the hospital has to show up
            // here too - not only on the admin's per-clinic card above.
            const site = siteBadge(members[0]);
            const patInitials = initialsOf(String(uniqNames[0] || '?').replace(HONORIFIC, ''));
            return '<div class="ent-recent-row is-' + esc(t) + '"'
                + (stamp ? ' title="' + esc(stamp.title) + ' · entered by ' + esc(who) + '"' : '') + '>'
                + '<span class="ent-recent-av is-' + esc(t) + '">' + esc(patInitials) + '</span>'
                + '<span class="ent-recent-main"><span class="ent-recent-name">' + names + '</span>'
                + '<span class="ent-recent-meta">' + esc(meta) + '</span>'
                + '<span class="ent-recent-by">Entered by ' + esc(who)
                + (role ? ' \u00b7 ' + esc(role) : '') + '</span></span>'
                + (site ? '<span class="ent-recent-site">' + site + '</span>' : '')
                + (stamp ? '<span class="ent-recent-entry"><span class="ent-recent-entry-label">Entered</span><span class="ent-recent-entry-date">'
                + esc(stamp.date) + '</span><span class="ent-recent-entry-time">'
                + esc(stamp.clock) + ' \u00b7 ' + esc(stamp.rel) + '</span></span>' : '')
                + (members.length > 1 ? '<span class="ent-recent-count" title="' + members.length + ' records grouped under this patient">×' + members.length + '</span>' : '')
                + '</div>';
        }).join('');
    }


    function renderActionSummary() {
        const host = byId('dashActionItems');
        if (!host) return;
        const queueKnown = queueLoaded && !queueError;
        const review = queueKnown ? queueLists().review.length : null;
        const offlineKnown = !!offlineStats && offlineStats.engine !== 'unavailable';
        const pending = offlineKnown
            ? Math.max(Number(offlineStats.pending) || 0, Number(offlineStats.unsynced) || 0)
            : null;
        function item(label, value, detail, href, kind) {
            const state = value === null ? 'is-unknown' : value > 0 ? 'is-action' : 'is-clear';
            const count = value === null ? '—' : String(value);
            const contents = '<span class="ent-action-count">' + esc(count) + '</span>'
                + '<span class="ent-action-copy"><b>' + esc(label) + '</b>'
                + '<small>' + esc(detail) + '</small></span>';
            const classes = 'ent-action-item ' + state + (kind ? ' is-' + kind : '');
            return href && value !== 0
                ? '<a class="' + classes + '" href="' + esc(href) + '">' + contents + '</a>'
                : '<div class="' + classes + '">' + contents + '</div>';
        }

        const offlineDetail = pending === null
            ? 'Device sync status unavailable'
            : pending
                ? 'Saved on this device; waiting for cloud sync'
                : 'No unsynced reports on this device';
        const reviewDetail = review === null
            ? 'Team review status unavailable'
            : review
                ? 'Teammate reports waiting for your review'
                : 'No reports waiting for review';
        host.innerHTML = [
            item('Team review', review, reviewDetail, '#dashQueueCard', 'review'),
            item('Offline sync', pending, offlineDetail, pageUrl('offlineWorkspace.html'), 'offline')
        ].join('');
        const hint = byId('dashActionHint');
        if (hint) {
            const known = review !== null && pending !== null;
            hint.textContent = known
                ? 'Walk-in workflow \u00b7 counts use records visible to this account'
                : 'Some checks need an online connection or a local sync-status read';
        }
    }


    /* --------------------------- team queue -------------------------- */
    // What the OTHER person in this doctor/secretary pair is busy with:
    //   Needs review - their records that are not in the database yet
    //   Saved        - their records already stored in the shared database
    // Scoped exactly like the counters: a doctor only sees his secretaries,
    // a secretary only her doctor.
    let queueTab = 'review';
    let queueRows = [];
    let queueError = '';
    let queueLoaded = false;
    let showAllPatients = false;     // secretary: reveal the saved patients on tap
    /* HOW MANY ROWS BEFORE "View all".
       This was 30, which is not a preview - it is nearly the whole list, and
       a secretary with a busy doctor got a card that ran most of the way down
       the dashboard before the next card. Five is enough to recognise "there
       is work here" and short enough that the card stays a card.

       The remaining rows are NOT discarded: "View all" reveals them and the
       box scrolls. queueExpanded is the whole feature - one boolean, one
       button, and the same data either way. */
    const QUEUE_PREVIEW = 5;
    let queueExpanded = false;
    const QUEUE_LIMIT = 400;          // hard ceiling only; the preview gates it
    const QUEUE_DAYS = 60;
    const QUEUE_POLL_MS = 60000;   // the queue is what people wait for, so it
                                   // polls on its own, faster than the counters
                                   // - but halved from 30s for the same free-plan
                                   // egress reason as REFRESH_MS above. A minute
                                   // is still well under how long a secretary
                                   // takes to look up from one task to the next.

    async function loadQueueRows() {
        if (!window.EntSupabase || !window.EntSupabase.isConfigured()) {
            throw new Error('The cloud database is not configured on this device.');
        }
        // v2: no clinic filter, no doctor filter — RLS decides (see loadCloudRows).
        const from = new Date(Date.now() - QUEUE_DAYS * 86400000).toISOString();
        const plain = 'record_key,created_by,doctor_id,clinic_id,report_type,patient_name,case_number,'
            + 'procedure_date,created_at,updated_at';
        // TWO defects, both of which stopped this query from ever reaching the
        // database:
        //   1. apiRequest() does `/rest/v1` + `/<endpoint>` - it never inserts
        //      a `?`. The first parameter therefore has to start with `?`, as
        //      loadCloudRows() two hundred lines up already does. `reports&created_at=...`
        //      is a malformed path.
        //   2. `scope` was never declared in this file (the other `scope`es
        //      belong to other modules' own closures). Reading it threw
        //      ReferenceError while evaluating the argument, so `api()` was
        //      never called and the catch block - which read `scope` again -
        //      rethrew. loadQueueRows() rejected, queueError was set, and the
        //      secretary's "New patients from your doctor" card showed an
        //      error instead of a single patient. The doctor's own queue and
        //      the hero pill went with it.
        // There is no client-side scoping to build here in v2: ent_may_touch_report()
        // answers "who may see this row" inside the policy.
        const endpoint = function (extra) {
            return 'reports'
                + '?created_at=gte.' + encodeURIComponent(from)
                + '&select=' + plain + extra
                + '&order=created_at.desc&limit=400';
        };
        let result;
        try {
            // payload->dbSaved says whether it reached "Save to Database";
            // created_by_name (0028) is the author's display name beside the
            // uuid. BOTH in one shot, then TWO fallbacks so a database that
            // has not run 0028 keeps today's exact behaviour (draft flag
            // intact, author shown by the old path) instead of a400.
            result = await api(endpoint(',payload->dbSaved,payload->>draftShared,created_by_name'));
        } catch (e) {
            try {
                result = await api(endpoint(',payload->dbSaved'));
            } catch (e2) {
                // Fallback for a schema the jsonb path cannot resolve. Everything
                // then reads as not-yet-saved, which shows drafts rather than
                // hiding them - the safe direction to fail in.
                result = await api(endpoint(''));
            }
        }
        // Same second opinion as the counters: a queue is a LIST OF PATIENTS,
        // so an over-wide response here is more visible and more alarming than
        // a number being slightly too big. Filtered here too, and the notice
        // on the counters will already have said how many were hidden.
        const mapped = (Array.isArray(result) ? result : []).map(function (row) {
            return {
                record_key: row.record_key || '',
                created_by: row.created_by || '',
                created_by_name: row.created_by_name || '',
                doctor_id: row.doctor_id || '',
                clinic_id: row.clinic_id || '',
                report_type: row.report_type || '',
                patient_name: row.patient_name || '',
                case_number: row.case_number || '',
                procedure_date: row.procedure_date || '',
                created_at: row.created_at || row.updated_at || '',
                updated_at: row.updated_at || row.created_at || '',

                saved: row.dbSaved === true || row.dbSaved === 'true',
                // draftShared marks a row the drafts browser uploaded WITH its
                // form. The background sync also writes is_draft = TRUE rows
                // carrying metadata only, and there is nothing in those to
                // open - so they are not work waiting for anybody.
                draftShared: row.draftShared === true || row.draftShared === 'true'
            };
        }).filter(function (r) {
            // A finished record, or a draft somebody can actually open. A
            // formless draft stub is neither, and listing it put "waiting for
            // review" items in the queue that could only ever dead-end.
            return r.saved || r.draftShared;
        });
        return splitByScope(mapped).kept;
    }


    // Map a creator row -> "Doctor"/"Secretary" (the human-readable role).
    // The stored role is the source of truth: rows only carry the author's id,
    // so we resolve staff_profiles once per browser session. A cross-clinic
    // admin may not see every doctor's staff row, so a miss simply falls back to
    // the name (still correct attribution, just without the role pill).
    function creatorRole(row) {
        const map = staffProfileMap;
        if (!map) return '';
        const id = String((row && row.created_by) || '').trim();
        if (id) {
            const p = map[id];
            if (p) {
                if (p.role === 'secretary') return 'Secretary';
                if (p.role === 'doctor') return 'Doctor';
            }
        }
        return '';
    }

    /* ------------------- "my team just finished this" ------------------ */
    // A doctor wants to know the secretary already finished the patient form.
    // A row is "fresh" when somebody else touched it in the last 24 hours and
    // this device has not marked it as reviewed yet.
    const REVIEWED_KEY = 'entDashReviewedRecordsV1';
    const FRESH_MS = 24 * 3600 * 1000;
    let reviewedKeys = [];

    function readReviewed() {
        try {
            const parsed = JSON.parse(localStorage.getItem(REVIEWED_KEY) || '[]');
            reviewedKeys = Array.isArray(parsed) ? parsed : [];
        } catch (e) { reviewedKeys = []; }
    }
    function stampOf(row) { return (row.record_key || '') + '|' + (row.updated_at || ''); }
    function isReviewed(row) { return reviewedKeys.indexOf(stampOf(row)) !== -1; }
    function markReviewed(row) {
        const stamp = stampOf(row);
        if (reviewedKeys.indexOf(stamp) === -1) reviewedKeys.push(stamp);
        reviewedKeys = reviewedKeys.slice(-200);
        try { localStorage.setItem(REVIEWED_KEY, JSON.stringify(reviewedKeys)); } catch (e) { /* ignore */ }
    }
    function freshEdits() {
        const now = Date.now();
        return queueRows.filter(function (row) {
            if (isMine(row)) return false;
            const ts = Date.parse(row.updated_at || row.created_at || '');
            if (isNaN(ts) || (now - ts) > FRESH_MS) return false;
            return !isReviewed(row);
        }).sort(function (a, b) {
            return String(b.updated_at).localeCompare(String(a.updated_at));
        });
    }

    function isMine(row) {
        const who = String(row.created_by || '').trim();
        if (!who || !me) return false;
        // v2 rows carry the author's UUID; v1 rows a username. Matching
        // only the username (the old code) meant isMine was NEVER true on
        // a v2 row - the doctor's own drafts showed under his team, and
        // the "Me" chip never appeared.
        if (who.toLowerCase() === String(me.id || '').toLowerCase()) return true;
        return !!(myName && who.toLowerCase() === myName);
    }

    // The queue's "who" column. created_by is a UUID in v2, and neither
    // readUserCache() (retired) nor RLS (profiles_select_self) lets the
    // browser resolve it, so the name rides on the row itself:
    // created_by_name, stamped by 0028 next to the id. The team list
    // fetched from rpc/my_secretaries is a second source for the people
    // this card is mostly about; a v1 username row prettifies itself;
    // a bare unknown uuid NEVER prints - it reads as "Someone".
    function authorLabel(row) {
        const stamped = String((row && row.created_by_name) || '').trim();
        if (stamped) return prettyName(stamped);
        const raw = String((row && row.created_by) || '').trim();
        if (!raw) return 'Someone';
        const teamHit = (teamRows || []).filter(function (u) {
            return u && String(u.id || '').toLowerCase() === raw.toLowerCase();
        })[0];
        if (teamHit) return prettyName(teamHit.full_name || teamHit.username || raw);
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return 'Someone';
        return userDisplayName(raw);
    }

    function queueLists() {
        const team = queueRows.filter(function (r) { return !isMine(r); });
        return {
            review: team.filter(function (r) { return !r.saved; }),
            saved: team.filter(function (r) { return r.saved; }),
            all: queueRows.slice()
        };
    }

    // created_by holds a username - show the person's real name when this
    // page knows it (a doctor then sees "Joy Pineda", not "joy").
    // The old source was Auth.readUserCache(), which v2 retired to a
    // permanent [] (see auth.js), so every queue row quietly lost its real
    // name too. The team list fetched below from rpc/my_secretaries knows
    // the full names of this doctor's own secretaries - the people his
    // queue can be about - and anybody else falls through to the readable
    // form of the username exactly as before.
    function userDisplayName(username) {
        const name = String(username || '').trim();
        if (!name) return 'Someone';
        const hit = (teamRows || []).filter(function (u) {
            return u && String(u.username || '').trim().toLowerCase() === name.toLowerCase();
        })[0];
        return prettyName((hit && (hit.full_name || hit.username)) || name);
    }

    /* THE ROW, REDESIGNED (v33an) — same grid contract (av / main / flags /
       action), same data, prettier read:
         · the avatar wears the REPORT TYPE's hue (sky / indigo / green,
           same three the mix chart and growth stats use) instead of only
           the saved/review tint, and the meta line leads with a coloured
           type chip, so a scan for "which of these are CF4?" is one glance
         · the by-line shows RELATIVE time ("2 h ago") with the exact stamp
           kept in the row's title - a live queue is about what is recent
         · the status pill gains the pulsing .dot the auth.css pill already
           defines, so "Waiting" visibly waits and "In database" stays calm  */
    function queueRowHtml(row) {
        const t = typeKey(row);
        const meta = TYPES[t] || { label: 'Other report', short: 'Other', page: '', icon: '\u2022' };
        const who = isMine(row) ? 'Me' : authorLabel(row);
        const ts = Date.parse(row.created_at || '');
        const action = (meta.page && row.record_key)
            ? '<button type="button" class="ent-queue-open" data-qkey="' + esc(row.record_key)
              + '" data-qtype="' + esc(t)
              + '" data-qpatient="' + esc(row.patient_name)
              + '" data-qauthor="' + esc(who) + '"'
            + (row.saved
                ? ' title="Open this saved record in the form and edit it">&#9998; Open &amp; edit</button>'
                : ' title="Not in the database yet - the form will show the details">&#128065; View details</button>')
            : '';
        return '<div class="ent-queue-row ' + (row.saved ? 'is-saved' : 'is-review')
            + (isMine(row) ? ' is-mine' : '') + '"'
            + (isNaN(ts) ? '' : ' title="' + esc(fmtTime(row.created_at)) + '"') + '>'
            + '<span class="ent-queue-av is-' + esc(t) + '">' + esc(initialsOf(who.replace(HONORIFIC, ''))) + '</span>'
            + '<span class="ent-queue-main">'
            + '<span class="ent-queue-name">' + esc(displayNameOf(row)) + '</span>'
            + '<span class="ent-queue-meta"><span class="ent-qtype is-' + esc(t) + '">'
            + esc(meta.icon + ' ' + (meta.short || meta.label)) + '</span>'
            + (row.procedure_date ? ' <span class="ent-qsep">\u00b7</span> ' + esc(row.procedure_date) : '')
            + (row.case_number ? ' <span class="ent-qsep">\u00b7</span> Case ' + esc(row.case_number) : '') + '</span>'
            + '<span class="ent-queue-by">' + esc(who) + ' \u00b7 '
            + esc(isNaN(ts) ? fmtTime(row.created_at) : relTime(ts)) + '</span>'
            + '</span>'
            + '<span class="ent-queue-flags">'
            + (row.saved
                ? '<span class="ent-pill live"><span class="dot"></span>In database</span>'
                : '<span class="ent-pill wait"><span class="dot"></span>Waiting for save</span>')
            + '</span>'
            + action
            + '</div>';
    }

    function freshEditHtml(row) {
        const t = typeKey(row);
        const meta = TYPES[t] || { label: 'Other report', icon: '\u2022' };
        const who = authorLabel(row);
        const when = relTime(Date.parse(row.updated_at || row.created_at || '') || 0);
        return '<div class="ent-fresh-row">'
            + '<span class="ent-fresh-main">'
            + '<b>' + esc(displayNameOf(row)) + '</b>'
            + '<small>' + esc(meta.icon + ' ' + meta.label + ' \u00b7 ' + who + ' \u00b7 ' + when) + '</small>'
            + '</span>'
            // View reuses the same deep link as the queue rows below.
            + '<button type="button" class="ent-fresh-view" data-qkey="' + esc(row.record_key)
            + '" data-qtype="' + esc(t)
            + '" data-qpatient="' + esc(row.patient_name)
            + '" data-qauthor="' + esc(who)
            + '" title="Open this record in the form">&#128065; View</button>'
            + '<button type="button" class="ent-fresh-ok" data-review="' + esc(row.record_key)
            + '" title="Mark as done here" aria-label="Mark as done">&#10003;</button>'
            + '</div>';
    }

    /* THE PREVIEW GATE.
       One place decides how many rows a list shows, so the button's count and
       the rows on screen can never disagree - which is the failure mode when
       the cap lives inside each renderer. */
    function previewRows(rows) {
        if (queueExpanded) return rows.slice(0, QUEUE_LIMIT);
        return rows.slice(0, QUEUE_PREVIEW);
    }
    function hiddenIn(rows) {
        return queueExpanded ? 0 : Math.max(0, rows.length - QUEUE_PREVIEW);
    }

    // Secretary: waiting drafts only, until "View patients" is tapped.
    // The two sections are TONE-CODED (is-wait amber, is-saved green) so the
    // count chips read as the same status as the rows under them.
    function secretaryList(lists) {
        const section = function (label, rows, empty, tone) {
            return '<p class="ent-queue-section' + (tone ? ' is-' + tone : '') + '">' + label + ' <b>' + rows.length + '</b></p>'
                + (rows.length
                    ? previewRows(rows).map(queueRowHtml).join('')
                    : '<p class="ent-queue-subempty">' + empty + '</p>');
        };
        const waiting = section('&#9203; Waiting for review', lists.review, 'Nothing waiting right now \uD83C\uDF89', 'wait');
        if (!showAllPatients) return waiting;
        return waiting + section('&#9989; Saved by your doctor', lists.saved,
            'Your doctor has not saved any patients yet.', 'saved');
    }

    // Doctor: the tab he is on.
    function tabbedList(lists, list, isDoc) {
        if (!list.length) {
            const who = isDoc ? 'your secretaries' : 'your doctor';
            const copy = queueTab === 'review'
                ? 'Nothing waiting for review from ' + who + ' \uD83C\uDF89'
                : (queueTab === 'saved'
                    ? 'Nothing saved to the database by ' + who + ' yet.'
                    : 'No records from ' + who + ' in the last ' + QUEUE_DAYS + ' days.');
            return '<p class="ent-empty">' + copy + '</p>';
        }
        const banner = queueTab === 'review'
            ? '<p class="ent-queue-alert">&#128269; <b>' + list.length + '</b> '
                + (list.length === 1 ? 'draft is' : 'drafts are') + ' waiting for review from '
                + (isDoc ? 'your team' : 'your doctor')
                + ' &mdash; check who the patients are, then open the saved ones to edit them.</p>'
            : '';
        return banner + previewRows(list).map(queueRowHtml).join('');
    }

    function renderQueue() {
        const card = byId('dashQueueCard');
        if (!card) return;
        const role = (me && me.role) || '';
        // Admins work from the console, not from this dashboard.
        if (role !== 'doctor' && role !== 'secretary') { card.hidden = true; return; }
        card.hidden = false;

        const isDoc = role === 'doctor';
        const isSec = role === 'secretary';
        const title = byId('dashQueueTitle');
        const hint = byId('dashQueueHint');
        if (title) {
            // Keep the designed SVG mark instead of swapping it for the 👥
            // emoji on first paint - the icon in index.html and the icon
            // after render are now the same one.
            const ic = '<svg class="ent-queue-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> ';
            title.innerHTML = ic + (isSec
                ? 'New patients from your doctor'
                : 'Your team&rsquo;s work');
        }
        if (hint) {
            hint.textContent = queueError
                ? 'Needs the cloud database'
                : (isDoc
                    ? 'Drafts your secretaries typed but have not saved yet, and what is already saved'
                    : 'The patients your doctor has saved, and the ones he is still drafting');
        }

        const lists = queueLists();
        const tabs = byId('dashQueueTabs');
        // A secretary only needs the doctor's waiting drafts, so the tab bar
        // (with "Everything") would only add noise - the list is grouped instead.
        if (tabs) tabs.hidden = isSec;
        const patientsBtn = byId('dashQueuePatients');
        if (patientsBtn) {
            patientsBtn.hidden = !isSec;
            if (isSec) {
                // The count rides the button so the toggle already says how
                // much is behind it before the tap.
                const savedN = lists.saved.length;
                patientsBtn.textContent = showAllPatients
                    ? '\uD83D\uDD05 Hide patients'
                    : '\uD83D\uDC41 View patients' + (savedN ? ' (' + savedN + ')' : '');
            }
        }
        if (tabs && typeof tabs.querySelectorAll === 'function') {
            Array.prototype.forEach.call(tabs.querySelectorAll('[data-qn]'), function (b) {
                const k = b.getAttribute('data-qn');
                if (lists[k]) {
                    b.textContent = lists[k].length;
                    // "Needs review" wears AMBER while it is not zero - the
                    // one tab that is work waiting on you, not just a filter.
                    if (typeof b.classList === 'object' && b.classList.toggle) {
                        b.classList.toggle('is-hot', k === 'review' && lists[k].length > 0);
                    }
                }
            });
        }

        /* The new-work badge at the top of the dashboard.
         *
         * Driven by the SAME `lists.review` the queue card uses, so the number
         * on the badge and the number on the "Needs review" tab can never
         * disagree. It is hidden at zero for the opposite reason to the admin's
         * ticket badge: this one is a "come look at this" alarm rather than a
         * status readout, and a permanently visible zero on a doctor's home
         * screen is noise. Zero means silent, which is correct - there is
         * genuinely nothing to do.
         *
         * Plurals matter here because it is read at a glance: "1 new report"
         * next to a "2" would make somebody stop and count again. */
        const badge = byId('dashNewWork');
        if (badge) {
            const n = lists.review ? lists.review.length : 0;
            const num = byId('dashNewWorkN');
            const text = byId('dashNewWorkText');
            badge.hidden = n === 0;
            if (num) num.textContent = String(n);
            if (text) text.textContent = n === 1 ? 'New report' : 'New reports';
            badge.title = n + (n === 1 ? ' draft is' : ' drafts are')
                + ' waiting for you to review';
        }
        refreshTicketReplies();

        const box = byId('dashQueue');
        if (!box) return;
        const list = lists[queueTab] || [];

        // Hero pill: the fastest way to notice a partner's waiting draft.
        const pill = byId('dashQueuePill');
        if (pill) {
            const waiting = lists.review.length;
            if (queueError || !waiting) {
                pill.hidden = true;
            } else {
                pill.hidden = false;
                pill.textContent = '\uD83D\uDC40 ' + waiting + ' waiting for review';
                pill.title = (isDoc
                    ? 'Your secretaries have drafts that are not in the database yet.'
                    : 'Your doctor has drafts that are not in the database yet.')
                    + ' Tap to see them below.';
            }
        }

        if (queueError) {
            box.innerHTML = '<p class="ent-empty">&#128249; Team drafts come from the cloud database &mdash; '
                + esc(queueError) + '</p>';
        } else {
            // "Finished by your team" sits on top for the doctor so a completed
            // patient form is never missed. The secretary keeps it out of the
            // way - her list stays "waiting for review" only.
            const fresh = isSec ? [] : freshEdits();
            const freshBlock = fresh.length
                ? '<p class="ent-queue-section is-fresh">&#9998; Finished by your team <b>' + fresh.length + '</b></p>'
                    + fresh.slice(0, 5).map(freshEditHtml).join('')
                : '';
            box.innerHTML = freshBlock + (isSec ? secretaryList(lists) : tabbedList(lists, list, isDoc));

            /* THE "VIEW ALL" BUTTON.
               Bottom of the list, not in the card header: the header already
               carries the "View patients" toggle, and a second control up there
               competing with it is how a user ends up not knowing which one
               opens what. Down here it reads as "there is more below this".

               It only appears when there IS more, and it counts the rows that
               are actually being held back - counted from the same lists the
               renderer drew from, so the number can never drift from the
               screen. */
            const hidden = isSec
                ? hiddenIn(lists.review) + (showAllPatients ? hiddenIn(lists.saved) : 0)
                : hiddenIn(list);
            if (hidden > 0) {
                box.insertAdjacentHTML('beforeend',
                    '<button type="button" class="ent-queue-more" data-queue-more>'
                    + '&#128065; View all ' + hidden + ' more</button>');
            } else if (queueExpanded) {
                box.insertAdjacentHTML('beforeend',
                    '<button type="button" class="ent-queue-more" data-queue-more>'
                    + '&#9650; Show fewer</button>');
            }

            /* Expanded means "show me everything", and everything on a busy
               doctor's list is 40 rows. Letting the card grow to 40 rows
               pushes the rest of the dashboard off the screen, so the box
               takes a bounded height and scrolls instead. Collapsed is
               untouched - five rows never needed it. */
            box.classList.toggle('is-expanded', queueExpanded);
        }

        const foot = byId('dashQueueFoot');
        if (foot) {
            if (isSec) {
                foot.textContent = (lists.saved.length || lists.review.length)
                    ? lists.saved.length + ' saved \u00b7 ' + lists.review.length
                        + ' waiting \u00b7 last ' + QUEUE_DAYS + ' days'
                    : 'Nothing from your doctor in the last ' + QUEUE_DAYS + ' days.';
            } else {
                /* Must not say "Showing the newest N" with N = QUEUE_LIMIT any
                   more: the preview shows five, so that sentence was describing
                   a list the user was not looking at. It now states what is on
                   screen, and stops saying "newest" - the preview is the NEWEST
                   five only while the list is ordered newest-first, which is not
                   a promise this footer can make about a tab's contents. */
                if (!list.length) {
                    foot.textContent = '';
                } else if (queueExpanded) {
                    foot.textContent = 'Showing all ' + list.length
                        + (queueTab === 'all' ? ' record(s).' : ' from your team.');
                } else {
                    foot.textContent = 'Showing ' + Math.min(list.length, QUEUE_PREVIEW)
                        + ' of ' + list.length
                        + (queueTab === 'all' ? ' record(s).' : ' from your team.');
                }
            }
        }
    }

    // Fire and forget: the queue must never hold up the counters.
    function refreshQueue() {
        if (navigator.onLine && window.EntSupabase && window.EntSupabase.isConfigured()) {
            loadQueueRows().then(function (list) {
                queueRows = list;
                queueError = '';
                queueLoaded = true;
                renderQueue();
                renderActionSummary();
            }, function (e) {
                queueRows = [];
                queueError = (e && e.message) || String(e);
                queueLoaded = true;
                renderQueue();
                renderActionSummary();
            });
        } else {
            queueRows = [];
            queueError = navigator.onLine
                ? 'The cloud database is not configured on this device.'
                : 'No internet connection right now.';
            queueLoaded = true;
            renderQueue();
            renderActionSummary();
        }
    }

    /* ---------------- "the admin replied to my ticket" ------------------ */
    /* ticketForm.js ALREADY answers this question: it holds `mine`, an
     * isUnread() test and a seen-map keyed by ticket id, and it paints a bell
     * pip with the count. This used to re-implement all of that here with a
     * second storage key, which is the wrong answer twice over - two "have I
     * seen this" memories that can disagree, and a second definition of what
     * counts as unread.
     *
     * So this only READS. The count comes from ticketForm's own state, and the
     * badge clears itself because ticketForm marks a ticket seen the moment the
     * person opens their ticket list - no extra write here, and no way for the
     * two memories to drift apart.
     *
     * If ticketForm is absent (an account that never loaded the ticket page)
     * the badge simply stays hidden rather than guessing. */
    function refreshTicketReplies() {
        const box = byId('dashTicketBadge');
        if (!box) return;
        const tf = window.EntTicketForm;
        if (!tf || typeof tf.unreadCount !== 'function') { box.hidden = true; return; }
        try {
            const n = tf.unreadCount();
            box.hidden = !n;
            const num = byId('dashTicketN');
            if (num) num.textContent = String(n);
            box.title = n === 1
                ? 'The administrator replied to your ticket - open it to read'
                : 'The administrator replied to ' + n + ' of your tickets';
        } catch (e) { box.hidden = true; }
    }

    /* --------------------- print + export (zero-risk) ----------------- */
    /* Both surfaces read ONLY the rows already in memory for the counters -
     * never a second query. That is the whole point: a CSV is a snapshot of
     * exactly what this account is allowed to see (RLS already scoped it),
     * and Print is the same screen on paper. Neither can widen reach, hit the
     * network, or break the deploy - they are pure DOM over data we hold. */
    function dashScopeLabel() {
        const user = me || {};
        if (user.role === 'admin') return 'Clinic-wide (all doctors)';
        if (user.role === 'secretary') {
            return 'Dr. ' + (prettyName(user.assigned_doctor_name) || 'assigned doctor');
        }
        return 'My own patients';
    }

    // RFC 4180 cell: wrap in quotes and double any inner quote. A leading
    // =,+,-,@ is prefixed with ' so a patient named "=cmd()" cannot be read
    // as a formula when the CSV is opened in Excel/Sheets (CSV injection).
    function csvCell(value) {
        let s = String(value == null ? '' : value);
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
        return '"' + s.replace(/"/g, '""') + '"';
    }

    async function exportMonthlyRecords(button) {
        if (monthlyExportBusy) return;
        if (source !== 'cloud' || !navigator.onLine) {
            window.alert('Connect to the cloud database before downloading the monthly records.');
            return;
        }
        monthlyExportBusy = true;
        if (button) {
            button.disabled = true;
            button.textContent = 'Preparing download\u2026';
        }

        try {
            const exportedAt = new Date().toISOString();
            const scope = dashScopeLabel();
            const prefix = '{"format":"ent-system-records-export","version":1'
                + ',"exported_at":' + JSON.stringify(exportedAt)
                + ',"scope":' + JSON.stringify(scope)
                + ',"consistency_note":"For the most consistent export, pause new saves and edits until the download finishes."'
                + ',"records":[';
            const parts = [prefix];
            const encoder = new TextEncoder();
            let bytes = encoder.encode(prefix).length;
            let count = 0;
            let offset = 0;
            const seenIds = new Set();

            while (true) {
                const endpoint = 'reports?is_draft=eq.false&deleted_at=is.null'
                    + '&select=*&order=created_at.asc,id.asc'
                    + '&limit=' + EXPORT_PAGE_SIZE + '&offset=' + offset;
                const page = await api(endpoint);
                if (!Array.isArray(page)) {
                    throw new Error('The database returned an invalid records page.');
                }
                if (offset >= MAX_MONTHLY_EXPORT_ROWS && page.length) {
                    throw new Error('This export exceeds the safe limit of '
                        + MAX_MONTHLY_EXPORT_ROWS.toLocaleString()
                        + ' records. Ask the administrator to create a full backup.');
                }

                for (const row of page) {
                    if (!row || typeof row.id !== 'string' || !row.id) {
                        throw new Error('A report is missing its record ID; the export was stopped to avoid an unreliable file.');
                    }
                    if (seenIds.has(row.id)) {
                        throw new Error('The report list changed during export. Pause saves and edits, then try again.');
                    }
                    seenIds.add(row.id);
                    const serialized = JSON.stringify(row);
                    const separator = count ? ',' : '';
                    const size = encoder.encode(separator + serialized).length;
                    if (bytes + size > MAX_MONTHLY_EXPORT_BYTES) {
                        throw new Error('This export is larger than the safe browser limit (150 MB). Ask the administrator to create a full backup.');
                    }
                    parts.push(separator, serialized);
                    bytes += size;
                    count++;
                }
                if (page.length < EXPORT_PAGE_SIZE) break;
                offset += EXPORT_PAGE_SIZE;
            }

            parts.push(']}');
            const blob = new Blob(parts, { type: 'application/json;charset=utf-8' });
            if (blob.size > MAX_MONTHLY_EXPORT_BYTES) {
                throw new Error('This export is larger than the safe browser limit (150 MB). Ask the administrator to create a full backup.');
            }
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'ent-records-' + dayKeyOf(new Date()) + '.json';
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            setTimeout(function () {
                URL.revokeObjectURL(url);
                link.remove();
            }, 30000);

            monthlyExportBusy = false;
            completeMonthlyExport();
            if (!count) window.alert('The dated export was downloaded. No saved reports were visible to this account.');
        } catch (error) {
            monthlyExportBusy = false;
            console.error('[Dashboard] Monthly records export failed:', error);
            renderNotices();
            window.alert('The monthly records download did not finish. ' + String(error && error.message || error));
        }
    }

    function exportDashboardCsv() {
        if (!rows.length) {
            window.alert('There is nothing to export yet. Save a report first and it will appear here.');
            return;
        }
        const header = ['Patient', 'Report type', 'Seen on', 'Case number',
            'Hospital', 'Saved by', 'Saved at', 'Follow-up date'];
        const body = rows.map(function (r) {
            const t = typeKey(r);
            const meta = TYPES[t] || { label: 'Other report' };
            return [
                displayNameOf(r),
                meta.label,
                r.procedure_date || '',
                r.case_number || '',
                siteOf(r) || '',
                prettyName(r.created_by_name) || r.created_by || '',
                r.created_at || '',
                followUpOf(r) || ''
            ];
        });
        const csv = [header].concat(body).map(function (row) {
            return row.map(csvCell).join(',');
        }).join('\r\n');
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const stamp = dayKeyOf(new Date());
        link.href = url;
        link.download = 'ent-patients-' + stamp + '.csv';
        document.body.appendChild(link);
        link.click();
        setTimeout(function () { URL.revokeObjectURL(url); link.remove(); }, 500);
    }

    function wireDashActions() {
        const exportBtn = byId('dashExportBtn');
        if (exportBtn) exportBtn.addEventListener('click', exportDashboardCsv);
        const mixPeriod = byId('dashMixPeriod');
        if (mixPeriod) mixPeriod.addEventListener('change', function () {
            renderReportMixPeriod(mixPeriod.value);
        });
    }

    function renderAll() {
        const data = computeAll();
        dashboardData = data;
        renderHero(data);
        renderNotices();
        renderTiles(data);
        renderSplitCharts(data);
        renderReportMixPeriod(reportMixPeriod);
        renderRecent();
        renderActionSummary();
        renderActivitySelector(new Date().getFullYear(), new Date().getMonth() + 1);
        renderTeam();
        renderQueue();
        tickClock();
    }

    /* ----------------------- my secretaries ------------------------- */
    // Secretaries linked to this doctor, from rpc/my_secretaries
    // (migration 0027): a NO-ARGUMENT function that returns exactly the
    // rows this signed-in doctor is allowed to know about - his own
    // secretaries, five columns, nothing of anybody else and no way to
    // ask for more. It is the mirror of 0015's my_assigned_doctor_name().
    //
    // WHY NOT Auth.readUserCache(), which this card used to read: v2
    // retired it to a permanent [] on purpose - a full copy of the account
    // table in the browser is a cached ROLE, the stale-claim problem
    // PRIV-04 tests. The card was never moved off it, so EVERY doctor saw
    // "No secretary is linked to you yet" while the admin panel showed
    // secretaries assigned and correct (verified in the 2026-10-03 backup:
    // tara -> jess, and the card still said none).
    //
    // Querying staff_profiles directly is not the fix either:
    // profiles_select_self (0008) hands a doctor exactly one row - his own
    // - so the secretaries come back filtered out by RLS, which is the
    // correct rule. 0027 is where the widening belongs: one narrow,
    // read-only, argument-free function instead of a policy.
    function initialsOf(name) {
        return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2)
            .map(function (part) { return part[0].toUpperCase(); }).join('') || '?';
    }
    // Re-filtered here even though the RPC already narrows the rows: this
    // card's invariant belongs at the card too, not only at the server.
    function mySecretaries() {
        if (!me || me.role !== 'doctor') return [];
        return (teamRows || []).filter(function (u) {
            return u && u.role === 'secretary'
                && String(u.assigned_doctor_id || '') === String(me.id || '');
        });
    }
    function renderTeam() {
        const card = byId('dashTeamCard');
        if (!card) return;
        if (!me || me.role !== 'doctor') { card.hidden = true; return; }
        card.hidden = false;
        const list = mySecretaries();
        // THREE empties, because they are three different facts: no answer
        // yet (waiting), no answer possible right now (error / offline),
        // and a real answer of "none". Only the last one may tell the
        // doctor to ask the admin - the old code said it every time,
        // which is how a correct database read as an empty one.
        const waiting = teamRows === null && !teamError;
        const hint = byId('dashTeamHint');
        if (hint) {
            hint.textContent = list.length
                ? 'They file reports under your name'
                : teamError
                    ? 'Could not reach the cloud database \u2014 tap Refresh to try again.'
                    : waiting
                        ? (navigator.onLine
                            ? 'Looking up your team\u2026'
                            : 'Your secretaries appear here once this device is online.')
                        : 'Ask the admin to link a secretary to your account';
        }
        const box = byId('dashTeam');
        if (!box) return;
        box.innerHTML = list.length
            ? list.map(function (u) {
                const name = prettyName(u.full_name || u.username || 'Unnamed');
                return '<div class="ent-team-row">'
                    + '<span class="ent-team-avatar">' + esc(initialsOf(name.replace(HONORIFIC, ''))) + '</span>'
                    + '<span class="ent-team-main">'
                    + '<span class="ent-team-name">' + esc(name) + '</span>'
                    + '<span class="ent-team-meta">@' + esc(u.username || '') + '</span></span>'
                    + (u.is_active === false ? '<span class="ent-team-flag">Deactivated</span>' : '')
                    + '</div>';
            }).join('')
            : '<p class="ent-team-empty">' + (teamError
                ? 'Your secretaries could not be loaded right now.'
                : waiting
                    ? 'Looking up your secretaries\u2026'
                    : 'No secretary is linked to you yet.') + '</p>';
    }
    // One fetch per page. Success stops all further calls; a failure is
    // remembered so the periodic refresh cannot hammer a dead endpoint,
    // and retryTeam() - wired to the Refresh button and to the browser
    // coming back online - is the way back from it.
    async function loadTeam() {
        if (!me || me.role !== 'doctor') return;
        if (teamBusy || teamRows !== null || teamError) return;
        if (!navigator.onLine || !window.EntSupabase || !window.EntSupabase.isConfigured()) {
            renderTeam();          // stays in the "waiting" wording above
            return;
        }
        teamBusy = true;
        try {
            const rows = await api('rpc/my_secretaries', { method: 'POST', body: '{}' });
            teamRows = Array.isArray(rows) ? rows : [];
            teamError = '';
        } catch (e) {
            teamError = (e && e.message) || String(e);
            console.warn('[Dashboard] my_secretaries failed:', teamError);
        }
        teamBusy = false;
        renderTeam();
    }
    function retryTeam() {
        teamError = '';
        return loadTeam();
    }

    /* ------------------------- quick actions ------------------------- */
    function startReport(type) {
        const meta = TYPES[type];
        if (!meta) return;
        if ((type === 'abstract' || type === 'medicalCertificate') && !medicalDocumentsAvailable) return;
        const go = function () { window.location.href = meta.page; };
        if (navigator.onLine && typeof Auth.logActivity === 'function') {
            // Best-effort audit trail; the form opens even if this stalls.
            Promise.race([
                Promise.resolve(Auth.logActivity('OPEN_FORM',
                    'Dashboard quick action: ' + meta.label)).catch(function () {}),
                new Promise(function (resolve) { setTimeout(resolve, 350); })
            ]).then(go, go);
        } else {
            go();
        }
    }


    /* --------------------------- admin gate -------------------------- */
    function revealDashboard() {
        const gate = byId('adminGate');
        if (gate) gate.hidden = true;
        const main = byId('dashMain');
        if (main) main.hidden = false;
    }

    function showAdminGate() {
        const main = byId('dashMain');
        if (main) main.hidden = true;
        const gate = byId('adminGate');
        if (!gate) { window.location.replace(pageUrl('admin.html')); return; }
        gate.hidden = false;
        const who = byId('gateUser');
        if (who && me) who.textContent = prettyName(me.full_name || me.username);
        const adminBtn = byId('gateOpenAdmin');
        if (adminBtn) adminBtn.addEventListener('click', function () {
            window.location.href = pageUrl('admin.html');
        });
        const goBtn = byId('gateDashboard');
        if (goBtn) goBtn.addEventListener('click', function () {
            try { sessionStorage.setItem(ADMIN_PREVIEW_KEY, '1'); } catch (e) { /* ignore */ }
            revealDashboard();
            start();
        });
        let remembered = false;
        try { remembered = sessionStorage.getItem(ADMIN_PREVIEW_KEY) === '1'; } catch (e) { /* ignore */ }
        if (remembered) { revealDashboard(); start(); }
    }

    /* ------------------------------ wiring --------------------------- */
    let wired = false;
    function wire() {
        if (wired) return;
        wired = true;

        /* The "Admin replied" badge has to react the moment the count changes -
         * after the person opens their ticket list the badge is marked seen, and
         * a number that lingers after that is a lie. ticketForm announces it. */
        document.addEventListener('ticketform:unread', function () { refreshTicketReplies(); });

        ['dashRecentSearch', 'dashRecentFrom', 'dashRecentTo', 'dashRecentType',
            'dashRecentSite'].forEach(function (id) {
            const control = byId(id);
            if (!control) return;
            control.addEventListener(control.type === 'search' ? 'input' : 'change', function () {
                recentPage = 0;
                renderRecent();
            });
        });
        const clearRecent = byId('dashRecentReset');
        if (clearRecent) clearRecent.addEventListener('click', function () {
            ['dashRecentSearch', 'dashRecentFrom', 'dashRecentTo', 'dashRecentType',
                'dashRecentSite'].forEach(function (id) {
                const control = byId(id);
                if (control) control.value = '';
            });
            recentPage = 0;
            renderRecent();
        });
        const pageSize = byId('dashRecentPageSize');
        if (pageSize) pageSize.addEventListener('change', function () {
            const selected = Number(pageSize.value);
            if (RECENT_PAGE_SIZES.indexOf(selected) === -1) {
                pageSize.value = String(recentPageSize);
                return;
            }
            recentPageSize = selected;
            recentPage = 0;
            renderRecent();
        });
        const previousPage = byId('dashRecentPrev');
        if (previousPage) previousPage.addEventListener('click', function () {
            if (recentPage > 0) {
                recentPage -= 1;
                renderRecent();
            }
        });
        const nextPage = byId('dashRecentNext');
        if (nextPage) nextPage.addEventListener('click', function () {
            const filtered = recentFilterState().filtered;
            const displayCount = isAdminView() ? filtered.length : buildGroupedRows(filtered).length;
            const totalPages = Math.max(1, Math.ceil(displayCount / recentPageSize));
            if (recentPage < totalPages - 1) {
                recentPage += 1;
                renderRecent();
            }
        });
        const refreshBtn = byId('dashRefreshBtn');
        if (refreshBtn) refreshBtn.addEventListener('click', function () {
            refresh({ push: true });
            retryTeam();               // a failed team lookup gets a second chance here
        });
        const doctorScopeToggle = byId('dashDoctorScopeToggle');
        if (doctorScopeToggle) doctorScopeToggle.addEventListener('click', function () {
            if (busy || !scopeInfo || !Array.isArray(scopeInfo.assignedDoctorIds)
                || scopeInfo.assignedDoctorIds.length < 2) return;
            scopeInfo.allAssigned = !scopeInfo.allAssigned;
            renderAll();
            refresh({});
        });

        // One delegated listener covers all three quick-action buttons.
        document.addEventListener('click', function (event) {
            const trigger = (event.target && event.target.closest)
                ? event.target.closest('[data-report-type]') : null;
            if (!trigger) return;
            event.preventDefault();
            startReport(trigger.getAttribute('data-report-type'));
        });

        // Team queue: the three tabs + the open / view button on every row.
        const qTabs = byId('dashQueueTabs');
        if (qTabs) {
            qTabs.addEventListener('click', function (event) {
                const btn = (event.target && event.target.closest)
                    ? event.target.closest('[data-qtab]') : null;
                if (!btn) return;
                queueTab = btn.getAttribute('data-qtab') || 'review';
                Array.prototype.forEach.call(qTabs.querySelectorAll('[data-qtab]'), function (b) {
                    b.classList.toggle('active', b === btn);
                });
                renderQueue();
            });
        }
        const qBox = byId('dashQueue');
        if (qBox) {
            qBox.addEventListener('click', function (event) {
                /* ONE delegated listener for the whole box, and this is the
                   only `const qBox` in the file. There was already a handler
                   here for the row actions; "View all" was first written as a
                   second `const qBox` block, which is a redeclaration and a
                   SyntaxError that stops dashboard.js loading entirely.

                   It has to live here rather than on the button itself,
                   because renderQueue() replaces the box's whole contents -
                   a listener bound to the button would fire once and then stop,
                   with no error to show for it. */
                const more = (event.target && event.target.closest)
                    ? event.target.closest('[data-queue-more]') : null;
                if (more) {
                    queueExpanded = !queueExpanded;
                    renderQueue();
                    /* Keep the top of the list in view. Expanding reveals rows
                       ABOVE the one being read, which otherwise pushes it out
                       of sight - the user taps "View all" and appears to lose
                       their place. */
                    const box = byId('dashQueue');
                    if (box && box.scrollIntoView) {
                        box.scrollIntoView({ block: 'nearest' });
                    }
                    return;
                }

                // "Reviewed" -> remembered on this device so it stops showing.
                const done = (event.target && event.target.closest)
                    ? event.target.closest('[data-review]') : null;
                if (done) {
                    const key = done.getAttribute('data-review');
                    const row = queueRows.filter(function (r) { return r.record_key === key; })[0];
                    if (row) { markReviewed(row); renderQueue(); }
                    return;
                }
                const btn = (event.target && event.target.closest)
                    ? event.target.closest('[data-qkey]') : null;
                if (!btn) return;
                const meta = TYPES[btn.getAttribute('data-qtype')];
                if (!meta) return;
                window.location.href = meta.page
                    + '?ent_record=' + encodeURIComponent(btn.getAttribute('data-qkey') || '')
                    + '&ent_patient=' + encodeURIComponent(btn.getAttribute('data-qpatient') || '')
                    + '&ent_author=' + encodeURIComponent(btn.getAttribute('data-qauthor') || '');
            });
        }

        // Hero pill -> jump straight to the waiting drafts.
        const qPill = byId('dashQueuePill');
        if (qPill) {
            qPill.addEventListener('click', function () {
                queueTab = 'review';
                if (qTabs) {
                    Array.prototype.forEach.call(qTabs.querySelectorAll('[data-qtab]'), function (b) {
                        b.classList.toggle('active', b.getAttribute('data-qtab') === 'review');
                    });
                }
                renderQueue();
                const card = byId('dashQueueCard');
                if (card && typeof card.scrollIntoView === 'function') {
                    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            });
        }
        const qRefresh = byId('dashQueueRefresh');
        if (qRefresh) {
            qRefresh.addEventListener('click', function () {
                qRefresh.classList.add('is-busy');
                refreshQueue();
                setTimeout(function () { qRefresh.classList.remove('is-busy'); }, 700);
            });
        }
        // "View patients" reveals (and hides again) the patients the doctor saved.
        const qPatients = byId('dashQueuePatients');
        if (qPatients) {
            qPatients.addEventListener('click', function () {
                showAllPatients = !showAllPatients;
                renderQueue();
            });
        }

        window.addEventListener('online', function () {
            refresh({ push: true });
            retryTeam();               // the card's own reconnect path
        });
        window.addEventListener('offline', function () { refresh({}); });
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden && Date.now() - lastLoadedAt > STALE_MS) refresh({});
        });

        // A report saved on this device reaches the counters without a reload.
        let settleTimer = null;
        window.addEventListener('patientrecords:updated', function () {
            clearTimeout(settleTimer);
            settleTimer = setTimeout(function () { refresh({}); }, 1200);
        });
    }

    /* ------------------------------- boot ---------------------------- */
    function start() {
        if (!scopeInfo) {
            try { scopeInfo = Auth.scope(); } catch (e) { scopeInfo = { seeAll: false, doctorId: '' }; }
        }
        wire();
        readReviewed();
        renderTeam();
        refresh({ push: true });
        loadTeam();
        setInterval(tickClock, 20000);
        setInterval(function () {
            if (!document.hidden && !busy) refresh({});
        }, REFRESH_MS);
        setInterval(function () {
            if (!document.hidden && !busy) refreshQueue();
        }, QUEUE_POLL_MS);
    }

    // guard() now resolves after the async session + profile read, because
    // deciding on a synchronous readSession() is always null on a fresh page
    // load and this returned before the dashboard was ever revealed.
    async function boot() {
        const session = await Auth.guard();
        if (!session || !session.user) return;
        me = session.user;
        myName = String(me.username || '').trim().toLowerCase();
        try {
            medicalDocumentsAvailable = await canUseMedicalDocuments(me);
        } catch (error) {
            medicalDocumentsAvailable = false;
            console.warn('[Dashboard] Could not verify medical-document clinic access:', error);
        }
        document.querySelectorAll('[data-report-type="abstract"], [data-report-type="medicalCertificate"]')
            .forEach(function (button) { button.hidden = !medicalDocumentsAvailable; });

        if (me.role === 'admin') {                    // admins live in admin.html
            scopeInfo = { role: 'admin', doctorId: '', seeAll: true };
            showAdminGate();
            return;
        }
        if (me.role !== 'doctor' && me.role !== 'secretary') {
            window.location.replace(pageUrl('index.html') + '?denied=1');
            return;
        }
        try { scopeInfo = Auth.scope(); } catch (e) { scopeInfo = { seeAll: false, doctorId: '' }; }
        if (me.role === 'secretary' && typeof Auth.fetchAssignedDoctors === 'function') {
            try {
                assignedDoctorRows = await Auth.fetchAssignedDoctors(true);
                assignedDoctorRows = Array.isArray(assignedDoctorRows)
                    ? assignedDoctorRows.filter(function (doctor) { return doctor && doctor.doctor_id; })
                    : [];
                scopeInfo.assignedDoctorIds = assignedDoctorRows.map(function (doctor) {
                    return String(doctor.doctor_id);
                });
                scopeInfo.allAssigned = me.is_super_secretary === true
                    && scopeInfo.assignedDoctorIds.length > 0;
            } catch (error) {
                assignedDoctorRows = [];
                console.warn('[Dashboard] Could not load assigned doctors for the dashboard:', error);
            }
        }
        revealDashboard();
        wireDashActions();
        start();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }

    window.EntDashboard = {
        refresh: refresh,
        getData: function () { return computeAll(); },
        getRows: function () { return rows.slice(); },
        getSource: function () { return source; }
    };

})(window);
