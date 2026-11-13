/* =====================================================================
   ENT CLINIC AUTHENTICATION & ROLE SCOPING  —  v2 (Supabase Auth)
   ---------------------------------------------------------------------
   WHAT THIS FILE USED TO DO, AND WHY IT IS GONE

   v1 kept the ENTIRE authentication system in the browser:
     · a pure-JS SHA-256 (the SHA_K table below), because it shipped the
       hash and the salt beside it;
     · hashPassword(salt, password) === user.password_hash, comparing a
       password against a column it had just downloaded from the database;
     · a hand-minted session token in localStorage with its own 12h TTL;
     · a user_sessions table holding bearer tokens, reachable by anyone
       holding the anon key — a complete account-takeover primitive.

   v2 has exactly ONE authentication system: Supabase Auth (GoTrue).
     · The browser calls signInWithPassword(). It never sees a hash,
       because the schema has no hash column to see: staff_profiles
       stores role and clinic membership and NOTHING credential-shaped.
     · GoTrue compares the password with bcrypt, server-side.
     · The session is supabase-js's, refreshed automatically, cleared by
       signOut().
     · Authorization is not in this file at all. It is RLS, and every
       policy re-reads staff_profiles on each request, so a demotion or a
       deactivation takes effect on the NEXT call rather than at token
       expiry.

   The browser still ASKS for a role and a clinic, to render a menu. It
   may not STATE one, and nothing it sends can change one.

   Depends on: supabaseClient.js (window.EntSupabase), which loads
   supabase-js.
   ===================================================================== */
