/* =====================================================================
   ADMIN CONSOLE  (admin.html)
   ---------------------------------------------------------------------
   Admin-only: user management (4 doctors / 4 secretaries / 1 admin by
   default), live session monitoring and the activity log.
   Depends on: supabaseClient.js (window.EntSupabase), auth.js (EntAuth)
   ===================================================================== */
(function (window) {
    'use strict';

    const Auth = window.EntAuth;
    if (!Auth) {
        document.body.insertAdjacentHTML('afterbegin',
            '<p style="padding:20px;color:#e74c3c;">auth.js failed to load - the admin console cannot run.</p>');
        return;
    }

    // Hard gate: only administrators may see this page. v2 loads the
    // session and the live profile asynchronously, so guard() can return a
    // pending result. Deciding here at module scope read a null session on
    // every load and aborted the console before it started; the check now
    // lives in boot() where it can be awaited.
    let session = null;

    const LIVE_WINDOW_MS = Auth.ACTIVE_WINDOW_MS || 300000;

    // The "ACTIVE NOW" poll. Was 15000; now 30000 (2026-10-03).
    //
    // Used by liveTick and NOTHING else in this file - verified with
    // `grep REFRESH_MS function/admin.js`, which returns exactly the
    // declaration here plus the one setInterval below it. ANALYTICS_REFRESH_MS
    // is a separate constant and was deliberately left at 60000.
    //
    // WHY 30s IS LOSSLESS, NOT A COMPROMISE
    //
    // This poll does not display "last seen 15 seconds ago". It drives a
    // tile whose entire definition of active is:
    //
    //     (Date.now() - seen) < LIVE_WINDOW_MS     // line 260
    //
    // and LIVE_WINDOW_MS is 300000 - five minutes. So a colleague who closed
    // their laptop five minutes ago already reads as inactive, and one who
    // is typing right now already reads as active. Every value between 0
    // and 300000 produces the SAME tile. Polling at 15s was already 20x
    // finer than the data it renders; at 30s it is 10x finer.
    //
    // What this cannot do is lose the transition: a heartbeat arrives at
    // most 30s after someone signs in, so the worst case is that someone
    // appears active up to 30s late. It cannot make an inactive user look
    // active, because staleness only ever pushes seen_at further into the
    // past, and the window is 5 minutes wide.
    //
    // Halving the biggest Edge Function invocation source in the app
    // (240/hr -> 120/hr per open console) for a bound no user can observe.
    const REFRESH_MS = 30000;

    // One source of truth for the password floor, owned by auth.js and
    // enforced identically by auth-admin. This file used to hard-code 6
    // while auth.js said 8 and the Edge Function said 10, so the admin
    // screen happily accepted a password the server then refused. The
    // fallback exists only so an older auth.js cannot break the console.
    const MIN_PASSWORD_LENGTH = Auth.MIN_PASSWORD_LENGTH || 6;

    let users = [];
    let sessions = [];
    /* A CORS/origin failure never heals by retrying: the server keeps
     * answering without Access-Control-Allow-Origin and the browser keeps
     * throwing every reply away. Without this counter each 30s liveTick and
     * each manual refresh adds another pair of red rows in F12, which is
     * exactly the "dumadami" the admin reported. After three consecutive
     * origin/offline failures the live poll stops itself and says the fix
     * once, instead of shouting it forever. A successful call resets it. */
    let originFailStreak = 0;
    const ACTIVITY_WINDOW = 1000;  // newest N audit rows kept on screen
    let activity = [];
    let activityLoaded = false;
    let activityCursorId = 0;     // highest activity_logs.id seen so far
    let activityError = '';
    let editingId = null;      // null = creating a new user
    // 0037: the secretary's ADDITIONAL doctors as last READ from the server
    // (secretary_assignments). Compared against the form on save so
    // set_assignments only fires when the set actually changed.
    let editingExtraIds = [];
    let extraAssignmentsLoading = false;
    let extraAssignmentsError = '';
    let liveTimer = null;

    /* ------------------------------- utils --------------------------- */
    function byId(id) { return document.getElementById(id); }
    function esc(value) { return Auth.escapeHtml(value); }

    // Names are typed by hand, so they arrive in any case ("joy pineda").
    // Every name shown in the console is tidied first: each word capitalised
    // (small words such as "de la" stay lower-case so it still looks right).
    const SMALL_WORDS = {
        de: 1, del: 1, la: 1, van: 1, von: 1, bin: 1, san: 1,
        y: 1, ng: 1, of: 1, and: 1, the: 1
    };
    function prettyName(name) {
        return String(name || '').trim().split(/\s+/).filter(Boolean).map(function (word, i) {
            const low = word.toLowerCase();
            if (i > 0 && SMALL_WORDS[low]) return low;
            return low.charAt(0).toUpperCase() + low.slice(1);
        }).join(' ');
    }
    // Full name for a user row, tidied. One call site for every label.
    function displayName(user) {
        return user ? prettyName(user.full_name || user.username || '') : '';
    }
    // Doctors are greeted as "Doc Ben" - the formal "Dr." is dropped.
    const HONORIFIC = /^(dr|doc|mr|mrs|ms|md|prof|atty)\.?\s+/i;
    function greetingName(user) {
        const full = displayName(user);
        const bits = full.replace(HONORIFIC, '').split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
        if (user && user.role === 'doctor') return 'Doc ' + (bits || full || 'Admin');
        return bits || full || 'Admin';
    }
    // Avatar letters with the honorific dropped: "Dr. Maria Cristina" -> MC.
    function displayInitials(user) {
        return initialsOf(displayName(user).replace(HONORIFIC, ''));
    }

    function api(endpoint, options) { return window.EntSupabase.apiRequest(endpoint, options); }

    /* ------------------------------------------------------------------
       ADMIN CALL â€” the only door to account administration in v2.

       v1 wrote to `clinic_users` straight from the browser: it minted the
       row id, generated a salt, computed SHA-256(salt+password) and
       PATCHed `password_hash` onto the row. Any signed-in browser could
       have done the same thing.

       v2 has no password column to write and no grant that would permit
       it. Every account action goes through the `auth-admin` Edge
       Function, which holds the service-role key, re-reads the caller's
       LIVE role on each request, writes auth.users + staff_profiles
       together, and writes an audit row. There is no code path left in
       the browser that can create or promote an account.
       ------------------------------------------------------------------ */
    /**
     * A fetch() that never produced a readable response. Three quite
     * different causes hide behind the same browser TypeError, and they do
     * NOT share a fix:
     *
     *   1. The page was opened as file:// (double-clicking login.html).
     *      A browser sends `Origin: null` for a file:// page, so NO
     *      allowlist entry can ever match it, and putting "null" or
     *      "file://" into ENT_ALLOWED_ORIGIN is nonsense. The only fix is
     *      to serve the folder over HTTP.
     *   2. The page IS served over HTTP, but the deployed Edge Function
     *      does not allow that origin, so the browser discards the reply.
     *   3. There is genuinely no network.
     *
     * Guessing wrong costs a long detour, and telling someone to run
     * `ENT_ALLOWED_ORIGIN=file://` for case 1 is actively harmful advice.
     */
    function unreachableError(loc, cause) {
        const protocol = (loc && loc.protocol) || '';
        const origin = (loc && loc.origin) || 'unknown';
        const err = new Error(
            protocol === 'file:'
                ? 'This page is open as a FILE, not served over the web.\n\n' +
                  'The browser sends "Origin: null" for a file:// page, so the ' +
                  'server can never be allowed to talk to it. Nothing on the ' +
                  'server side will fix this.\n\n' +
                  'Start a local server in the project folder:\n' +
                  '    node serve.mjs\n\n' +
                  'Then open http://localhost:5500/login.html and sign in again.'
                : 'Cannot reach the server from ' + origin + '.\n\n' +
                  'The request never got an answer. Either the auth-admin Edge ' +
                  'Function does not allow this origin, so the browser threw the ' +
                  'reply away, or there is no connection.\n\n' +
                  'Fix the origin with:\n' +
                  '    supabase secrets set ENT_ALLOWED_ORIGIN=' + origin + '\n\n' +
                  'Then re-run: node supabase-v2/scripts/probe_preflight.mjs'
        );
        err.cause = cause;
        err.code = protocol === 'file:' ? 'OPENED_AS_FILE' : 'ORIGIN_OR_OFFLINE';
        return err;
    }

    async function callAdmin(payload) {
        const cfg = window.EntSupabase.getConfig();
        const jwt = window.EntSupabase.getAccessToken
            ? await window.EntSupabase.getAccessToken() : '';
        if (!jwt) throw new Error('Sign in before administering accounts.');

        // "Failed to fetch" is the browser refusing to hand JavaScript a
        // response at all. The server was almost certainly fine and answered
        // perfectly well to curl -- Node does not enforce CORS, which is why
        // every script in this repo calls these calls healthy while the page
        // cannot read a byte. Turn the raw TypeError into the one thing that
        // actually fixes it, which is NOT always the same answer: a page
        // opened as file:// and a page on a disallowed host are opposites.
        let response;
        try {
            response = await fetch(String(cfg.supabaseUrl).replace(/\/+$/, '') + '/functions/v1/auth-admin', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    apikey: cfg.supabaseAnonKey || '',
                    Authorization: 'Bearer ' + jwt
                },
                body: JSON.stringify(payload || {})
            });
        } catch (networkError) {
            throw unreachableError(window.location, networkError);
        }
        let data = null;
        try { data = await response.json(); } catch (error) { data = null; }
        if (!response.ok || !data || data.ok === false) {
            const failure = new Error((data && data.error) || ('The server refused that (' + response.status + ').'));
            failure.status = response.status;
            failure.code = (data && data.code) || '';
            throw failure;
        }
        return data;
    }

    /* ------------------------------------------------------------------
       PHOTOS CALL — the only door to Storage bytes, and only for the one
       thing the REST API cannot do: freeing the objects of an
       already-deleted report (0036 / patient-photos 'purge_report').

       Deleting a report row CASCADEs its report_photos metadata, but the
       actual bytes in the private bucket live outside SQL and would keep
       counting against the 500 MB quota forever. This POSTs the same
       envelope photoStore.js uses. A failure here is NOT fatal to the
       erase: the metadata row is already going, and the orphaned objects
       can be swept later — so callers treat a throw as a warning, never
       as a reason to keep a deleted record alive. */
    async function callPhotos(payload) {
        const cfg = window.EntSupabase.getConfig();
        const jwt = window.EntSupabase.getAccessToken
            ? await window.EntSupabase.getAccessToken() : '';
        if (!jwt) throw new Error('Sign in before freeing photo storage.');
        let response;
        try {
            response = await fetch(String(cfg.supabaseUrl).replace(/\/+$/, '') + '/functions/v1/patient-photos', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    apikey: cfg.supabaseAnonKey || '',
                    Authorization: 'Bearer ' + jwt
                },
                body: JSON.stringify(payload || {})
            });
        } catch (networkError) {
            throw unreachableError(window.location, networkError);
        }
        let data = null;
        try { data = await response.json(); } catch (error) { data = null; }
        if (!response.ok || !data || data.ok === false) {
            const failure = new Error((data && data.error) || ('The server refused that (' + response.status + ').'));
            failure.status = response.status;
            throw failure;
        }
        return data;
    }

    function body(method, payload) {
        return {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        };
    }

    function fmtDateTime(iso) {
        if (!iso) return '\u2014';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '\u2014';
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
            + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }

    function relTime(iso) {
        if (!iso) return 'never';
        const then = new Date(iso).getTime();
        if (isNaN(then)) return 'never';
        const secs = Math.round((Date.now() - then) / 1000);
        if (secs < 45) return 'just now';
        if (secs < 3600) return Math.round(secs / 60) + ' min ago';
        if (secs < 86400) return (Math.round(secs / 360) / 10) + ' h ago';
        return Math.round(secs / 86400) + ' d ago';
    }

    function isToday(iso) {
        if (!iso) return false;
        const d = new Date(iso), now = new Date();
        return d.getFullYear() === now.getFullYear()
            && d.getMonth() === now.getMonth()
            && d.getDate() === now.getDate();
    }

    /* The presence payload -> the shape this console renders.
     *
     * auth-admin {action:'presence'} answers with user_id / device_label /
     * role_at_seen / seen_at, while this console read username / role /
     * device / last_seen_at. Every one of those reads was `undefined`, so
     * new Date(undefined) was NaN, isActiveSession() returned false for
     * EVERYONE, and the card said "Nobody is signed in right now." while the
     * heartbeats were landing every 30 seconds.
     *
     * `users` is consulted for the display name and the live role rather than
     * trusting the snapshot: the account may have been renamed or deactivated
     * since the heartbeat, and a person who has been switched off must not
     * keep looking signed in. If the list has not arrived yet the raw values
     * are used, and the next tick re-resolves them (see sessionName()). */
    function normaliseSession(row) {
        if (!row) return {};
        const person = row.user_id
            ? users.find(function (u) { return u.id === row.user_id; }) || null
            : null;
        const seen = row.seen_at || row.last_seen_at || row.created_at || '';
        return {
            // id is what <tr data-id> carries and what the Revoke handler looks
            // up with, so it must be the account id, not a row id v2 no longer has.
            id: row.id || row.user_id || '',
            user_id: row.user_id || '',
            username: person ? displayName(person) : (row.username || row.user_id || '\u2014'),
            role: row.role || row.role_at_seen || (person && person.role) || '',
            device: row.device || row.device_label || '\u2014',
            device_label: row.device_label || row.device || '\u2014',
            created_at: row.created_at || seen,
            seen_at: seen,
            last_seen_at: seen,
            revoked: row.revoked === true || (person ? person.is_active === false : false),
        };
    }

    /* Re-read the name at render time: `users` can finish loading after the
     * first presence read, and a name frozen from an empty list would stick
     * until the page was reloaded. */
    function sessionName(s) {
        const u = (s && s.user_id)
            ? users.find(function (x) { return x.id === s.user_id; }) || null
            : null;
        return u ? displayName(u) : ((s && s.username) || '\u2014');
    }

    function isActiveSession(row) {
        if (!row || row.revoked) return false;
        const seen = new Date(row.last_seen_at).getTime();
        if (isNaN(seen)) return false;
        return (Date.now() - seen) < LIVE_WINDOW_MS;
    }

    function userName(id) {
        const found = users.find(u => u.id === id);
        return found ? (displayName(found)) : 'Unknown user';
    }

    function emptyRow(tbody, colspan, message) {
        byId(tbody).innerHTML = '<tr><td colspan="' + colspan + '" class="ent-empty">' + esc(message) + '</td></tr>';
    }

    /* ----------------------------- loading --------------------------- */
    async function loadUsers(force) {
        // v2: the directory comes from auth-admin, which returns only the
        // caller's own clinic and only to a live admin. There is no
        // entUsersCacheV1 any more â€” a cached role is exactly the stale
        // claim PRIV-04 tests.
        const result = await callAdmin({ action: 'list' });
        users = (result && Array.isArray(result.users)) ? result.users : [];
        void force;

        /* THE CLINIC DIRECTORY DEPENDED ON THIS ONE CALL.
         *
         * Every clinic card counts its doctors with
         * `users.filter(u => u.role === 'doctor' && clinicOfUser(u) === id)`.
         * If that single Edge Function call fails, is slow, or returns a shape
         * without clinic_id, `users` is [] and every card renders
         * "0 doctors / 0 secretaries / No doctor in this clinic yet" - which
         * reads as "these clinics are empty" when in fact every one of them has
         * a full staff. Observed live: Manila showed 0 doctors while holding
         * five. A directory that confidently says "no doctor" about a clinic
         * with five is worse than one that admits it could not load.
         *
         * staff_profiles is readable by an authenticated admin, so the same
         * facts can be read directly as a fallback. The Edge Function stays
         * the primary source - it applies the cross-clinic rules and returns
         * the complete columns - but a directory that reports zero is only
         * believable when the read genuinely returned zero. */
        if (!users.length) {
            try {
                const direct = await api('staff_profiles?select=id,username,full_name,role,'
                    + 'clinic_id,assigned_doctor_id,specialty,license_no,email,phone,'
                    + 'is_active,must_change_password,last_login_at,created_at&order=full_name');
                if (Array.isArray(direct) && direct.length) users = direct;
            } catch (e) {
                console.warn('Staff list fell back to a direct read and that failed too:', e);
            }
        }

        /* The open ticket panel names its reporter by looking that person up
         * in `users`. It used to be rendered once, when the thread loaded,
         * and never again - so a ticket opened while the staff list was
         * still in flight matched nothing and stayed saying "Unknown
         * account" until the admin happened to reply or change the status,
         * both of which happened to re-render it by accident.
         *
         * Refreshing the list and refreshing the panel are the same event:
         * whenever `users` changes, anything drawn from it must be redrawn.
         * Done here rather than at each call site so no future caller can
         * forget.
         */
        if (adminTicketOpen) renderAdminTicketDetail();
    }

    async function loadSessions() {
        // v2: user_sessions is GONE. user_presence is a heartbeat table
        // that stores no token at all, so "who is online" is now read
        // without anyone holding a replayable credential.
        //
        // Rows are normalised HERE, once, so the card, the sessions table and
        // the Revoke handler all agree on the field names (see
        // normaliseSession above - they used to be two different vocabularies).
        try {
            const result = await callAdmin({ action: 'presence' });
            const rows = (result && Array.isArray(result.presence)) ? result.presence : [];
            sessions = rows.map(normaliseSession);
        } catch (error) {
            sessions = [];
        }
    }

    function normaliseActivity(row) {
        if (!row) return row;
        const person = row.actor_id
            ? users.find(function (u) { return String(u.id) === String(row.actor_id); }) || null
            : null;
        return Object.assign({}, row, {
            username: row.username || (person && person.username) || row.actor_label || '',
            role: row.role || row.actor_role || (person && person.role) || ''
        });
    }

    // Merging is by id, never by position. That makes it idempotent: an
    // overlapping or retried fetch hands back rows already held, and they
    // are dropped instead of appearing twice. Gaps in the sequence (a
    // rolled-back insert leaves one) are harmless because the server does
    // the filtering, not us.
    function mergeActivity(incoming) {
        const seen = Object.create(null);
        const merged = [];
        for (let i = 0; i < incoming.length; i++) {
            const row = incoming[i];
            if (!row) continue;
            const id = Number(row.id);
            if (!Number.isFinite(id) || seen[id]) continue;
            seen[id] = true;
            merged.push(row);
        }
        for (let i = 0; i < activity.length; i++) {
            const row = activity[i];
            if (!row) continue;
            const id = Number(row.id);
            if (!Number.isFinite(id) || seen[id]) continue;
            seen[id] = true;
            merged.push(row);
        }
        merged.sort(function (a, b) { return Number(b.id) - Number(a.id); });
        if (merged.length > ACTIVITY_WINDOW) merged.length = ACTIVITY_WINDOW;
        // sorted descending, so the first row is the highest id present.
        if (merged.length) activityCursorId = Number(merged[0].id);
        return merged;
    }

    // activity_logs is append-only and its id is GENERATED ALWAYS AS
    // IDENTITY: the server owns it, it only ever rises, and no caller can
    // backdate or invent one. That is what makes it a cursor. created_at is
    // NOT - it is a plain DEFAULT now() a client could override, and now() is
    // a TRANSACTION timestamp, so two rows written together tie exactly and a
    // `created_at > lastSeen` filter would drop one of them.
    //
    // The first load still pulls the newest window it always did. Every load
    // after that asks only for ids beyond the cursor and merges them, so an
    // idle console transfers a few hundred bytes a minute instead of
    // re-downloading the whole log.
    //
    // 1000 rows keeps ~30 days of history on the clock chart and the
    // user / period filters without pulling the whole log down.
    async function loadActivity(force) {
        if (activityLoaded && !force) return;
        const first = !activityLoaded;
        let repaint = first;
        try {
            const path = first
                ? 'activity_logs?select=*&order=id.desc&limit=' + ACTIVITY_WINDOW
                : 'activity_logs?select=*&id=gt.' + activityCursorId
                    + '&order=id.desc&limit=' + ACTIVITY_WINDOW;
            const rows = await api(path);
            const incoming = Array.isArray(rows) ? rows.map(normaliseActivity) : [];
            if (first || incoming.length) {
                activity = mergeActivity(incoming);
                repaint = true;
            }
            activityLoaded = true;
            activityError = '';
        } catch (error) {
            activityError = (error && error.message) || String(error);
            // Still repaint: renderActivity() is what puts this message in
            // the table, so a silent repaint would hide a real failure.
            repaint = true;
        }
        if (!repaint) return;
        populateActivityUsers();
        populateActivityActions();
        renderActivity();
        renderHourly();
    }

    function fail(tbodyId, colspan, error) {
        const message = (error && error.message) ? error.message : String(error);
        emptyRow(tbodyId, colspan, 'Could not load data: ' + message);
    }

    /* ----------------------------- render ---------------------------- */
    // A warm, time-aware hello in the header (emoji included - it lifts the
    // mood), plus a one-line live status so the admin knows at a glance.
    function renderGreeting() {
        const el = byId('adminGreeting');
        if (!el) return;
        const me = (typeof Auth.currentUser === 'function' ? Auth.currentUser() : null) || {};
        const who = greetingName(me);
        const h = new Date().getHours();
        const hello = h < 5 ? { text: 'Still up', emoji: '\uD83C\uDF19' }
            : h < 12 ? { text: 'Good morning', emoji: '\u2600\uFE0F' }
            : h < 17 ? { text: 'Good afternoon', emoji: '\uD83C\uDF24\uFE0F' }
            : h < 21 ? { text: 'Good evening', emoji: '\uD83C\uDF06' }
            : { text: 'Good night', emoji: '\uD83C\uDF19' };
        const live = new Set(sessions.filter(isActiveSession).map(s => s.user_id)).size;
        const tail = live
            ? ' \u00b7 \uD83D\uDFE2 ' + live + ' signed in right now'
            : ' \u00b7 \uD83D\uDCC4 ' + users.length + ' account' + (users.length === 1 ? '' : 's') + ' on file';
        el.textContent = hello.emoji + ' ' + hello.text + ', ' + who + tail;
    }

    function renderStats() {
        const activeUserIds = new Set(
            sessions.filter(isActiveSession).map(s => s.user_id)
        );
        byId('statActive').textContent = activeUserIds.size;
        byId('statUsers').textContent = users.length;
        byId('statDoctors').textContent = users.filter(u => u.role === 'doctor').length;
        byId('statSecretaries').textContent = users.filter(u => u.role === 'secretary').length;
        byId('statInactive').textContent = users.filter(u => u.is_active === false).length;
        byId('statLogins').textContent = new Set(activity.filter(a =>
            a && a.action === 'LOGIN' && String(a.created_at || '').slice(0, 10) === dayKey(new Date())
        ).map(a => a.username || a.user_id || 'anonymous')).size;
        byId('lastRefresh').textContent = 'Updated ' + new Date().toLocaleTimeString();
        renderGreeting();
        renderOverviewStats();
        renderOverviewChart();
    }

    function statusPill(active) {
        return active
            ? '<span class="ent-pill live"><span class="dot"></span>Active</span>'
            : '<span class="ent-pill idle">Idle</span>';
    }

    function rolePill(role) {
        return '<span class="ent-pill role-' + esc(role) + '">' + esc(role) + '</span>';
    }

    function renderOverviewSessions() {
        const live = sessions.filter(isActiveSession).slice(0, 8);
        if (!live.length) return emptyRow('overviewSessions', 5, 'Nobody is signed in right now.');
        byId('overviewSessions').innerHTML = live.map(s => `
            <tr>
                <td data-label="Who"><strong>${esc(sessionName(s))}</strong></td>
                <td data-label="Role">${rolePill(s.role)}</td>
                <td data-label="Device">${esc(s.device || '\u2014')}</td>
                <td data-label="Seen">${esc(relTime(s.last_seen_at))}</td>
                <td data-label="Status">${statusPill(true)}</td>
            </tr>`).join('');
    }

    function userCard(u) {
        const active = u.is_active !== false;
        const boss = u.role === 'secretary'
            ? (u.assigned_doctor_id ? userName(u.assigned_doctor_id) : 'not set')
            : '';
        const clinic = clinicLabel((u && u.clinic_id) || 'main_clinic');
        /* Role icon per row: a stethoscope for doctors, a clipboard for
         * secretaries, a shield for admins - carried on the avatar so the
         * role is visible without reading the pill. */
        const roleIcon = u.role === 'doctor' ? '&#129657;'
            : u.role === 'secretary' ? '&#128203;'
            : u.role === 'admin' ? '&#128737;' : '';
        const accessibleName = esc(displayName(u));
        return '<tr class="ent-user-row role-' + esc(u.role) + (active ? '' : ' is-off') + '"'
            + ' data-id="' + esc(u.id) + '">'
            + '<td data-label="User"><div class="ent-user-cell">'
            + '<span class="ent-user-av" title="' + esc(u.role || '') + '">'
            + esc(displayInitials(u))
            + (roleIcon ? '<i class="ent-user-avic" aria-hidden="true">' + roleIcon + '</i>' : '')
            + '</span><span class="ent-user-main"><b>' + esc(displayName(u)) + '</b>'
            + '<small>@' + esc(u.username || '') + '</small></span></div></td>'
            + '<td data-label="Access"><div class="ent-user-tags">' + rolePill(u.role)
            + (u.role === 'secretary' && u.is_super_secretary
                ? '<span class="ent-pill is-super-secretary">Super Secretary</span>' : '')
            + (active ? '<span class="ent-pill live">Active</span>'
                : '<span class="ent-pill idle">Deactivated</span>')
            + '</div></td>'
            + '<td data-label="Clinic"><span class="ent-user-clinic" title="' + esc(clinic) + '">'
            + esc(clinic) + '</span></td>'
            + '<td data-label="Assignment / last login"><div class="ent-user-meta">'
            + (boss ? '<span title="' + esc(boss) + '"><em>Works for</em><b>' + esc(boss) + '</b></span>' : '')
            + '<span><em>Last login</em><b title="' + esc(u.last_login_at || '') + '">'
            + esc(relTime(u.last_login_at)) + '</b></span></div></td>'
            + '<td data-label="Actions"><div class="ent-user-actions">'
            + '<button type="button" class="ent-rowbtn edit" data-act="edit" aria-label="Edit ' + accessibleName + '" title="Edit account">'
            + 'Edit</button>'
            + '<button type="button" class="ent-rowbtn key" data-act="password" aria-label="Set password for ' + accessibleName + '" title="Set password">'
            + 'Pass</button>'
            + '<button type="button" class="ent-rowbtn ' + (active ? 'off' : 'on') + '" data-act="toggle"'
            + ' aria-label="' + (active ? 'Deactivate ' : 'Activate ') + accessibleName + '"'
            + ' title="' + (active ? 'Deactivate account' : 'Activate account') + '">'
            + (active ? 'Disable' : 'Enable') + '</button>'
            // Delete remains the last, destructive action. It asks for the
            // admin's own password before doing anything; see auth-admin.
            + '<button type="button" class="ent-rowbtn del" data-act="delete" aria-label="Delete ' + accessibleName + '"'
            + ' title="Delete account permanently">'
            + 'Delete</button>'
            + '</div></td>'
            + '</tr>';
    }

    /* ---------------------- delete confirmation ---------------------- */
    // A typed password field rather than a yes/no dialog. "Are you sure?" is
    // answered "yes" by muscle memory, and this is the only irreversible action
    // in the console; requiring the caller's own password is the one thing that
    // proves the person at the keyboard is the account holder.
    function confirmDeleteUser(user) {
        const wrap = document.createElement('div');
        wrap.className = 'ent-delmask';
        wrap.innerHTML =
            '<div class="ent-delbox" role="alertdialog" aria-modal="true" aria-labelledby="entDelTitle">'
            + '<h3 id="entDelTitle">Delete ' + esc(displayName(user)) + '?</h3>'
            + '<p>This removes the account and its access, permanently. '
            + 'Patient records made by this person are kept and still belong to their doctor.</p>'
            + '<label for="entDelPw">Enter your admin password to confirm</label>'
            + '<input type="password" id="entDelPw" autocomplete="current-password">'
            + '<p class="ent-delerr" id="entDelErr" hidden></p>'
            + '<div class="ent-delrow">'
            + '<button type="button" class="ent-btn" id="entDelNo">Cancel</button>'
            + '<button type="button" class="ent-btn danger" id="entDelYes">Delete account</button>'
            + '</div></div>';
        document.body.appendChild(wrap);
        const pw = byId('entDelPw');
        const err = byId('entDelErr');
        const yes = byId('entDelYes');
        const done = () => { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); };
        byId('entDelNo').addEventListener('click', done);
        wrap.addEventListener('click', e => { if (e.target === wrap) done(); });
        pw.focus();

        yes.addEventListener('click', async function () {
            const typed = pw.value;
            if (!typed) {
                err.textContent = 'Enter your password to confirm.';
                err.hidden = false;
                pw.focus();
                return;
            }
            yes.disabled = true;
            yes.textContent = 'Deleting…';
            err.hidden = true;
            try {
                await callAdmin({ action: 'delete', id: user.id, password: typed });
                done();
                toast('Deleted ' + displayName(user) + '.');
                await loadUsers(true);
                renderStats();
                renderUsers();
                renderClinicDirectory();
            } catch (e) {
                // Stay open: a wrong password is a typo, not a refusal, and
                // closing the dialog would make them start over.
                err.textContent = (e && e.message) || 'Could not delete.';
                err.hidden = false;
                yes.disabled = false;
                yes.textContent = 'Delete account';
                pw.value = '';
                pw.focus();
            }
        });
        pw.addEventListener('keydown', e => { if (e.key === 'Enter') yes.click(); });
        document.addEventListener('keydown', function esc2(e) {
            if (e.key === 'Escape') { done(); document.removeEventListener('keydown', esc2); }
        });
    }

    // Three tidy rows: doctors, then secretaries, then admins.
    function renderUsers() {
        /* The hero stats above the directory. Counted from the full list,
         * never the filtered one, so searching reads as "1 of 9". */
        (function paintUserStats() {
            const set = function (id, n) {
                const el = byId(id);
                if (el) el.textContent = String(n);
            };
            set('userStatDoctors', users.filter(function (u) { return u.role === 'doctor'; }).length);
            set('userStatSecretaries', users.filter(function (u) { return u.role === 'secretary'; }).length);
            set('userStatAdmins', users.filter(function (u) { return u.role === 'admin'; }).length);
            set('userStatInactive', users.filter(function (u) { return u.is_active === false; }).length);
        })();

        const search = byId('userSearch');
        const roleBox = byId('roleFilter');
        const needle = (search ? search.value : '').trim().toLowerCase();
        const role = (roleBox ? roleBox.value : '');
        const rows = users.filter(u => {
            if (role && u.role !== role) return false;
            if (!needle) return true;
            return (u.full_name || '').toLowerCase().indexOf(needle) !== -1
                || (u.username || '').toLowerCase().indexOf(needle) !== -1;
        });
        const box = byId('usersGrid');
        if (!box) return;
        const clearSearch = byId('usersSearchClear');
        if (clearSearch) clearSearch.hidden = !needle;
        const resultCount = byId('usersResultCount');
        if (resultCount) {
            resultCount.textContent = 'Showing ' + rows.length + ' of ' + users.length
                + ' account' + (users.length === 1 ? '' : 's');
        }

        if (!rows.length) {
            box.innerHTML = '<div class="ent-empty ent-users-empty">'
                + (users.length ? 'No accounts match your search or role filter.' : 'No user accounts yet.')
                + '</div>';
            return;
        }

        const groups = [
            { role: 'doctor', label: 'Doctors', icon: '&#129657;', hint: 'See only their own patients' },
            { role: 'secretary', label: 'Secretaries', icon: '&#128203;', hint: 'See their doctor\u2019s patients' },
            { role: 'admin', label: 'Admins', icon: '&#128737;', hint: 'See everything in the clinic' }
        ];
        box.innerHTML = groups.map(function (g) {
            const list = rows.filter(function (u) { return u.role === g.role; })
                .sort(function (a, b) {
                    return String(displayName(a)).localeCompare(String(displayName(b)));
                });
            if (!list.length) return '';
            return '<section class="ent-user-group" data-role="' + g.role + '">'
                + '<h4 class="ent-user-group-head role-' + g.role + '">'
                + '<span class="ent-user-group-ic" aria-hidden="true">' + g.icon + '</span>' + g.label
                + '<em>' + list.length + '</em>'
                + '<span class="ent-user-group-hint">' + g.hint + '</span></h4>'
                + '<div class="ent-user-table-scroll"><table class="ent-user-table" aria-label="' + g.label + ' accounts">'
                + '<thead><tr><th scope="col">User</th><th scope="col">Access</th>'
                + '<th scope="col">Clinic</th><th scope="col">Assignment / last login</th>'
                + '<th scope="col">Actions</th></tr></thead>'
                + '<tbody>' + list.map(userCard).join('') + '</tbody></table></div>'
                + '</section>';
        }).join('') || '<div class="ent-empty">No user matches this filter.</div>';
    }

    function renderSessions() {
        const rows = sessions.slice(0, 60);
        const online = sessions.filter(isActiveSession).length;
        const revoked = sessions.filter(function (s) { return !!s.revoked; }).length;
        const offline = Math.max(0, sessions.length - online - revoked);
        setText('sessionMetricOnline', fmtNum(online));
        setText('sessionMetricTotal', fmtNum(sessions.length));
        setText('sessionMetricOffline', fmtNum(offline));
        setText('sessionMetricRevoked', fmtNum(revoked));
        setText('sessionsResultCount', rows.length
            ? 'Showing ' + fmtNum(rows.length) + ' of ' + fmtNum(sessions.length) + ' latest sessions'
            : 'No session records to show');
        if (!rows.length) return emptyRow('sessionsTable', 7, 'No sessions recorded yet.');
        byId('sessionsTable').innerHTML = rows.map(s => {
            const live = isActiveSession(s);
            const mine = s.user_id === session.user.id;
            return `<tr class="${s.revoked ? 'inactive' : ''}" data-id="${esc(s.id)}">
                <td data-label="Who"><strong>${esc(sessionName(s))}</strong>${mine ? ' <em style="font-size:.7rem;">(you)</em>' : ''}</td>
                <td data-label="Role">${rolePill(s.role)}</td>
                <td data-label="Device">${esc(s.device || '\u2014')}</td>
                <td data-label="Signed in">${esc(fmtDateTime(s.created_at))}</td>
                <td data-label="Last seen">${esc(relTime(s.last_seen_at))}</td>
                <td data-label="Status">${s.revoked ? '<span class="ent-pill idle">Revoked</span>' : statusPill(live)}</td>
                <td class="ent-actions" data-label="Actions"><div class="ent-action-row">
                    ${s.revoked ? '' : `<button type="button" class="ent-rowbtn off" data-act="revoke" title="End this session now"><span class="ent-rowbtn-icon" aria-hidden="true">&#128683;</span>Revoke</button>`}
                </div></td>
            </tr>`;
        }).join('');
    }

    function renderActivity() {
        const rows = filteredActivity();
        populateActivityUsers();
        renderActivityKpis(rows);
        const shown = rows.slice(0, 200);
        const foot = byId('activityFoot');
        const search = byId('activitySearch');
        const clearSearch = byId('activitySearchClear');
        if (clearSearch) clearSearch.hidden = !((search && search.value) || '').trim();
        setText('activityResultCount', rows.length
            ? 'Showing ' + fmtNum(shown.length) + ' of ' + fmtNum(rows.length) + ' matching events'
            : 'No events match the current filters');
        if (!shown.length) {
            emptyRow('activityTable', 6, activityError
                ? 'Could not read the activity log: ' + activityError
                : (activity.length
                    ? 'No events match those filters \u2014 widen the period or clear the search.'
                    : 'No activity recorded yet.'));
            if (foot) foot.textContent = '';
            return;
        }
        const dayLabel = function (iso) {
            const d = new Date(iso);
            const today = new Date();
            const yest = new Date();
            yest.setDate(today.getDate() - 1);
            const key = function (x) {
                return x.getFullYear() + '-' + (x.getMonth() + 1) + '-' + x.getDate();
            };
            const pretty = d.toLocaleDateString(undefined, {
                weekday: 'short', day: 'numeric', month: 'short'
            });
            if (key(d) === key(today)) return 'Today \u00b7 ' + pretty;
            if (key(d) === key(yest)) return 'Yesterday \u00b7 ' + pretty;
            return pretty;
        };
        let lastDay = null;
        byId('activityTable').innerHTML = shown.map(function (a) {
            const u = (a.actor_id
                ? users.find(function (person) { return String(person.id) === String(a.actor_id); })
                : null) || userByName(a.username);
            const actorName = (u && displayName(u)) || a.actor_label || a.username || '\u2014';
            const actorUsername = u ? u.username
                : (a.username && a.username !== a.actor_label ? a.username : '');
            const actorRole = a.role || a.actor_role || (u && u.role) || '';
            // DAY GROUPING. The log is a timeline, not a spreadsheet: rows
            // arriving as one undifferentiated stream made "when did this
            // happen" a scroll-and-count exercise. A full-width separator row
            // per calendar day turns the table into day sections - the exact
            // shape the dashboard's follow-ups card already uses - and it is
            // a real <tr> so the mobile card layout and the CSV export (which
            // reads the raw data, not this DOM) are untouched.
            const day = String(a.created_at || '').slice(0, 10);
            const sep = day !== lastDay
                ? '<tr class="ent-daysep"><td colspan="6">'
                    + '<span class="ent-daysep-label">' + esc(dayLabel(a.created_at)) + '</span>'
                    + '</td></tr>'
                : '';
            lastDay = day;
            return sep + '<tr>'
                // The timeline dot rides in the When cell so the rail reads
                // top-to-bottom through the day without a new column.
                + '<td data-label="When" style="white-space:nowrap;" title="' + esc(a.created_at) + '">'
                + '<span class="ent-act-when"><span class="ent-act-dot"></span><span>'
                + esc(fmtDateTime(a.created_at)) + '</span></span>'
                + '<div class="ent-hint">' + esc(relTime(a.created_at)) + '</div></td>'
                + '<td data-label="Who"><strong>' + esc(actorName) + '</strong>'
                + (actorUsername ? '<div class="ent-hint">' + esc(actorUsername) + '</div>' : '') + '</td>'
                + '<td data-label="Role">' + (actorRole ? rolePill(actorRole) : '\u2014') + '</td>'
                + '<td data-label="Clinic">' + esc(a.clinic_id ? clinicLabel(a.clinic_id) : '\u2014') + '</td>'
                + '<td data-label="Action">' + actionPill(a.action) + '</td>'
                // Detail: clamped to one line with the full text in the title,
                // so a long patient/clinic string stops stretching the row
                // into two lines and the table keeps its rhythm.
                + '<td data-label="Detail"><span class="ent-act-detail" title="'
                + esc(a.detail || '') + '">' + esc(a.detail || '') + '</span></td>'
                + '</tr>';
        }).join('');
        if (foot) {
            foot.textContent = fmtNum(rows.length) + ' event(s) inside the filter \u00b7 showing the newest '
                + shown.length + ' \u00b7 ' + fmtNum(activity.length)
                + ' loaded from activity_logs' + (activityError ? ' \u00b7 last error: ' + activityError : '');
        }
    }

    function toast(message, bad) {
        let box = byId('entToast');
        if (!box) {
            box = document.createElement('div');
            box.id = 'entToast';
            box.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);'
                + 'padding:11px 18px;border-radius:10px;font-size:.84rem;z-index:9999;color:#fff;'
                + 'box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:88vw;';
            document.body.appendChild(box);
        }
        box.style.background = bad ? '#c0392b' : '#1f9d55';
        box.textContent = message;
        clearTimeout(box._t);
        box._t = setTimeout(function () { if (box.parentNode) box.remove(); }, 4200);
    }

    /* --------------------------- user modal -------------------------- */
    function modalError(message) {
        const box = byId('userModalError');
        box.textContent = message || '';
        box.classList.toggle('show', !!message);
    }

    function populateDoctors(selectedId) {
        const docs = users.filter(u => u.role === 'doctor');
        const sel = byId('fAssigned');
        sel.innerHTML = docs.length
            ? docs.map(d => `<option value="${esc(d.id)}">${esc(displayName(d))} (${esc(d.username)})</option>`).join('')
            : '<option value="">No doctor accounts yet</option>';
        if (selectedId) sel.value = selectedId;
    }

    /* 0037: the ADDITIONAL doctors a secretary may also work under, beyond
     * her primary. The primary lives in fAssigned (staff_profiles
     * .assigned_doctor_id); this multi-select holds the secretary_assignments
     * junction set, which auth-admin's set_assignments action REPLACES on
     * save. The primary (and any inactive doctor) is deliberately excluded
     * from the options, so the two controls can never disagree about who her
     * home doctor is. */
    function populateExtraDoctors() {
        const sel = byId('fExtraDoctors');
        if (!sel) return;
        const primary = byId('fAssigned').value;
        const docs = users.filter(u => u.role === 'doctor' && u.id !== primary && u.is_active !== false);
        sel.innerHTML = docs.length
            ? docs.map(d => `<option value="${esc(d.id)}">${esc(displayName(d))} (${esc(d.username)})</option>`).join('')
            : '<option value="" disabled>No other doctor accounts yet</option>';
        // Re-apply the remembered selection, minus whoever is now primary.
        const keep = (editingExtraIds || []).filter(id => id && id !== primary);
        editingExtraIds = keep;
        const opts = Array.isArray(sel.options) ? sel.options : [];
        for (let i = 0; i < opts.length; i++) {
            if (opts[i] && opts[i].value) opts[i].selected = keep.indexOf(opts[i].value) !== -1;
        }
        syncExtraDoctorsToggle();
    }

    function syncExtraDoctorsToggle() {
        const button = byId('fExtraDoctorsToggle');
        const sel = byId('fExtraDoctors');
        if (!button || !sel) return;
        const opts = Array.prototype.filter.call(sel.options || [], function (option) {
            return option && option.value && !option.disabled;
        });
        const allSelected = opts.length > 0 && opts.every(function (option) { return option.selected; });
        button.disabled = opts.length === 0;
        button.textContent = allSelected ? 'Clear additional doctors' : 'Select all other doctors';
    }

    /* The current junction set for a secretary, straight from the server.
     * Read-only from here (secretary_assignments_read_admin, 0037);
     * set_assignments is the only writer. A failed read must stay visible:
     * treating it as an empty set could erase assignments on the next save. */
    async function loadSecretaryAssignments(id) {
        if (!id) return [];
        const rows = await api('secretary_assignments?select=doctor_id&secretary_id=eq.' + encodeURIComponent(id));
        return Array.isArray(rows)
            ? rows.map(r => (r && r.doctor_id) || '').filter(Boolean)
            : [];
    }

    /* The extra doctors the form is asking for, as a plain id array with the
     * primary removed and blanks/duplicates dropped. set_assignments replaces
     * the whole junction set, so an empty array is meaningful: it clears
     * every extra. selectedOptions is the browser path; the fallback keeps
     * test harnesses (which stub options as a bare array) working. */
    function collectExtraDoctors(primaryId) {
        const sel = byId('fExtraDoctors');
        let picked = [];
        if (sel && sel.selectedOptions) {
            picked = Array.prototype.map.call(sel.selectedOptions, o => o && o.value);
        } else if (sel && Array.isArray(sel.options)) {
            picked = sel.options.filter(o => o && o.selected).map(o => o.value);
        }
        const out = [];
        for (const id of picked) {
            if (id && id !== primaryId && out.indexOf(id) === -1) out.push(id);
        }
        return out;
    }

    function syncRoleFields() {
        const secretary = byId('fRole').value === 'secretary';
        byId('assignedWrap').style.display = secretary ? '' : 'none';
        const assignmentSection = byId('userAssignmentSection');
        if (assignmentSection) assignmentSection.hidden = !secretary;
        // 0037: the "Also works at" multi-select is secretary-only, exactly
        // like the primary assigned-doctor field above it.
        const extraWrap = byId('extraWrap');
        if (extraWrap) extraWrap.style.display = secretary ? '' : 'none';
        if (secretary) populateExtraDoctors();
    }

    function openUserModal(user, focusPassword) {
        editingId = user ? user.id : null;
        byId('userModalTitle').textContent = user ? 'Edit ' + (displayName(user)) : 'Add user';
        byId('userModalDescription').textContent = user
            ? 'Review this account identity and access, then save any updates.'
            : 'Create a clinic account and choose its role, doctor access, and sign-in details.';
        byId('userModalSave').textContent = user ? 'Save changes' : 'Create account';
        byId('fFullName').value = user ? (user.full_name || '') : '';
        byId('fUsername').value = user ? user.username : '';
        byId('fUsername').disabled = !!user;
        byId('fRole').value = user ? user.role : 'doctor';
        byId('fSpecialty').value = user ? (user.specialty || '') : '';
        byId('fActive').checked = user ? user.is_active !== false : true;
        byId('fSuperSecretary').checked = !!(user && user.is_super_secretary);
        byId('fPassword').value = '';
        extraAssignmentsLoading = !!(user && user.role === 'secretary');
        extraAssignmentsError = '';
        byId('passwordLabel').textContent = user ? 'New password (blank = keep current)' : 'Password';
        byId('passwordHint').textContent = user
            ? 'Fill this in only if you want to replace their password.'
            : 'At least ' + MIN_PASSWORD_LENGTH + ' characters. Share it with the user.';
        populateDoctors(user ? user.assigned_doctor_id : '');
        // 0037: seed the "Also works at" control. A new secretary starts with
        // no extras; an existing one is filled from the junction table (read
        // via secretary_assignments, written only by set_assignments). The
        // async fill re-runs populateExtraDoctors once the rows arrive.
        editingExtraIds = [];
        syncRoleFields();
        if (user && user.role === 'secretary') {
            loadSecretaryAssignments(user.id).then(function (ids) {
                if (editingId !== user.id) return;
                editingExtraIds = ids;
                extraAssignmentsLoading = false;
                populateExtraDoctors();
            }).catch(function (error) {
                if (editingId !== user.id) return;
                extraAssignmentsLoading = false;
                extraAssignmentsError = (error && error.message) || 'Unknown error';
                modalError('Could not load additional doctor assignments: '
                    + extraAssignmentsError + '. Close and reopen this account before saving changes.');
            });
        }
        modalError('');
        byId('userModal').classList.add('open');
        setTimeout(function () { (focusPassword ? byId('fPassword') : byId('fFullName')).focus(); }, 60);
    }

    function closeUserModal() {
        byId('userModal').classList.remove('open');
        editingId = null;
    }

    async function saveUser() {
        const fullName = byId('fFullName').value.trim();
        const username = byId('fUsername').value.trim().toLowerCase().replace(/\s+/g, '');
        const role = byId('fRole').value;
        const specialty = byId('fSpecialty').value.trim();
        const active = byId('fActive').checked;
        const password = byId('fPassword').value;
        const assigned = role === 'secretary' ? byId('fAssigned').value : '';
        const isSuperSecretary = role === 'secretary' && byId('fSuperSecretary').checked;

        if (!fullName) return modalError('Please enter the full name.');
        if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
            return modalError('Username: 3-32 characters, lowercase letters, numbers, dot, dash or underscore.');
        }
        if (password && password.length < MIN_PASSWORD_LENGTH) {
            return modalError('Password must be at least ' + MIN_PASSWORD_LENGTH + ' characters.');
        }
        if (!editingId && !password) return modalError('A new user needs a starting password.');
        if (role === 'secretary' && extraAssignmentsLoading) {
            return modalError('Please wait for this secretary\u2019s doctor assignments to load.');
        }
        if (role === 'secretary' && extraAssignmentsError) {
            return modalError('Additional doctor assignments could not be loaded. Close and reopen this account before saving.');
        }
        if (role === 'secretary' && !assigned) {
            return modalError('Assign this secretary to a doctor first (create a doctor account if none exists).');
        }

        const saving = byId('userModalSave');
        saving.disabled = true;
        saving.textContent = 'Saving\u2026';
        // The row as it stands right now, so the active/inactive checkbox can
        // be compared against it. Null when creating.
        const target = users.find(function (u) { return u.id === editingId; }) || null;
        try {
            if (editingId) {
                // v2: no salt, no password_hash, no direct PATCH. auth-admin
                // writes auth.users and staff_profiles together, refuses
                // privileged column changes the caller is not allowed to
                // make, and logs the change.
                //
                // license_no is DELIBERATELY ABSENT. This form has no licence
                // field, and the server applies any value it is handed
                // (`if (body.license_no !== undefined)`), so sending ''
                // silently erased a doctor's licence number every single time
                // an admin renamed them or fixed a typo. Omitting the key
                // leaves the stored value untouched.
                await callAdmin({
                    action: 'update',
                    id: editingId,
                    full_name: fullName,
                    role: role,
                    assigned_doctor_id: assigned || null,
                    is_super_secretary: isSuperSecretary,
                    specialty: specialty
                });
                // is_active is NOT part of the update action: it has its own
                // audited path (set_active -> ent_admin_set_active) so that
                // deactivation always re-checks the admin and writes an audit
                // row. It used to be included in the payload above, where the
                // server ignored it, so unticking "Account is active" and
                // pressing Save did nothing whatsoever.
                const wasActive = !target || target.is_active !== false;
                if (wasActive !== active) {
                    await callAdmin({ action: 'set_active', id: editingId, is_active: active });
                    if (!active) await revokeSessionsOf(editingId, 'account deactivated');
                }
                // 0037: replace the secretary's ADDITIONAL doctors (the
                // secretary_assignments junction). Her primary lives in
                // assigned_doctor_id, saved above; set_assignments takes the
                // complete EXTRA list and replaces it, so no diff is computed
                // here. Only fires when the set actually changed, so renaming
                // a secretary does not rewrite her assignments.
                if (role === 'secretary') {
                    const extras = collectExtraDoctors(assigned);
                    const before = (editingExtraIds || []).filter(id => id && id !== assigned).slice().sort();
                    const after = extras.slice().sort();
                    if (JSON.stringify(before) !== JSON.stringify(after)) {
                        await callAdmin({ action: 'set_assignments', id: editingId, doctor_ids: extras });
                    }
                }
                if (password) {
                    // A password reset is its own action, and the server
                    // returns the generated password ONCE. It is never
                    // stored here and never derivable from this page.
                    const reset = await callAdmin({
                        action: 'reset_password',
                        id: editingId
                    });
                    if (reset && reset.password) {
                        modalInfo('Temporary password for ' + username + ':\n\n' + reset.password +
                            '\n\nIt is shown once. Copy it now, and ask them to change it at first sign-in.');
                    }
                    await Auth.logActivity('PASSWORD_RESET', 'Password reset for ' + username);
                }
                await Auth.logActivity('USER_UPDATED', 'Updated account ' + username + ' (' + role + ')');
                toast('Saved ' + username + '.');
            } else {
                if (users.some(u => (u.username || '').toLowerCase() === username)) {
                    return modalError('That username is already taken.');
                }
                // v2: auth-admin creates the auth.users row (GoTrue owns the
                // hash), the staff_profiles row, and returns a starter
                // password exactly once. The browser cannot create an
                // auth.users row at all, which is the point.
                //
                // NO email IS SENT, and none is needed. This form has no
                // email field on purpose: the clinic knows its people by
                // username, and GoTrue only needs a unique, unroutable
                // address to key the account on. auth-admin derives it from
                // the username when the caller omits it.
                //
                // It used to send `email: email || ...` here, and `email` was
                // never declared in this function â€” so every create threw
                // ReferenceError: email is not defined and surfaced as
                // "Could not save: email is not defined". Creating a user was
                // impossible from this screen. The fallback also read
                // window.EntAuth.EMAIL_DOMAIN, which auth.js never exported.
                const created = await callAdmin({
                    action: 'create',
                    username: username,
                    password: password || undefined,
                    full_name: fullName,
                    role: role,
                    assigned_doctor_id: assigned || null,
                    is_super_secretary: isSuperSecretary,
                    specialty: specialty,
                    license_no: '',   // no license field in this form (see the create block)
                    is_active: active
                });
                // 0037: the create action seeds the junction with her primary.
                // Add any EXTRA doctors the admin ticked on the same screen.
                // The new account's id comes back as `created.id`.
                if (role === 'secretary') {
                    const extras = collectExtraDoctors(assigned);
                    if (extras.length && created && created.id) {
                        await callAdmin({ action: 'set_assignments', id: created.id, doctor_ids: extras });
                    }
                }
                await Auth.logActivity('USER_CREATED', 'Created ' + username + ' as ' + role);
                if (created && created.password) {
                    modalInfo('Account ' + username + ' created.\n\nTemporary password:\n\n' +
                        created.password + '\n\nIt is shown once.');
                }
                toast('Account ' + username + ' created.');
            }
            closeUserModal();
            await loadUsers(true);
            renderStats();
            renderUsers();
        } catch (error) {
            modalError('Could not save: ' + error.message);
        } finally {
            saving.disabled = false;
            saving.textContent = editingId ? 'Save changes' : 'Create account';
        }
    }

    /* ----------------------------- actions --------------------------- */
    async function toggleActive(user) {
        const activate = user.is_active === false;
        const label = activate ? 'Activate' : 'Deactivate';
        const who = displayName(user);
        if (!confirm(label + ' ' + who + '?' + (activate ? '' : '\nThey will be signed out of every device.'))) return;
        try {
            // v2: is_active moves through the RPC, not a table PATCH, so the
            // guard trigger in 0003 cannot be bypassed and the change is
            // logged with an actor.
            await callAdmin({ action: 'set_active', id: user.id, is_active: activate });
            if (!activate) await revokeSessionsOf(user.id, 'account deactivated');
            await Auth.logActivity(activate ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', label + ' ' + user.username);
            await loadUsers(true);
            renderStats();
            renderUsers();
            toast(who + ' ' + (activate ? 'activated.' : 'deactivated.'));
        } catch (error) {
            toast('Could not ' + label.toLowerCase() + ': ' + error.message, true);
        }
    }

    async function revokeSessionsOf(userId, reason) {
        try {
            // v1 PATCHed user_sessions.revoked. v2 calls
            // auth.admin.signOut(), which really ends the Supabase session.
            // The browser copy of the token does not vanish, so the next
            // request 401s â€” auth.js treats that as signed out, which is
            // the correct reading.
            await callAdmin({ action: 'revoke_sessions', id: userId });
            await Auth.logActivity('SESSION_REVOKED', 'Revoked open sessions - ' + reason);
        } catch (error) {
            console.warn('Could not revoke sessions:', error);
        }
    }

    async function revokeSession(row) {
        if (!confirm('Sign ' + row.username + ' out of that device now?')) return;
        try {
            await callAdmin({ action: 'revoke_sessions', id: row.user_id || row.id });
            await Auth.logActivity('SESSION_REVOKED', 'Revoked session of ' + row.username + ' (' + (row.device_label || row.device || '?') + ')');
            await loadSessions();
            renderStats();
            renderSessions();
            toast('Session revoked.');
        } catch (error) {
            toast('Could not revoke: ' + error.message, true);
        }
    }

    /* --------------------------- refreshing -------------------------- */
    /* Real clinic names, from the database.
     *
     * `labels` was only ever populated from localStorage, and only when an
     * admin renamed a clinic from this console. On any browser that had not
     * done that, clinicLabel() had nothing to work with and fell back to
     * prettifying the raw id - so the Clinics tab and the ticket panel
     * printed "00000000-0000-4000-8000-00000000C11C" where a person's clinic
     * name belongs.
     *
     * The name now lives in `clinics.name` - one row per clinic, including
     * the per-doctor clinics ("ENT Clinic Doc Jess") created by auth-admin -
     * and an active admin may read every clinic row. That is the correct
     * source; clinic_settings only ever held a single clinic's friendly name,
     * so it is kept below purely as a fallback for an old row.
     *
     * A rename made from this console is device-local and still wins, so this
     * only fills a gap rather than clobbering the admin's choice.
     */
    async function loadClinicLabels() {
        let filled = false;
        try {
            // is_active rides along: a retired clinic must be known as
            // retired even when it has no name left to show, which is why
            // the flag is stored BEFORE the name early-return below.
            const rows = await api('clinics?select=id,name,code,is_active&order=name');
            if (Array.isArray(rows)) {
                rows.forEach(function (r) {
                    if (!r || !r.id) return;
                    if (r.code) clinicCodes[r.id] = r.code;
                    clinicActive[r.id] = r.is_active !== false;
                    if (!r.name) return;
                    if (labels[r.id]) return;      // a local rename wins
                    labels[r.id] = r.name;
                    filled = true;
                });
            }
        } catch (e) {
            // The id fallback still produces something readable; a missing
            // clinic name must never break the console.
        }
        if (filled) saveLabels();

        // Fallback for the one clinic whose friendly name predates
        // `clinics.name` and still lives only in clinic_settings.
        try {
            const rows = await api('clinic_settings?select=clinic_id,setting_key,value'
                + '&setting_key=eq.clinicProfile');
            const row = (Array.isArray(rows) ? rows[0] : null);
            if (!row || !row.clinic_id) return;
            const v = row.value || {};
            const name = v.hciName || v.clinicName || '';
            if (!name || labels[row.clinic_id]) return;
            labels[row.clinic_id] = name;
            saveLabels();
        } catch (e) {
            // A missing clinic name must never break the console.
        }
    }

    async function refreshAll(loud) {
        const problems = [];
        try {
            await loadClinicLabels();
        } catch (e) { /* clinicLabel() has a fallback */ }
        try {
            await loadUsers(true);
        } catch (e) {
            problems.push('users: ' + e.message);
            const grid = byId('usersGrid');
            if (grid) {
                grid.innerHTML = '<div class="ent-empty">Could not load the user list: '
                    + esc((e && e.message) || e) + '</div>';
            }
        }
        /* The ticket badge used to be filled ONLY when the Tickets panel was
         * opened, so an administrator signing in saw a nav item with no number
         * and had to click Tickets to find out whether anything was waiting.
         * The badge is the notification - that is the whole point of it - so it
         * is fetched at login like everything else.
         *
         * loadAdminTickets() also renders the panel itself, which is harmless
         * while that panel is hidden, and it is the only path that already knows
         * how to count "open or in_progress". A second, narrower request would
         * be a second definition of what counts as outstanding. */
        try {
            await loadAdminTickets();
        } catch (e) {
            problems.push('tickets: ' + e.message);
        }
        try {
            await loadSessions();
        } catch (e) { problems.push('sessions: ' + e.message); fail('sessionsTable', 7, e); fail('overviewSessions', 5, e); }
        try {
            await loadActivity(loud);
        } catch (e) { problems.push('activity log: ' + e.message); fail('activityTable', 6, e); }
        /* The Overview's "Latest patients records" card is loaded LAST on
         * purpose: created_by_name may be absent (pre-0028) and the role pill
         * comes from `users`, so both must already be settled before the card
         * draws - otherwise an admin sees "Unknown user" on the first paint
         * and the names only correct themselves after a manual refresh. */
        try {
            await loadLatestPatients(true);
        } catch (e) { problems.push('latest records: ' + e.message); }

        // The clinic-wide follow-up tracker, alongside the latest-patients
        // card - same window-of-refresh, its own payload.followUpDate read.
        try {
            await loadFollowUps();
        } catch (e) { problems.push('follow-ups: ' + e.message); }

        // 0041: the possible-duplicates review list (read-only). Its own
        // RPC, its own failure path - it can never block the Overview,
        // and an empty answer is the healthy one.
        loadDuplicates(true).catch(function () { /* its own renderer reports */ });

        renderStats();
        renderOverviewSessions();
        renderUsers();
        renderSessions();
        /* Manual refreshes retry the same blocked origin, so they count too -
         * otherwise Refresh keeps adding red rows while the poll is stopped. */
        if (problems.length) {
            const blocked = problems.some(function (p) {
                return /origin|Failed to fetch|not answering/i.test(p);
            });
            if (blocked) noteAdminCall(false, { code: 'ORIGIN_OR_OFFLINE' });
            else noteAdminCall(true);
        } else {
            noteAdminCall(true);
        }
        if (problems.length && loud) toast('Loaded only partly - ' + problems.join(' / '), true);
    }

    async function liveTick() {
        if (document.hidden) return;
        try {
            await loadSessions();
            noteAdminCall(true);
            renderStats();
            renderOverviewSessions();
            renderSessions();
        } catch (e) {
            /* keep the previous picture on a dropped request. A CORS/origin
             * failure also stops the poll after 3 strikes - see
             * noteAdminCall, otherwise F12 fills with blocked rows. */
            noteAdminCall(false, e);
        }
    }

    function setLive(on) {
        clearInterval(liveTimer);
        liveTimer = null;
        clearInterval(analyticsTimer);
        analyticsTimer = null;
        if (on && originFailStreak < 3) {
            liveTimer = setInterval(liveTick, REFRESH_MS);
            analyticsTimer = setInterval(analyticsTick, ANALYTICS_REFRESH_MS);
        }
    }

    /* Count one failed round trip. Returns true while polling may continue.
     * Only origin/offline failures count: a wrong password or a 500 is a
     * different problem and must not silence the live view. */
    function noteAdminCall(ok, err) {
        if (ok) { originFailStreak = 0; return true; }
        const code = err && err.code;
        if (code !== 'ORIGIN_OR_OFFLINE' && code !== 'OPENED_AS_FILE') { return true; }
        originFailStreak++;
        if (originFailStreak === 3) {
            setLive(false);
            const box = byId('liveChk');
            if (box) box.checked = false;
            toast('Live refresh stopped: the server is not answering this origin. '
                + 'Run: supabase secrets set ENT_ALLOWED_ORIGIN=' + window.location.origin, true);
        }
        return originFailStreak < 3;
    }

    /* ------------------------------ wiring --------------------------- */

    /* --------------------------- the mobile drawer -------------------
       Below 860px the rail becomes an off-canvas drawer (admin.css). The
       open state is ONE class on <body>, because every visual part of the
       drawer keys off it: the slide, the scrim, the scroll lock and the
       burger turning into an X.

       Kept deliberately small. Three ways out - the toggle, the scrim, and
       Escape - because on a phone the scrim is the only tap target that is
       guaranteed to be big, and Escape is what a keyboard user reaches for
       without being told. */
    function setDrawer(open) {
        document.body.classList.toggle('ent-nav-open', open);
        const t = byId('adminNavToggle');
        if (t) {
            t.setAttribute('aria-expanded', open ? 'true' : 'false');
            t.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
        }
    }
    function drawerIsOpen() {
        return document.body.classList.contains('ent-nav-open');
    }

    function wireDrawer() {
        const t = byId('adminNavToggle');
        if (t) t.addEventListener('click', function () { setDrawer(!drawerIsOpen()); });
        const scrim = byId('adminNavScrim');
        if (scrim) scrim.addEventListener('click', function () { setDrawer(false); });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && drawerIsOpen()) setDrawer(false);
        });

        // Choosing a section closes the drawer. Without this the admin taps
        // a section, the panel changes behind an open drawer, and it looks
        // like the tap did nothing.
        document.querySelectorAll('#adminTabs button[data-panel]').forEach(function (b) {
            b.addEventListener('click', function () { setDrawer(false); });
        });

        /* Rotating a phone back to landscape, or resizing a desktop window
           past 860px, leaves a body class that no longer means anything:
           the rail is a grid column again and the scrim is display:none, so
           a hidden scrim over a visible page is the one thing that could
           still swallow taps. Clearing it is the fix, and the drawer simply
           is not available above the breakpoint. */
        window.addEventListener('resize', function () {
            if (window.innerWidth > 860 && drawerIsOpen()) setDrawer(false);
        });
    }

    function selectPanel(name) {
        currentPanel = name;
        let title = '';
        document.querySelectorAll('#adminTabs button[data-panel]').forEach(function (b) {
            const on = b.dataset.panel === name;
            b.classList.toggle('active', on);
            if (on) {
                title = b.dataset.title || '';
                b.setAttribute('aria-current', 'true');
            } else {
                b.removeAttribute('aria-current');
            }
        });
        document.querySelectorAll('.ent-admin-panel').forEach(function (p) {
            p.classList.toggle('active', p.id === 'panel-' + name);
        });
        const head = byId('panelTitle');
        if (head && title) head.textContent = title;
        // The ticket queue is only fetched when it is actually looked at: a
        // clinic that has never had a problem should not pay for the request
        // on every console load.
        // These panels are only fetched when they are actually looked at: a
        // clinic with no problems and no settings changes should not pay for
        // the requests on every console load.
        if (name === 'tickets') loadAdminTickets().catch(function () { /* shown in the panel */ });
        if (name === 'trash') loadTrash().catch(function () { /* shown in the panel */ });
        if (name === 'settings') loadSettings().catch(function () { /* shown in the panel */ });
    }

    /* ======================= THE RECYCLE BIN =======================
       Every read here goes through ent_deleted_reports() and never through a
       plain `reports` query. That is not a style choice: 0026 puts
       `deleted_at IS NULL` into reports_select_owner, so a deleted row is not
       returned to this console either. There is exactly one way to read one,
       and it is the SECURITY DEFINER function that checks the caller is an
       active admin of the owning clinic.

       Restore is deliberately NOT a call into that function. It is an ordinary
       PATCH of deleted_at back to NULL, which reports_update_owner already
       authorises for exactly this case. A separate "undelete" RPC would be a
       second, hand-written copy of the rule "who may undo a deletion", and the
       day the two drift apart is the day somebody restores a patient into the
       wrong clinic. */
    const TRASH_TYPES = { nasal: 'Nasal Endoscopy', laryngeal: 'Laryngeal Endoscopy', cf4: 'CF4 Claim Form' };

    function trashWhen(iso) {
        const t = Date.parse(iso || '');
        if (!t) return 'unknown time';
        const mins = Math.round((Date.now() - t) / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return mins + ' min ago';
        const hrs = Math.round(mins / 60);
        if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
        const days = Math.round(hrs / 24);
        if (days < 30) return days + (days === 1 ? ' day ago' : ' days ago');
        return new Date(t).toLocaleDateString();
    }

    function renderTrash(rows) {
        const box = byId('trashList');
        if (!box) return;
        const count = byId('trashCount');
        if (count) count.textContent = String(rows.length);
        const badge = byId('trashNavCount');
        if (badge) {
            badge.textContent = String(rows.length);
            badge.hidden = rows.length === 0;
        }
        if (!rows.length) {
            box.innerHTML = '<p class="ent-empty">Nothing has been deleted. '
                + 'When a doctor removes a record by mistake, it waits here.</p>';
            return;
        }
        box.innerHTML = rows.map(function (r) {
            const who = r.deleted_who || 'someone';
            return '<article class="ent-trash-row" data-trash-id="' + esc(r.id) + '">'
                + '<div class="ent-trash-main">'
                +   '<b>' + esc(r.patient_name || 'Unnamed patient') + '</b>'
                +   '<small>' + esc(TRASH_TYPES[r.report_type] || r.report_type || 'Report')
                +       (r.is_draft ? ' &middot; Draft' : ' &middot; Saved record')
                +       ' &middot; ' + esc(trashWhen(r.deleted_at)) + '</small>'
                + '</div>'
                + '<div class="ent-trash-side">'
                +   '<span class="ent-trash-by">Deleted by ' + esc(who) + '</span>'
                +   (r.deleted_reason ? '<span class="ent-trash-why">' + esc(r.deleted_reason) + '</span>' : '')
                +   '<button type="button" class="ent-rowbtn edit" data-trash-action="restore">'
                +     '&#9650; Restore</button>'
                // The ONLY hard delete in the product. 0026's policy takes a
                // row only when deleted_at IS NOT NULL and the caller is an
                // active admin - this button is the UI half of exactly that
                // rule, and it is deliberately last, red, and two clicks.
                +   '<button type="button" class="ent-rowbtn del" data-trash-action="purge"'
                +     ' title="Erase this record permanently. This cannot be undone.">'
                +     '&#128465; Delete forever</button>'
                + '</div>'
                + '</article>';
        }).join('');
    }

    async function loadTrash() {
        const box = byId('trashList');
        const hint = byId('trashHint');
        if (hint) hint.textContent = 'Reading the recycle bin…';
        try {
            // POST because ent_deleted_reports takes a named argument, and this
            // module's api() has no GET-with-body path.
            const rows = await api('/rpc/ent_deleted_reports', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ p_limit: 200 })
            });
            renderTrash(Array.isArray(rows) ? rows : []);
            if (hint) {
                hint.textContent = 'Restore puts a record back exactly where it was. "Delete forever" is the only erase - admin only, and only over an already-deleted record.';
            }
        } catch (e) {
            if (box) {
                box.innerHTML = '<p class="ent-empty">Could not read the recycle bin: '
                    + esc(String((e && e.message) || e)) + '</p>';
            }
            if (hint) {
                hint.textContent = 'Needs the recycle bin function (migration 0026).';
            }
        }
    }

    async function restoreTrashRow(id, btn) {
        if (btn) { btn.disabled = true; btn.textContent = 'Restoring…'; }
        try {
            // Clearing the marker is the whole operation. The row keeps its
            // clinic, its doctor, its payload and its photos, so it reappears
            // exactly where it was rather than as a new record.
            // 0045: restore through the SECURITY DEFINER RPC (mirror of the
            // delete) - the direct PATCH hit the same 42501 the delete did.
            const res = await api('rpc/ent_restore_report', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ p_id: id })
            });
            if (!res || res.ok !== true) {
                throw new Error((res && res.error) || 'the server returned nothing to restore');
            }
            const row = (btn && btn.closest('.ent-trash-row'));
            if (row && row.parentNode) row.parentNode.removeChild(row);
            toast('Record restored.');
            loadTrash().catch(function () { /* the row is gone either way */ });
        } catch (e) {
            if (btn) { btn.disabled = false; btn.textContent = '▲ Restore'; }
            toast('Could not restore: ' + ((e && e.message) || e), true);
        }
    }

    /* The FINAL delete - admin only, already-soft-deleted rows only.
     *
     * Two gates sit in front of it, and both are real:
     *
     *   1. THE CLICK. purgeTrashRow is reached only from an ARMED button
     *      (two clicks - see the delegated handler), never from the first.
     *   2. THE DATABASE. reports_delete_admin (0026, untouched here) takes a
     *      row only when deleted_at IS NOT NULL AND the caller is an active
     *      admin of the owning clinic. A live row, or a non-admin session,
     *      comes back with zero rows deleted - which the return=representation
     *      Prefer makes VISIBLE, so this function reports refusal instead of
     *      quietly celebrating it. The deleted_at=not.null query filter is a
     *      third, redundant gate: even a future policy regression could not
     *      aim this DELETE at a live record.
     *
     * No restore follows: this is the one action with no undo. */
    async function purgeTrashRow(id, btn) {
        if (btn) { btn.disabled = true; btn.textContent = 'Erasing…'; }
        try {
            // Free the Storage bytes FIRST, while the report_photos rows
            // still exist to name them. The DELETE below cascades that
            // metadata away, so after it there is nothing left to look the
            // object paths up by. This is the 0036 leak fix. A failure is
            // logged, not fatal: the row is going regardless and the
            // orphaned objects can be swept later — a missing storage
            // unlock must never resurrect a deleted patient record.
            try {
                await callPhotos({ action: 'purge_report', report_id: id });
            } catch (photoErr) {
                console.warn('Could not free photo storage for ' + id + ':', photoErr);
            }
            const res = await api(
                'reports?id=eq.' + encodeURIComponent(id) + '&deleted_at=not.null',
                {
                    method: 'DELETE',
                    headers: { 'Prefer': 'return=representation' }
                });
            if (!Array.isArray(res) || !res.length) {
                throw new Error('nothing was erased - the record may already be gone, or this session may not have access');
            }
            const row = (btn && btn.closest('.ent-trash-row'));
            if (row && row.parentNode) row.parentNode.removeChild(row);
            toast('Record permanently deleted.');
            loadTrash().catch(function () { /* the row is gone either way */ });
        } catch (e) {
            if (btn) {
                btn.disabled = false;
                btn.removeAttribute('data-armed');
                btn.textContent = '🗑 Delete forever';
            }
            toast('Could not delete forever: ' + ((e && e.message) || e), true);
        }
    }

    /* ==================================================================
       TICKETS  (the clinic queue)
       ------------------------------------------------------------------
       The SAME two tables the staff page uses. What differs is the vantage
       point: reportProblem.html shows one person their own tickets; this shows
       every ticket raised in the admin's clinic.

       RLS is the real boundary. tickets_select_admin_clinic admits an
       ACTIVE admin for HIS OWN clinic and nothing else, so a cross-clinic
       ticket is unreachable, not merely filtered out. The query says the
       same thing out loud, so a policy change cannot silently widen this.
    ================================================================== */
    const TICKET_STATUS = {
        open: { text: 'Open', cls: 'is-open' },
        in_progress: { text: 'In progress', cls: 'is-progress' },
        resolved: { text: 'Resolved', cls: 'is-resolved' },
        closed: { text: 'Closed', cls: 'is-closed' },
    };
    // The area a ticket is about. Kept beside TICKET_CATEGORY so the two
    // questions stay separate on screen: WHERE it broke vs WHAT KIND of
    // problem it is.
    const TICKET_SCOPE = {
        nasal: 'Nasal', laryngeal: 'Laryngeal', cf4: 'CF4',
        system: 'The app itself',
    };
    const TICKET_CATEGORY = {
        bug: 'Something is broken', access: 'Cannot get in',
        data: 'A record looks wrong', question: 'How do I...', other: 'Other',
    };
    // How urgent the reporter said it was. This was collected by the form
    // and stored in tickets.priority, but the admin detail never showed it,
    // so an admin triaging the queue had no idea what "high" meant - they
    // could not even see that it had been said.
    const TICKET_PRIORITY = {
        low: { text: 'Not urgent', cls: 'is-low', mark: 'Low' },
        normal: { text: 'Normal', cls: 'is-normal', mark: 'Normal' },
        high: { text: 'Urgent', cls: 'is-high', mark: 'Urgent' },
    };

    /* Who filed this, said plainly.
     *
     * The ticket row only carries a created_by UUID. An admin trying to act
     * on a complaint needs to know three things that were previously hidden
     * behind a bare full name: WHICH account filed it (so they can match it
     * to a login), WHAT they are (a doctor and a secretary need different
     * follow-up), and WHICH clinic it came from.
     *
     * The clinic is read from the ticket's own clinic_id rather than from
     * the session, because the ticket is the fact being examined - it should
     * not be able to display a clinic the viewer happened to be signed into.
     * The visible 8-character tail is enough to match against Settings.
     */
    function ticketReporter(t, messages) {
        const who = users.find(function (u) { return u.id === t.created_by; });

        /* The role survives the account.
         *
         * ticket_messages.author_role is stamped server-side from the
         * caller's live profile (trg_ticket_messages_stamp), so it is on
         * the row and it cannot be forged by the browser. The users list is
         * a live join against the current staff_profiles, so it says nothing
         * about someone who has since been removed or whose account was
         * deleted.
         *
         * That combination is exactly what produced "Unknown account" with
         * no role at all: the clinic had genuinely deleted the person, and
         * the screen then refused to tell the admin the single most useful
         * thing still knowable - was this a doctor or a secretary, and from
         * which clinic. Both of those are on the ticket itself.
         */
        const rows = Array.isArray(messages) ? messages : [];
        const own = rows.filter(function (m) { return m.author_id === t.created_by; });
        const roleFromTicket = (own.length ? own : rows)
            .map(function (m) { return m.author_role; })
            .find(function (r) { return r === 'doctor' || r === 'secretary' || r === 'admin'; }) || '';

        const role = (who && who.role) || roleFromTicket;
        const clinic = String(t.clinic_id || '');

        /* Has the staff list actually arrived yet?
         *
         * `users` comes from the auth-admin Edge Function, so for a moment
         * after the panel opens it is still []. Every lookup then misses,
         * and the old code reported "Unknown account" / "Removed account"
         * for people who were sitting right there in the staff list. The
         * screen was not describing the clinic; it was describing its own
         * loading state.
         *
         * An empty list means "not known yet", which is a different claim
         * from "no such person". Saying so is the difference between a
         * correct panel and one that quietly lies about a colleague.
         */
        const staffLoaded = users.length > 0;

        return {
            known: !!who,
            staffLoaded: staffLoaded,
            name: who ? displayName(who) : (staffLoaded ? 'Removed account' : 'Loading staff list\u2026'),
            // Never a bare UUID after an @. It is meaningless to a person, and
            // a hex string in that position is also something tooling will try
            // to read as a version-control ref. The ticket number is the
            // only honest thing to offer in its place.
            username: who ? (who.username || '') : '',
            ticketNo: String(t.id || '').slice(0, 8),
            role: role,
            roleFromTicket: !who && !!roleFromTicket,
            roleText: role === 'doctor' ? 'Doctor'
                : role === 'secretary' ? 'Secretary'
                : role === 'admin' ? 'Administrator' : '',
            roleCls: role === 'doctor' ? 'is-doctor'
                : role === 'secretary' ? 'is-secretary'
                : role === 'admin' ? 'is-admin' : '',
            initials: who ? initialsOf(who.full_name || who.username || '?')
                : (clinic ? clinic.slice(0, 2).toUpperCase() : '?'),
            assigned: who && who.role === 'secretary'
                ? (who.assigned_doctor_id
                    ? (users.find(function (d) { return d.id === who.assigned_doctor_id; }) || {}).username || ''
                    : '')
                : '',
            /* The clinic NAME, not its id. "00000000-0000-4000-8000-..." is
             * how the database stores it and is no use to a person trying to
             * tell two clinics apart. The id stays on hover for anyone who
             * does need it. */
            clinicName: clinic ? clinicLabel(clinic) : 'Unknown clinic',
            clinicId: clinic ? clinic.slice(0, 8) : '-',
        };
    }

    let adminTickets = [];
    let adminTicketOpen = null;
    let adminTicketMessages = [];
    let adminTicketBusy = false;
    /* messageCount per ticket, so a queue row can show how much back and
     * forth a ticket already has. The row used to show nothing about that,
     * so a four-message argument and a one-line report looked identical in
     * the list. Filled by the same query that loads the list. */
    let adminTicketCounts = {};

    function ticketWhen(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d)) return '';
        const s = (Date.now() - d.getTime()) / 1000;
        if (s < 60) return 'just now';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        if (s < 86400) return Math.floor(s / 3600) + 'h ago';
        if (s < 604800) return Math.floor(s / 86400) + 'd ago';
        return d.toLocaleDateString();
    }
    function ticketStamp(iso) {
        const d = new Date(iso);
        return (iso && !isNaN(d)) ? d.toLocaleString() : '';
    }
    function ticketSay(msg, bad) {
        const box = byId('adminTicketNotice');
        if (!box) return;
        box.textContent = msg || '';
        box.className = 'ent-ticket-notice' + (msg ? ' show' : '') + (bad ? ' is-bad' : ' is-ok');
    }

    async function loadAdminTickets() {
        if (!session || !session.user) return;
        const q = new URLSearchParams();
        q.set('select', 'id,subject,scope,category,priority,status,created_by,clinic_id,created_at,last_message_at,resolved_at,last_message_by');
        q.set('order', 'last_message_at.desc');
        q.set('limit', '200');
        const rows = await api('tickets?' + q.toString());
        adminTickets = Array.isArray(rows) ? rows : [];

        /* How many messages each ticket has, for the queue rows.
         *
         * Two columns and no body: the queue never reads message text, and
         * selecting only two columns keeps a busy clinic's queue from
         * pulling every message body into the browser just to draw a
         * list. Grouping is done here rather than with an RPC because the
         * queue is capped at 200 tickets, so this is bounded.
         */
        const counts = {};
        try {
            const cq = new URLSearchParams();
            cq.set('select', 'ticket_id');
            cq.set('limit', '5000');
            const msgs = await api('ticket_messages?' + cq.toString());
            (Array.isArray(msgs) ? msgs : []).forEach(function (m) {
                if (m && m.ticket_id) counts[m.ticket_id] = (counts[m.ticket_id] || 0) + 1;
            });
        } catch (e) {
            // A missing count must not hide the queue. The rows simply go
            // without a reply badge, which is honest rather than wrong.
        }
        adminTicketCounts = counts;

        const open = adminTickets.filter(function (t) {
            return t.status === 'open' || t.status === 'in_progress';
        }).length;
        const badge = byId('ticketNavCount');
        /* The badge stays VISIBLE at zero once the count has loaded.
         *
         * It used to be hidden whenever the count was 0, which made "no tickets
         * waiting" look identical to "the count has not been fetched yet" - an
         * administrator could not tell a quiet queue from a broken one without
         * opening the panel. Zero is information. It is drawn in a neutral colour
         * so it never shouts about nothing, and turns red the moment there is
         * something waiting. */
        if (badge) {
            badge.textContent = String(open);
            badge.hidden = false;
            badge.classList.toggle('is-zero', open === 0);
            badge.title = open === 0
                ? 'No tickets waiting'
                : open + (open === 1 ? ' ticket' : ' tickets') + ' waiting';
        }

        /* The hero stats above the inbox. Same rows, counted four ways, so
         * the numbers can never disagree with the queue underneath them. */
        (function paintTicketStats() {
            const set = function (id, n) {
                const el = byId(id);
                if (el) el.textContent = String(n);
            };
            set('ticketStatOpen', adminTickets.filter(function (t) { return t.status === 'open'; }).length);
            set('ticketStatProgress', adminTickets.filter(function (t) { return t.status === 'in_progress'; }).length);
            set('ticketStatUrgent', adminTickets.filter(function (t) {
                return t.priority === 'high' && t.status !== 'resolved' && t.status !== 'closed';
            }).length);
            set('ticketStatResolved', adminTickets.filter(function (t) { return t.status === 'resolved'; }).length);
            const qc = byId('ticketQueueCount');
            if (qc) qc.textContent = adminTickets.length
                ? String(adminTickets.length) + (adminTickets.length === 1 ? ' ticket' : ' tickets') : '';
        })();

        renderAdminTickets();
        if (adminTicketOpen) {
            const still = adminTickets.some(function (t) { return t.id === adminTicketOpen; });
            if (still) await loadAdminTicketThread(adminTicketOpen);
            else adminTicketOpen = null;
        }
    }

    /* One row of the queue.
     *
     * The old row packed four facts into one run-on line separated by
     * dots - "Tara · CF4 · Something is broken · 2 hours ago" - and printed
     * "someone" whenever the reporter was not in the staff list, which is
     * the same missing-person bug the detail panel had. An admin scanning
     * a queue needs three things in order: how urgent, who is waiting, and
     * what it is about. Urgency was not on the row at all, so triage meant
     * opening every ticket to learn it.
     */
    function ticketQueueRow(t, selected) {
        const st = TICKET_STATUS[t.status] || TICKET_STATUS.open;
        const pri = TICKET_PRIORITY[t.priority] || TICKET_PRIORITY.normal;
        const who = users.find(function (u) { return u.id === t.created_by; });
        const roleText = who
            ? (who.role === 'doctor' ? 'Doctor' : who.role === 'secretary' ? 'Secretary'
                : who.role === 'admin' ? 'Admin' : '')
            : '';
        const roleCls = who
            ? (who.role === 'doctor' ? 'is-doctor' : who.role === 'secretary' ? 'is-secretary'
                : who.role === 'admin' ? 'is-admin' : '')
            : '';

        const n = adminTicketCounts[t.id] || 0;
        const replies = n > 1
            ? '<span class="ent-tk-replies" title="' + n + ' messages in this ticket">'
              + '<span aria-hidden="true">&#8617;</span> ' + (n - 1) + '</span>'
            : '';

        /* The other half of the notification.
         *
         * The same last_message_by column tells the admin the mirror image of
         * what it tells the reporter: if the last word on a ticket was NOT the
         * admin, then somebody is waiting for an answer. Without this the queue
         * shows message COUNTS but never says which tickets are actually the
         * admin's turn to move - and triage then means reading every thread.
         *
         * Deliberately not localStorage-backed the way the reporter's badge is:
         * a clinic's admin queue is shared and long-lived, so "seen" here has
         * to mean "handled", and the ticket reaching resolved or closed is
         * that signal. Anything else would leave a stale dot on a ticket that
         * was answered an hour ago.
         */
        const awaitingMe = session && session.user
            && t.last_message_by && t.last_message_by !== session.user.id
            && t.status !== 'resolved' && t.status !== 'closed';
        const waiting = awaitingMe
            ? '<span class="ent-tk-waiting" title="Nobody has answered this yet">'
              + '<span aria-hidden="true">&#9873;</span> Needs you</span>'
            : '';

        /* ----------------------------------------------------------------
           The row, rebuilt to be read rather than decoded.

           Before: the subject shared its line with two badges, the @handle
           was set in monospace at the same weight as the name, the role
           was a third coloured chip saying what the avatar already said,
           and scope AND category were two chips for one idea. Seven small
           coloured objects per row, so the eye had nothing to land on.

           Now each line answers exactly one question and carries one
           accent:

             line 1  how urgent, and since when
             line 2  what it is about          <- the subject, full width
             line 3  who is waiting
             line 4  which part of the app

           The subject is no longer competing with anything on its line, so
           it can breathe and clamp at two lines. Message text is still not
           fetched: see the note in loadAdminTickets.
         ---------------------------------------------------------------- */
        return '<button type="button" class="ent-admin-ticket'
            + (selected ? ' is-selected' : '')
            + ' is-' + pri.cls.replace('is-', '')
            + ' status-' + esc(t.status || 'open')
            + '" data-id="' + esc(t.id) + '">'
            + '<span class="ent-tk-bar" aria-hidden="true"></span>'
            + '<span class="ent-tk-body">'
                + '<span class="ent-tk-strip">'
                    + '<span class="ent-tk-badges">'
                        + '<span class="ent-badge ' + pri.cls + '">' + esc(pri.mark) + '</span>'
                        + '<span class="ent-badge ' + st.cls + '">' + esc(st.text) + '</span>'
                    + '</span>'
                    + '<time class="ent-tk-when">' + esc(ticketWhen(t.last_message_at)) + '</time>'
                + '</span>'
                + '<strong class="ent-tk-subject">' + esc(t.subject) + '</strong>'
                + '<span class="ent-tk-who">'
                    + '<span class="ent-tk-av' + (roleCls ? ' ' + roleCls : '') + '">'
                        + esc(who ? initialsOf(who.full_name || who.username || '?') : '?')
                    + '</span>'
                    + '<span class="ent-tk-name">' + esc(who ? displayName(who) : 'Removed account') + '</span>'
                    + (who && who.username ? '<code class="ent-tk-handle">@' + esc(who.username) + '</code>' : '')
                    + (roleText ? '<span class="ent-tk-role ' + roleCls + '">' + esc(roleText) + '</span>' : '')
                    + waiting
                    + replies
                + '</span>'
                + '<span class="ent-tk-tags">'
                    + '<span class="ent-tk-tag is-scope">' + esc(TICKET_SCOPE[t.scope] || TICKET_SCOPE.system) + '</span>'
                    + '<span class="ent-tk-tag">' + esc(TICKET_CATEGORY[t.category] || TICKET_CATEGORY.other) + '</span>'
                + '</span>'
            + '</span>'
        + '</button>';
    }

    function renderAdminTickets() {
        const box = byId('adminTicketList');
        if (!box) return;
        const needle = String(byId('ticketSearch').value || '').trim().toLowerCase();
        const clearSearch = byId('ticketSearchClear');
        if (clearSearch) clearSearch.hidden = !needle;
        const want = byId('ticketStatusFilter').value;
        const wantScope = byId('ticketScopeFilter').value;

        const rows = adminTickets.filter(function (t) {
            if (want && t.status !== want) return false;
            if (wantScope && (t.scope || 'system') !== wantScope) return false;
            if (!needle) return true;
            const who = (users.find(function (u) { return u.id === t.created_by; }) || {}).username || '';
            return (t.subject + ' ' + who + ' ' + (t.category || '')).toLowerCase().indexOf(needle) !== -1;
        });

        // The open ticket first. An admin who is mid-reply must not have the
        // row they are reading rearrange itself under them.
        rows.sort(function (a, b) {
            if (a.id === adminTicketOpen) return -1;
            if (b.id === adminTicketOpen) return 1;
            const rank = { open: 0, in_progress: 1, resolved: 2, closed: 3 };
            const ra = (rank[a.status] ?? 9), rb = (rank[b.status] ?? 9);
            if (ra !== rb) return ra - rb;
            // Then most urgent, so the queue reads as a worklist.
            const ph = { high: 0, normal: 1, low: 2 };
            const pa = (ph[a.priority] ?? 1), pb = (ph[b.priority] ?? 1);
            if (pa !== pb) return pa - pb;
            return String(b.last_message_at || '').localeCompare(String(a.last_message_at || ''));
        });

        setText('ticketResults', rows.length
            ? 'Showing ' + fmtNum(rows.length) + ' of ' + fmtNum(adminTickets.length) + ' tickets'
            : 'No tickets match the current filters');
        if (!rows.length) {
            box.innerHTML = '<div class="ent-empty">'
                + (adminTickets.length ? 'No ticket matches that filter.'
                    : 'Nothing reported. When a doctor or secretary reports a problem it appears here.')
                + '</div>';
            return;
        }

        box.innerHTML = rows.map(function (t) {
            return ticketQueueRow(t, t.id === adminTicketOpen);
        }).join('');
    }

    async function loadAdminTicketThread(id) {
        const q = new URLSearchParams();
        q.set('select', 'id,body,author_id,author_role,created_at');
        q.set('ticket_id', 'eq.' + encodeURIComponent(id));
        q.set('order', 'created_at.asc');
        q.set('limit', '500');
        const rows = await api('ticket_messages?' + q.toString());
        adminTicketMessages = Array.isArray(rows) ? rows : [];
        renderAdminTicketDetail();
    }

    function renderAdminTicketDetail() {
        const box = byId('adminTicketDetail');
        if (!box) return;
        const t = adminTickets.find(function (x) { return x.id === adminTicketOpen; });
        if (!t) {
            box.innerHTML = '<div class="ent-empty">Choose a ticket on the left to read it and reply.</div>';
            return;
        }
        const st = TICKET_STATUS[t.status] || TICKET_STATUS.open;
        const by = ticketReporter(t, adminTicketMessages);
        const pri = TICKET_PRIORITY[t.priority] || TICKET_PRIORITY.normal;
        const closed = t.status === 'resolved' || t.status === 'closed';

        // Everything the reporter actually filled in, as a labelled grid.
        // category and priority have been stored this whole time and shown
        // nowhere, so an admin triaging the queue had to guess the urgency
        // from the wording of the complaint.
        const filled = [
            ['Which part', TICKET_SCOPE[t.scope] || TICKET_SCOPE.system, 'is-scope'],
            ['Kind of problem', TICKET_CATEGORY[t.category] || TICKET_CATEGORY.other, ''],
            ['How urgent', pri.text, 'is-pri ' + pri.cls],
            ['Filed', ticketStamp(t.created_at), ''],
        ];

        box.innerHTML =
            '<div class="ent-ticket-thread status-' + esc(t.status || 'open') + '">' +
            '<div class="ent-thread-top">' +
                '<span class="ent-thread-no">Ticket #' + esc(String(t.id || '').slice(0, 8).toUpperCase()) + '</span>' +
                '<span class="ent-thread-time">' + esc(ticketWhen(t.last_message_at) || ticketStamp(t.created_at)) + '</span>' +
            '</div>' +
            '<header class="ent-admin-ticket-head">' +
                '<div class="ent-admin-ticket-headmain">' +
                    '<h3>' + esc(t.subject) + '</h3>' +
                    '<div class="ent-admin-ticket-tags">' +
                        '<span class="ent-badge ' + st.cls + '">' + esc(st.text) + '</span>' +
                        '<span class="ent-badge ' + pri.cls + '">' + esc(pri.mark) + '</span>' +
                        (by.roleText ? '<span class="ent-badge is-role ' + by.roleCls + '">' + esc(by.roleText) + '</span>' : '') +
                    '</div>' +
                '</div>' +
            '</header>' +

            // WHO FILED IT. This used to be one bare full name and nothing
            // else - no login, no role, no clinic - and when the account
            // was no longer in the staff list it collapsed to "Unknown
            // account" with no role at all, which is the least useful thing
            // an admin could be shown about a complaint.
            '<section class="ent-admin-ticket-who' + (by.known ? '' : (by.staffLoaded ? ' is-gone' : ' is-loading')) + '">' +
                '<span class="ent-admin-ticket-avatar">' + esc(by.initials) + '</span>' +
                '<span class="ent-admin-ticket-who-meta">' +
                    '<strong>' + esc(by.name) +
                        (by.username ? ' <span class="ent-admin-ticket-handle">@' + esc(by.username) + '</span>' : '')
                        + (by.staffLoaded ? '' : ' <span class="ent-tk-spin" aria-hidden="true"></span>') +
                    '</strong>' +
                    '<small>' +
                        (by.known
                            ? esc(by.roleText || 'Staff') +
                              (by.assigned ? ' &middot; works for <b>@' + esc(by.assigned) + '</b>' : '')
                            : (!by.staffLoaded
                                // One line, not two. It used to print "Loading
                                // staff list" as the name and "Fetching the
                                // staff list" underneath, which reads as two
                                // separate faults rather than one.
                                ? 'The name comes from the <b>auth-admin</b> function, which is not answering. '
                                  + 'The clinic and role below are read from the ticket itself and are correct.'
                                : 'This account is no longer in the staff list'
                                  + (by.roleFromTicket ? ' &middot; filed it as a <b>' + esc(by.roleText.toLowerCase()) + '</b>' : ''))) +
                    '</small>' +
                '</span>' +
                // The clinic NAME. The id is what the database stores and is
                // no use to anyone reading a complaint.
                '<span class="ent-admin-ticket-clinic" title="Clinic id ' + esc(by.clinicId) + '">' +
                    '<small>CLINIC</small><b>' + esc(by.clinicName) + '</b>' +
                '</span>' +
            '</section>' +

            '<dl class="ent-admin-ticket-facts">' +
                filled.map(function (f) {
                    return '<div class="ent-admin-ticket-fact ' + f[2] + '">' +
                        '<dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd></div>';
                }).join('') +
            '</dl>' +

            (t.resolved_at
                ? '<p class="ent-admin-ticket-closed">Resolved ' + esc(ticketStamp(t.resolved_at)) + '</p>'
                : '') +

            '<div class="ent-msg-list">' +
                (adminTicketMessages.length
                    ? adminTicketMessages.map(function (m, i) {
                        const mine = m.author_role === 'admin';
                        const author = mine ? null : users.find(function (u) { return u.id === m.author_id; });
                        const label = mine
                            ? displayName(session.user)
                            : (author ? displayName(author)
                                      : (m.author_role === 'secretary' ? 'Secretary'
                                        : m.author_role === 'admin' ? 'Administrator' : 'Doctor'));
                        const roleTag = mine ? 'You'
                            : m.author_role === 'secretary' ? 'Secretary'
                            : m.author_role === 'admin' ? 'Admin' : 'Doctor';
                        return '<article class="ent-msg' + (mine ? ' is-mine' : '') + (i === 0 ? ' is-first' : '') + '">' +
                            '<header>' +
                                '<span class="ent-msg-who"><b>' + esc(label) + '</b>' +
                                    '<span class="ent-msg-role">' + esc(roleTag) + '</span></span>' +
                                '<time>' + esc(ticketStamp(m.created_at)) + '</time>' +
                            '</header>' +
                            (i === 0 ? '<span class="ent-msg-tag">What they reported</span>' : '') +
                            '<p>' + esc(m.body).replace(/\n/g, '<br>') + '</p>' +
                        '</article>';
                      }).join('')
                    : '<p class="ent-empty">No messages.</p>') +
            '</div>' +
            (closed ? '' :
                '<form class="ent-admin-reply" id="adminReplyForm">' +
                    '<textarea id="adminReplyBody" rows="3" maxlength="8000" ' +
                    'placeholder="Type your answer or an update to ' + esc(by.name) + '&hellip;"></textarea>' +
                    '<div class="ent-admin-reply-actions">' +
                        '<button type="submit" class="ent-btn primary">Send reply</button>' +
                        '<button type="button" class="ent-btn" data-resolve="1">Mark resolved</button>' +
                    '</div>' +
                '</form>') +
            '<div class="ent-admin-status">' +
                '<label for="adminTicketStatus">Status</label>' +
                '<select id="adminTicketStatus">' +
                    ['open', 'in_progress', 'resolved', 'closed'].map(function (v) {
                        return '<option value="' + v + '"' + (t.status === v ? ' selected' : '') + '>' +
                            esc(TICKET_STATUS[v].text) + '</option>';
                    }).join('') +
                '</select>' +
            '</div>' +
            '</div>'; // .ent-ticket-thread

        const form = byId('adminReplyForm');
        if (form) form.addEventListener('submit', submitAdminReply);
        // One-click resolve, so the common case is not: type, pick from a
        // dropdown, wait for a round trip.
        const quick = box.querySelector('[data-resolve]');
        if (quick) quick.addEventListener('click', function () { setAdminTicketStatus('resolved'); });
        const sel = byId('adminTicketStatus');
        if (sel) sel.addEventListener('change', function () { setAdminTicketStatus(this.value); });
    }

    async function submitAdminReply(ev) {
        ev.preventDefault();
        if (adminTicketBusy || !adminTicketOpen) return;
        const body = byId('adminReplyBody').value.trim();
        if (!body) return ticketSay('Type a message first.', true);
        adminTicketBusy = true;
        ticketSay('');
        try {
            // No author_id, no author_role: both are stamped from the
            // caller's live profile by trg_ticket_messages_stamp.
            await api('ticket_messages', {
                method: 'POST',
                headers: { 'Prefer': 'return=representation' },
                body: JSON.stringify([{ ticket_id: adminTicketOpen, body: body }])
            });
            await loadAdminTicketThread(adminTicketOpen);
            await loadAdminTickets();
            ticketSay('Reply sent.', false);
        } catch (e) {
            ticketSay(String((e && e.message) || e).slice(0, 160), true);
        } finally {
            adminTicketBusy = false;
        }
    }

    async function setAdminTicketStatus(next) {
        if (adminTicketBusy || !adminTicketOpen) return;
        adminTicketBusy = true;
        ticketSay('');
        try {
            await api('tickets?id=eq.' + encodeURIComponent(adminTicketOpen), {
                method: 'PATCH',
                headers: { 'Prefer': 'return=representation' },
                body: JSON.stringify({ status: next })
            });
            await loadAdminTickets();
            renderAdminTicketDetail();
            ticketSay('Marked ' + ((TICKET_STATUS[next] || {}).text || next) + '.', false);
        } catch (e) {
            ticketSay(String((e && e.message) || e).slice(0, 160), true);
            renderAdminTicketDetail();   // put the select back where it was
        } finally {
            adminTicketBusy = false;
        }
    }


    /* ==================================================================
       SETTINGS
       ------------------------------------------------------------------
       Two things an ADMIN owns, both of which were previously a page
       they had to leave the console for:

         1. the clinic name, which is printed on every report. It lives in
            clinic_settings under the whitelisted key 'clinicProfile', the
            only settings key the database accepts.
         2. the capability switches. These are the SERVER-side flags in
            system_flags. The switches inside the app are a localStorage
            convenience and cannot unlock anything; only these decide. That
            is why they belong here, next to the accounts that use them.

       clinic_id is never sent: trg_settings_stamp stamps it from the
       caller's own profile, so an admin cannot write into another clinic.
    ================================================================== */
    let systemFlags = [];

    function settingsSay(msg, bad) {
        const box = byId('settingsNotice');
        if (!box) return;
        box.textContent = msg || '';
        box.className = 'ent-ticket-notice' + (msg ? ' show' : '') + (bad ? ' is-bad' : ' is-ok');
    }

    /* The switches are stored with camelCase keys - cloud_reports_read,
     photo_storage - and the old panel printed the raw key in bold with the
     dev note underneath. An administrator is not meant to decode
     "photo_storage", and the note is an internal test-plan reference that
     means nothing to the person standing in front of the screen.
     Both are now given a plain label and a sentence about consequences. */
const FLAG_INFO = {
        cloud_reports_read: {
            label: 'Read shared reports',
            desc: 'Open a report that another device in this clinic has already saved.',
        },
        cloud_reports_write: {
            label: 'Save reports to the cloud',
            desc: 'Send each finished report to the server so other devices can open it.',
        },
        photo_storage: {
            label: 'Patient photo storage',
            desc: 'Attach photos to a report. While this is off the upload is refused by the '
                + 'server, not merely hidden, so leaving it off keeps photos switched off everywhere.',
        },
    };
    function flagLabel(key) {
        const known = FLAG_INFO[key];
        if (known) return known;
        // Unknown key: still readable. photo_storage -> Photo storage.
        const words = String(key).replace(/[_-]+/g, ' ').trim();
        return words.charAt(0).toUpperCase() + words.slice(1);
    }

    /* The fixed facts about your own clinic. Shown at the top of Settings
     * so the page answers "which clinic am I configuring?" before it asks
     * for anything. Read from the staff list already in memory - no extra
     * query, and it cannot drift from what the Users tab shows. */
    function renderSettingsFacts() {
        const me = (typeof Auth !== 'undefined' && typeof Auth.currentUser === 'function'
            ? Auth.currentUser() : null)
            || (session && session.user) || {};
        const id = byId('settingsClinicId');
        if (id) id.textContent = me.clinic_id ? String(me.clinic_id).slice(0, 8) + '\u2026' : '\u2014';
        const doctors = users.filter(function (u) { return u.role === 'doctor'; }).length;
        const secs = users.filter(function (u) { return u.role === 'secretary'; }).length;
        const set = function (elem, n) { const el = byId(elem); if (el) el.textContent = n; };
        set('settingsStaffCount', String(users.length));
        set('settingsDoctorCount', String(doctors));
        set('settingsSecretaryCount', String(secs));
        /* The identity strip shows the saved clinic NAME, not just its id.
         * The input holds the draft; this heading holds the truth. It is
         * refreshed here (counts) and again when loadSettings reads the
         * stored profile below, so typing never rewrites it early. */
        const nm = byId('settingsClinicName');
        if (nm && !nm.dataset.fromServer) {
            const typed = byId('clinicNameInput');
            const v = typed ? String(typed.value || '').trim() : '';
            nm.textContent = v || 'Unnamed clinic';
        }
    }

    async function loadSettings() {
        if (!session || !session.user) return;
        settingsSay('');
        renderSettingsFacts();

        // --- the clinic name ---
        try {
            const rows = await api('clinic_settings?select=setting_key,value&setting_key=eq.clinicProfile');
            const row = Array.isArray(rows) ? rows[0] : null;
            const v = (row && row.value) || {};
            const saved = v.hciName || v.clinicName || '';
            byId('clinicNameInput').value = saved;
            /* Paint the identity strip from the stored profile - the one
             * source that survives a reload. dataset marks it so the counts
             * refresh above cannot overwrite a saved name with a blank. */
            const nm = byId('settingsClinicName');
            if (nm) { nm.textContent = saved || 'Unnamed clinic'; nm.dataset.fromServer = '1'; }
        } catch (e) {
            settingsSay('Could not read the clinic name: ' + String((e && e.message) || e).slice(0, 120), true);
        }

        // --- the capability switches ---
        try {
            const rows = await api('system_flags?select=flag_key,enabled,note,updated_at&order=flag_key');
            systemFlags = Array.isArray(rows) ? rows : [];
        } catch (e) {
            settingsSay('Could not read the switches: ' + String((e && e.message) || e).slice(0, 120), true);
            return;
        }

        const box = byId('flagList');
        if (!box) return;
        if (!systemFlags.length) {
            box.innerHTML = '<p class="ent-empty">No switches defined.</p>';
            return;
        }
        box.innerHTML = systemFlags.map(function (f) {
            // The raw flag_key stays in data-flag, so flipping the switch
            // still posts the exact key the server knows.
            const info = FLAG_INFO[f.flag_key];
            return '<label class="ent-flag-row' + (f.enabled ? ' is-on' : '') + '">' +
                '<input type="checkbox" data-flag="' + esc(f.flag_key) + '"' + (f.enabled ? ' checked' : '') + '>' +
                '<span class="ent-flag-text">' +
                    '<b>' + esc(info ? info.label : flagLabel(f.flag_key)) + '</b>' +
                    '<small>' + esc(info ? info.desc : (f.note || flagLabel(f.flag_key))) + '</small>' +
                '</span>' +
                '<span class="ent-flag-state">' + (f.enabled ? 'On' : 'Off') + '</span>' +
            '</label>';
        }).join('');
        renderSettingsFacts();
    }

    async function saveClinicName() {
        if (!session || !session.user) return;
        const name = byId('clinicNameInput').value.trim();
        if (name.length < 2) return settingsSay('Give the clinic a name.', true);
        settingsSay('');
        const btn = byId('saveClinicNameBtn');
        btn.disabled = true;
        try {
            // No clinic_id and no updated_by: both are stamped server-side.
            await api('clinic_settings?on_conflict=clinic_id,setting_key', {
                method: 'POST',
                headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
                body: JSON.stringify([{ setting_key: 'clinicProfile', value: { hciName: name } }]),
            });
            settingsSay('Clinic name saved.', false);
            await Auth.logActivity('SETTING_UPDATED', 'Changed the clinic name from the admin console');
        } catch (e) {
            settingsSay('Could not save: ' + String((e && e.message) || e).slice(0, 140), true);
        } finally {
            btn.disabled = false;
        }
    }

    async function toggleFlag(key, on) {
        settingsSay('');
        try {
            await api('system_flags?flag_key=eq.' + encodeURIComponent(key), {
                method: 'PATCH',
                headers: { Prefer: 'return=representation' },
                body: JSON.stringify({ enabled: !!on }),
            });
            settingsSay(key + ' is now ' + (on ? 'ON' : 'OFF') + '.', false);
            await Auth.logActivity('SETTING_UPDATED',
                (on ? 'Enabled ' : 'Disabled ') + key);
        } catch (e) {
            settingsSay('Could not change ' + key + ': ' + String((e && e.message) || e).slice(0, 140), true);
            await loadSettings();   // put the switch back where it really is
        }
    }
    async function openAdminTicket(id) {
        adminTicketOpen = id;
        renderAdminTickets();
        try {
            await loadAdminTicketThread(id);
        } catch (e) {
            ticketSay(String((e && e.message) || e).slice(0, 160), true);
        }
    }

    function wire() {
        document.querySelectorAll('#adminTabs button[data-panel]').forEach(function (b) {
            b.addEventListener('click', function () { selectPanel(b.dataset.panel); });
        });

        byId('userSearch').addEventListener('input', renderUsers);
        byId('roleFilter').addEventListener('change', renderUsers);
        const usersSearchClear = byId('usersSearchClear');
        if (usersSearchClear) {
            usersSearchClear.addEventListener('click', function () {
                const search = byId('userSearch');
                if (!search) return;
                search.value = '';
                renderUsers();
                search.focus();
            });
        }
        byId('activityFilter').addEventListener('change', renderActivity);
        const activitySearchClear = byId('activitySearchClear');
        if (activitySearchClear) {
            activitySearchClear.addEventListener('click', function () {
                const search = byId('activitySearch');
                if (!search) return;
                search.value = '';
                renderActivity();
                search.focus();
            });
        }

        byId('refreshUsersBtn').addEventListener('click', function () { refreshAll(true); });
        byId('refreshSessionsBtn').addEventListener('click', function () { refreshAll(true); });
        byId('refreshActivityBtn').addEventListener('click', function () { refreshAll(true); });

        byId('liveChk').addEventListener('change', function (e) { setLive(e.target.checked); });

        // ---- recycle bin ----
        const refreshTrash = byId('refreshTrashBtn');
        if (refreshTrash) {
            refreshTrash.addEventListener('click', function () {
                loadTrash().catch(function () { /* the panel shows the error */ });
            });
        }
        // Empty the bin in bulk: erase every already-deleted record past
        // the retention cutoff (90 days). Two-step, because it is
        // irreversible and bulk - the same instinct as "Delete forever"
        // on one row.
        //
        // WHY THIS ITERATES purgeTrashRow INSTEAD OF CALLING 0036's RPC
        // DIRECTLY: order matters. purgeTrashRow frees the Storage bytes
        // FIRST (while report_photos still names the object paths), THEN
        // deletes the row. The bulk RPC deletes the row in SQL, which
        // CASCADEs report_photos away - after which there is nothing left
        // to look the paths up by, so the bytes would orphan. So the
        // console does the storage-then-delete order per row; 0036 remains
        // the pure-SQL retention tool for a cron or an already-swept bin.
        // ent_purge path can only ever touch ALREADY-deleted rows of this
        // admin's own clinic, so no live record is ever at risk.
        const emptyTrash = byId('emptyTrashBtn');
        if (emptyTrash) {
            emptyTrash.addEventListener('click', async function () {
                const armed = emptyTrash.getAttribute('data-armed') === '1';
                if (!armed) {
                    emptyTrash.setAttribute('data-armed', '1');
                    emptyTrash.textContent = '⌛ Click again to empty';
                    setTimeout(function () {
                        if (emptyTrash.getAttribute('data-armed') === '1') {
                            emptyTrash.removeAttribute('data-armed');
                            emptyTrash.textContent = '🗑 Empty old bin';
                        }
                    }, 4000);
                    return;
                }
                emptyTrash.removeAttribute('data-armed');
                emptyTrash.disabled = true;
                emptyTrash.textContent = 'Emptying…';
                try {
                    // Read the bin (the one door RLS leaves), keep only rows
                    // deleted more than 90 days ago, and erase each through
                    // purgeTrashRow so storage is freed before the row goes.
                    const rows = await api('/rpc/ent_deleted_reports', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ p_limit: 2000 })
                    });
                    const cutoff = Date.now() - 90 * 86400000;
                    const old = (Array.isArray(rows) ? rows : []).filter(function (r) {
                        const t = Date.parse(r.deleted_at || '');
                        return t && t <= cutoff;
                    });
                    if (!old.length) {
                        toast('Nothing in the bin is older than 90 days.');
                        return;
                    }
                    let done = 0;
                    for (const r of old) {
                        try { await purgeTrashRow(r.id, null); done++; }
                        catch (e) { console.warn('empty-bin skip ' + r.id, e); }
                    }
                    toast('Emptied ' + done + ' old record(s).');
                    await loadTrash();
                } catch (e) {
                    toast('Could not empty the bin: ' + ((e && e.message) || e), true);
                } finally {
                    emptyTrash.disabled = false;
                    emptyTrash.textContent = '🗑 Empty old bin';
                }
            });
        }
        // Delegated on the LIST, which renderTrash() replaces wholesale - a
        // listener on the button would work once and then stop silently.
        const trashList = byId('trashList');
        if (trashList) {
            trashList.addEventListener('click', function (e) {
                const btn = (e.target && e.target.closest)
                    ? e.target.closest('[data-trash-action]') : null;
                if (!btn) return;
                const row = btn.closest('[data-trash-id]');
                if (!row) return;
                const id = row.getAttribute('data-trash-id');
                const action = btn.getAttribute('data-trash-action');
                if (action === 'restore') {
                    restoreTrashRow(id, btn);
                    return;
                }
                if (action !== 'purge') return;
                // Two-step arming. "Delete forever" is the one irreversible
                // action in this console, and a double-travel misclick must
                // not be able to reach it: the first click only changes the
                // button into its own warning, the second performs the erase.
                // The arm disarms itself after four seconds so a button left
                // armed cannot surprise anybody later.
                if (btn.getAttribute('data-armed') !== '1') {
                    btn.setAttribute('data-armed', '1');
                    btn.textContent = '⚠ Click again to erase';
                    setTimeout(function () {
                        if (btn.getAttribute('data-armed') === '1') {
                            btn.removeAttribute('data-armed');
                            btn.textContent = '🗑 Delete forever';
                        }
                    }, 4000);
                    return;
                }
                purgeTrashRow(id, btn);
            });
        }

        // ---- tickets panel ----
        byId('ticketSearch').addEventListener('input', renderAdminTickets);
        const ticketSearchClear = byId('ticketSearchClear');
        if (ticketSearchClear) {
            ticketSearchClear.addEventListener('click', function () {
                const search = byId('ticketSearch');
                if (!search) return;
                search.value = '';
                renderAdminTickets();
                search.focus();
            });
        }
        byId('ticketStatusFilter').addEventListener('change', renderAdminTickets);
        byId('ticketScopeFilter').addEventListener('change', renderAdminTickets);
        byId('refreshTicketsBtn').addEventListener('click', function () {
            loadAdminTickets().catch(function (e) { ticketSay(String((e && e.message) || e).slice(0, 160), true); });
        });
        byId('adminTicketList').addEventListener('click', function (e) {
            const btn = e.target.closest('.ent-admin-ticket');
            if (!btn) return;
            openAdminTicket(btn.getAttribute('data-id'));
        });
        // ---- settings ----
        byId('refreshSettingsBtn').addEventListener('click', function () {
            loadSettings().catch(function (e) { settingsSay(String((e && e.message) || e).slice(0, 160), true); });
        });
        byId('saveClinicNameBtn').addEventListener('click', saveClinicName);
        byId('clinicNameInput').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); saveClinicName(); }
        });
        byId('flagList').addEventListener('change', function (e) {
            const box = e.target;
            if (!box || box.type !== 'checkbox' || !box.dataset.flag) return;
            // Move the pill and the row tint with the checkbox straight away,
            // so the switch answers the finger before the server replies.
            const row = box.closest('.ent-flag-row');
            if (row) {
                row.classList.toggle('is-on', box.checked);
                const state = row.querySelector('.ent-flag-state');
                if (state) state.textContent = box.checked ? 'On' : 'Off';
            }
            toggleFlag(box.dataset.flag, box.checked);
        });
        document.addEventListener('visibilitychange', function () { if (!document.hidden) liveTick(); });

        byId('addUserBtn').addEventListener('click', function () { openUserModal(null); });
        byId('userModalCancel').addEventListener('click', closeUserModal);
        byId('userModalSave').addEventListener('click', saveUser);
        byId('fRole').addEventListener('change', syncRoleFields);
        // 0037: changing the PRIMARY doctor re-fills the "Also works at"
        // options so the new primary is excluded from the extra list.
        byId('fAssigned').addEventListener('change', populateExtraDoctors);
        byId('fExtraDoctorsToggle').addEventListener('click', function () {
            const sel = byId('fExtraDoctors');
            if (!sel) return;
            const opts = Array.prototype.filter.call(sel.options || [], function (option) {
                return option && option.value && !option.disabled;
            });
            const selectAll = opts.some(function (option) { return !option.selected; });
            opts.forEach(function (option) { option.selected = selectAll; });
            syncExtraDoctorsToggle();
        });
        byId('userModal').addEventListener('click', function (e) {
            if (e.target === byId('userModal')) closeUserModal();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && byId('userModal').classList.contains('open')) closeUserModal();
        });

        byId('usersGrid').addEventListener('click', function (e) {
            const btn = e.target.closest('button[data-act]');
            if (!btn) return;
            const card = btn.closest('[data-id]');
            if (!card) return;
            const user = users.find(u => u.id === card.dataset.id);
            if (!user) return;
            if (btn.dataset.act === 'edit') openUserModal(user);
            else if (btn.dataset.act === 'password') openUserModal(user, true);
            else if (btn.dataset.act === 'toggle') toggleActive(user);
            if (btn.dataset.act === 'delete') {
                if (user && user.id === me.id) {
                    toast('You cannot delete your own account.', true);
                } else {
                    confirmDeleteUser(user);
                }
            }
        });

        byId('sessionsTable').addEventListener('click', function (e) {
            const btn = e.target.closest('button[data-act="revoke"]');
            if (!btn) return;
            const row = btn.closest('tr[data-id]');
            const row_ = sessions.find(s => s.id === row.dataset.id);
            if (row_) revokeSession(row_);
        });
    }

    /* ================================================================
       CLINIC GROWTH + DATABASE USAGE  (Clinics & growth / Database tabs)
       ================================================================ */
    const LABEL_KEY = 'ent_admin_clinic_labels_v1';
    const PAGE_SIZE = 1000;          // Supabase REST paging cap
    const MAX_PAGES = 25;            // ... and the hard stop (25 000 rows)
    const HISTORY_DAYS = 400;        // how far back we pull record counts
    const PALETTE = ['#0ea5e9', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444',
        '#06b6d4', '#ec4899', '#84cc16'];

    const FREE_DB = 500 * 1024 * 1024;
    const FREE_STORAGE = 1024 * 1024 * 1024;
    const FREE_MAU = 50000;
    const FREE_EGRESS = 5 * 1024 * 1024 * 1024;

    let buckets = [];            // {clinic, doctor, by, type, day:'YYYY-MM-DD', n}
    let bucketSource = '';       // 'rpc' | 'rest'
    let bucketTruncated = false;
    let bucketError = '';
    let usage = null;
    let usageError = '';
    let labels = readLabels();
    // clinics.code, keyed by id. Kept apart from `labels` (the name) because a
    // local RENAME must win for the name without the code being able to
    // shadowed by it, and because the code is never renamed.
    let clinicCodes = {};
    // clinics.is_active, keyed by id. FALSE means the row was retired from
    // the SQL console (the app has no UPDATE policy on clinics - 0008 - so
    // this can only ever come from outside). See clinicVisible().
    let clinicActive = {};
    let growthMode = 'day';
    let currentPanel = 'overview';   // which tab is showing (skip idle work)

    /* ------------------------------ labels --------------------------- */
    function readLabels() {
        try { return JSON.parse(localStorage.getItem(LABEL_KEY) || '{}') || {}; }
        catch (e) { return {}; }
    }
    function saveLabels() {
        try { localStorage.setItem(LABEL_KEY, JSON.stringify(labels)); } catch (e) { /* ignore */ }
    }
    function clinicLabel(id) {
        const clean = id || 'main_clinic';
        if (labels[clean]) return labels[clean];
        const nice = String(clean)
            .replace(/[_-]+/g, ' ')
            .replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); })
            .trim();
        return nice || 'Main clinic';
    }
    function clinicColor(id) {
        const s = String(id || '');
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 9973;
        return PALETTE[h % PALETTE.length];
    }

    /* ------------------------------- dates --------------------------- */
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function dayKey(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }
    function parseDayKey(key) {
        const p = String(key || '').split('-');
        const d = new Date(Number(p[0]), (Number(p[1]) || 1) - 1, Number(p[2]) || 1);
        return isNaN(d.getTime()) ? null : d;
    }
    function addDays(date, n) {
        const d = new Date(date.getTime());
        d.setDate(d.getDate() + n);
        return d;
    }
    function weekStartOf(date) {          // Monday-based
        const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        return addDays(d, -(((d.getDay() + 6) % 7)));
    }
    function monthKeyOf(date) { return date.getFullYear() + '-' + pad2(date.getMonth() + 1); }
    function viewerTz() {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
        catch (e) { return 'UTC'; }
    }
    function setText(id, value) {
        const el = byId(id);
        if (el) el.textContent = value;
    }
    function fmtBytes(bytes) {
        const n = Number(bytes);
        if (!isFinite(n) || n < 0) return '\u2014';
        if (n < 1024) return n + ' B';
        if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
        if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
        return (n / 1073741824).toFixed(2) + ' GB';
    }
    function fmtNum(n) { return (Number(n) || 0).toLocaleString(); }
    function dayLabel(key) {
        const d = parseDayKey(key);
        return d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '\u2014';
    }

    /* --------------------------- data loading ------------------------ */
    async function loadBuckets(force) {
        if (buckets.length && !force) return buckets;
        try {
            // PostgREST exposes SQL functions under /rpc/<name>; a POST with
            // a JSON body is the only form that reliably reaches them.
            const rows = await api('rpc/admin_record_activity',
                body('POST', { p_days: HISTORY_DAYS, p_tz: viewerTz() }));
            buckets = (Array.isArray(rows) ? rows : []).map(function (r) {
                return {
                    clinic: r.clinic_id || 'main_clinic',
                    doctor: r.doctor_id || '',
                    by: r.created_by || '',
                    type: r.report_type || 'other',
                    day: String(r.day || '').slice(0, 10),
                    n: Number(r.n) || 0
                };
            });
            bucketSource = 'rpc';
            bucketTruncated = false;
            bucketError = '';
            return buckets;
        } catch (rpcError) {
            buckets = await loadBucketsViaRest();
            bucketSource = 'rest';
            bucketError = (rpcError && rpcError.message) || String(rpcError);
            return buckets;
        }
    }

    // Fallback when admin_record_activity() is unavailable: page through
    // reports asking only for the small columns. No clinic filter â€” RLS
    // scopes this to the caller's own clinic, and an admin only ever sees
    // their own because the policy says so.
    async function loadBucketsViaRest() {
        const since = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString();
        const merged = new Map();
        let pages = 0;
        for (let page = 0; page < MAX_PAGES; page++) {
            const from = page * PAGE_SIZE;
            const rows = await api('reports?select=clinic_id,doctor_id,created_by,report_type,created_at'
                + '&created_at=gte.' + encodeURIComponent(since)
                + '&order=created_at.desc&limit=' + PAGE_SIZE + '&offset=' + from);
            if (!Array.isArray(rows) || !rows.length) break;
            pages++;
            rows.forEach(function (r) {
                const when = new Date(r.created_at);
                const item = {
                    clinic: r.clinic_id || 'main_clinic',
                    doctor: r.doctor_id || '',
                    by: r.created_by || '',
                    type: r.report_type || 'other',
                    day: isNaN(when.getTime()) ? dayKey(new Date()) : dayKey(when),
                    n: 1
                };
                const key = [item.clinic, item.doctor, item.by, item.type, item.day].join('|');
                const hit = merged.get(key);
                if (hit) hit.n += 1; else merged.set(key, item);
            });
            if (rows.length < PAGE_SIZE) break;
        }
        bucketTruncated = pages >= MAX_PAGES;
        return Array.from(merged.values());
    }

    /* ------------------- latest patients records --------------------- */
    /* Newest report rows, one block per clinic, for the Overview card.
     *
     * Deliberately NOT built from `buckets`: those are COUNTS per clinic/day
     * and cannot answer the three questions this card exists for - WHICH
     * patient, at WHICH hospital (payload.site, tagged by DB Records from the
     * device's letterhead), filed by WHICH secretary or doctor
     * (created_by_name, stamped beside the uuid by 0028).
     *
     * Same three-tier select as dbRecords.js and dashboard.js: ask for the
     * author's name, drop it for a database that has not run 0028, then drop
     * the hospital tag as well. A missing column must degrade this card,
     * never the console. */
    const LATEST_DAYS = 30;             // window the card reads
    const LATEST_LIMIT = 40;            // newest N rows fetched
    const LATEST_ROWS_PER_CLINIC = 5;   // newest N drawn per clinic
    const LATEST_MIN_AGE_MS = 45000;    // coalesce the 60s analytics ticks
    const LATEST_TYPES = {
        nasal: 'Nasal Endoscopy',
        laryngeal: 'Laryngeal Endoscopy',
        cf4: 'CF4 Claim Form'
    };
    const LATEST_SITES = {
        RMCI: 'Rever Medical Center Inc.',
        CUMC: 'Capitol University Medical Center'
    };

    let latestRows = [];
    let latestError = '';
    let latestBusy = false;
    let latestAt = 0;

    async function loadLatestPatients(force) {
        if (latestBusy) return;
        if (!force && latestRows.length && Date.now() - latestAt < LATEST_MIN_AGE_MS) return;
        latestBusy = true;
        const since = new Date(Date.now() - LATEST_DAYS * 86400000).toISOString();
        const base = 'id,clinic_id,doctor_id,created_by,report_type,patient_name,'
            + 'patient_id,procedure_date,file_name,created_at,updated_at';
        const query = function (extra) {
            return 'reports?is_draft=eq.false&created_at=gte.' + encodeURIComponent(since)
                + '&select=' + base + extra + '&order=created_at.desc&limit=' + LATEST_LIMIT;
        };
        try {
            let rows;
            try {
                rows = await api(query(',created_by_name,payload->>site'));
            } catch (e) {
                try {
                    rows = await api(query(',payload->>site'));
                } catch (e2) {
                    rows = await api(query(''));
                }
            }
            latestRows = Array.isArray(rows) ? rows : [];
            latestError = '';
        } catch (error) {
            latestError = (error && error.message) || String(error);
        }
        latestBusy = false;
        latestAt = Date.now();
        renderLatestPatients();
    }

    // The periodic path. renderOverviewStats() runs on every analytics tick
    // (and on the initial load), so the card keeps up without adding a fourth
    // fetch to analyticsTick itself - a body the test suite evaluates
    // directly with a fixed set of stubs.
    function maybeRefreshLatestPatients() {
        if (latestBusy) return;
        if (latestRows.length && Date.now() - latestAt < LATEST_MIN_AGE_MS) return;
        loadLatestPatients().catch(function () { /* keep the last picture */ });
    }

    // The hospital this record belongs to. PostgREST names a JSON-extracted
    // field after its LAST key, so select=payload->>site answers `site`.
    function latestSite(row) {
        if (!row) return '';
        const raw = String(
            row.site !== undefined ? row.site
                : row['payload->>site'] !== undefined ? row['payload->>site']
                    : (row.payload && typeof row.payload === 'object') ? row.payload.site
                        : ''
        ).trim().toUpperCase();
        return LATEST_SITES[raw] ? raw : '';
    }
    function latestSiteChip(row) {
        const site = latestSite(row);
        if (!site) return '';
        return '<span class="ent-latest-site is-' + site.toLowerCase()
            + '" title="' + esc(LATEST_SITES[site]) + '">' + site + '</span>';
    }

    /* WHO saved it. created_by is a server-stamped uuid and the browser
     * cannot resolve it on its own, so the display name rides beside it in
     * created_by_name (0028). `users` is the second source and the only one
     * that knows the ROLE - which is the point of this card: an admin wants
     * "Secretary Tara Bautista", not a name with no idea who that is. A bare
     * uuid never prints. */
    function latestAuthor(row) {
        const raw = String((row && row.created_by) || '').trim();
        const hit = raw ? users.find(function (u) { return u && String(u.id) === raw; }) : null;
        const role = hit
            ? (hit.role === 'doctor' ? 'Doctor'
                : hit.role === 'secretary' ? 'Secretary' : '')
            : '';
        const stamped = String((row && row.created_by_name) || '').trim();
        if (stamped) return { name: prettyName(stamped), role: role };
        if (hit) return { name: displayName(hit), role: role };
        if (!raw) return { name: 'Someone', role: '' };
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
            return { name: 'Unknown user', role: role };
        }
        return { name: prettyName(raw), role: role };   // a v1 username row
    }

    // "3:42 PM" today, "Oct 6, 12:00 PM" otherwise - a time with no day is a
    // lie about recency the moment the date rolls over.
    function latestWhen(iso) {
        const ms = Date.parse(String(iso || ''));
        if (isNaN(ms)) return '';
        const d = new Date(ms);
        const now = new Date();
        const clock = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        const sameDay = d.getFullYear() === now.getFullYear()
            && d.getMonth() === now.getMonth()
            && d.getDate() === now.getDate();
        return sameDay
            ? clock
            : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + clock;
    }

    function latestRowHtml(row) {
        const who = latestAuthor(row);
        const type = LATEST_TYPES[row.report_type] || 'Other report';
        const meta = type + (row.procedure_date ? ' \u00b7 ' + row.procedure_date : '');
        const when = latestWhen(row.updated_at || row.created_at);
        const patient = String(row.patient_name || '').trim()
            || String(row.file_name || '').trim()
            || 'Untitled record';
        return '<div class="ent-latest-row">'
            + '<span class="ent-latest-main">'
            + '<span class="ent-latest-name">' + esc(patient) + '</span>'
            + '<span class="ent-latest-meta">' + esc(meta) + '</span>'
            + '</span>'
            + latestSiteChip(row)
            + '<span class="ent-latest-by">'
            + (who.role ? esc(who.role) + ' ' : '')
            + '<b>saved by ' + esc(who.name) + '</b></span>'
            + (when ? '<span class="ent-latest-time">' + esc(when) + '</span>' : '')
            + '</div>';
    }

    function renderLatestPatients() {
        const box = byId('latestPatients');
        if (!box) return;
        const hint = byId('latestPatientsHint');
        if (hint && !latestError) {
            hint.textContent = 'Newest first \u00b7 last ' + LATEST_DAYS
                + ' days \u00b7 grouped by clinic';
        }
        if (!latestRows.length) {
            box.innerHTML = '<div class="ent-empty">'
                + (latestError
                    ? 'Could not read the latest records: ' + esc(latestError)
                    : 'No records saved in the last ' + LATEST_DAYS + ' days yet.')
                + '</div>';
            return;
        }
        // Rows arrive newest first, so the first row seen for a clinic is
        // that clinic's newest patient - and the first clinic seen is the
        // one with the freshest record overall.
        const order = [];
        const byClinic = new Map();
        latestRows.forEach(function (row) {
            const id = String(row.clinic_id || '').trim() || 'main_clinic';
            if (!byClinic.has(id)) { byClinic.set(id, []); order.push(id); }
            byClinic.get(id).push(row);
        });
        box.innerHTML = order.map(function (id) {
            const members = byClinic.get(id);
            const newest = members[0];
            const shown = members.slice(0, LATEST_ROWS_PER_CLINIC);
            const headWhen = latestWhen(newest.updated_at || newest.created_at);
            const hidden = members.length - shown.length;
            return '<div class="ent-latest-clinic">'
                + '<div class="ent-latest-head">'
                + '<b title="' + esc(id) + '">' + esc(clinicLabel(id)) + '</b>'
                + '<span class="ent-latest-n">' + members.length
                + ' record' + (members.length === 1 ? '' : 's') + '</span>'
                + latestSiteChip(newest)
                + (headWhen ? '<span class="ent-latest-when">last ' + esc(headWhen) + '</span>' : '')
                + '</div>'
                + shown.map(latestRowHtml).join('')
                + (hidden > 0
                    ? '<div class="ent-latest-more">+ ' + hidden + ' older record'
                        + (hidden === 1 ? '' : 's') + ' in this clinic</div>'
                    : '')
                + '</div>';
        }).join('');
    }

    /* ------------------------- follow-ups (clinic-wide) ---------------- */
    /* THE ADMIN'S FOLLOW-UP TRACKER.
     *
     * The dashboard card is the personal reminder (a doctor's own patients);
     * this is the clinic-wide view an admin needs: "who across the whole
     * clinic is due or overdue for a follow-up visit, and under which
     * doctor?". It reads the SAME payload.followUpDate field the save dialog
     * writes - no migration, no new column - through the same three-tier
     * select the latest-patients card uses, so a database that predates the
     * feature simply shows an empty card instead of an error.
     *
     * Its own loader rather than a filter on latestRows, because the window is
     * deliberately wider (a follow-up promised three weeks ago must still
     * appear even though the latest card only reads 30 days of SAVES). */
    const FOLLOWUP_DAYS = 120;           // how far back to look for follow-ups
    const FOLLOWUP_LIMIT = 200;          // cap on rows fetched
    const FOLLOWUP_PREVIEW = 8;          // rows drawn before "+N more"
    let followUpRows = [];
    let followUpError = '';

    function followUpDateOf(row) {
        if (!row) return '';
        const raw = String(
            row.followUpDate !== undefined ? row.followUpDate
                : row['payload->>followUpDate'] !== undefined ? row['payload->>followUpDate']
                    : (row.payload && typeof row.payload === 'object') ? row.payload.followUpDate
                        : ''
        ).trim();
        return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
    }
    function followUpDelta(dateStr) {
        const parts = dateStr.split('-').map(Number);
        const then = new Date(parts[0], parts[1] - 1, parts[2]);
        if (isNaN(then.getTime())) return null;
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        return Math.round((then - today) / 86400000);
    }
    function followUpBadgeFor(days) {
        if (days === null) return { cls: '', label: '' };
        if (days < 0) return { cls: 'is-overdue', label: Math.abs(days) + (Math.abs(days) === 1 ? ' day overdue' : ' days overdue') };
        if (days === 0) return { cls: 'is-today', label: 'Today' };
        if (days === 1) return { cls: 'is-soon', label: 'Tomorrow' };
        if (days <= 7) return { cls: 'is-soon', label: 'In ' + days + ' days' };
        if (days <= 30) return { cls: 'is-future', label: 'In ' + days + ' days' };
        return { cls: 'is-future', label: 'In ' + Math.round(days / 30) + ' month' + (days >= 60 ? 's' : '') };
    }

    async function loadFollowUps() {
        const since = new Date(Date.now() - FOLLOWUP_DAYS * 86400000).toISOString();
        const base = 'clinic_id,patient_name,procedure_date,report_type';
        const query = function (extra) {
            return 'reports?is_draft=eq.false&created_at=gte.' + encodeURIComponent(since)
                + '&select=' + base + extra + '&order=created_at.desc&limit=' + FOLLOWUP_LIMIT;
        };
        try {
            let raw;
            try {
                raw = await api(query(',payload->>followUpDate'));
            } catch (e) {
                // No followUpDate reachable (older shape) - the card is empty,
                // the console is not. Fall through with an honest empty list.
                raw = [];
            }
            followUpRows = (Array.isArray(raw) ? raw : []).map(function (row) {
                const d = followUpDateOf(row);
                const days = d ? followUpDelta(d) : null;
                return { row: row, date: d, days: days, state: followUpBadgeFor(days) };
            }).filter(function (f) {
                return f.date && f.days !== null && f.days >= -90 && f.days <= 365;
            }).sort(function (a, b) { return a.days - b.days; });
            followUpError = '';
        } catch (error) {
            followUpRows = [];
            followUpError = (error && error.message) || String(error);
        }
        renderFollowUps();
    }

    function renderFollowUps() {
        const box = byId('adminFollowUp');
        if (!box) return;
        const hint = byId('followUpHint');
        const list = followUpRows;
        const due = list.filter(function (f) { return f.days <= 0; });
        const today = list.filter(function (f) { return f.days === 0; });
        if (hint) {
            hint.textContent = followUpError
                ? 'Could not read follow-ups'
                : (due.length
                    ? today.length + ' due today &middot; ' + (due.length - today.length) + ' overdue &middot; ' + list.length + ' upcoming'
                    : (list.length ? list.length + ' upcoming &middot; none due' : 'No follow-ups set'));
        }
        if (followUpError) {
            box.innerHTML = '<div class="ent-empty">Could not read follow-ups: ' + esc(followUpError) + '</div>';
            return;
        }
        if (!list.length) {
            box.innerHTML = '<div class="ent-empty">No patient has a follow-up date yet. '
                + 'They appear here once a report is saved with one.</div>';
            return;
        }
        const preview = list.slice(0, FOLLOWUP_PREVIEW);
        const hidden = list.length - preview.length;
        box.innerHTML = preview.map(function (f) {
            const label = followUpTypeLabel(f.row.report_type);
            return '<div class="ent-followup-row ' + f.state.cls + '">'
                + '<span class="ent-followup-date">' + esc(f.date) + '</span>'
                + '<span class="ent-followup-main"><span class="ent-followup-name">'
                + esc(prettyName(f.row.patient_name) || 'Untitled record') + '</span>'
                + '<span class="ent-followup-meta">' + esc(label)
                + (f.row.procedure_date ? ' &middot; seen ' + esc(f.row.procedure_date) : '')
                + ' &middot; ' + esc(clinicLabel(f.row.clinic_id)) + '</span></span>'
                + '<span class="ent-followup-state">' + esc(f.state.label) + '</span>'
                + '</div>';
        }).join('')
            + (hidden > 0
                ? '<p class="ent-queue-subempty">+' + hidden + ' more follow-up' + (hidden === 1 ? '' : 's') + ' further out</p>'
                : '');
    }
    function followUpTypeLabel(t) {
        return LATEST_TYPES[t] || t || 'Report';
    }

    /* ------------------------------------------------------------------
     * POSSIBLE DUPLICATES (0041) - a READ-ONLY review list.
     * ent_possible_duplicates() groups live final rows the CALLER can
     * already see (SECURITY INVOKER - RLS decides, nothing is bypassed)
     * by normalised name + date + type + shelf. A NAME is not a patient
     * identifier, so this card never merges and never deletes: it names
     * the groups and a human decides. An empty list is the healthy,
     * expected answer - the patient-ID duplicates are prevented
     * automatically by 0041's unique indexes before they ever exist.
     * ------------------------------------------------------------------ */
    let dupGroups = null;
    let dupError = '';
    async function loadDuplicates(force) {
        if (dupGroups && !force) return;
        try {
            const raw = await api('rpc/ent_possible_duplicates', body('POST', {}));
            dupGroups = Array.isArray(raw) ? raw : [];
            dupError = '';
        } catch (error) {
            dupGroups = [];
            dupError = (error && error.message) || String(error);
        }
        renderDuplicates();
    }

    function renderDuplicates() {
        const box = byId('adminDuplicates');
        if (!box) return;
        const hint = byId('dupHint');
        const groups = dupGroups || [];
        if (hint) {
            hint.textContent = dupError
                ? 'Could not read the review list'
                : (groups.length
                    ? groups.length + ' group' + (groups.length === 1 ? '' : 's') + ' to review'
                    : 'None found');
        }
        if (dupError) {
            box.innerHTML = '<div class="ent-empty">Could not read possible duplicates: ' + esc(dupError) + '</div>';
            return;
        }
        if (!groups.length) {
            box.innerHTML = '<div class="ent-empty">No potential duplicates. Rows only appear here when the '
                + 'same normalised patient name, date and report type exist twice on one shelf. '
                + 'Patient-ID duplicates are blocked automatically; a NAME match is for human eyes only.</div>';
            return;
        }
        box.innerHTML = groups.slice(0, 20).map(function (g) {
            const names = (Array.isArray(g.name_variants) ? g.name_variants : [])
                .filter(Boolean).join(' / ');
            const label = followUpTypeLabel(g.report_type);
            const when = g.procedure_date ? esc(g.procedure_date) : 'no date';
            const count = Number(g.row_count) || 0;
            return '<div class="ent-followup-row">'
                + '<span class="ent-followup-date">' + count + '&times;</span>'
                + '<span class="ent-followup-main"><span class="ent-followup-name">'
                + esc(names || 'Unnamed patient') + '</span>'
                + '<span class="ent-followup-meta">' + esc(label) + ' &middot; ' + when
                + ' &middot; ' + esc(clinicLabel(g.clinic_id)) + '</span></span>'
                + '<span class="ent-followup-state">review</span>'
                + '</div>';
        }).join('')
            + (groups.length > 20
                ? '<p class="ent-queue-subempty">+' + (groups.length - 20) + ' more groups</p>'
                : '')
            + '<p class="ent-queue-subempty">Read-only list - nothing is merged or deleted from here.</p>';
    }

    async function loadUsage(force) {
        if (usage && !force) return usage;
        try {
            const raw = await api('rpc/admin_db_usage', body('POST', {}));
            if (!raw || typeof raw !== 'object') throw new Error('Empty usage payload.');
            usage = raw;
            usage.exact = raw.exact !== false;
            usageError = '';
        } catch (error) {
            usageError = (error && error.message) || String(error);
            usage = await estimateUsage();
        }
        renderDatabase();
        renderOverviewStats();
        return usage;
    }

    // No RPC available -> count the rows already held and sample a few
    // metadata payloads to guess the average row size.
    //
    // HOW OFTEN THIS RUNS (2026-10-03, measured)
    //
    // Once per console load, plus once per "Refresh usage meters" click.
    // It is NOT on the 60s analytics poll: loadUsage() is called from boot()
    // and from that refresh button only, and renderDatabase() - which the
    // analytics tick DOES call every 60s - reads the cached `usage` object
    // without refetching. An earlier audit claimed this ran every 60s and
    // cost 16.6 MB/hour; that was wrong by a factor of ~58. It is ~284 KB
    // per console load.
    //
    // WHY THE SAMPLE IS 5 AND NOT 60
    //
    // This is an AVERAGE that renders one number - "Estimated: N records x
    // avg row size" - already labelled exact:false. It is not an audit, not
    // a report, and nothing depends on the sample representing all rows;
    // 60 rows over a table of a few dozen is not a meaningful sample of
    // "every report" either. Five rows average the same payload shapes just
    // as well for a rounded byte estimate.
    //
    // Measured live: limit=60 -> 284.0 KB, limit=5 -> 1.4 KB. A 200x cut on
    // the same call, with the same displayed meaning.
    //
    // Deliberately still a SNAPSHOT taken when this runs, not a value cached
    // forever: the refresh button must still produce fresh numbers, or it
    // would be lying about what "Refresh" means. Memoising across clicks
    // would save the same 1.4 KB and would break the button.
    const USAGE_SAMPLE_ROWS = 5;

    async function estimateUsage() {
        let avg = 3072;
        try {
            const sample = await api('reports?select=payload&limit=' + USAGE_SAMPLE_ROWS);
            if (Array.isArray(sample) && sample.length) {
                // Averaged over the rows ACTUALLY returned, never over
                // USAGE_SAMPLE_ROWS. With 1 report the divisor must be 1;
                // dividing by the constant would report a fifth of the real
                // row size and under-report the estimate by 80%.
                const bytes = sample.reduce(function (sum, row) {
                    return sum + JSON.stringify((row && row.payload) || {}).length + 240;
                }, 0);
                avg = Math.max(256, Math.round(bytes / sample.length));
            }
        } catch (e) { /* keep the flat estimate */ }
        const rows = buckets.reduce(function (sum, b) { return sum + b.n; }, 0);
        return {
            exact: false,
            db_bytes: null,
            app_bytes: rows * avg,
            app_rows: rows,
            avg_row_bytes: avg,
            tables: [],
            storage_bytes: null,
            storage_files: null,
            mau: null,
            auth_users: null,
            db_limit_bytes: FREE_DB,
            storage_limit_bytes: FREE_STORAGE,
            mau_limit: FREE_MAU,
            egress_limit_bytes: FREE_EGRESS
        };
    }

    /* ---------------------------- aggregates ------------------------- */
    /* Every clinic id this console can NAME.
     *
     * The union itself is unchanged - "clinics that hold records" plus
     * "every row in clinics" - because a few readers (the activity filter's
     * dropdown) still need to name a clinic that no longer appears on
     * screen. What changed is who consumes it: see clinicIds() below for
     * the visible subset. */
    function allClinicIds() {
        const set = new Set();
        buckets.forEach(function (b) { set.add(b.clinic); });
        Object.keys(labels).forEach(function (k) { set.add(k); });
        return Array.from(set).sort();
    }

    /* Is this clinic one the console should DRAW?
     *
     * An administrator once saw TEN clinic cards for FOUR working doctors:
     * a test account's auto-created clinic, two retired doctors' clinics
     * and a doctor-less shell all counted the same as his own, because
     * clinicIds() was a plain union with no opinion about any of it. The
     * directory hid clinics whose doctors were all deactivated; the
     * snapshot, the cards, the table, the CSV export and the "Clinics" stat
     * did not - so two panels of the same page disagreed about how many
     * clinics exist.
     *
     * The rule is recomputed on EVERY render and nothing is stored, which
     * is what makes it self-maintaining: deactivate a doctor and his clinic
     * leaves the list; reactivate him and it comes straight back - the same
     * promise the directory's own rule already made.
     *
     *   1. clinics.is_active = FALSE means the row was retired on purpose
     *      from the SQL console. The app cannot write that column (0008
     *      has no UPDATE policy on clinics), so it only ever arrives from
     *      outside, and it outranks everything below.
     *   2. a clinic that HOLDS RECORDS is always drawn. Those rows belong
     *      to it; hiding the card would make its patients vanish from the
     *      overview while still counting in the totals - the exact split
     *      brain the stat line must never have.
     *   3. a clinic WITH doctors is drawn while at least ONE of them is
     *      active - the narrow test the directory has always used.
     *   4. a clinic with no doctor at all is drawn when it has an active
     *      member: the shared ones (an administrator's own clinic, a
     *      secretary-only one) must not disappear with the doctors.
     *   5. everything else - the empty shells - is simply not drawn. */
    function clinicVisible(id) {
        if (clinicActive[id] === false) return false;
        if (buckets.some(function (b) { return b.clinic === id; })) return true;
        const docs = users.filter(function (u) {
            return u && u.role === 'doctor' && clinicOfUser(u) === id;
        });
        if (docs.length) return docs.some(function (d) { return d.is_active !== false; });
        return users.some(function (u) {
            return u && u.is_active !== false && clinicOfUser(u) === id;
        });
    }

    /* The clinics on screen: every named or record-bearing clinic, minus
     * the retired ones, the empty shells and the clinics whose doctors are
     * all deactivated. */
    function clinicIds() {
        return allClinicIds().filter(clinicVisible);
    }
    function scopeBuckets(clinicId) {
        return clinicId ? buckets.filter(function (b) { return b.clinic === clinicId; }) : buckets;
    }
    function selectedClinic() {
        const sel = byId('clinicFilter');
        return (sel && sel.value) || '';
    }
    // Today / yesterday, this week vs last week, this month vs last month
    function periodTotals(clinicId) {
        const now = new Date();
        const today = dayKey(now);
        const yesterday = dayKey(addDays(now, -1));
        const week = dayKey(weekStartOf(now));
        const prevWeek = dayKey(weekStartOf(addDays(now, -7)));
        const month = monthKeyOf(now);
        const prevMonth = monthKeyOf(new Date(now.getFullYear(), now.getMonth() - 1, 1));
        const out = {
            today: 0, yesterday: 0, week: 0, prevWeek: 0, month: 0, prevMonth: 0,
            total: 0, lastDay: '', days: {}, staff: {}, doctors: {}, types: {}
        };
        scopeBuckets(clinicId).forEach(function (b) {
            if (!b.n) return;
            out.total += b.n;
            out.days[b.day] = (out.days[b.day] || 0) + b.n;
            if (b.day === today) out.today += b.n;
            if (b.day === yesterday) out.yesterday += b.n;
            if (b.day >= week) out.week += b.n;
            else if (b.day >= prevWeek) out.prevWeek += b.n;
            const mk = String(b.day).slice(0, 7);
            if (mk === month) out.month += b.n;
            else if (mk === prevMonth) out.prevMonth += b.n;
            if (b.day > out.lastDay) out.lastDay = b.day;
            if (b.by) out.staff[b.by] = (out.staff[b.by] || 0) + b.n;
            if (b.doctor) out.doctors[b.doctor] = (out.doctors[b.doctor] || 0) + b.n;
            out.types[b.type] = (out.types[b.type] || 0) + b.n;
        });
        return out;
    }
    function trendPill(current, previous) {
        current = Number(current) || 0;
        previous = Number(previous) || 0;
        if (!previous && !current) return '<span class="ent-trend flat">&mdash;</span>';
        if (!previous) return '<span class="ent-trend fresh">&#9650; new</span>';
        const delta = current - previous;
        const pct = Math.abs(Math.round((delta / previous) * 100));
        if (delta > 0) return '<span class="ent-trend up">&#9650; ' + pct + '% (+)' + delta + '</span>';
        if (delta < 0) return '<span class="ent-trend down">&#9660; ' + pct + '% (' + delta + ')</span>';
        return '<span class="ent-trend flat">&#9644; steady</span>';
    }
    function miniCell(label, value, extra) {
        return '<div><span>' + esc(label) + '</span><b>' + fmtNum(value) + '</b>' + (extra || '') + '</div>';
    }
    function sparkline(days) {
        const keys = [];
        for (let i = 13; i >= 0; i--) keys.push(dayKey(addDays(new Date(), -i)));
        let max = 1;
        keys.forEach(function (k) { max = Math.max(max, days[k] || 0); });
        return '<div class="ent-spark">' + keys.map(function (k, i) {
            const v = days[k] || 0;
            return '<i class="' + (i === keys.length - 1 ? 'today' : '') + '"'
                + ' style="height:' + Math.max(2, Math.round((v / max) * 32)) + 'px"'
                + ' title="' + esc(dayLabel(k)) + ': ' + v + ' record' + (v === 1 ? '' : 's') + '"></i>';
        }).join('') + '</div>';
    }

    /* ------------------------------ series --------------------------- */
    function buildSeries(list, mode, count) {
        const now = new Date();
        const out = [];
        if (mode === 'month') {
            for (let i = count - 1; i >= 0; i--) {
                const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                out.push({
                    key: monthKeyOf(d),
                    label: d.toLocaleDateString(undefined, { month: 'short' }),
                    parts: new Map(), total: 0
                });
            }
        } else if (mode === 'week') {
            const first = weekStartOf(addDays(now, -7 * (count - 1)));
            for (let i = 0; i < count; i++) {
                const start = addDays(first, 7 * i);
                out.push({
                    key: dayKey(start),
                    label: (start.getMonth() + 1) + '/' + start.getDate(),
                    parts: new Map(), total: 0
                });
            }
        } else {
            for (let i = count - 1; i >= 0; i--) {
                const d = addDays(now, -i);
                out.push({
                    key: dayKey(d),
                    label: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
                    parts: new Map(), total: 0
                });
            }
        }
        const index = new Map(out.map(function (b) { return [b.key, b]; }));
        list.forEach(function (b) {
            const d = parseDayKey(b.day);
            if (!d) return;
            const key = mode === 'month' ? monthKeyOf(d)
                : mode === 'week' ? dayKey(weekStartOf(d))
                    : b.day;
            const slot = index.get(key);
            if (!slot) return;
            slot.parts.set(b.clinic, (slot.parts.get(b.clinic) || 0) + b.n);
            slot.total += b.n;
        });
        return out;
    }
    function hourlySeries(days) {
        const out = [];
        for (let h = 0; h < 24; h++) {
            out.push({
                key: String(h), label: pad2(h) + ':00',
                tick: (h % 3 === 0) ? pad2(h) + ':00' : '',   // thin the axis
                parts: new Map(), total: 0
            });
        }
        const index = new Map(out.map(function (b) { return [b.key, b]; }));
        const from = dayKey(addDays(new Date(), -(days - 1)));
        activity.forEach(function (a) {
            if (!a || String(a.created_at || '').slice(0, 10) < from) return;
            const d = new Date(a.created_at);
            if (isNaN(d.getTime())) return;
            const slot = index.get(String(d.getHours()));
            if (slot) slot.total += 1;
        });
        return out;
    }
    function renderChart(chartEl, legendEl, series) {
        if (!chartEl) return;
        let max = 1;
        series.forEach(function (s) { max = Math.max(max, s.total); });
        const ids = clinicIds();
        chartEl.innerHTML = series.map(function (s) {
            const segs = [];
            ids.forEach(function (c) {
                const v = s.parts.get(c);
                if (!v) return;
                segs.push('<span class="ent-chart-seg" style="height:'
                    + Math.max(2, Math.round((v / max) * 150)) + 'px;background:' + clinicColor(c)
                    + '" title="' + esc(clinicLabel(c)) + ': ' + v + '"></span>');
            });
            const height = s.total ? Math.max(3, Math.round((s.total / max) * 150)) : 3;
            return '<div class="ent-chart-col" title="' + esc(s.label) + ' \u00b7 ' + s.total + ' records">'
                + '<span class="ent-chart-val">' + (s.total || '') + '</span>'
                + '<div class="ent-chart-stack" style="height:' + height + 'px">'
                + (segs.join('') || '<span class="ent-chart-seg" style="height:100%"></span>')
                + '</div>'
                + '<span class="ent-chart-x">'
                + esc(s.tick === undefined ? s.label : s.tick) + '</span></div>';
        }).join('');
        if (legendEl) {
            const used = ids.filter(function (c) {
                return series.some(function (s) { return s.parts.get(c); });
            });
            legendEl.innerHTML = used.length
                ? used.map(function (c) {
                    return '<span><i style="background:' + clinicColor(c) + '"></i>'
                        + esc(clinicLabel(c)) + '</span>';
                }).join('')
                : '<span>No clinic data inside this window</span>';
        }
    }
    function rangeDays() {
        const sel = byId('growthRange');
        return sel ? (Number(sel.value) || 30) : 30;
    }

    function renderGrowthSummary(series) {
        let total = 0;
        let peak = null;
        const contributing = new Set();
        series.forEach(function (slot) {
            total += slot.total;
            if (!peak || slot.total > peak.total) peak = slot;
            slot.parts.forEach(function (count, clinic) {
                if (count > 0) contributing.add(clinic);
            });
        });
        setText('growthMetricTotal', fmtNum(total));
        setText('growthMetricClinics', fmtNum(contributing.size));
        setText('growthMetricPeak', peak && peak.total ? peak.label : '\u2014');
        setText('growthMetricPeakNote', peak && peak.total
            ? fmtNum(peak.total) + ' records in this interval'
            : 'No records in this interval');
        setText('growthMetricAverage', fmtNum(series.length ? Math.round(total / series.length) : 0));
        setText('growthMetricAverageNote', 'Across ' + fmtNum(series.length) + ' plotted intervals');
    }

    /* ------------------------------ panels --------------------------- */
    function renderGrowth() {
        const days = rangeDays();
        const counts = {
            day: Math.min(days, 45),
            week: Math.max(2, Math.min(Math.ceil(days / 7), 26)),
            month: Math.max(2, Math.min(Math.ceil(days / 30), 13))
        };
        const series = buildSeries(scopeBuckets(selectedClinic()), growthMode,
            counts[growthMode] || 30);
        renderChart(byId('growthChart'), byId('growthLegend'), series);
        renderGrowthSummary(series);
        const shown = series.reduce(function (s, b) { return s + b.total; }, 0);
        const totalAll = buckets.reduce(function (s, b) { return s + b.n; }, 0);
        setText('growthCaption', 'Showing ' + fmtNum(shown) + ' of ' + fmtNum(totalAll)
            + ' records \u00b7 ' + (bucketSource === 'rpc'
                ? 'daily buckets grouped in ' + viewerTz()
                : 'grouped in the browser (fallback mode)'));
        renderHourly();
    }
    // The peak-hour picture comes from activity_logs, not from the record
    // counts, so it is redrawn whenever either feed finishes.
    function renderHourly() {
        setText('hourlyCaption', activity.length
            ? fmtNum(activity.length) + ' logged events analysed \u00b7 peak hours come from the activity log'
            : 'No activity log rows loaded yet \u2014 this fills in as staff work.');
        renderChart(byId('hourlyChart'), null, hourlySeries(30));
    }
    function renderTypeMix() {
        const host = byId('typeMix');
        if (!host) return;
        const from = dayKey(addDays(new Date(), -29));
        const totals = {};
        let sum = 0;
        scopeBuckets(selectedClinic()).forEach(function (b) {
            if (String(b.day) < from || !b.n) return;
            totals[b.type] = (totals[b.type] || 0) + b.n;
            sum += b.n;
        });
        const entries = Object.keys(totals).map(function (k) { return [k, totals[k]]; })
            .sort(function (a, b) { return b[1] - a[1]; });
        if (!entries.length) {
            host.innerHTML = '<div class="ent-empty">No reports saved in the last 30 days.</div>';
            return;
        }
        host.innerHTML = entries.map(function (e) {
            const pct = sum ? Math.round((e[1] / sum) * 100) : 0;
            return '<div class="ent-mix-row"><b>' + esc(e[0]) + '</b>'
                + '<span class="ent-share"><span class="ent-share-bar"><span style="width:'
                + pct + '%"></span></span></span>'
                + '<em>' + fmtNum(e[1]) + ' &middot; ' + pct + '%</em></div>';
        }).join('');
    }
    function renderOverviewStats() {
        // The card sits in this panel and this function runs on every
        // analytics tick, so that is where its refresh is scheduled.
        maybeRefreshLatestPatients();
        const has = buckets.length > 0;
        const all = periodTotals('');
        setText('statRecords', has ? fmtNum(all.today) : '\u2014');
        setText('statWeek', has ? fmtNum(all.week) : '\u2014');
        setText('statMonth', has ? fmtNum(all.month) : '\u2014');
        setText('statTotal', has ? fmtNum(all.total) : '\u2014');
        setText('statClinics', fmtNum(clinicIds().length));
        if (usage) {
            const used = Number(usage.db_bytes) || Number(usage.app_bytes) || 0;
            const limit = Number(usage.db_limit_bytes) || FREE_DB;
            const pct = limit ? (used / limit) * 100 : 0;
            const el = byId('statDb');
            if (el) {
                el.textContent = (pct < 10 ? pct.toFixed(1) : Math.round(pct)) + '%';
                el.title = fmtBytes(used) + ' of ' + fmtBytes(limit)
                    + (usage.exact ? ' (exact)' : ' (estimated)');
            }
        }
    }
    function renderSnapshot() {
        const host = byId('clinicSnapshot');
        if (!host) return;
        const ids = clinicIds();
        if (!ids.length) {
            host.innerHTML = '<div class="ent-empty">Nothing stored yet \u2014 saved reports '
                + 'appear here automatically.</div>';
            return;
        }
        host.innerHTML = ids.map(function (id) {
            const t = periodTotals(id);
            return '<div class="ent-snapshot" style="--accent:' + clinicColor(id) + '">'
                + '<b title="' + esc(id) + '">' + esc(clinicLabel(id)) + '</b>'
                + '<div class="ent-snapshot-n">' + fmtNum(t.today) + '</div>'
                + '<div class="ent-snapshot-foot"><span>today</span>'
                + trendPill(t.today, t.yesterday) + '</div></div>';
        }).join('');
    }
    function renderClinicCards() {
        const host = byId('clinicCards');
        if (!host) return;
        const ids = clinicIds();
        if (!ids.length) {
            host.innerHTML = '<div class="ent-empty">No clinic has saved a report yet. As soon as '
                + 'a device in a clinic saves one, its live counters appear here.</div>';
            return;
        }
        host.innerHTML = ids.map(function (id) {
            const t = periodTotals(id);
            return '<div class="ent-clinic-card" style="--accent:' + clinicColor(id) + '">'
                + '<h4>' + esc(clinicLabel(id)) + '</h4>'
                + '<div class="ent-clinic-sub">' + esc(id) + '</div>'
                + '<div class="ent-clinic-today"><strong>' + fmtNum(t.today) + '</strong>'
                + '<span>records today</span>' + trendPill(t.today, t.yesterday) + '</div>'
                + '<div class="ent-clinic-rows">'
                + miniCell('This week', t.week, trendPill(t.week, t.prevWeek))
                + miniCell('This month', t.month, trendPill(t.month, t.prevMonth))
                + miniCell('Records on file', t.total, '')
                + miniCell('Staff active (13 mo)', Object.keys(t.staff).length, '')
                + '</div>'
                + sparkline(t.days)
                + '<div class="ent-clinic-foot"><span>'
                + (t.lastDay ? 'Last record ' + esc(dayLabel(t.lastDay)) : 'No records yet')
                + '</span><button type="button" class="ent-btn ent-btn-sm" data-act="rename-clinic" '
                + 'data-id="' + esc(id) + '">Rename</button></div>'
                + '</div>';
        }).join('');
    }

    function renderOverviewChart() {
        const series = buildSeries(buckets, 'day', 7);
        renderChart(byId('overviewChart'), null, series);
        const thisWeek = series.reduce(function (s, b) { return s + b.total; }, 0);
        const prev = buildSeries(buckets, 'day', 14).slice(0, 7)
            .reduce(function (s, b) { return s + b.total; }, 0);
        const el = byId('weekTrendHint');
        if (el) el.innerHTML = thisWeek + ' records \u00b7 ' + trendPill(thisWeek, prev)
            + ' vs previous 7 days';
    }
    function renderClinicTable() {
        const bodyEl = byId('clinicTable');
        if (!bodyEl) return;
        const ids = clinicIds();
        if (!ids.length) {
            bodyEl.innerHTML = '<tr><td colspan="7" class="ent-empty">No clinic has saved a record yet.</td></tr>';
            return;
        }
        const rows = ids.map(function (id) { return { id: id, t: periodTotals(id) }; })
            .sort(function (a, b) { return (b.t.month - a.t.month) || (b.t.total - a.t.total); });
        bodyEl.innerHTML = rows.map(function (r) {
            const t = r.t;
            return '<tr>'
                + '<td data-label="Clinic"><strong>' + esc(clinicLabel(r.id)) + '</strong>'
                + '<div class="ent-hint">' + esc(r.id) + '</div></td>'
                + '<td class="ent-num" data-label="Today">' + fmtNum(t.today) + '</td>'
                + '<td class="ent-num" data-label="This week">' + fmtNum(t.week) + '</td>'
                + '<td class="ent-num" data-label="This month">' + fmtNum(t.month) + '</td>'
                + '<td class="ent-num" data-label="All records">' + fmtNum(t.total) + '</td>'
                + '<td class="ent-num" data-label="Staff active">' + Object.keys(t.staff).length + '</td>'
                + '<td data-label="Last record">' + (t.lastDay ? esc(t.lastDay) : '\u2014') + '</td></tr>';
        }).join('');
    }

    function userByName(name) {
        const needle = String(name || '').toLowerCase();
        if (!needle) return null;
        return users.find(function (u) {
            return String(u.username || '').toLowerCase() === needle;
        }) || null;
    }
    /* ------------------------- clinics directory ------------------------ */
    // Clinic -> doctors -> the secretaries linked to each doctor.
    function initialsOf(name) {
        return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2)
            .map(function (part) { return part[0].toUpperCase(); }).join('') || '?';
    }
    // The uuid, shortened. Two seeded clinics share the "00000000" prefix, so a
    // truncated id is not reliably distinguishable - the code is preferred and
    // this is only the fallback for a clinic that somehow has neither.
    function shortIdFallback(id) {
        return String(id).length > 12 ? String(id).slice(0, 8) + '\u2026' : String(id);
    }

    // clinics.code is the stable, human-readable handle ("ent-josh",
    // "main_clinic"). With one auto-named clinic per doctor, the NAME is no
    // longer unique, so the code is what tells two cards apart.
    function clinicCode(id) {
        return String(clinicCodes[id] || '').trim();
    }

    function clinicOfUser(user) { return String((user && user.clinic_id) || 'main_clinic'); }
    function byStaffName(a, b) {
        return String(displayName(a) || '').localeCompare(String(displayName(b) || ''));
    }
    function userHit(user, needle) {
        if (!needle) return true;
        return [user.full_name, user.username, user.specialty]
            .some(function (v) { return String(v || '').toLowerCase().indexOf(needle) !== -1; });
    }
    /* One person in the directory.
     *
     * `count` and `monthTotal` are optional. When given, the row carries
     * that person's own record count with an explicit period label, because
     * a bare number next to a name is read as "this month" or "all time"
     * depending on who is looking, and getting that wrong in a clinic
     * dashboard is not a small thing.
     */
    function personRow(user, kind, doctorName, count, monthTotal) {
        const off = user.is_active === false;
        const name = String(displayName(user) || 'Unnamed');
        const sub = kind === 'sec'
            ? '@' + (user.username || '?') + ' \u00b7 secretary for ' + (doctorName || 'NOT SET')
            : '@' + (user.username || '?') + ' \u00b7 last seen ' + relTime(user.last_login_at);

        // Both numbers, each labelled. "all time" is the fallback only when
        // no month figure is available to compare it against.
        const period = (count === undefined || count === null) ? '' :
            '<span class="ent-person-count" title="Records made by this person">'
            + '<b>' + fmtNum(count) + '</b>'
            + (monthTotal === undefined ? ' all time' : ' this month')
            + '</span>';

        return '<div class="ent-person ent-person-' + kind + (off ? ' is-off' : '') + '">'
            + '<span class="ent-person-av">' + esc(initialsOf(name)) + '</span>'
            + '<span class="ent-person-main"><b>' + esc(name) + '</b>'
            + '<small>' + esc(sub) + '</small></span>'
            + period
            + (off ? '<span class="ent-pill idle">Deactivated</span>'
                : '<span class="ent-pill live">Active</span>')
            + '</div>';
    }
    /* The account-wide totals, shown above the directory.
         *
         * Before this, the only way to learn how many clinics or doctors
         * existed was to count the cards. An admin opening this tab could
         * see the shape of the data but not its size. These are always the
         * FULL totals, never the filtered ones, so a search can be read as
         * "3 of 9 clinics" rather than silently hiding the rest.
         */
    function renderClinicSummary() {
        const host = byId('clinicSummary');
        if (!host) return;
        const docs = users.filter(function (u) { return u && u.role === 'doctor'; });
        const secs = users.filter(function (u) { return u && u.role === 'secretary'; });
        const admins = users.filter(function (u) { return u && u.role === 'admin'; });
        const t = periodTotals('');
        const loose = secs.filter(function (u) { return !u.assigned_doctor_id; }).length;
        const tiles = [
            ['Clinics', fmtNum(clinicIds().length), ''],
            ['Doctors', fmtNum(docs.length), ''],
            ['Secretaries', fmtNum(secs.length), loose ? loose + ' not linked to a doctor' : ''],
            ['Administrators', fmtNum(admins.length), ''],
            ['Records', fmtNum(t.total), 'all time'],
            ['This month', fmtNum(t.month), ''],
        ];
        host.innerHTML = tiles.map(function (x) {
            return '<div class="ent-clinic-sum">' +
                '<span class="ent-clinic-sum-n">' + esc(x[1]) + '</span>' +
                '<span class="ent-clinic-sum-l">' + esc(x[0]) + '</span>' +
                (x[2] ? '<span class="ent-clinic-sum-s">' + esc(x[2]) + '</span>' : '') +
                '</div>';
        }).join('');
    }

    function renderClinicDirectory() {
        const host = byId('clinicDirectory');
        if (!host) return;
        const box = byId('clinicSearch');
        const needle = (box ? box.value : '').trim().toLowerCase();
        const clearBtn = byId('clinicSearchClear');
        if (clearBtn) clearBtn.hidden = !needle;
        renderClinicSummary();
        const doctors = users.filter(function (u) { return u && u.role === 'doctor'; });
        const secretaries = users.filter(function (u) { return u && u.role === 'secretary'; });
        const orphans = [];
        const cards = [];
        clinicIds().forEach(function (id) {
            const docs = doctors.filter(function (u) { return clinicOfUser(u) === id; }).sort(byStaffName);

            /* A clinic whose only doctor has been DEACTIVATED is hidden.
             *
             * Every doctor now owns a clinic named after him, so deactivating a
             * doctor used to leave his clinic sitting in the panel with an empty
             * body and "0 doctors" on it - a card that reads as a data problem
             * rather than as "this person is off". The clinic asked for it to go
             * away when he is deactivated.
             *
             * HIDDEN, never deleted, and that distinction is the whole point:
             * the rows on his shelf still belong to the clinic, and deleting the
             * card - let alone the clinic row - would take his patients with it.
             * Re-activating him brings the card straight back, because this is
             * computed on every render from is_active and nothing is stored.
             *
             * The test is deliberately narrow. A clinic is hidden only when it
             * HAS doctors and every one of them is deactivated: a clinic with no
             * doctor at all (the shared ones an admin belongs to) must still be
             * visible, or the administrator would lose sight of his own. */
            const liveDocs = docs.filter(function (d) { return d.is_active !== false; });
            if (docs.length && !liveDocs.length) return;      // hidden

            const ids = docs.map(function (d) { return String(d.id); });
            const mine = secretaries.filter(function (u) {
                return u.assigned_doctor_id && ids.indexOf(String(u.assigned_doctor_id)) !== -1;
            });
            const loose = [];
            secretaries.forEach(function (u) {
                if (!u.assigned_doctor_id) {
                    if (clinicOfUser(u) === id) loose.push(u);
                } else if (ids.indexOf(String(u.assigned_doctor_id)) === -1) {
                    orphans.push(u);
                }
            });
            const people = docs.concat(mine, loose);
            const keep = !needle || clinicLabel(id).toLowerCase().indexOf(needle) !== -1
                || String(id).toLowerCase().indexOf(needle) !== -1
                || people.some(function (u) { return userHit(u, needle); });
            if (!keep) return;
            const t = periodTotals(id);
            const secCount = mine.length + loose.length;

            /* Each doctor now carries their own numbers, so a clinic block
             * answers "who is busiest here" without the admin having to
             * work it out from a single clinic-wide figure. The count is
             * the doctor's own records, which is what a reader assumes a
             * number sitting next to a person means. */
            const busiest = docs.map(function (d) {
                return { name: displayName(d), n: t.doctors[String(d.id)] || 0 };
            }).sort(function (a, b) { return b.n - a.n; });
            const top = busiest.filter(function (x) { return x.n > 0; })[0];

            /* Reports carry the doctor_id of whoever created them, and an
             * administrator creating one is stamped with the admin's own id.
             * Administrators are not listed under a clinic's doctors, so those
             * records would silently go missing from the per-doctor figures
             * while still counting towards the clinic total - the numbers on
             * the card would not add up and the whole panel would stop being
             * believable. Shown only when it is non-zero.
             */
            const attributed = busiest.reduce(function (a, x) { return a + x.n; }, 0);
            const unattributed = Math.max(0, (t.total || 0) - attributed);

            const body = docs.map(function (d) {
                const mineSecs = mine.filter(function (s) {
                    return String(s.assigned_doctor_id) === String(d.id);
                }).sort(byStaffName);
                const dCount = t.doctors[String(d.id)] || 0;
                return '<div class="ent-doc-group">' + personRow(d, 'doc', dCount, t.month)
                    + (mineSecs.length
                        ? '<div class="ent-sec-list">' + mineSecs.map(function (s) {
                            const sCount = t.staff[String(s.id)] || 0;
                            return personRow(s, 'sec', displayName(d), sCount);
                        }).join('') + '</div>'
                        : '<div class="ent-sec-none">No secretary linked yet</div>')
                    + '</div>';
            }).join('') + loose.map(function (s) {
                return personRow(s, 'sec', '', t.staff[String(s.id)] || 0);
            }).join('');

            // The full UUID was printed in the header of every clinic. It is
            // an implementation detail: it cannot be acted on, and it is the
            // longest thing on the card. The first eight characters are
            // enough to identify it, and the whole value stays on hover.
            // The uuid itself stays on the title attribute of the code chip, so a
            // suspicious name can always be traced back to the real row.
            cards.push('<section class="ent-clinic-block" style="--accent:' + clinicColor(id) + '">'
                + '<header class="ent-clinic-block-head">'
                + '<span class="ent-clinic-dot" aria-hidden="true"></span>'
                // The clinic CODE is now shown next to the name. Every doctor
                // now gets their own auto-named clinic, so a list of cards that
                // are all called "ENT-Clinic Doc. <someone>" is unusable without
                // the one field that is actually unique - and short ids collide
                // visually because several seeded clinics share a prefix.
                + '<div class="ent-clinic-block-title"><h3>' + esc(clinicLabel(id)) + '</h3>'
                + '<code title="' + esc(id) + '">' + esc(clinicCode(id) || shortIdFallback(id)) + '</code></div>'
                + '<div class="ent-clinic-block-stats">'
                + '<span><b>' + docs.length + '</b> doctor' + (docs.length === 1 ? '' : 's') + '</span>'
                + '<span><b>' + secCount + '</b> secretar' + (secCount === 1 ? 'y' : 'ies') + '</span>'
                + '<span><b>' + fmtNum(t.month) + '</b> this month</span>'
                + '<span><b>' + fmtNum(t.total) + '</b> all time</span>'
                + (unattributed
                    ? '<span class="ent-clinic-unattr" title="Records in this clinic made by someone who is not one of its doctors">'
                      + '<b>' + fmtNum(unattributed) + '</b> by an admin</span>'
                    : '')
                + '<button type="button" class="ent-btn ent-btn-sm" data-act="rename-clinic" '
                + 'data-id="' + esc(id) + '">Rename</button>'
                + '</div></header>'
                + (top ? '<p class="ent-clinic-block-top">Most records this month: <b>'
                    + esc(top.name) + '</b> with ' + fmtNum(top.n) + '</p>' : '')
                + '<div class="ent-clinic-block-body">'
                + (body || '<p class="ent-empty">No doctor and no secretary in this clinic yet.</p>')
                + '</div></section>');
        });
        if (orphans.length) {
            cards.push('<section class="ent-clinic-block is-warn" style="--accent:var(--warning-color)">'
                + '<header class="ent-clinic-block-head">'
                + '<span class="ent-clinic-dot" aria-hidden="true"></span>'
                + '<div class="ent-clinic-block-title"><h3>Secretaries without a doctor</h3>'
                + '<code>fix it in Users \u2192 assigned doctor</code></div></header>'
                + '<div class="ent-clinic-block-body">'
                + orphans.sort(byStaffName).map(function (u) { return personRow(u, 'sec', ''); }).join('')
                + '</div></section>');
        }
        host.innerHTML = cards.join('')
            || '<div class="ent-empty">No clinic matches this search.</div>';

        /* Search feedback. Without this, typing in the box silently
         * removes cards and there is no way to tell "your search found one
         * clinic" from "this account only has one clinic". */
        if (needle) {
            const found = cards.length;
            // The denominator counts only VISIBLE clinics: clinicIds() now
            // filters retired shells and clinics whose doctors are all
            // deactivated at the source, so "showing 1 of 4" matches the
            // cards actually on screen.
            const total = clinicIds().length;
            const note = document.createElement('p');
            note.className = 'ent-clinic-found';
            note.innerHTML = found
                ? 'Showing <b>' + found + '</b> of ' + total + ' clinic'
                    + (total === 1 ? '' : 's') + ' for &ldquo;' + esc(needle) + '&rdquo;.'
                : 'No clinic, doctor or secretary matches &ldquo;' + esc(needle) + '&rdquo;.';
            host.insertBefore(note, host.firstChild);
        }
    }
    function exportDirectoryCsv() {
        const rows = [['Clinic', 'Clinic id', 'Doctor', 'Doctor username', 'Doctor status',
            'Secretary', 'Secretary username', 'Secretary status']];
        clinicIds().forEach(function (id) {
            const docs = users.filter(function (u) {
                return u && u.role === 'doctor' && clinicOfUser(u) === id;
            });
            // Same rule as the panel: a clinic whose doctors are all deactivated
            // is not shown, so the CSV matches what the screen shows. An export
            // that lists a clinic the panel hides is the kind of discrepancy
            // that makes people stop trusting both.
            if (docs.length && !docs.some(function (d) { return d.is_active !== false; })) return;
            if (!docs.length) {
                rows.push([clinicLabel(id), id, '', '', '', '', '', '']);
                return;
            }
            docs.forEach(function (d) {
                const secs = users.filter(function (u) {
                    return u && u.role === 'secretary' && String(u.assigned_doctor_id) === String(d.id);
                });
                if (!secs.length) {
                    rows.push([clinicLabel(id), id, displayName(d), d.username,
                        d.is_active === false ? 'deactivated' : 'active', '', '', '']);
                    return;
                }
                secs.forEach(function (s) {
                    rows.push([clinicLabel(id), id, displayName(d), d.username,
                        d.is_active === false ? 'deactivated' : 'active',
                        displayName(s), s.username,
                        s.is_active === false ? 'deactivated' : 'active']);
                });
            });
        });
        downloadCsv('clinics-and-staff-' + dayKey(new Date()) + '.csv', rows);
    }

    /* ------------------- staff scoreboard as cards ---------------------- */
    // One card per person - the old 8 column table was unreadable.
    function renderStaffCards() {
        const box = byId('staffCards');
        if (!box) return;
        const now = new Date();
        const today = dayKey(now);
        const week = dayKey(weekStartOf(now));
        const month = monthKeyOf(now);
        const byUser = {};
        scopeBuckets(selectedClinic()).forEach(function (b) {
            if (!b.by || !b.n) return;
            const key = String(b.by).toLowerCase();
            if (!byUser[key]) byUser[key] = { today: 0, week: 0, month: 0, total: 0 };
            const row = byUser[key];
            row.total += b.n;
            if (b.day === today) row.today += b.n;
            if (b.day >= week) row.week += b.n;
            if (String(b.day).slice(0, 7) === month) row.month += b.n;
        });
        const staff = users.filter(function (u) {
            return u && (u.role === 'doctor' || u.role === 'secretary');
        }).map(function (u) {
            return { user: u, n: byUser[String(u.username || '').toLowerCase()] || {} };
        }).sort(function (a, b) {
            return (b.n.total || 0) - (a.n.total || 0) || byStaffName(a.user, b.user);
        });
        if (!staff.length) {
            box.innerHTML = '<div class="ent-empty">No staff accounts yet.</div>';
            return;
        }
        box.innerHTML = staff.map(function (row, i) {
            const u = row.user;
            const n = row.n;
            const off = u.is_active === false;
            const name = String(displayName(u) || 'Unnamed');
            const boss = u.role === 'secretary' ? (userName(u.assigned_doctor_id) || 'not set') : '';
            return '<article class="ent-staff-card' + (off ? ' is-off' : '') + '">'
                + '<div class="ent-staff-top">'
                + '<span class="ent-staff-rank">' + (i + 1) + '</span>'
                + '<span class="ent-person-av">' + esc(initialsOf(name)) + '</span>'
                + '<div class="ent-staff-main">'
                + '<b>' + esc(name) + '</b>'
                + '<small>@' + esc(u.username || '') + ' \u00b7 ' + esc(u.role) + '</small>'
                + '<small class="ent-staff-where">' + esc(clinicLabel(clinicOfUser(u)))
                + (boss ? ' \u00b7 works for ' + esc(boss) : '') + '</small>'
                + '</div>'
                + (off ? '<span class="ent-pill idle">Deactivated</span>' : '')
                + '</div>'
                + '<div class="ent-staff-nums">'
                + '<span><em>Today</em><b>' + fmtNum(n.today || 0) + '</b></span>'
                + '<span><em>Week</em><b>' + fmtNum(n.week || 0) + '</b></span>'
                + '<span><em>Month</em><b>' + fmtNum(n.month || 0) + '</b></span>'
                + '<span class="is-total"><em>All</em><b>' + fmtNum(n.total || 0) + '</b></span>'
                + '</div>'
                + '</article>';
        }).join('');
    }
    function populateClinicFilter() {
        const sel = byId('clinicFilter');
        if (!sel) return;
        const keep = sel.value;
        // The dropdown keeps the FULL set (allClinicIds): the activity log
        // holds rows from clinics that are hidden from every other panel,
        // and an audit filter that cannot name them would hide the very
        // history an administrator might be looking for.
        sel.innerHTML = '<option value="">All clinics</option>' + allClinicIds().map(function (id) {
            return '<option value="' + esc(id) + '">' + esc(clinicLabel(id)) + '</option>';
        }).join('');
        if (keep && allClinicIds().indexOf(keep) !== -1) sel.value = keep;
    }
    function populateActivityUsers() {
        const sel = byId('activityUser');
        if (!sel) return;
        const keep = sel.value;
        const names = new Set();
        activity.forEach(function (a) { if (a && a.username) names.add(String(a.username)); });
        users.forEach(function (u) { if (u && u.username) names.add(String(u.username)); });
        sel.innerHTML = '<option value="">Everyone</option>' + Array.from(names).sort().map(function (n) {
            const u = userByName(n);
            return '<option value="' + esc(n) + '">' + esc((u && prettyName(u.full_name)) || n) + '</option>';
        }).join('');
        if (keep && Array.from(names).indexOf(keep) !== -1) sel.value = keep;
    }

    /* ---------------------------- activity log ----------------------- */
    const ACTION_KINDS = {
        LOGIN: 'live', LOGOUT: 'idle', SAVE_RECORD: 'live', OPEN_RECORD: 'idle',
        USER_CREATED: 'role-admin', USER_UPDATED: 'role-admin',
        USER_ACTIVATED: 'live', USER_DEACTIVATED: 'idle',
        PASSWORD_RESET: 'role-secretary', SESSION_REVOKED: 'idle'
    };
    const ACTION_LABELS = {
        LOGIN: 'Login', LOGOUT: 'Logout', SAVE_RECORD: 'Record saved',
        OPEN_RECORD: 'Record opened', USER_CREATED: 'User created',
        USER_UPDATED: 'User updated', USER_ACTIVATED: 'User activated',
        USER_DEACTIVATED: 'User deactivated', PASSWORD_RESET: 'Password reset',
        SESSION_REVOKED: 'Session revoked'
    };
    // ACTION_ICONS. A pill of words alone reads as one grey mass down the
    // Action column - the eye cannot find "the save" without reading each
    // label. A small leading glyph per action kind gives the column a shape
    // at a glance (the green save, the red admin change, the grey goodbye)
    // while the label keeps the exact meaning for anyone who needs it.
    const ACTION_ICONS = {
        LOGIN: '\u25CF', LOGOUT: '\u25CB', SAVE_RECORD: '\u2713',
        OPEN_RECORD: '\u25B8', USER_CREATED: '\u2795', USER_UPDATED: '\u270E',
        USER_ACTIVATED: '\u2600', USER_DEACTIVATED: '\u2601',
        PASSWORD_RESET: '\uD83D\uDD11', SESSION_REVOKED: '\u26D4'
    };
    function actionPill(action) {
        const key = String(action || '').toUpperCase();
        const icon = ACTION_ICONS[key] ? ACTION_ICONS[key] + ' ' : '';
        return '<span class="ent-pill ' + (ACTION_KINDS[key] || 'idle') + '">'
            + icon + esc(ACTION_LABELS[key] || key || '\u2014') + '</span>';
    }
    function filteredActivity() {
        const search = byId('activitySearch');
        const userSel = byId('activityUser');
        const actionSel = byId('activityFilter');
        const periodSel = byId('activityPeriod');
        const needle = ((search && search.value) || '').trim().toLowerCase();
        const user = ((userSel && userSel.value) || '').toLowerCase();
        const action = (actionSel && actionSel.value) || '';
        const days = periodSel ? (Number(periodSel.value) || 0) : 0;
        const fromDay = days > 0 ? dayKey(addDays(new Date(), -(days - 1))) : '';
        return activity.filter(function (a) {
            if (!a) return false;
            if (user && String(a.username || '').toLowerCase() !== user) return false;
            if (action && a.action !== action) return false;
            if (fromDay && String(a.created_at || '').slice(0, 10) < fromDay) return false;
            if (needle) {
                const hay = [a.detail, a.username, a.role, a.clinic_id, a.action]
                    .join(' ').toLowerCase();
                if (hay.indexOf(needle) === -1) return false;
            }
            return true;
        });
    }
    function renderActivityKpis(rows) {
        const host = byId('activityKpis');
        if (!host) return;
        const today = dayKey(new Date());
        const weekFrom = dayKey(addDays(new Date(), -6));
        const peopleToday = new Set();
        const loginsToday = new Set();
        const perUser = {};
        let savesToday = 0;
        let savesWeek = 0;
        rows.forEach(function (a) {
            const day = String(a.created_at || '').slice(0, 10);
            const act = String(a.action || '').toUpperCase();
            if (day === today) {
                peopleToday.add(a.username || 'anonymous');
                if (act === 'LOGIN') loginsToday.add(a.username || 'anonymous');
                if (act === 'SAVE_RECORD') savesToday += 1;
            }
            if (day >= weekFrom && act === 'SAVE_RECORD') savesWeek += 1;
            if (act === 'SAVE_RECORD') {
                const who = a.username || 'anonymous';
                perUser[who] = (perUser[who] || 0) + 1;
            }
        });
        const busiest = Object.keys(perUser).sort(function (a, b) {
            return perUser[b] - perUser[a];
        })[0];
        const cards = [
            ['Events in filter', fmtNum(rows.length)],
            ['People active today', fmtNum(peopleToday.size)],
            ['Logins today', fmtNum(loginsToday.size)],
            ['Records saved today', fmtNum(savesToday)],
            ['Saved this week', fmtNum(savesWeek)],
            ['Busiest person', busiest ? perUser[busiest] + ' saves' : '\u2014']
        ];
        host.innerHTML = cards.map(function (c) {
            return '<div class="ent-stat"><div class="ent-stat-value">' + esc(c[1])
                + '</div><div class="ent-stat-label">' + esc(c[0]) + '</div></div>';
        }).join('');
    }
    function populateActivityActions() {
        const sel = byId('activityFilter');
        if (!sel) return;
        const known = Array.prototype.map.call(sel.options, function (o) { return o.value; });
        const extra = [];
        activity.forEach(function (a) {
            const key = String((a && a.action) || '').toUpperCase();
            if (key && known.indexOf(key) === -1 && extra.indexOf(key) === -1) extra.push(key);
        });
        extra.sort().forEach(function (key) {
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = ACTION_LABELS[key] || key;
            sel.appendChild(opt);
        });
    }

    /* --------------------------- csv exports -------------------------- */
    function csvCell(value) {
        const s = (value === null || value === undefined) ? '' : String(value);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    function downloadCsv(name, rows) {
        const csv = rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        setTimeout(function () { URL.revokeObjectURL(url); link.remove(); }, 500);
        toast(name + ' downloaded');
    }
    function exportClinicsCsv() {
        const rows = [['Clinic id', 'Clinic name', 'Today', 'Yesterday', 'This week',
            'Last week', 'This month', 'Last month', 'Records on file', 'Active staff',
            'Last record']].concat(clinicIds().map(function (id) {
                const t = periodTotals(id);
                return [id, clinicLabel(id), t.today, t.yesterday, t.week, t.prevWeek,
                    t.month, t.prevMonth, t.total, Object.keys(t.staff).length, t.lastDay];
            }));
        downloadCsv('clinic-growth-' + dayKey(new Date()) + '.csv', rows);
    }
    function exportActivityCsv() {
        const rows = [['When', 'Who', 'Role', 'Clinic', 'Action', 'Detail']]
            .concat(filteredActivity().slice(0, 5000).map(function (a) {
                return [a.created_at, a.username || a.actor_label, a.role || a.actor_role,
                    a.clinic_id, a.action, a.detail];
            }));
        downloadCsv('activity-log-' + dayKey(new Date()) + '.csv', rows);
    }

    /* -------------------------- clinic rename ------------------------- */
    let renameTarget = '';
    function applyRename() {
        const box = byId('renameModal');
        const input = byId('renameInput');
        const hint = byId('renameHint');
        if (!input || !renameTarget) return;
        const value = String(input.value || '').trim().slice(0, 60);
        if (!value) {
            if (hint) hint.textContent = 'Type a name first \u2014 or press Cancel to leave it as is.';
            return;
        }
        labels[renameTarget] = value;
        saveLabels();
        if (box) box.classList.remove('open');
        renderClinicViews();
        renderClinicUsage();
        toast('Clinic now shown as "' + value + '"');
    }
    function openRenameModal(clinicId) {
        let box = byId('renameModal');
        if (!box) {
            box = document.createElement('div');
            box.id = 'renameModal';
            box.className = 'ent-modal';
            box.innerHTML = '<div class="ent-modal-card" style="max-width:440px;">'
                + '<h3>Name this clinic</h3>'
                + '<div class="ent-field"><label for="renameInput">Display name</label>'
                + '<input type="text" id="renameInput" autocomplete="off" maxlength="60">'
                + '<div class="ent-hint" id="renameHint"></div></div>'
                + '<div class="ent-modal-actions">'
                + '<button type="button" class="ent-btn" id="renameCancel">Cancel</button>'
                + '<button type="button" class="ent-btn primary" id="renameSave">Save</button>'
                + '</div></div>';
            document.body.appendChild(box);
            box.addEventListener('click', function (e) {
                if (e.target === box) box.classList.remove('open');
            });
            byId('renameCancel').addEventListener('click', function () {
                box.classList.remove('open');
            });
            byId('renameSave').addEventListener('click', applyRename);
            byId('renameInput').addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); applyRename(); }
                else if (e.key === 'Escape') box.classList.remove('open');
            });
        }
        renameTarget = clinicId;
        byId('renameInput').value = labels[clinicId] || '';
        byId('renameHint').textContent = 'Technical id: ' + clinicId
            + '. The friendly name is remembered in this browser \u2014 nothing in Supabase changes.';
        box.classList.add('open');
        byId('renameInput').focus();
    }

    /* --------------------------- database usage ----------------------- */
    function quotaCard(title, usedText, limitText, pct, note, available) {
        const safe = Math.max(0, Math.min(100, Number(pct) || 0));
        const kind = safe >= 90 ? 'danger' : (safe >= 70 ? 'warn' : '');
        return '<div class="ent-quota"><div class="ent-quota-top"><strong>' + esc(title) + '</strong>'
            + '<span class="ent-quota-pct">'
            + (available ? (safe < 10 ? safe.toFixed(1) : Math.round(safe)) + '%' : 'n/a')
            + '</span></div>'
            + '<div class="ent-quota-nums">' + esc(usedText) + ' <small>/ ' + esc(limitText) + '</small></div>'
            + '<div class="ent-meter ' + kind + '"><span style="width:'
            + (available ? safe : 0) + '%"></span></div>'
            + '<small>' + esc(note) + '</small></div>';
    }
    function renderDatabase() {
        const host = byId('quotaCards');
        if (!host || !usage) return;
        const dbLimit = Number(usage.db_limit_bytes) || FREE_DB;
        const storageLimit = Number(usage.storage_limit_bytes) || FREE_STORAGE;
        const mauLimit = Number(usage.mau_limit) || FREE_MAU;
        const egressLimit = Number(usage.egress_limit_bytes) || FREE_EGRESS;
        const exact = usage.exact !== false;
        const dbUsed = Number(usage.db_bytes);
        const hasDb = usage.db_bytes !== null && usage.db_bytes !== undefined
            && usage.db_bytes !== '' && isFinite(dbUsed) && dbUsed >= 0;
        const appRaw = Number(usage.app_bytes);
        const hasApp = usage.app_bytes !== null && usage.app_bytes !== undefined
            && usage.app_bytes !== '' && isFinite(appRaw) && appRaw >= 0;
        const appUsed = hasApp ? appRaw : 0;
        const appRows = Number(usage.app_rows) || 0;
        const avgRowRaw = Number(usage.avg_row_bytes);
        const hasAvgRow = usage.avg_row_bytes !== null && usage.avg_row_bytes !== undefined
            && usage.avg_row_bytes !== '' && isFinite(avgRowRaw) && avgRowRaw >= 0;
        const storageUsed = Number(usage.storage_bytes);
        const hasStorage = usage.storage_bytes !== null && usage.storage_bytes !== undefined
            && usage.storage_bytes !== '' && isFinite(storageUsed) && storageUsed >= 0;
        const mauRaw = (usage.mau === null || usage.mau === undefined) ? usage.auth_users : usage.mau;
        const mau = Number(mauRaw);
        const hasMau = mauRaw !== null && mauRaw !== undefined && mauRaw !== ''
            && isFinite(mau) && mau >= 0;
        host.innerHTML = [
            quotaCard('Database size', hasDb ? fmtBytes(dbUsed) : hasApp ? fmtBytes(appUsed) : '\u2014',
                fmtBytes(dbLimit),
                hasDb ? (dbUsed / dbLimit) * 100 : hasApp ? (appUsed / dbLimit) * 100 : 0,
                hasDb
                    ? 'pg_database_size() \u2014 tables, indexes and free space together.'
                    : hasApp
                        ? 'Estimated app data from ' + fmtNum(appRows) + ' records'
                            + (hasAvgRow ? ' \u00d7 ' + fmtBytes(avgRowRaw) + ' per row' : '')
                            + '. Run the SQL script for exact database bytes.'
                        : 'Database size measurement is unavailable.',
                hasDb || hasApp),
            quotaCard('App data', hasApp ? fmtBytes(appUsed) : '\u2014', fmtBytes(dbLimit),
                hasApp ? (appUsed / dbLimit) * 100 : 0,
                hasApp
                    ? fmtNum(appRows) + ' rows across the public schema'
                        + (bucketTruncated
                            ? ' \u00b7 listing capped at ' + fmtNum(MAX_PAGES * PAGE_SIZE) + ' rows' : '')
                    : 'App data measurement is unavailable.',
                hasApp),
            quotaCard('File storage', hasStorage ? fmtBytes(storageUsed) : '\u2014',
                fmtBytes(storageLimit),
                hasStorage ? (storageUsed / storageLimit) * 100 : 0,
                hasStorage
                    ? fmtNum(usage.storage_files) + ' file(s) in buckets \u00b7 free plan allows 1 GB'
                    : 'Needs the SQL script \u2014 bucket sizes come from storage.objects.',
                hasStorage),
            quotaCard('Monthly active users', hasMau ? fmtNum(mau) : '\u2014', fmtNum(mauLimit),
                hasMau ? (mau / mauLimit) * 100 : 0,
                hasMau
                    ? fmtNum(usage.auth_users) + ' sign-ups in total \u00b7 free plan allows 50 000 MAU'
                    : 'Needs the SQL script \u2014 MAU is counted from auth.users.',
                hasMau),
            quotaCard('Bandwidth (egress)', '\u2014', fmtBytes(egressLimit), 0,
                'Postgres cannot measure egress from the browser \u2014 see Project Settings \u2192 Usage.',
                false)
        ].join('');
        setText('dbSourceNote', exact
            ? 'Exact numbers read straight from Postgres \u00b7 refreshed ' + new Date().toLocaleTimeString()
            : 'Estimated through the REST API \u2014 run supabase_admin_insights.sql in the SQL editor for exact meters.');
        const capacityNote = byId('dbCapacityNote');
        if (capacityNote) {
            const readings = [];
            if (hasDb) readings.push({ label: 'Database', pct: dbUsed / dbLimit * 100 });
            else if (hasApp) readings.push({ label: 'Estimated app data', pct: appUsed / dbLimit * 100 });
            if (hasStorage) readings.push({ label: 'File storage', pct: storageUsed / storageLimit * 100 });
            const warnings = readings.filter(function (reading) { return reading.pct >= 70; });
            const danger = warnings.some(function (reading) { return reading.pct >= 90; });
            const kind = danger ? 'is-danger' : warnings.length ? 'is-warn' : '';
            capacityNote.className = 'ent-hint' + (kind ? ' ' + kind : '');
            if (!readings.length) {
                capacityNote.textContent = 'Capacity readings are unavailable. Check the usage source and refresh; no percentage is being assumed.';
            } else if (warnings.length) {
                capacityNote.textContent = warnings.map(function (reading) {
                    return reading.label + ' at ' + Math.round(reading.pct) + '%';
                }).join(' \u00b7 ') + (danger ? ' \u2014 review capacity soon.' : ' \u2014 monitor growth.');
            } else {
                capacityNote.textContent = 'No measured capacity is at the 70% warning threshold. These are point-in-time readings, not live alerts.';
            }
        }
        renderDbTables();
        renderClinicUsage();
        renderPlanNote();
    }

    function renderDbTables() {
        const bodyEl = byId('dbTable');
        if (!bodyEl || !usage) return;
        const tables = Array.isArray(usage.tables) ? usage.tables.slice(0, 25) : [];
        if (!tables.length) {
            return emptyRow('dbTable', 5,
                'Per-table sizes need supabase_admin_insights.sql (it reads pg_class).');
        }
        const max = tables.reduce(function (m, t) { return Math.max(m, Number(t.bytes) || 0); }, 1);
        bodyEl.innerHTML = tables.map(function (t) {
            const total = Number(t.bytes) || 0;
            return '<tr><td data-label="Table"><strong>' + esc(t.name || t.table_name) + '</strong>'
                + '<div class="ent-share" style="margin-top:4px;"><span class="ent-share-bar"><span style="width:'
                + Math.round((total / max) * 100) + '%"></span></span></div></td>'
                + '<td class="ent-num" data-label="Rows">' + fmtNum(t.rows) + '</td>'
                + '<td class="ent-num" data-label="Table size">' + fmtBytes(t.table_bytes) + '</td>'
                + '<td class="ent-num" data-label="Indexes">' + fmtBytes(t.index_bytes) + '</td>'
                + '<td class="ent-num" data-label="Total"><strong>' + fmtBytes(total) + '</strong></td></tr>';
        }).join('');
        const sum = tables.reduce(function (s, t) { return s + (Number(t.bytes) || 0); }, 0);
        setText('dbTablesHint', fmtBytes(sum) + ' across ' + tables.length
            + ' table(s) in the public schema');
    }
    function renderClinicUsage() {
        const bodyEl = byId('clinicUsageTable');
        if (!bodyEl) return;
        const totals = clinicIds().map(function (id) {
            return { id: id, n: periodTotals(id).total };
        }).sort(function (a, b) { return b.n - a.n; });
        const sum = totals.reduce(function (s, r) { return s + r.n; }, 0);
        if (!totals.length || !sum) return emptyRow('clinicUsageTable', 3, 'No records stored yet.');
        const avg = Number(usage && usage.avg_row_bytes) || 0;
        bodyEl.innerHTML = totals.map(function (r) {
            const pct = Math.round((r.n / sum) * 100);
            return '<tr style="--accent:' + clinicColor(r.id) + '">'
                + '<td data-label="Clinic"><strong>' + esc(clinicLabel(r.id)) + '</strong>'
                + '<div class="ent-hint">' + esc(r.id) + '</div></td>'
                + '<td class="ent-num" data-label="Records">' + fmtNum(r.n) + '</td>'
                + '<td data-label="Share"><div class="ent-share"><span class="ent-share-bar"><span style="width:'
                + pct + '%"></span></span></span><em>' + pct + '%'
                + (avg ? ' \u00b7 ' + fmtBytes(r.n * avg) : '') + '</em></div></td></tr>';
        }).join('');
    }
    function renderPlanNote() {
        const host = byId('planNote');
        if (!host || !usage) return;
        const note = usage.plan_note || ('Supabase Free plan: 500 MB database, 1 GB file storage, '
            + '50 000 monthly active users, 5 GB egress. Free projects pause after a week of inactivity.');
        let extra = '';
        if (usageError) extra = ' Usage function unavailable: ' + usageError;
        else if (bucketError) extra = ' Growth function unavailable (' + bucketError
            + ') \u2014 counts were paged through the REST API instead.';
        host.textContent = note + extra;
    }

    /* -------------------------- orchestration ------------------------- */
    /* ------------------------- top clinics by volume ------------------ *
     * The three clinics that have recorded the most patients.
     *
     * Ranked on the ALL-TIME count (periodTotals().total) rather than today's,
     * because the question is "which clinics are doing the most work" and a
     * clinic that happens to be quiet this morning is still the one that has
     * recorded the most. The bar is drawn against the LEADER so the top row
     * always fills and the rest read as a proportion of it.
     */
    function renderTopClinics() {
        const host = byId('topClinics');
        if (!host) return;
        const ids = clinicIds();
        if (!ids.length) {
            host.innerHTML = '<div class="ent-empty">No clinic has saved a report yet. '
                + 'The ranking fills in as soon as records are stored.</div>';
            return;
        }
        const ranked = ids.map(function (id) {
            const t = periodTotals(id);
            return { id: id, total: t.total, month: t.month, week: t.week, last: t.lastDay };
        }).sort(function (a, b) {
            // Tie-break on the id so two level clinics never swap places
            // between renders.
            return (b.total - a.total) || (a.id < b.id ? -1 : 1);
        }).slice(0, 3);
        const lead = ranked.length ? ranked[0].total : 0;
        host.innerHTML = ranked.map(function (r, i) {
            const pct = lead > 0 ? Math.max(6, Math.round((r.total / lead) * 100)) : 0;
            return '<div class="ent-topclinic" style="--accent:' + clinicColor(r.id) + '">'
                + '<span class="ent-topclinic-rank">' + (i + 1) + '</span>'
                + '<div class="ent-topclinic-body">'
                + '<div class="ent-topclinic-head">'
                + '<b title="' + esc(r.id) + '">' + esc(clinicLabel(r.id)) + '</b>'
                + '<span class="ent-topclinic-n">' + fmtNum(r.total) + '</span>'
                + '</div>'
                + '<div class="ent-topclinic-bar"><span style="width:' + pct + '%"></span></div>'
                + '<div class="ent-topclinic-meta">' + fmtNum(r.month) + ' this month &middot; '
                + fmtNum(r.week) + ' this week'
                + (r.last ? ' &middot; last record ' + esc(dayLabel(r.last)) : '')
                + '</div>'
                + '</div></div>';
        }).join('');
        // Say how many clinics were ranked when there are more than three, so
        // a clinic in fourth place does not read as a missing one.
        const hint = byId('topClinicsHint');
        if (hint) {
            hint.textContent = ids.length > 3
                ? 'The three busiest of ' + ids.length + ' clinics, by records on file'
                : 'The three clinics that have recorded the most patients';
        }
    }

    function renderClinicViews() {
        populateClinicFilter();
        renderSnapshot();
        renderTopClinics();
        renderClinicDirectory();
        renderClinicTable();
        renderStaffCards();
        renderGrowth();
        renderTypeMix();
    }
    async function loadAnalytics(force) {
        try {
            await loadBuckets(force);
        } catch (error) {
            const message = (error && error.message) || String(error);
            if (byId('clinicCards')) {
                byId('clinicCards').innerHTML = '<div class="ent-empty">Could not read reports: '
                    + esc(message) + '</div>';
            }
            return;
        }
        renderClinicViews();
        renderOverviewStats();
        renderOverviewChart();
    }
    function renderConnPill() {
        const pill = byId('connPill');
        if (!pill) return;
        const configured = !!(window.EntSupabase
            && typeof window.EntSupabase.isConfigured === 'function'
            && window.EntSupabase.isConfigured());
        const online = navigator.onLine !== false;
        pill.classList.toggle('online', configured && online);
        pill.classList.toggle('offline', !(configured && online));
        // v2: the browser no longer knows its clinic, and that is the point.
        // The clinic is a fact in staff_profiles; showing it here would only
        // ever be a display value the client chose, which is what v1 did.
        setText('connText', !configured
            ? 'Supabase not configured'
            : (online ? 'Live \u00b7 your clinic' : 'Offline \u2014 showing last numbers'));
    }

    /* --------------------------- event wiring ------------------------ */
    // FREE-PLAN DISCIPLINE. This drives loadBuckets + loadActivity + the usage
    // meters every tick - the heaviest recurring read in the app, and pure
    // egress against the 5 GB/month cap while the console sits open. Doubled
    // 60s -> 120s: an admin glancing at growth charts or the DB meter loses
    // nothing at a two-minute cadence, and it halves the console's share of the
    // clinic's egress. Mirrors the dashboard's REFRESH_MS change for the same
    // reason. The presence poll (REFRESH_MS above) stays at 30s on purpose -
    // it reads a single tiny presence row, not the analytics set.
    const ANALYTICS_REFRESH_MS = 120000;     // record counts / usage meters
    let analyticsTimer = null;

    function wireAnalytics() {
        // --- Clinics & growth panel -------------------------------------
        const growthRange = byId('growthRange');
        if (growthRange) growthRange.addEventListener('change', renderGrowth);

        const modeBar = byId('growthMode');
        if (modeBar) {
            modeBar.querySelectorAll('button[data-mode]').forEach(function (b) {
                b.addEventListener('click', function () {
                    growthMode = b.dataset.mode;
                    modeBar.querySelectorAll('button[data-mode]').forEach(function (x) {
                        x.classList.toggle('active', x === b);
                    });
                    renderGrowth();
                });
            });
        }

        const clinicSel = byId('clinicFilter');
        if (clinicSel) {
            clinicSel.addEventListener('change', function () {
                renderClinicViews();
                renderClinicUsage();
            });
        }

        // --- clinics directory (search + export + refresh) -----------------
        const clinicSearch = byId('clinicSearch');
        if (clinicSearch) clinicSearch.addEventListener('input', renderClinicDirectory);
        // Escape empties the box from the keyboard, and the x does it with a
        // pointer. Small, but searching and then having to select-all and
        // delete is the sort of thing that makes a panel feel broken.
        if (clinicSearch) {
            clinicSearch.addEventListener('keydown', function (e) {
                if (e.key !== 'Escape' || !clinicSearch.value) return;
                e.stopPropagation();
                clinicSearch.value = '';
                renderClinicDirectory();
            });
        }
        const clearSearch = byId('clinicSearchClear');
        if (clearSearch) {
            clearSearch.addEventListener('click', function () {
                const field = byId('clinicSearch');
                if (field) field.value = '';
                renderClinicDirectory();
                if (field) field.focus();
            });
        }
        const exportDirectory = byId('exportDirectoryBtn');
        if (exportDirectory) exportDirectory.addEventListener('click', exportDirectoryCsv);
        const refreshDirectory = byId('refreshDirectoryBtn');
        if (refreshDirectory) {
            refreshDirectory.addEventListener('click', function () {
                toast('Refreshing the clinic list\u2026');
                loadAnalytics(true);
            });
        }

        const exportClinics = byId('exportClinicsBtn');
        if (exportClinics) exportClinics.addEventListener('click', exportClinicsCsv);

        const refreshClinics = byId('refreshClinicsBtn');
        if (refreshClinics) {
            refreshClinics.addEventListener('click', function () {
                toast('Refreshing clinic numbers\u2026');
                loadAnalytics(true);
            });
        }

        // --- activity log filters ---------------------------------------
        ['activityUser', 'activityPeriod'].forEach(function (id) {
            const el = byId(id);
            if (el) el.addEventListener('change', renderActivity);
        });
        const actSearch = byId('activitySearch');
        if (actSearch) actSearch.addEventListener('input', renderActivity);

        const exportActivity = byId('exportActivityBtn');
        if (exportActivity) exportActivity.addEventListener('click', exportActivityCsv);

        // --- database panel ----------------------------------------------
        const refreshDb = byId('refreshDbBtn');
        if (refreshDb) {
            refreshDb.addEventListener('click', function () {
                toast('Reading the usage meters\u2026');
                loadUsage(true);
            });
        }

        // --- clinic rename (event delegation on both clinic views) -------
        ['clinicCards', 'clinicTable', 'clinicDirectory'].forEach(function (id) {
            const host = byId(id);
            if (!host) return;
            host.addEventListener('click', function (e) {
                const btn = e.target.closest('button[data-act="rename-clinic"]');
                if (!btn) return;
                openRenameModal(btn.dataset.id);
            });
        });

        // --- connection pill ---------------------------------------------
        window.addEventListener('online', renderConnPill);
        window.addEventListener('offline', renderConnPill);
    }

    async function analyticsTick() {
        if (document.hidden) return;
        if (currentPanel === 'users' || currentPanel === 'sessions') return;
        try {
            await Promise.all([loadBuckets(true), loadActivity(true)]);
        } catch (e) { /* keep the previous picture on a dropped request */ }
        renderClinicViews();
        renderOverviewStats();
        renderOverviewChart();
        renderActivity();
        renderDatabase();
    }

    /* ------------------------------- boot ---------------------------- */
    async function boot() {
        session = await Auth.guard({
            roles: ['admin'],
            // This page lives in pages/, so the dashboard it falls back to is
            // one level up. Auth.pageUrl() resolves that; a bare
            // "index.html" here would land on pages/index.html, which does
            // not exist, and a denied admin would get a 404 instead of the
            // dashboard.
            onDenied: function () {
                window.location.replace(Auth.pageUrl('index.html') + '?denied=1');
                return null;
            }
        });
        if (!session || !session.user) return;
        wire();
        wireDrawer();
        wireAnalytics();
        setLive(byId('liveChk').checked);
        renderConnPill();
        // Three independent feeds: the live console, the record counts and
        // the usage meters. None of them may hold up the others.
        await Promise.all([
            refreshAll(true).catch(function (e) {
                toast('Part of the live console failed: ' + ((e && e.message) || e), true);
            }),
            loadAnalytics(true),
            loadUsage(true)
        ]);
    }

    window.addEventListener('DOMContentLoaded', function () { boot(); });

})(window);