(function (window) {
    'use strict';

    const HEARTBEAT_MS = 30000;
    const PUBLIC_PAGES = ['login.html'];

    /* ------------------------------------------------------------------
       PAGE PATHS.

       index.html is the app entry point and stays at the root. Every other
       page lives in pages/, one level down - including this file's own
       login.html, admin.html, viewAll.html and the three report forms.

       Every redirect below used to be a bare "login.html", which resolved
       against whatever document happened to be open. From the root that
       was correct; from pages/ it silently pointed at pages/login.html,
       which did not exist until the move that created this. The symptom
       is the worst kind: sign-out appears to do nothing, or a guard
       bounces to a 404, and neither looks like a path problem.

       EntPaths (function/paths.js) knows the depth from the page's own
       URL, so these stay correct at either level. It is loaded before this
       file on every page; the fallbacks below keep the module usable if a
       page ever forgets the tag.
       ------------------------------------------------------------------ */
    const P = (window.EntPaths || {});
    const pageUrl = function (name) {
        return typeof P.page === 'function' ? P.page(name) : name;
    };

    /* SERVICE WORKER REGISTRATION — from HERE, because auth.js is the one
       script EVERY page loads (login, dashboard, admin, settings, tickets,
       viewAll, records-doctor and the three report forms). Registration used
       to live only in index.js and cf4.js, so a visit that started - and
       stayed - on any other page never installed a worker at all: offline,
       its navigations fell through to the network and showed the browser's
       native "You're offline." page. register() with the same URL is a no-op
       after the first call, so the copies in index.js/cf4.js are harmless.
       Guarded so a harness without navigator, or a file:// page, never
       throws at load time. */
    (function registerServiceWorkerOnce() {
        try {
            if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
            if (!/^https?:$/.test(String((window.location && window.location.protocol) || ''))) return;
            const swUrl = typeof P.asset === 'function' ? P.asset('sw.js') : 'sw.js';
            const register = function () {
                try {
                    navigator.serviceWorker.register(swUrl).catch(function (err) {
                        console.error('Service worker registration failed:', err);
                    });
                } catch (e) { /* never let offline plumbing break a page */ }
            };
            if (document.readyState === 'complete') register();
            else window.addEventListener('load', register, { once: true });
        } catch (e) { /* no offline support in this context; the page still works online */ }
    })();

    // GoTrue signs in with an EMAIL, but the clinic knows its people by a
    // bare username. v2 provisions accounts as <username>@zztest.invalid.
    // Real accounts must be given a real unroutable address at migration
    // time — changing this later means re-linking every account, so it is
    // deliberately a constant and not a setting the browser can edit.
    //
    // It MUST equal ACCOUNT_EMAIL_DOMAIN in
    // supabase-v2/edge-functions/auth-admin/index.ts, which derives the
    // address when an admin creates an account. If the two disagree the
    // account is created under an address this page never queries, and the
    // user can never sign in. Do not "fix" one side alone.
    const EMAIL_DOMAIN = 'zztest.invalid';

    // GoTrue's own project floor. Proved live: /auth/v1/admin/users answers
    // HTTP 422 "Password should be at least 6 characters" for anything
    // shorter, so this is the lowest value that can ever work here. It used
    // to be 8, which contradicted the admin screen's 6 and auth-admin's 10.
    const MIN_PASSWORD_LENGTH = 6;
    // Ceiling on one sign-in attempt. A real refusal comes back in well under
    // a second; if nothing has come back by now the connection is dead, not
    // the password, and the visitor must be told rather than left watching a
    // spinner.
    const SIGN_IN_TIMEOUT_MS = 15000;

    let heartbeatTimer = null;
    let currentProfile = null;      // the live staff_profiles row
    let signedInUser = null;        // the GoTrue user
    // Mutual recursion guards. logActivity() calls logout() when the server
    // says the session is gone, and logout() logs LOGOUT - so without these
    // the pair can call each other forever on a failed sign-in. See
    // logActivity() for the full story of the login hang.
    let logBusy = false;
    let logoutBusy = false;

    /* 0037 — the cross-clinic secretary's "working today at ..." choice.
       A secretary may now be assigned to SEVERAL doctors (primary in
       assigned_doctor_id, extras in secretary_assignments) but files onto
       exactly ONE shelf at a time, so the app must know which. The choice
       lives in SESSION STORAGE because it is a per-login convenience, not a
       fact about the account. For Super Secretaries, the active clinic is
       also bound to the authenticated session and checked by RLS; the
       network-wide doctor list is only for switching. It is dropped on
       sign-out so the next account inherits no selection. */
    const WORKING_DOCTOR_KEY = 'ent_working_doctor_v1';
    const SUPER_WORKING_DOCTOR_KEY = 'ent_super_secretary_working_doctor_v1';
    const DOC_JESS_CLINIC_ID = '00000000-0000-4000-8000-00000000c11c';
    const DOC_JESS_CLINIC_NAME = 'Doc Jess';
    // Set once the picker has been shown this session so it does not nag on
    // every page load; a secretary can reopen it from the header chip.
    const WORKING_PROMPTED_KEY = 'ent_working_prompted_v1';
    // In-memory cache of rpc/my_assigned_doctors (null = not fetched yet).
    let assignedDoctorsCache = null;
    let activeClinicContextDoctorId = '';
    let activeClinicContextError = null;
    let clinicContextWarningShown = false;

    function isDocJessClinic(clinicId, clinicName) {
        if (String(clinicId || '').trim() === DOC_JESS_CLINIC_ID) return true;
        // 0002 preserves any pre-existing main_clinic UUID; 0046 fixes its name.
        return String(clinicName || '').trim().toLowerCase() === DOC_JESS_CLINIC_NAME.toLowerCase();
    }

    async function getClinicName(clinicId) {
        const id = String(clinicId || '').trim();
        if (!id) return '';
        const rows = await api('clinics?id=eq.' + encodeURIComponent(id) + '&select=name');
        return Array.isArray(rows) && rows[0] ? String(rows[0].name || '').trim() : '';
    }

    /** The stored working choice { id, name, clinic }, or null. Never throws. */
    function workingChoice() {
        const user = currentUser();
        if (user && user.is_super_secretary === true) {
            try {
                const shared = window.localStorage.getItem(SUPER_WORKING_DOCTOR_KEY);
                if (shared) {
                    const value = JSON.parse(shared);
                    if (value && value.user_id === user.id && value.id) return value;
                }
            } catch (e) { /* use the current tab's choice */ }
        }
        try {
            const raw = window.sessionStorage.getItem(WORKING_DOCTOR_KEY);
            if (!raw) return null;
            const v = JSON.parse(raw);
            return (v && v.id) ? v : null;
        } catch (e) { return null; }
    }

    function setWorkingChoice(choice) {
        try {
            if (choice && choice.id) {
                window.sessionStorage.setItem(WORKING_DOCTOR_KEY, JSON.stringify(choice));
            } else {
                window.sessionStorage.removeItem(WORKING_DOCTOR_KEY);
            }
        } catch (e) { /* private mode: the primary stays the shelf */ }
        const user = currentUser();
        if (user && user.is_super_secretary === true) {
            try {
                if (choice && choice.id) {
                    window.localStorage.setItem(SUPER_WORKING_DOCTOR_KEY, JSON.stringify(
                        Object.assign({}, choice, { user_id: user.id })
                    ));
                } else {
                    window.localStorage.removeItem(SUPER_WORKING_DOCTOR_KEY);
                }
            } catch (e) { /* the server still validates this tab's selection */ }
        }
    }

    function clearWorkingChoice() {
        try { window.sessionStorage.removeItem(WORKING_DOCTOR_KEY); } catch (e) { /* ignore */ }
        try { window.localStorage.removeItem(SUPER_WORKING_DOCTOR_KEY); } catch (e) { /* ignore */ }
    }

    function bindSuperSecretaryChoiceSync(user) {
        if (!user || user.is_super_secretary !== true || typeof window.addEventListener !== 'function') return;
        window.addEventListener('storage', function (event) {
            if (!event || event.key !== SUPER_WORKING_DOCTOR_KEY) return;
            try {
                if (event.newValue) {
                    const choice = JSON.parse(event.newValue);
                    if (!choice || choice.user_id !== user.id || !choice.id) return;
                    window.sessionStorage.setItem(WORKING_DOCTOR_KEY, JSON.stringify(choice));
                } else {
                    window.sessionStorage.removeItem(WORKING_DOCTOR_KEY);
                }
            } catch (error) {
                console.error('[Auth] Could not sync the active clinic between tabs:', error);
                return;
            }
            if (window.location && typeof window.location.reload === 'function') {
                window.location.reload();
            }
        });
    }

    async function setActiveClinicContext(doctorId) {
        const id = String(doctorId || '').trim();
        if (!id) throw new Error('Choose a doctor in the clinic you want to open.');
        const clinicId = await api('rpc/ent_set_active_clinic', {
            method: 'POST',
            body: JSON.stringify({ p_doctor: id })
        });
        if (typeof clinicId !== 'string' || !clinicId.trim()) {
            throw new Error('The database did not confirm the selected clinic.');
        }
        activeClinicContextDoctorId = id;
        activeClinicContextError = null;
        clinicContextWarningShown = false;
        return clinicId;
    }

    async function ensureSuperSecretaryClinicContext(user) {
        if (!user || user.role !== 'secretary' || user.is_super_secretary !== true || offlineSessionActive) return;
        const doctors = await fetchAssignedDoctors(true, true);
        const current = workingChoice();
        let selected = current && doctors.find(function (doctor) {
            return String(doctor.doctor_id) === String(current.id);
        });
        if (current && !selected) clearWorkingChoice();
        if (!selected) {
            selected = doctors.find(function (doctor) { return doctor.is_primary; }) || null;
        }
        if (!selected) {
            throw new Error('No active doctor was found in your managed clinic network.');
        }
        if (activeClinicContextDoctorId === String(selected.doctor_id)) return;
        const activeClinicId = await api('rpc/ent_ensure_active_clinic', {
            method: 'POST',
            body: JSON.stringify({ p_doctor: String(selected.doctor_id) })
        });
        if (typeof activeClinicId !== 'string' || !activeClinicId.trim()) {
            throw new Error('The database did not confirm the active clinic.');
        }
        let contextDoctor = selected;
        if (String(selected.clinic_id || '') !== activeClinicId) {
            contextDoctor = doctors.find(function (doctor) {
                return String(doctor.clinic_id || '') === activeClinicId;
            }) || null;
            if (!contextDoctor) {
                throw new Error('The active clinic is no longer in your managed network.');
            }
            setWorkingChoice({
                id: String(contextDoctor.doctor_id),
                name: contextDoctor.doctor_name || '',
                clinic: contextDoctor.clinic_name || '',
                clinic_id: contextDoctor.clinic_id || ''
            });
        }
        activeClinicContextDoctorId = String(contextDoctor.doctor_id);
        activeClinicContextError = null;
    }

    function showClinicContextError() {
        if (clinicContextWarningShown) return;
        clinicContextWarningShown = true;
        if (typeof window.alert === 'function') {
            window.alert('Could not verify the active clinic. Reconnect and reload before opening clinic records.');
        }
    }

    function client() {
        if (!window.EntSupabase || typeof window.EntSupabase.getClient !== 'function') {
            throw new Error('Supabase client is not loaded.');
        }
        return window.EntSupabase.getClient();
    }

    /** A username, or an address the caller typed, becomes an email. */
    function toEmail(username) {
        const raw = String(username || '').trim();
        if (!raw) return '';
        if (raw.indexOf('@') > -1) return raw;     // they typed an address
        return `${raw.toLowerCase()}@${EMAIL_DOMAIN}`;
    }

    /* ------------------------------------------------------------------
       Low level helpers
       ------------------------------------------------------------------ */
    function api(endpoint, options) {
        if (!window.EntSupabase || typeof window.EntSupabase.apiRequest !== 'function') {
            return Promise.reject(new Error('Supabase client is not loaded.'));
        }
        return window.EntSupabase.apiRequest(endpoint, options);
    }

    function json(method, body, extraHeaders) {
        return {
            method,
            headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
            body: JSON.stringify(body)
        };
    }

    function isNetworkError(error) {
        const msg = String((error && error.message) || '');
        return /Failed to fetch|NetworkError|Load failed|ERR_|timed? ?out|ECONN/i.test(msg);
    }

    function deviceLabel() {
        const ua = navigator.userAgent || '';
        if (/Android/i.test(ua)) return 'Android';
        if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
        if (/Windows/i.test(ua)) return 'Windows';
        if (/Mac OS X/i.test(ua)) return 'macOS';
        if (/Linux/i.test(ua)) return 'Linux';
        return 'Unknown device';
    }

    function currentPageName() {
        let path = window.location.pathname.split('/').pop() || '';
        if (!path) path = 'index.html';
        return path.toLowerCase();
    }

/* ------------------------------------------------------------------
       SESSION — owned by supabase-js, not by this file.

       v1 kept a hand-minted token in localStorage with its own 12-hour
       TTL, plus a user_sessions table full of bearer tokens that anyone
       holding the anon key could read. Both are gone.

       Now the session is GoTrue's. supabase-js persists it under
       `sb-<ref>-auth-token`, refreshes it before expiry, and clears it on
       signOut(). This file keeps an in-memory mirror of the LIVE
       staff_profiles row, because a JWT role claim is only a cache — the
       database re-reads that row on every single policy check.

       readSession() keeps its old {user} shape because login.html and
       dashboard.js call it, but it no longer decodes or validates
       anything of its own.
       ------------------------------------------------------------------ */
    const SESSION_PROBLEM_KEY = 'entSessionProblemV1';

    let lastSessionProblem = null;
    let readyPromise = null;
    // Has ready() actually resolved? v2 loads the session and the live profile
    // asynchronously, so until it has, readSession() is null on EVERY fresh
    // page load — including for a user who just signed in. guard() used to
    // read it synchronously, redirected to login.html, and login.html then
    // sent the user straight back: an endless login <-> page loop.
    let readyResolved = false;

    function noteSessionProblem(message) {
        lastSessionProblem = { message, at: Date.now() };
        try { localStorage.setItem(SESSION_PROBLEM_KEY, JSON.stringify(lastSessionProblem)); } catch (e) { /* ignore */ }
    }

    function readSessionProblem() {
        try {
            const raw = JSON.parse(localStorage.getItem(SESSION_PROBLEM_KEY) || 'null');
            if (raw && raw.message) return raw;
        } catch (e) { /* ignore */ }
        return lastSessionProblem;
    }

    function clearSessionProblem() {
        try { localStorage.removeItem(SESSION_PROBLEM_KEY); } catch (e) { /* ignore */ }
    }

    /* ------------------------------------------------------------------
       OFFLINE ACCESS GRANT (v36a) — "airplane mode" sign-in, done honestly.

       THE RULES THIS BLOCK EXISTS TO ENFORCE
         · NO PLAINTEXT PASSWORD IS EVER STORED. The old flow wrote
           {username, password} into localStorage under entSavedLoginV1 and
           let one click reach the dashboard with zero verification - device
           possession alone was the credential. That key is deleted on sight
           below, and the guard branch that read it (it referenced a
           SAVED_LOGIN_KEY constant that only existed inside login.html's
           <script>, so it threw a ReferenceError its own try/catch swallowed
           and ALWAYS redirected) is gone.
         · NO BYPASS. Offline entry requires re-entering the ACCOUNT'S OWN
           password, checked against a PBKDF2-SHA256 verifier this device
           wrote during the last SUCCESSFUL ONLINE sign-in. There is no
           universal code, no remembered plaintext, and no account picker: a
           username this device holds no grant for simply cannot sign in
           offline.
         · IDENTITY IS PRESERVED. The grant carries a snapshot of the
           profile row the SERVER sent (id, role, clinic, assigned doctor),
           so offline work is stamped with the REAL owner and later sync
           lands on the right shelf. Nothing here can STATE a role: the
           snapshot is only ever copied from a live staff_profiles row.
           Doctors retain their own shelf; secretaries are limited to their
           assigned primary doctor's shelf while offline.
         · LOCAL ONLY. Offline access reads/writes THIS DEVICE's data. Every
           cloud call still needs a live Supabase session - apiRequest fails
           closed without one and RLS is untouched - and while the device is
           online, ready() refuses the offline session and asks for a real
           sign-in, so "offline access to local data" and "authenticated
           against Supabase" can never be confused.
         · LIFETIME. The device grant lasts 180 days; an offline tab session
           lasts at most 12 hours and explicit sign-out clears only that
           session. A server-side revocation or deactivation cannot reach a
           device while it is offline; cloud calls still require live auth.
       ------------------------------------------------------------------ */
    const OFFLINE_GRANT_KEY = 'entOfflineGrantV2';
    const OFFLINE_SESSION_KEY = 'entOfflineSessionV1';
    const LEGACY_SAVED_LOGIN_KEY = 'entSavedLoginV1';       // plaintext era: deleted
    const REMEMBERED_PASSWORD_KEY = 'entRememberedPasswordV1';
    const PBKDF2_ITERATIONS = 210000;
    const OFFLINE_GRANT_DAYS = 180;
    const OFFLINE_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
    const OFFLINE_ALLOWED_PAGES = [
        'offlineworkspace.html',
        'nasalendoscopy.html',
        'laryngealendoscopy.html',
        'cf4form.html'
    ];
    let offlineSessionActive = false;

    // The plaintext era is over - delete any legacy entry on sight, even
    // before the first sign-in of this page load. It can never grant access
    // again, and every hour it sits in localStorage is an hour the password
    // is readable by anything that can reach this device's storage.
    try { localStorage.removeItem(LEGACY_SAVED_LOGIN_KEY); } catch (e) { /* ignore */ }

    function isOfflineNow() {
        try { return navigator.onLine === false; } catch (e) { return false; }
    }

    function subtleCrypto() {
        try {
            return (typeof crypto !== 'undefined' && crypto && crypto.subtle) ? crypto.subtle : null;
        } catch (e) { return null; }
    }

    function bytesToB64(bytes) {
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }

    function b64ToBytes(b64) {
        const bin = atob(String(b64));
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    /* PBKDF2-SHA256 with 210k iterations. Runs only at sign-in and at the
       offline verify (a few hundred ms on a phone), never on a hot path.
       Returns null when WebCrypto is unavailable (non-HTTPS origin, very old
       browser, bare test harness) - callers treat that as "no offline
       access", NEVER as "accept anything". */
    async function deriveVerifier(password, saltB64) {
        const subtle = subtleCrypto();
        if (!subtle || typeof TextEncoder === 'undefined') return null;
        try {
            const key = await subtle.importKey(
                'raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']
            );
            const bits = await subtle.deriveBits(
                { name: 'PBKDF2', salt: b64ToBytes(saltB64), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
                key,
                256
            );
            return bytesToB64(new Uint8Array(bits));
        } catch (e) {
            return null;
        }
    }

    /* Fixed-work comparison: every character is examined and the running OR
       means an early mismatch cannot return early. */
    function verifierMatches(expected, actual) {
        if (typeof expected !== 'string' || typeof actual !== 'string') return false;
        if (!expected.length || expected.length !== actual.length) return false;
        let diff = 0;
        for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
        return diff === 0;
    }

    function profileSnapshot(profile) {
        // ONLY the fields the offline UI and scopes need. The v2 schema has
        // nothing credential-shaped, so there is nothing sensitive to copy.
        const fields = ['id', 'username', 'full_name', 'role', 'clinic_id',
            'assigned_doctor_id', 'assigned_doctor_name', 'is_active'];
        const out = {};
        for (let i = 0; i < fields.length; i++) {
            const k = fields[i];
            if (profile && profile[k] !== undefined) out[k] = profile[k];
        }
        return out;
    }

    function readOfflineGrant() {
        let raw = null;
        try {
            raw = JSON.parse(localStorage.getItem(OFFLINE_GRANT_KEY) || 'null');
        } catch (e) { raw = null; }
        if (!raw || raw.v !== 2 || !raw.username || !raw.salt || !raw.verifier ||
            !raw.profile || !raw.profile.id ||
            (raw.profile.role !== 'doctor' &&
                !(raw.profile.role === 'secretary' && raw.profile.assigned_doctor_id))) {
            return null;
        }
        const grantedAt = Number(raw.grantedAt);
        const expiresAt = Number(raw.expiresAt);
        if (!Number.isFinite(grantedAt) || !Number.isFinite(expiresAt) ||
            expiresAt <= Date.now() || expiresAt <= grantedAt) {
            try { localStorage.removeItem(OFFLINE_GRANT_KEY); } catch (e) { /* ignore */ }
            return null;
        }
        // A grant for an already-inactive account is never usable.
        if (raw.profile.is_active === false) {
            try { localStorage.removeItem(OFFLINE_GRANT_KEY); } catch (e) { /* ignore */ }
            return null;
        }
        return raw;
    }

    /* Called ONLY from login() after GoTrue accepted the password and the
       live staff_profiles row passed every check. Best-effort by contract:
       a storage or crypto hiccup must never fail a sign-in - it only means
       this device will not have offline access until the next sign-in. */
    async function writeOfflineGrant(username, password, profile) {
        try {
            const supportedRole = profile && (
                profile.role === 'doctor' ||
                (profile.role === 'secretary' && profile.assigned_doctor_id)
            );
            if (!profile || !profile.id || !supportedRole || !password) return false;
            const subtle = subtleCrypto();
            if (!subtle) return false;
            // getRandomValues lives on crypto, not on subtle.
            const saltBytes = new Uint8Array(16);
            crypto.getRandomValues(saltBytes);
            const salt = bytesToB64(saltBytes);
            const verifier = await deriveVerifier(password, salt);
            if (!verifier) return false;
            localStorage.setItem(OFFLINE_GRANT_KEY, JSON.stringify({
                v: 2,
                username: String(username || '').trim(),
                salt: salt,
                verifier: verifier,
                profile: profileSnapshot(profile),
                grantedAt: Date.now(),
                expiresAt: Date.now() + OFFLINE_GRANT_DAYS * 24 * 60 * 60 * 1000
            }));
            try { localStorage.removeItem(LEGACY_SAVED_LOGIN_KEY); } catch (e) { /* ignore */ }
            return true;
        } catch (e) {
            return false;
        }
    }

    // Public, but deliberately MINIMAL: callers get the username to prefill
    // a box and nothing else - never the verifier, never the raw profile.
    function getOfflineGrant() {
        const grant = readOfflineGrant();
        return grant ? {
            username: grant.username,
            grantedAt: grant.grantedAt,
            expiresAt: grant.expiresAt
        } : null;
    }

    function hasOfflineGrant() {
        return !!readOfflineGrant();
    }

    function markOfflineSession(username) {
        try {
            sessionStorage.setItem(OFFLINE_SESSION_KEY, JSON.stringify({
                username: String(username || ''),
                at: Date.now()
            }));
            return true;
        } catch (e) { return false; }
    }

    function readOfflineSessionMark() {
        try {
            const raw = JSON.parse(sessionStorage.getItem(OFFLINE_SESSION_KEY) || 'null');
            return (raw && raw.username) ? raw : null;
        } catch (e) { return null; }
    }

    function clearOfflineSession() {
        try { sessionStorage.removeItem(OFFLINE_SESSION_KEY); } catch (e) { /* ignore */ }
        offlineSessionActive = false;
    }

    function clearOfflineAccess() {
        try { localStorage.removeItem(OFFLINE_GRANT_KEY); } catch (e) { /* ignore */ }
        try { localStorage.removeItem(LEGACY_SAVED_LOGIN_KEY); } catch (e) { /* ignore */ }
        clearOfflineSession();
    }

    function isOfflineSession() {
        return !!offlineSessionActive;
    }

    /* Bring the offline session - already password-VERIFIED in this tab by
       loginOffline() - to life from the grant snapshot. ready() calls this
       ONLY while the device is actually offline. Every check fails CLOSED:
       no marker, no grant, a username mismatch, or a GoTrue session for a
       different account all end with "not authorized", never with a user. */
    function hydrateOfflineSession() {
        try {
            const mark = readOfflineSessionMark();
            if (!mark) return false;
            const grant = readOfflineGrant();
            if (!grant) { clearOfflineSession(); return false; }
            if (String(mark.username).toLowerCase() !== String(grant.username).toLowerCase()) {
                clearOfflineSession(); return false;
            }
            if (!Number.isFinite(Number(mark.at)) ||
                Date.now() - Number(mark.at) > OFFLINE_SESSION_MAX_AGE_MS) {
                clearOfflineSession(); return false;
            }
            if (signedInUser && signedInUser.id && String(grant.profile.id) !== String(signedInUser.id)) {
                clearOfflineSession(); return false;
            }
            if (!signedInUser) {
                signedInUser = {
                    id: grant.profile.id,
                    email: grant.profile.username ? toEmail(grant.profile.username) : ''
                };
            }
            currentProfile = grant.profile;
            offlineSessionActive = true;
            return true;
        } catch (e) {
            return false;
        }
    }

    /* OFFLINE SIGN-IN (v36a). Verifies username + password against THIS
       device's grant, then brings the profile snapshot to life for this tab.
       Returns the same shape login() returns, plus offline:true so the login
       screen can say plainly that this is local access with cloud sync
       paused - not a live Supabase session. Refuses exactly like an online
       sign-in does: one message for "wrong password" and for "no grant for
       that username", so the screen never confirms which account exists. */
    async function loginOffline(username, password) {
        const name = String(username || '').trim();
        if (!name || !password) {
            return { success: false, error: 'Enter your username and password.' };
        }
        const grant = readOfflineGrant();
        if (!grant || String(grant.username).toLowerCase() !== name.toLowerCase()) {
            if (!grant) {
                return { success: false, error: 'This device has no valid offline grant. Connect to the internet and sign in again to prepare offline access.' };
            }
            return { success: false, error: 'Wrong username or password.' };
        }
        let verifier = null;
        try { verifier = await deriveVerifier(password, grant.salt); } catch (e) { verifier = null; }
        if (!verifier || !verifierMatches(verifier, grant.verifier)) {
            return { success: false, error: 'Wrong username or password.' };
        }
        // Verified. The snapshot becomes the current user for THIS tab only;
        // no server was asked, and none will be until the device is online.
        if (!markOfflineSession(grant.username)) {
            return { success: false, error: 'This browser could not start a secure offline session. Check browser storage settings and try again.' };
        }
        signedInUser = {
            id: grant.profile.id,
            email: grant.profile.username ? toEmail(grant.profile.username) : ''
        };
        currentProfile = grant.profile;
        offlineSessionActive = true;
        readyResolved = true;
        readyPromise = Promise.resolve(buildSafeUser());
        return { success: true, offline: true, user: buildSafeUser() };
    }


    /** The caller's live staff_profiles row, or null. Never a cached one. */
    async function loadProfile() {
        if (!signedInUser) { currentProfile = null; return null; }
        try {
            // MUST ask for MY OWN ROW BY ID.
            //
            // This used to read `staff_profiles?select=...&limit=1` and let
            // RLS narrow it to one row. That is only true for a doctor or a
            // secretary: profiles_select_self gives them exactly one row, so
            // limit=1 happened to be their own and everything looked fine.
            //
            // An admin is different. profiles_select_admin_clinic
            // (0008:48-55) deliberately lets an admin read EVERY profile in
            // his own clinic, so the unfiltered query returned the whole
            // clinic and `limit=1` took whichever row sorted first. Proved
            // against the live project: signing in as `testadmin` returned
            // username=testdoc1 with role=doctor, and `zzbadmin` returned
            // zcbdoc1/doctor. buildSafeUser() then built the admin out of a
            // DOCTOR's row, so the header said DOCTOR, isAdmin() was false,
            // and login.html sent the admin to index.html instead of
            // admin.html. RLS was never wrong; the query was ambiguous.
            //
            // Filtering by id removes the ambiguity at the source. RLS still
            // re-checks the same condition, so this narrows what the browser
            // may read and never widens it.
            const rows = await api(
                'staff_profiles?select=id,username,full_name,role,clinic_id,' +
                'assigned_doctor_id,is_super_secretary,is_active,must_change_password' +
                '&id=eq.' + encodeURIComponent(signedInUser.id));
            const row = (Array.isArray(rows) && rows[0]) ? rows[0] : null;
            // Belt and braces: never trust a row that is not literally mine.
            currentProfile = (row && row.id === signedInUser.id) ? row : null;

            /* A secretary works for ONE named doctor, and the header chip says so
             * out loud. buildSafeUser hardcoded assigned_doctor_name to '',
             * so every secretary was shown the literal text
             * "Dr. assigned only" - which reads as an unfilled field, not
             * as a fact about their access.
             *
             * This cannot be fetched from the browser by reading the
             * doctor's profile row: a secretary's token is filtered by RLS
             * and gets HTTP 200 with an empty array. Confirmed against the
             * live project. Loosening staff_profiles to work around it
             * would expose the whole staff table to fix one name.
             *
             * my_assigned_doctor_name() takes no arguments, so the caller
             * cannot aim it at anybody - it resolves the doctor from
             * auth.uid() server-side and returns one name or NULL.
             *
             * If the function is not deployed yet this simply yields no
             * name, and the chip falls back to wording that is true either
             * way. Sign-in must never depend on it.
             */
            if (currentProfile && currentProfile.role === 'secretary') {
                try {
                    const named = await api('rpc/my_assigned_doctor_name', { method: 'POST', body: '{}' });
                    currentProfile.assigned_doctor_name =
                        typeof named === 'string' ? named : '';
                } catch (e) { /* leave it blank; the chip has a neutral fallback */ }
            }
        } catch (e) {
            // 401/403 here means the server stopped accepting this token:
            // deactivated, deleted, or sessions revoked. That is SIGNED OUT,
            // not a network fault, so handle it as such (plan Step 5).
            if (e && (e.code === 'AUTH_REQUIRED' || e.status === 401 || e.status === 403)) {
                await logout({ silent: true });
                return null;
            }
            currentProfile = null;
        }
        return currentProfile;
    }

    /** A plain object shaped like the old v1 user, from the profile row. */
    function buildSafeUser() {
        if (!signedInUser || !currentProfile) return null;
        return Object.assign({}, currentProfile, {
            id: currentProfile.id || signedInUser.id,
            email: signedInUser.email,
            assigned_doctor_name: currentProfile.assigned_doctor_name || ''
        });
    }

    function readSession() {
        const user = buildSafeUser();
        // The shape login.html/dashboard.js expect. `session` and
        // `expiresAt` are vestigial: supabase-js owns both now.
        // `offline` (v36a) marks a session that came from THIS device's
        // offline grant instead of from GoTrue - renderChrome() wears the
        // dashed chip and the scope line says "offline access", so local
        // access is never mistaken for a live sign-in.
        return user ? { user, session: null, expiresAt: null, offline: offlineSessionActive } : null;
    }

    function clearSession() {
        signedInUser = null;
        currentProfile = null;
        readyPromise = null;
        // 0037: the cross-clinic secretary's "working today at ..." choice and
        // its once-per-session prompt flag are per-login. Drop both on sign-out
        // so the next account on this device never inherits another shelf, and
        // the next secretary is asked afresh. The RPC cache goes too.
        assignedDoctorsCache = null;
        clearWorkingChoice();
        activeClinicContextDoctorId = '';
        activeClinicContextError = null;
        clinicContextWarningShown = false;
        try { window.sessionStorage.removeItem(WORKING_PROMPTED_KEY); } catch (e) { /* ignore */ }
        // The photo service token dies with the session, so a signed-out
        // device cannot ask for photos.
        try {
            if (window.EntPhotoStore && typeof window.EntPhotoStore.clearToken === 'function') {
                window.EntPhotoStore.clearToken();
            }
        } catch (e) { /* ignore */ }
    }

    function currentUser() { return buildSafeUser(); }

    function isAdmin() {
        const user = currentUser();
        return !!user && user.role === 'admin';
    }

    /** Resolve once the session + profile are known. boot() awaits this. */
    function ready() {
        if (!readyPromise) {
            readyPromise = (async function () {
                try {
                    if (isOfflineNow()) {
                        // OFFLINE (v36a): never wait on - or depend on - the
                        // network. A stored GoTrue session cannot refresh
                        // itself with the radio off and loadProfile() would
                        // always fail, which is exactly why the OLD ready()
                        // resolved to null offline and boot() bounced every
                        // protected page back to the login screen in a loop.
                        // The only thing that can authorize a page here is the
                        // offline session this tab already VERIFIED through
                        // loginOffline() (password against the device grant).
                        hydrateOfflineSession();
                    } else {
                        const sb = client();
                        const { data } = await sb.auth.getSession();
                        if (data && data.session && data.session.user) {
                            signedInUser = data.session.user;
                            await loadProfile();
                            if (currentProfile) {
                                // A live server answer supersedes any offline
                                // claim: this is a real sign-in again.
                                offlineSessionActive = false;
                                markOfflineSession(currentProfile.username);
                            }
                        }
                    }
                } catch (e) {
                    signedInUser = null;
                    currentProfile = null;
                }
                // The connection can die mid-flight (getSession started online,
                // the radio went off before it settled). One more offline
                // attempt covers that: still no user while offline means this
                // device/tab is simply not authorized to work offline - guard()
                // sends it to the login screen, which explains the flow.
                // Nothing is ever fabricated here.
                if (!buildSafeUser() && isOfflineNow()) hydrateOfflineSession();
                if (buildSafeUser() && !offlineSessionActive) {
                    try {
                        await ensureSuperSecretaryClinicContext(buildSafeUser());
                    } catch (error) {
                        activeClinicContextError = error;
                        console.error('[Auth] Could not establish the active clinic context:', error);
                    }
                }
                readyResolved = true;
                return buildSafeUser();
            })();
        }
        return readyPromise;
    }

    /** Force a profile re-read, e.g. after a role change. */
    async function refreshProfile() {
        if (signedInUser) {
            await loadProfile();
            activeClinicContextError = null;
            await ensureSuperSecretaryClinicContext(buildSafeUser());
        }
        return buildSafeUser();
    }

    /* Picking a clinic stores its assigned doctor and reloads so every module
     * agrees on the new clinic context. */
    function openClinicPicker(doctors) {
        if (!Array.isArray(doctors) || doctors.length < 2) return;
        if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
        const old = document.getElementById('entClinicPicker');
        if (old && old.parentNode) old.parentNode.removeChild(old);

        const pickerUser = currentUser();
        const isSuperSecretary = pickerUser && pickerUser.is_super_secretary === true;
        const cur = workingChoice();
        const currentScope = scope();
        const curId = String(cur && cur.id || currentScope.doctorId || '');
        const currentDoctor = doctors.find(function (doctor) {
            return String(doctor.doctor_id || '') === curId;
        });
        const currentClinicId = String(cur && cur.clinic_id
            || currentDoctor && currentDoctor.clinic_id || '');
        let choices;
        if (isSuperSecretary) {
            const clinicGroups = Object.create(null);
            doctors.forEach(function (doctor) {
                const doctorId = String(doctor && doctor.doctor_id || '').trim();
                if (!doctorId) return;
                const clinicId = String(doctor.clinic_id || '').trim();
                const key = clinicId || 'doctor:' + doctorId;
                if (!clinicGroups[key]) {
                    clinicGroups[key] = {
                        clinicId: clinicId,
                        clinicName: doctor.clinic_name || 'Clinic not named',
                        doctors: []
                    };
                } else if (clinicGroups[key].clinicName === 'Clinic not named' && doctor.clinic_name) {
                    clinicGroups[key].clinicName = doctor.clinic_name;
                }
                clinicGroups[key].doctors.push(doctor);
            });
            choices = Object.keys(clinicGroups).map(function (key) {
                const clinic = clinicGroups[key];
                const selectedDoctor = clinic.doctors.find(function (doctor) {
                    return String(doctor.doctor_id || '') === curId;
                }) || clinic.doctors.find(function (doctor) {
                    return doctor.is_primary === true;
                }) || clinic.doctors[0];
                return {
                    id: String(selectedDoctor.doctor_id),
                    doctor: selectedDoctor,
                    clinicName: clinic.clinicName,
                    doctorCount: clinic.doctors.length,
                    isCurrent: clinic.clinicId
                        ? clinic.clinicId === currentClinicId
                        : clinic.doctors.some(function (doctor) {
                            return String(doctor.doctor_id || '') === curId;
                        })
                };
            });
        } else {
            choices = doctors.map(function (doctor) {
                const id = String(doctor.doctor_id);
                return {
                    id: id,
                    doctor: doctor,
                    clinicName: doctor.clinic_name || 'Clinic not named',
                    doctorCount: 1,
                    isCurrent: id === curId
                };
            });
        }
        if (choices.length < 2) return;

        const options = choices.map(function (choice) {
            const doctor = choice.doctor;
            const currentBadge = choice.isCurrent
                ? '<span class="ent-clinic-current">Current clinic</span>' : '';
            const title = isSuperSecretary
                ? choice.clinicName
                : 'Dr. ' + (doctor.doctor_name || 'Unknown');
            const detail = isSuperSecretary
                ? 'Dr. ' + (doctor.doctor_name || 'Unknown') + ' · '
                    + choice.doctorCount + ' assigned doctor' + (choice.doctorCount === 1 ? '' : 's')
                : choice.clinicName;
            return '<button type="button" class="ent-clinic-opt' + (choice.isCurrent ? ' is-current' : '')
                + '" data-id="' + escapeHtml(choice.id) + '" aria-pressed="' + String(choice.isCurrent) + '">'
                + '<span class="ent-clinic-opt-icon" aria-hidden="true">'
                + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
                + ' stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V7l7-4 7 4v14"/>'
                + '<path d="M9 10h.01M15 10h.01M9 14h.01M15 14h.01M10 21v-4h4v4"/></svg>'
                + '</span><span class="ent-clinic-opt-copy"><span class="ent-clinic-opt-name">'
                + escapeHtml(title) + '</span><span class="ent-clinic-opt-clinic">'
                + escapeHtml(detail) + '</span></span>' + currentBadge
                + '<span class="ent-clinic-opt-arrow" aria-hidden="true">&#8250;</span></button>';
        }).join('');

        const box = document.createElement('div');
        box.id = 'entClinicPicker';
        box.className = 'ent-modal ent-clinic-picker';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        box.setAttribute('aria-labelledby', 'entClinicPickerTitle');
        box.setAttribute('aria-describedby', 'entClinicPickerHint');
        box.setAttribute('tabindex', '-1');
        const pickerHint = isSuperSecretary
            ? 'Your dashboard shows records from the selected clinic only. Clinical Abstract and Medical Certificate stay available in Doc Jess clinic.'
            : 'Choose the doctor whose records you are working with. You can switch again anytime.';
        const heading = isSuperSecretary ? 'Switch clinic' : 'Choose doctor';
        box.innerHTML = '<div class="ent-modal-card ent-clinic-picker-card">'
            + '<div class="ent-clinic-picker-heading">'
            + '<span class="ent-clinic-picker-mark" aria-hidden="true">'
            + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
            + ' stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V7l7-4 7 4v14"/>'
            + '<path d="M9 10h.01M15 10h.01M9 14h.01M15 14h.01M10 21v-4h4v4"/></svg></span>'
            + '<span class="ent-clinic-picker-title"><small>WORKSPACE</small><h2 id="entClinicPickerTitle">'
            + heading + '</h2></span>'
            + '<button type="button" class="ent-clinic-picker-close" id="entClinicClose"'
            + ' aria-label="Close clinic switcher">&times;</button></div>'
            + '<p class="ent-clinic-picker-hint" id="entClinicPickerHint">' + pickerHint + '</p>'
            + '<div class="ent-clinic-list" role="group" aria-label="Available clinics">' + options + '</div>'
            + '<div class="ent-clinic-picker-footer">'
            + '<span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
            + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<path d="M12 3 4.5 6v5.5c0 4.3 3.2 7.7 7.5 9.5 4.3-1.8 7.5-5.2 7.5-9.5V6L12 3Z"/>'
            + '<path d="m9 12 2 2 4-4"/></svg>Clinic records stay separated</span>'
            + '<button type="button" class="ent-clinic-picker-cancel" id="entClinicCancel">Cancel</button>'
            + '</div></div>';
        const returnFocus = document.activeElement;
        document.body.appendChild(box);

        function close() {
            if (box.parentNode) box.parentNode.removeChild(box);
            document.removeEventListener('keydown', handleKeydown);
            if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus();
        }
        function handleKeydown(event) {
            if (event.key === 'Escape') close();
        }
        box.addEventListener('click', function (e) { if (e.target === box) close(); });
        document.addEventListener('keydown', handleKeydown);
        const cancel = box.querySelector('#entClinicCancel');
        if (cancel) cancel.addEventListener('click', close);
        const closeButton = box.querySelector('#entClinicClose');
        if (closeButton) closeButton.addEventListener('click', close);

        const list = box.querySelector('.ent-clinic-list');
        if (list) list.addEventListener('click', function (e) {
            const tgt = (e && e.target) ? e.target : null;
            const btn = (tgt && typeof tgt.closest === 'function') ? tgt.closest('.ent-clinic-opt') : null;
            if (!btn) return;
            const id = String(btn.getAttribute('data-id') || '');
            const doc = doctors.filter(function (d) { return String(d.doctor_id) === id; })[0];
            if (!doc) return;
            const user = currentUser();
            const contextReady = user && user.is_super_secretary === true
                ? setActiveClinicContext(id)
                : Promise.resolve();
            contextReady.then(function () {
                setWorkingChoice({
                    id: id,
                    name: doc.doctor_name || '',
                    clinic: doc.clinic_name || '',
                    clinic_id: doc.clinic_id || ''
                });
                close();
                if (window.location && typeof window.location.reload === 'function') window.location.reload();
            }).catch(function (error) {
                console.error('[Auth] Could not switch the active clinic:', error);
                activeClinicContextError = error;
                showClinicContextError();
                if (window.location && typeof window.location.reload === 'function') {
                    window.location.reload();
                }
            });
        });

        box.classList.add('open');
        const firstChoice = box.querySelector('.ent-clinic-opt');
        if (firstChoice && typeof firstChoice.focus === 'function') firstChoice.focus();
    }

    /* Every doctor this secretary may file under (primary + junction), as
     * rows { doctor_id, doctor_name, clinic_id, clinic_name, is_primary }.
     * No arguments, so the browser cannot aim it at anybody — the set is
     * resolved from auth.uid() server-side (0037). Non-secretaries and a
     * missing/un-deployed RPC yield [], so a single-doctor secretary keeps
     * working exactly as before. */
    function fetchAssignedDoctors(force, strict) {
        const user = currentUser();
        if (!user || user.role !== 'secretary') return Promise.resolve([]);
        if (assignedDoctorsCache && !force) return Promise.resolve(assignedDoctorsCache);
        return api('rpc/my_assigned_doctors', { method: 'POST', body: '{}' })
            .then(function (rows) {
                assignedDoctorsCache = Array.isArray(rows)
                    ? rows.filter(function (r) { return r && r.doctor_id; })
                    : [];
                return assignedDoctorsCache;
            })
            .catch(function (error) {
                assignedDoctorsCache = [];
                if (strict) throw error;
                return assignedDoctorsCache;
            });
    }

    /* Called once per page load from boot(). For a single-doctor secretary
     * (or a non-secretary) this is a no-op that also clears any STALE choice
     * left over from a removed junction row. For a multi-doctor secretary it
     * opens the picker once per session, and never over a page that already
     * has a valid choice. Guarded throughout so it can never block boot. */
    function ensureWorkingChoice() {
        const user = currentUser();
        if (!user || user.role !== 'secretary') return Promise.resolve();
        return fetchAssignedDoctors().then(function (doctors) {
            if (!doctors || doctors.length < 2) {
                // 0 or 1 doctor: nothing to choose. Drop a remembered choice so
                // the scope cannot point at a doctor she no longer works under.
                if (workingChoice()) clearWorkingChoice();
                return;
            }
            const cur = workingChoice();
            const stillValid = !!(cur && doctors.some(function (d) { return String(d.doctor_id) === cur.id; }));
            if (cur && !stillValid) clearWorkingChoice();
            if (stillValid) return;                    // already picked this session
            let prompted = null;
            try { prompted = window.sessionStorage.getItem(WORKING_PROMPTED_KEY); } catch (e) { prompted = '1'; }
            if (prompted) return;                      // already asked once
            try { window.sessionStorage.setItem(WORKING_PROMPTED_KEY, '1'); } catch (e) { prompted = '1'; }
            if (prompted) return;                      // private mode: never nag
            openClinicPicker(doctors);
        }).catch(function () { /* never block boot on the picker */ });
    }

    /* ------------------------------------------------------------------
       ROLE SCOPE - the heart of "walang nagsas SHARE ng records".
       doctor    -> only rows whose doctor_id is his/her own user id
       secretary -> only rows whose doctor_id is HER assigned doctor's id
       admin     -> everything (seeAll = true)
       offline   -> local device only (seeAll = false, doctorId = 'offline')
       ------------------------------------------------------------------ */
    function scope() {
        const user = currentUser();
        if (!user) return { role: 'guest', doctorId: '', seeAll: false, label: 'Not signed in' };
        if (user.role === 'admin') {
            return {
                role: 'admin',
                doctorId: '',
                seeAll: true,
                label: user.full_name || user.username
            };
        }
        if (user.role === 'doctor') {
            return {
                role: 'doctor',
                doctorId: user.id,
                seeAll: false,
                label: user.full_name || user.username,
                assignedDoctorId: ''
            };
        }
        if (user.role === 'offline') {
            return {
                role: 'offline',
                doctorId: 'offline',
                seeAll: false,
                label: user.full_name || user.username + ' (Offline)'
            };
        }
        // secretary. 0037: she may work under her primary OR any doctor in
        // secretary_assignments. The "working today at ..." choice names
        // where new reports are filed. A Super Secretary's active clinic is
        // separately validated by the database before protected pages load.
        const primary = user.assigned_doctor_id || '';
        const choice = workingChoice();
        const usingChoice = !!(choice && choice.id);
        const doctorId = usingChoice ? choice.id : primary;
        const doctorName = usingChoice
            ? (choice.name || user.assigned_doctor_name || 'assigned doctor')
            : (user.assigned_doctor_name || 'assigned doctor');
        return {
            role: 'secretary',
            doctorId: doctorId || '',
            seeAll: false,
            label: `${user.full_name || user.username} \u2192 Dr. ${doctorName}`,
            assignedDoctorId: primary,
            // Non-empty only when she is shelved under a NON-primary doctor.
            workingDoctorId: (usingChoice && choice.id !== primary) ? choice.id : '',
            workingClinicName: usingChoice ? (choice.clinic || '') : '',
            workingClinicId: usingChoice ? (choice.clinic_id || '') : ''
        };
    }

    /* ------------------------------------------------------------------
       USERS CACHE — retired, deliberately.

       v1 kept a full copy of the account table in every browser
       (entUsersCacheV1) so sign-in could work offline. That is a cached
       ROLE: the browser deciding who you are from a value it wrote
       itself, which is the stale-claim problem PRIV-04 tests.

       There is no replacement, and there must not be. An admin asks
       auth-admin {action:'list'} for the clinic directory when the admin
       screen needs it, and the answer is cached in memory for the page,
       not in localStorage for the week. readUserCache() is kept as a
       no-op so dbRecords.js, which uses it only to resolve a display
       name, still runs.
       ------------------------------------------------------------------ */
    function readUserCache() { return []; }

    async function loadAllUsers() { return []; }

    /* ------------------------------------------------------------------
       ACTIVITY LOG
       ent_stamp_audit (0005) OVERWRITES actor_id / actor_role / clinic_id
       from the caller's live profile, so the browser cannot forge an
       author. The one thing it must still get right is `action`, which is
       the ent_activity enum — an unknown value is rejected by Postgres.
       ------------------------------------------------------------------ */
    const ALLOWED_ACTIONS = [
        'LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'PASSWORD_CHANGED', 'PASSWORD_RESET',
        'USER_CREATED', 'USER_UPDATED', 'USER_ROLE_CHANGED',
        'USER_DEACTIVATED', 'USER_ACTIVATED', 'SESSION_REVOKED',
        'SAVE_RECORD', 'DELETE_RECORD', 'OPEN_RECORD',
        'SAVE_DRAFT', 'DELETE_DRAFT',
        'PHOTO_UPLOAD', 'PHOTO_DOWNLOAD', 'PHOTO_DELETE',
        'SETTING_UPDATED', 'ACCESS_DENIED'
    ];

    async function logActivity(action, detail) {
        const act = String(action || '').toUpperCase();
        if (ALLOWED_ACTIONS.indexOf(act) === -1) {
            console.warn('[EntAuth] refusing unknown activity action:', action);
            return false;
        }
        // audit_no_patient_name (0005) rejects detail containing
        // "patient_name": — patient-identifying text belongs in the report
        // row, never in the audit trail.
        const safeDetail = String(detail || '')
            .slice(0, 2000)
            .replace(/"patient_name"\s*:/gi, '"name":');
        const row = { action: act, detail: safeDetail, target_type: '', target_id: '' };
        /* Guard: a failed sign-in logs LOGIN_FAILED while the visitor has no
         * session at all. That POST comes back 401, and the old handler
         * reacted by calling logout() - which logs LOGOUT, which 401s again,
         * which calls logout()... The two functions called each other with
         * nothing to stop them, login() never returned, and the Sign in
         * button sat on "Signing in" forever with no message.
         *
         * That is what "it just hangs" was. Two guards, because either one
         * alone leaves a way in:
         *   - logBusy stops a second write while one is in flight;
         *   - no session means there is nothing to sign out of, so there is
         *     nothing for logout() to do and it must not be called.
         */
        if (logBusy) return false;
        if (!signedInUser) {
            // Expected on LOGIN_FAILED. Writing the row is impossible
            // without a session and pointless to attempt.
            return false;
        }
        logBusy = true;
        try {
            await api('activity_logs', json('POST', row));
            return true;
        } catch (error) {
            if (error && (error.code === 'AUTH_REQUIRED' || error.status === 401 || error.status === 403)) {
                // Still only a real session problem if we had one. A visitor
                // who simply typed the wrong password has not been signed
                // out of anything.
                if (signedInUser) await logout({ silent: true });
            } else {
                console.warn('[EntAuth] Could not write activity log:', error.message);
            }
            return false;
        } finally {
            logBusy = false;
        }
    }

    /* ------------------------------------------------------------------
       HEARTBEAT -> user_presence (v2).
       v1 PATCHed user_sessions, a table that literally stored bearer
       tokens. v2 stores nothing secret: ent_stamp_presence (0005) stamps
       user_id / clinic_id / role_at_seen from the caller, so the browser
       only has to name the device.
       ------------------------------------------------------------------ */
    async function beat() {
        if (!signedInUser) return false;
        // v36a: with the radio off every beat is a guaranteed failed fetch -
        // skip it; the 'online' listener in startHeartbeat beats on reconnect.
        if (isOfflineNow()) return false;
        // 2026-10-03: do not heartbeat from a hidden tab.
        //
        // This was the only timer in the app without this guard -
        // dashboard.js refresh(), refreshQueue(), ticketForm loadMine() and
        // admin.js liveTick() all already begin with a document.hidden
        // check. So one laptop with five background tabs open was writing a
        // user_presence row every 30 seconds, indefinitely, including
        // overnight, purely to tell a colleague someone was at their desk.
        //
        // WHY IT IS SAFE TO DROP
        //
        // user_presence is only ever read through the 5-minute window
        // (admin.js:260, LIVE_WINDOW_MS = 300000). A tab nobody is looking
        // at is a person nobody considers present, so the rows it was
        // writing were already being ignored - the writes bought nothing.
        //
        // RESUME IS NOT LOST, and it does not depend on this guard:
        //   1. setInterval keeps running. The tick that follows the tab
        //      becoming visible beats normally, because the guard is now
        //      false. Nothing has to be restarted.
        //   2. startHeartbeat() already registers a visibilitychange
        //      listener that beats immediately on return, so presence is
        //      restored on the same event that revealed the tab rather than
        //      up to HEARTBEAT_MS later.
        //
        // The guard is checked AFTER the session check on purpose: an
        // undefined document.hidden (a non-browser harness) is falsy, so
        // !document.hidden is true and the beat proceeds. Fail-open to
        // sending is the safe direction - the alternative would silently
        // stop presence for any context that does not model visibility.
        if (document.hidden) return false;
        try {
            // The heartbeat is an UPSERT, not a bare INSERT.
            //
            // user_presence is keyed (user_id, device_label) — see 0005,
            // which literally calls a heartbeat "a cheap upsert" — and the
            // row written by the PREVIOUS beat is still there. A bare POST
            // therefore answered 409 (unique violation 23505) on every tick
            // after the very first one: red in the console, beat() caught
            // the throw and returned false, and — the part that actually
            // mattered — seen_at never advanced, so Admin's "ACTIVE NOW"
            // froze at whatever the first-ever beat wrote.
            //
            // Same pattern reports and clinic_settings already use:
            // ?on_conflict=<the key> + Prefer: resolution=merge-duplicates.
            // The BEFORE INSERT OR UPDATE trigger ent_stamp_presence
            // re-stamps user_id / clinic_id / role_at_seen / seen_at on the
            // merge, so the payload stays just the device name — the
            // browser still decides nothing about who or when.
            await api(
                'user_presence?on_conflict=user_id,device_label',
                json('POST', { device_label: deviceLabel() }, {
                    Prefer: 'resolution=merge-duplicates'
                })
            );
            return true;
        } catch (error) {
            return false;
        }
    }

    function startHeartbeat() {
        if (heartbeatTimer) return;
        beat();
        heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
        // The immediate beat on return is what makes the hidden-tab guard
        // invisible to the user: they come back and presence is already
        // restored, without waiting for the next interval tick.
        document.addEventListener('visibilitychange', () => { if (!document.hidden) beat(); });
        window.addEventListener('online', () => beat());
    }

    function stopHeartbeat() {
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    }

/* ------------------------------------------------------------------
       LOGIN — Supabase Auth, not a password compared in the browser.

       v1 did this: fetch the clinic_users row -> pull password_hash and
       salt out of it -> hashPassword(salt, password) -> compare. The
       browser downloaded the credential in order to verify it, which
       means it was readable by anything that could reach the table.

       v2 does this: signInWithPassword({email, password}). The password
       goes to GoTrue, is compared with bcrypt there, and a session comes
       back. No hash is ever transmitted to or stored by this page.

       The username is still accepted at the login screen — a UI decision,
       not a security one — and becomes the address the account was
       actually created with.
       ------------------------------------------------------------------ */
    /* Failed sign-ins are queued, not written.
     *
     * activity_logs may only be written by a signed-in caller, so a failed
     * attempt genuinely cannot be recorded at the moment it happens. The old
     * code tried anyway, and the 401 it drew back kicked it into a loop with
     * logout() that never ended - which is precisely the "it just hangs on
     * sign in" report.
     *
     * Instead the attempt is remembered, and flushed after the next
     * successful sign-in, when there is finally a session to write it with.
     * sessionStorage so a reload does not lose it, and capped so a long
     * sequence of typos cannot fill it. Only the username is kept - never the
     * password - and audit_no_patient_name still screens the string.
     */
    const FAILED_KEY = 'entFailedLoginsV1';
    const FAILED_MAX = 10;

    function rememberFailedAttempt(username) {
        const name = String(username || '').trim().slice(0, 60);
        if (!name) return;
        let list = [];
        try { list = JSON.parse(sessionStorage.getItem(FAILED_KEY) || '[]'); } catch (e) { list = []; }
        if (!Array.isArray(list)) list = [];
        list.push({ username: name, at: Date.now() });
        while (list.length > FAILED_MAX) list.shift();
        try { sessionStorage.setItem(FAILED_KEY, JSON.stringify(list)); } catch (e) { /* private mode */ }
    }

    async function flushFailedAttempts() {
        let list = [];
        try { list = JSON.parse(sessionStorage.getItem(FAILED_KEY) || '[]'); } catch (e) { return; }
        if (!Array.isArray(list) || !list.length) return;
        try { sessionStorage.removeItem(FAILED_KEY); } catch (e) { /* ignore */ }
        for (const item of list) {
            if (!item || !item.username) continue;
            await logActivity('LOGIN_FAILED', 'username=' + item.username);
        }
    }

    async function login(username, password) {
        const email = toEmail(username);
        if (!email || !password) {
            return { success: false, error: 'Enter your username and password.' };
        }
        let sb;
        try {
            sb = client();
        } catch (e) {
            return { success: false, error: 'Sign-in is unavailable: ' + e.message };
        }

        let result;
        try {
            // A hard ceiling. signInWithPassword() has no timeout of its own,
            // so on a network that accepts the connection and then goes
            // quiet the promise simply never settles - the button says
            // "Signing in" and the visitor is told nothing. Fifteen seconds
            // is far longer than the ~0.8s a real refusal takes.
            //
            // Guarded on setTimeout actually existing. Where it does not, the
            // race would reject with "setTimeout is not defined" - and that
            // string matches isNetworkError()'s /timed? ?out/ pattern on the
            // "Timeout" inside it, so a missing timer would be reported to the
            // user as a network fault and every sign-in would fail.
            const attempt = sb.auth.signInWithPassword({ email, password });
            let timer = null;
            if (typeof setTimeout === 'function') {
                const ceiling = new Promise(function (resolve, reject) {
                    timer = setTimeout(function () {
                        reject(new Error('The server did not answer in time.'));
                    }, SIGN_IN_TIMEOUT_MS);
                });
                try {
                    result = await Promise.race([attempt, ceiling]);
                } finally {
                    // Clear it the moment the attempt settles. Otherwise a
                    // fast, ordinary refusal leaves a pending 15s timer
                    // holding the closure alive, which keeps short-lived
                    // hosts (tests, workers) from ever going idle.
                    if (timer !== null && typeof clearTimeout === 'function') clearTimeout(timer);
                }
            } else {
                result = await attempt;
            }
        } catch (e) {
            const slow = /did not answer in time/i.test(String((e && e.message) || e));
            return {
                success: false,
                error: slow
                    ? 'The server did not answer. Check your connection and try again.'
                    : (isNetworkError(e)
                        ? 'Could not reach the server. Check your connection and try again.'
                        : (e.message || 'Sign-in failed.'))
            };
        }

        if (result.error || !result.data || !result.data.user) {
            // Never say which half was wrong - that would confirm to anyone
            // probing the screen whether an account exists. Say plainly that
            // the pair did not match, which is both accurate and the thing
            // the person needs to hear.
            //
            // The attempt is still worth recording for the audit trail, but
            // activity_logs can only be written by a signed-in caller, and
            // this caller by definition is not one. Writing it here is what
            // caused the hang. So it is held until there IS a session: the
            // next successful sign-in flushes it, and it is remembered across
            // a reload via sessionStorage so closing the tab does not erase it.
            rememberFailedAttempt(username);
            return { success: false, error: 'Wrong username or password.' };
        }

        signedInUser = result.data.user;
        await loadProfile();

        // No profile row means the account exists in auth but was never
        // provisioned as staff — or was removed. Refuse rather than treat it
        // as a usable session.
        if (!currentProfile) {
            try { await sb.auth.signOut(); } catch (e) { /* ignore */ }
            clearSession();
            return { success: false, error: 'This account has no staff profile. Ask an administrator.' };
        }
        if (currentProfile.is_active === false) {
            try { await sb.auth.signOut(); } catch (e) { /* ignore */ }
            clearSession();
            return { success: false, error: 'This account has been deactivated.' };
        }

        startHeartbeat();
        // Now there IS a session, so the queued failures can finally be
        // written. Awaited but never allowed to block the sign-in.
        try { await flushFailedAttempts(); } catch (e) { /* ignore */ }
        try { await logActivity('LOGIN', 'Signed in'); } catch (e) { /* ignore */ }
        // OFFLINE ACCESS GRANT: THIS is the only moment a device ever earns
        // offline access - GoTrue accepted the password AND the live
        // staff_profiles row passed every check. Store a PBKDF2 verifier of
        // the password plus the profile snapshot the offline UI needs; never
        // the password itself. Doctors retain their own shelf; secretaries
        // are granted only when a primary assigned doctor is present. The
        // sessionStorage mark means THIS tab signed in, so a reload after the
        // wifi drops does not demand the password twice - closing the tab
        // does, which is the point.
        try {
            await writeOfflineGrant(username, password, currentProfile);
        } catch (e) { /* offline access is a convenience, never a failure reason */ }
        markOfflineSession(username);
        offlineSessionActive = false;
        return {
            success: true,
            mustChangePassword: !!currentProfile.must_change_password,
            user: buildSafeUser()
        };
    }
/* ------------------------------------------------------------------
       setPassword — GoTrue owns the password now.

       v1 wrote `salt` and `password_hash` back onto the clinic_users row
       from the browser. v2 has no such column, and no client code may
       create one. updateUser() re-supplies the CURRENT password, so an
       unattended signed-in browser cannot silently change a credential.
       ------------------------------------------------------------------ */
    async function setPassword(username, newPassword, currentPassword) {
        const next = String(newPassword || '');
        if (next.length < MIN_PASSWORD_LENGTH) {
            return { success: false, error: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
        }
        let sb;
        try {
            sb = client();
        } catch (e) {
            return { success: false, error: 'Password change is unavailable: ' + e.message };
        }

        if (signedInUser) {
            const { error } = await sb.auth.updateUser({ password: next });
            if (!error) {
                try { await logActivity('PASSWORD_CHANGED', 'Password changed'); } catch (e) { /* ignore */ }
                return { success: true };
            }
            return { success: false, error: friendlyAuthError(error, 'The password could not be changed.') };
        }

        // The "must change password" screen can run before a usable session
        // exists, so re-authenticate with the OLD password first. GoTrue
        // verifies it server-side; this page never handles a hash.
        const email = toEmail(username);
        if (!email || !currentPassword) {
            return { success: false, error: 'Enter your current password.' };
        }
        const check = await sb.auth.signInWithPassword({ email, password: currentPassword });
        if (check.error || !check.data || !check.data.user) {
            return { success: false, error: 'Your current password was not correct.' };
        }
        signedInUser = check.data.user;
        await loadProfile();

        const { error } = await sb.auth.updateUser({ password: next });
        if (error) {
            return { success: false, error: friendlyAuthError(error, 'The password could not be changed.') };
        }
        try { await logActivity('PASSWORD_CHANGED', 'Password changed'); } catch (e) { /* ignore */ }
        return { success: true };
    }

    function friendlyAuthError(error, fallback) {
        const msg = String((error && error.message) || '').toLowerCase();
        if (/invalid login credentials/.test(msg)) return 'That username and password did not match.';
        if (/same as the old|should be different/.test(msg)) return 'The new password must be different from the old one.';
        if (/password should be at least/.test(msg)) {
            // Say OUR floor, not GoTrue's number: the message quotes whatever
            // the project setting is, and echoing it back used to tell users
            // "8 characters" on a screen whose own rule was 6.
            return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
        }
        if (/rate limit|too many/.test(msg)) return 'Too many attempts. Wait a moment and try again.';
        if (/email not confirmed/.test(msg)) return 'This account has not been confirmed yet.';
        return (error && error.message) || fallback;
    }

    /* ------------------------------------------------------------------
       LOGOUT — signOut() clears the session supabase-js stored and stops
       the heartbeat. There is no server-side session row to revoke: GoTrue
       owns the token. Revoking SOMEONE ELSE's sessions is an admin action
       ({action:'revoke_sessions'}).
       ------------------------------------------------------------------ */
    async function logout(options) {
        const opts = options || {};
        const wasOfflineSession = offlineSessionActive;
        // Second line of defence. A second logout() while one is already
        // running must not re-enter and re-log.
        if (logoutBusy) return;
        logoutBusy = true;
        try {
            if (!wasOfflineSession) {
                try { await logActivity('LOGOUT', 'Signed out'); } catch (e) { /* ignore */ }
            }
            stopHeartbeat();
            try {
                const sb = window.EntSupabase && window.EntSupabase.getClient
                    ? window.EntSupabase.getClient() : null;
                if (sb) {
                    await sb.auth.signOut(wasOfflineSession ? { scope: 'local' } : undefined);
                }
            } catch (e) { /* sign out locally regardless */ }
            clearSession();
            // Logout ends this tab's authenticated session but leaves the
            // device grant available for a later password-verified offline
            // sign-in. Patient drafts and queued reports are stored separately.
            clearOfflineSession();
            if (!opts.silent) window.location.href = pageUrl('login.html');
        } finally {
            logoutBusy = false;
        }
    }

    /* ------------------------------------------------------------------
       GUARD - every protected page calls this.
       ------------------------------------------------------------------ */
    function currentPageFile() {
        let path = (window.location.pathname || '').split('/').pop() || '';
        if (!path) return 'index.html';
        path = decodeURIComponent(path).toLowerCase();
        // The static server strips the extension: /login and /login.html are
        // the same document, but PUBLIC_PAGES is written with extensions, so
        // '/login' failed the check, boot() treated the login page as
        // protected, redirected to login.html, the server rewrote that back
        // to /login, and the page reloaded itself in a loop forever.
        return /\.html?$/.test(path) ? path : path + '.html';
    }

    // v36a: hasOfflineCredentials() is GONE. It read SAVED_LOGIN_KEY, a
    // constant that only existed inside login.html's <script> - inside this
    // file the reference threw a ReferenceError its own try/catch swallowed,
    // so it returned false forever and guard() bounced every protected page
    // back to login while offline. Offline authorization now lives in
    // hydrateOfflineSession()/loginOffline() above and runs inside ready().
    function guard(options) {
        const opts = options || {};
        const page = currentPageFile();
        if (PUBLIC_PAGES.indexOf(page) !== -1) return readSession();

        const sendToLogin = function () {
            const next = encodeURIComponent(window.location.pathname.split('/').pop() + window.location.search);
            window.location.replace(pageUrl('login.html') + `?next=${next}`);
        };

        // The session is not known yet. Reading it synchronously returned a
        // null session and bounced a signed-in user to the login screen on
        // every load — and login.html sent them straight back, an endless
        // loop. Return the pending result instead so callers can await it.
        if (!readyResolved) {
            return ready().then(function () { return decide(); });
        }
        return decide();

        function decide() {
            const s = readSession();
            if (!s) { 
                // v36a: the offline branch that used to live here read a
                // SAVED_LOGIN_KEY constant that only existed inside
                // login.html's <script> (ReferenceError, swallowed, always
                // redirected) - so offline the page ping-ponged between the
                // login screen and its target forever. The offline session is
                // now established BEFORE guard() runs: ready() hydrates it
                // only after loginOffline() verified the password against
                // this device's grant. No session here while offline means
                // "this device/tab is not authorized offline", and the login
                // screen explains the flow.
                sendToLogin(); return null; 
            }
            if (activeClinicContextError && s.user.role === 'secretary' && s.user.is_super_secretary === true) {
                showClinicContextError();
                return null;
            }
            if (opts.roles && opts.roles.indexOf(s.user.role) === -1) {
                if (typeof opts.onDenied === 'function') return opts.onDenied(s);
                window.location.replace(pageUrl('index.html') + '?denied=1');
                return null;
            }
            return s;
        }
    }

    /* ------------------------------------------------------------------
       HEADER CHROME - who am I, whose records am I viewing, sign out.
       ------------------------------------------------------------------ */
    function initialsOf(name) {
        return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2)
            .map(part => part[0].toUpperCase()).join('') || '?';
    }

    function bindOfflineBackToMenu() {
        const backButton = document.querySelector('.back-button');
        if (!backButton || backButton.dataset.offlineMenuBound === 'true') return;
        backButton.dataset.offlineMenuBound = 'true';
        backButton.href = pageUrl('offlineWorkspace.html');
        backButton.addEventListener('click', async function (event) {
            if (!offlineSessionActive) return;
            event.preventDefault();
            backButton.setAttribute('aria-busy', 'true');
            backButton.classList.add('is-saving-offline');
            try {
                const bridge = window.EntFormBridge;
                const drafts = window.EntDrafts;
                const data = bridge && typeof bridge.getData === 'function' ? bridge.getData() : null;
                const draft = data && drafts && typeof drafts.saveOfflineDraft === 'function'
                    ? drafts.saveOfflineDraft(bridge.reportType, data)
                    : null;
                if (draft && draft.offlinePersistPromise) {
                    const result = await draft.offlinePersistPromise;
                    if (result && result.saved) {
                        window.location.href = pageUrl('offlineWorkspace.html');
                        return;
                    }
                    const reason = result && result.error
                        ? '\n\n' + result.error
                        : '';
                    if (!window.confirm(
                        'This form could not be confirmed in local storage.' + reason +
                        '\n\nReturn to the Offline Mode menu anyway? Unsaved changes may be lost.'
                    )) return;
                } else {
                    const reason = data
                        ? 'This form has not been saved as a local draft (a patient name may be required).'
                        : 'The form data could not be read for a local draft save.';
                    if (!window.confirm(
                        reason + '\n\nReturn to the Offline Mode menu anyway? Unsaved changes may be lost.'
                    )) return;
                }
                window.location.href = pageUrl('offlineWorkspace.html');
            } catch (error) {
                console.error('[EntAuth] Could not save the form before returning to Offline Mode:', error);
                if (window.confirm(
                    'The form could not be saved locally.' +
                    '\n\nReturn to the Offline Mode menu anyway? Unsaved changes may be lost.'
                )) window.location.href = pageUrl('offlineWorkspace.html');
            } finally {
                backButton.removeAttribute('aria-busy');
                backButton.classList.remove('is-saving-offline');
            }
        });
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, c => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    function renderChrome() {
        const session = readSession();
        if (!session) return null;
        if (document.getElementById('entUserChip')) return document.getElementById('entUserChip');
        if (document.body.classList.contains('ent-login-page')) return null;

        const user = session.user;
        const scoped = scope();
        const chip = document.createElement('div');
        chip.id = 'entUserChip';
        chip.className = `ent-user-chip role-${user.role} no-print`;

        /* What this person can actually reach, in plain words.
         *
         * The old line was one shouty string: "SECRETARY · Dr. assigned
         * only". Two problems. The role was shouted while the scope - the
         * part that actually matters - was crammed after it, and a
         * secretary with no doctor resolved yet rendered the literal words
         * "Dr. assigned only", which looks like an unfilled field.
         *
         * Role and scope are now separate elements so they can be styled
         * differently: the role is a small badge, the scope is the readable
         * line. The doctor's name comes from the profile now, and the
         * no-doctor case says so honestly instead of inventing one.
         */
        const roleText = { admin: 'Administrator', doctor: 'Doctor', secretary: 'Secretary', offline: 'Offline Mode' };
        // v36a: an OFFLINE ACCESS session (password verified against this
        // device's local grant, no server round-trip) is labelled where the
        // scope line is, so "offline access to previously authorized local
        // data" is never mistaken for a live sign-in against Supabase.
        const offlineAccess = !!(session.offline && isOfflineNow());
        let viewing = user.role === 'admin'
            ? 'Every doctor in the clinic'
            : (user.role === 'doctor'
                ? 'Own patients only'
                : (user.role === 'offline'
                    ? 'Offline mode - local device only'
                    : (function () {
                        // 0037: name the shelf she is actually on — the "working
                        // today at ..." choice if she made one, else her primary.
                        const choice = workingChoice();
                        const name = choice ? (choice.name || user.assigned_doctor_name) : user.assigned_doctor_name;
                        const clinic = choice ? (choice.clinic || '') : '';
                        if (name) return 'Works for Dr. ' + name + (clinic ? ' \u00b7 ' + clinic : '');
                        // "No doctor assigned yet" would be a lie. The RPC
                        // returns nothing both when there is genuinely no doctor
                        // AND when it simply has not been deployed yet. This
                        // wording is true in either case: a secretary is scoped
                        // to one doctor regardless.
                        return 'Scoped to one doctor';
                    })()));
        if (offlineAccess) {
            viewing = 'Offline access \u00b7 local device only \u00b7 sign in online to sync';
        }

        chip.innerHTML = `
            <span class="ent-user-avatar" aria-hidden="true">${escapeHtml(initialsOf(user.full_name || user.username))}</span>
            <span class="ent-user-meta">
                <strong>
                    <span class="ent-user-name">${escapeHtml(user.full_name || user.username)}</span>
                    <span class="ent-user-role role-${escapeHtml(user.role)}">${escapeHtml(roleText[user.role] || user.role)}</span>
                </strong>
                <small class="ent-user-scope" title="What this account can see">${escapeHtml(viewing)}</small>
            </span>
            ${user.role === 'secretary' ? '<button type="button" class="ent-user-switch" title="Choose which clinic you are working at today" aria-label="Switch working clinic"><span aria-hidden="true">&#8644;</span><span class="ent-user-switch-text">Switch clinic</span></button>' : ''}
            ${user.role === 'admin' ? '<a class="ent-user-admin" href="' + escapeHtml(pageUrl('admin.html')) + '" title="Open the admin console"><span aria-hidden="true">&#9881;</span> Admin console</a>' : ''}
            ${user.role === 'admin' ? '<a class="ent-user-settings" href="' + escapeHtml(pageUrl('settings.html')) + '" title="Form settings - letterhead, doctors, cloud sync" aria-label="Form settings"><span aria-hidden="true">&#9881;</span></a>' : ''}
            <button type="button" class="ent-user-logout" title="Sign out of this device" aria-label="Sign out"><span class="ent-user-logout-icon" aria-hidden="true">&#9099;</span><span class="ent-user-logout-text">Sign out</span></button>
        `;
        const logoutButton = chip.querySelector('.ent-user-logout');
        logoutButton.addEventListener('click', () => {
            let modal = document.getElementById('signOutModal');
            if (!modal) {
                modal = document.createElement('div');
                modal.id = 'signOutModal';
                modal.className = 'modal-overlay signout-overlay';
                modal.style.display = 'none';
                modal.setAttribute('role', 'dialog');
                modal.setAttribute('aria-modal', 'true');
                modal.setAttribute('aria-labelledby', 'signOutModalTitle');
                modal.setAttribute('aria-describedby', 'signOutModalText');
                modal.setAttribute('aria-hidden', 'true');
                modal.innerHTML = `
                    <div class="signout-dialog">
                        <span class="signout-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M10 17l5-5-5-5M15 12H3"/>
                                <path d="M12 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5"/>
                            </svg>
                        </span>
                        <p class="signout-eyebrow">SESSION</p>
                        <h2 id="signOutModalTitle">Sign out?</h2>
                        <p id="signOutModalText">You can sign back in anytime. Are you sure you want to sign out of this device?</p>
                        <div class="signout-actions">
                            <button id="cancelSignOutBtn" type="button" class="signout-cancel">Stay signed in</button>
                            <button id="confirmSignOutBtn" type="button" class="signout-confirm">
                                <span>Sign out</span>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>
                            </button>
                        </div>
                    </div>
                `;
                document.body.appendChild(modal);
            }
            const confirmButton = document.getElementById('confirmSignOutBtn');
            const cancelButton = document.getElementById('cancelSignOutBtn');

            if (!confirmButton || !cancelButton) {
                void logout();
                return;
            }

            let isClosing = false;
            const closeModal = () => {
                if (isClosing) return;
                isClosing = true;
                modal.classList.remove('is-open');
                modal.classList.add('is-closing');
                document.removeEventListener('keydown', handleKeydown);
                window.setTimeout(() => {
                    modal.style.display = 'none';
                    modal.setAttribute('aria-hidden', 'true');
                    modal.classList.remove('is-closing');
                    isClosing = false;
                    logoutButton.focus();
                }, 240);
            };
            const handleKeydown = (event) => {
                if (event.key === 'Escape') closeModal();
            };

            confirmButton.onclick = () => {
                closeModal();
                void logout();
            };
            cancelButton.onclick = closeModal;
            modal.onclick = (event) => {
                if (event.target === modal) closeModal();
            };
            modal.classList.remove('is-closing');
            modal.style.display = 'flex';
            modal.setAttribute('aria-hidden', 'false');
            window.requestAnimationFrame(() => modal.classList.add('is-open'));
            document.addEventListener('keydown', handleKeydown);
            cancelButton.focus();
        });
        // 0037: a secretary with more than one assigned doctor can re-open the
        // "working today at ..." picker here. Force a fresh list so a newly
        // added assignment shows up without a reload first. A secretary with a
        // single assignment gets a no-op (the picker refuses to open for <2).
        if (user.role === 'secretary') {
            const swBtn = chip.querySelector('.ent-user-switch');
            if (swBtn) swBtn.addEventListener('click', function () {
                fetchAssignedDoctors(true).then(function (doctors) {
                    if (doctors && doctors.length > 1) openClinicPicker(doctors);
                });
            });
        }

        // Preferred landing spot: the dedicated slot in the header's status row.
        // Falling back to the old hosts keeps every page working.
        const host = document.querySelector('.header-user-slot')
            || document.querySelector('.header-content')
            || document.querySelector('.report-header')
            || document.querySelector('header')
            || document.body;
        host.appendChild(chip);

        // The chip is white-on-gradient inside the coloured (.header) bar, and
        // dark-on-light everywhere else (report headers, plain pages).
        chip.classList.toggle('is-on-dark', !!(host.closest && host.closest('.header')));


        if (session.offline && navigator.onLine === false) {
            chip.classList.add('is-offline');
        }
        return chip;
    }

    /* ------------------------------------------------------------------
       BOOT

       v2 makes this asynchronous on purpose. The session and the live
       staff_profiles row are two separate reads now, so guarding a page
       before the profile arrives would bounce a signed-in user to the
       login screen on every reload. ready() resolves once both are known,
       and only then do we guard.
       ------------------------------------------------------------------ */
    async function boot() {
        const page = currentPageFile();
        if (PUBLIC_PAGES.indexOf(page) !== -1) return;

        const user = await ready();
        if (!user) {
            const next = encodeURIComponent(window.location.pathname.split('/').pop() + window.location.search);
            window.location.replace(pageUrl('login.html') + `?next=${next}`);
            return;
        }
        if (activeClinicContextError && user.role === 'secretary' && user.is_super_secretary === true) {
            showClinicContextError();
            return;
        }
        bindSuperSecretaryChoiceSync(user);

        if (offlineSessionActive && OFFLINE_ALLOWED_PAGES.indexOf(page) === -1) {
            window.location.replace(pageUrl('offlineWorkspace.html'));
            return;
        }

        if (page !== 'offlineworkspace.html') {
            startHeartbeat();
            renderChrome();
            if (offlineSessionActive) bindOfflineBackToMenu();
        }
        // 0037: a secretary who may work under several doctors picks which
        // clinic she is at today. Fire-and-forget so it never delays the page.
        if (page !== 'offlineworkspace.html') {
            try { ensureWorkingChoice(); } catch (e) { /* never block boot */ }
        }

        // A revoked or deactivated session must land the user on the login
        // screen from wherever they are, not on a broken page.
        if (window.EntSupabase && typeof window.EntSupabase.onAuthChange === 'function') {
            window.EntSupabase.onAuthChange(function (evt) {
                if (evt && evt.event === 'SIGNED_OUT') {
                    // The server ended the session (sign-out elsewhere,
                    // revoked, refresh token gone) - this tab's OFFLINE claim
                    // goes with it. The device grant itself survives until an
                    // explicit sign-out, because a revocation cannot reach a
                    // device that is offline; this limitation is documented
                    // in the grant block above.
                    clearOfflineSession();
                    window.location.replace(pageUrl('login.html'));
                }
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }

    /* ------------------------------------------------------------------
       PUBLIC API

       v2 REMOVED these exports on purpose. Anything still calling them
       has not been migrated yet, and is listed here so the failure is a
       clear "not a function" rather than a silent no-op:
         hashPassword, sha256Hex   — browser-side password hashing
         randomHex, uuid           — v1 session token minting
         getClinicId               — the browser picking its own clinic
         cacheUsers                — a full account table in localStorage
         freeSpaceForSession       — quota juggling for the hand-rolled session
       ------------------------------------------------------------------ */
    window.EntAuth = {
        // auth
        login,
        // v36a offline access: verified against this device's grant, local
        // only, and deliberately separate from the online login above.
        loginOffline,
        hasOfflineGrant,
        getOfflineGrant,
        isOfflineSession,
        logout,
        setPassword,
        guard,
        boot,
        ready,
        refreshProfile,
        // identity + scope
        scope,
        currentUser,
        isAdmin,
        // Shared with the admin console so the two screens cannot disagree
        // about the sign-in address or the password floor. Read-only
        // constants; nothing here can change a role.
        EMAIL_DOMAIN,
        MIN_PASSWORD_LENGTH,
        toEmail,
        readSession,
        readSessionProblem,
        clearSessionProblem,
        clearSession,
        // activity + presence
        logActivity,
        beat,
        startHeartbeat,
        stopHeartbeat,
        // misc kept for existing callers
        renderChrome,
        // 0037 cross-clinic secretary: the "working today at ..." picker.
        fetchAssignedDoctors,
        openClinicPicker,
        isDocJessClinic,
        getClinicName,
        workingDoctor: workingChoice,
        // Page URLs, resolved against this page's own depth. Shared with
        // dashboard.js, admin.js and draftsBrowser.js so a link to the
        // admin console is built the same way on every screen instead of
        // each module guessing a relative path.
        pageUrl,
        loadAllUsers,
        readUserCache,
        deviceLabel,
        escapeHtml,
        HEARTBEAT_MS,
        ACTIVE_WINDOW_MS: 5 * 60 * 1000
    };

})(window);
