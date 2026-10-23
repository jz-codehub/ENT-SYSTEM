/* =====================================================================
   SUPABASE CLIENT & CONFIGURATION  —  v2 (Supabase Auth + RLS)
   ENT-HNS Endoscopy & CF4 Reporting System
   ---------------------------------------------------------------------
   WHAT CHANGED FROM v1, AND WHY

   1. PROJECT. The default now points at the v2 project. v1's project is
      the one with the known audit findings (password_hash readable over
      REST by anon) and must never be shipped again.

   2. clinicId IS GONE FROM THE DEFAULTS. In v1 the browser chose its own
      clinic and put it in the query string. In v2 clinic membership is a
      fact in staff_profiles and every RLS policy derives the clinic from
      the JWT, so a client-supplied clinic is not merely redundant — it is
      the hole. Nothing here may reintroduce it.

   3. apiRequest() NOW AUTHENTICATES. v1 sent the anon key in BOTH the
      apikey and Authorization header, i.e. every read and every write was
      anonymous. v2 sends the anon key as `apikey` (PostgREST requires it)
      but the CALLER'S SESSION TOKEN as `Authorization`. That one change
      is what makes RLS actually run: the rows a page can see are now
      decided by staff_profiles, not by what the browser asked for.

   4. SESSION. supabase-js owns it (`sb-<ref>-auth-token`), refreshes it
      automatically and clears it on signOut. There is no hand-rolled
      session token in localStorage any more, and nothing to decode.

   SECURITY: only the anon/publishable key appears below. That key is
   designed to be public — the anon role has no grants in 0007, so it can
   read nothing. The service_role key must NEVER appear in this file, or
   in any other file under function/; it exists only as an Edge Function
   secret. Test CRED-04 checks exactly that.
   ===================================================================== */
(function (window) {
    'use strict';

    const CONFIG_KEY = 'ent_supabase_config_v1';

    // v2 project — NEW Supabase project (ybnlvfdvfrwnmdvhxeof), provisioned
    // 2026-10-11 for the fresh deployment. The previous project
    // is archived — do not touch it. Browser-safe values only.
    const PROJECT_REF = 'ybnlvfdvfrwnmdvhxeof';
    const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlibmx2ZmR2ZnJ3bm1kdmh4ZW9mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3MjA5MjIsImV4cCI6MjEwNzI5NjkyMn0.BoyYx9P1q6I2P9gAH30p9Qei517cYlpcA6X-XbnNlwM';

    const defaultConfig = {
        supabaseUrl: `https://${PROJECT_REF}.supabase.co`,
        supabaseAnonKey: ANON_KEY,
        autoSync: true
        // NOTE: no `clinicId`. v2 has no endpoint that accepts a clinic
        // from the client. getConfig() still echoes a legacy clinicId back
        // if one is sitting in old localStorage, so stale state cannot
        // break a page mid-deploy, but no query is ever built from it.
    };

    // ---- supabase-js instance (loaded by each page before this file) ----
    let _client = null;
    let _session = null;
    let _listeners = [];

    function emit(evt) {
        _listeners.forEach(function (fn) { try { fn(evt); } catch (e) { /* listener's problem */ } });
    }

    /** Subscribe to auth changes: fn({ event, session }). Returns unsubscribe. */
    function onAuthChange(fn) {
        _listeners.push(fn);
        return function () { _listeners = _listeners.filter(function (f) { return f !== fn; }); };
    }

    function getClient() {
        if (_client) return _client;
        const factory = window.supabase && window.supabase.createClient;
        if (typeof factory !== 'function') {
            throw new Error('supabase-js failed to load. Add the @supabase/supabase-js UMD script tag before supabaseClient.js.');
        }
        const cfg = getConfig();
        _client = factory(cfg.supabaseUrl, cfg.supabaseAnonKey, {
            auth: {
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: false,
                storageKey: 'sb-' + PROJECT_REF + '-auth-token'
            }
        });
        // Keep _session current. This is what makes an access token
        // available to apiRequest() without a round-trip per call.
        _client.auth.onAuthStateChange(function (event, session) {
            _session = session || null;
            emit({ event: event, session: _session });
        });
        // Hydrate on first use so a page reload has a token immediately.
        _client.auth.getSession().then(function (r) {
            if (r && r.data && r.data.session) _session = r.data.session;
        }).catch(function () { /* signed out is a valid state */ });
        return _client;
    }

    /** Current access token, or null. */
    async function getAccessToken() {
        if (_session && _session.access_token) return _session.access_token;
        const client = getClient();
        const { data } = await client.auth.getSession();
        _session = (data && data.session) || null;
        return _session ? _session.access_token : null;
    }

    function currentSession() { return _session; }

    function getConfig() {
        let saved = {};
        try {
            const raw = window.localStorage.getItem(CONFIG_KEY);
            if (raw) saved = JSON.parse(raw) || {};
        } catch (e) {
            console.warn('Could not read Supabase config from storage', e);
        }
        // A legacy clinicId may still sit in storage from v1. It is echoed
        // back for display compatibility ONLY; no query is built from it.
        const cfg = Object.assign({}, defaultConfig, saved);
        if (!('clinicId' in cfg)) cfg.clinicId = '';
        return cfg;
    }

    function saveConfig(newConfig) {
        try {
            const current = getConfig();
            const merged = Object.assign({}, current, newConfig || {});
            delete merged.clinicId;                    // never persist it
            window.localStorage.setItem(CONFIG_KEY, JSON.stringify(merged));
            window.dispatchEvent(new CustomEvent('supabase:configChanged', { detail: merged }));
            return merged;
        } catch (e) {
            console.error('Failed to save Supabase config', e);
            return null;
        }
    }

    function isConfigured() {
        const config = getConfig();
        return Boolean(config.supabaseUrl && config.supabaseAnonKey && config.supabaseUrl.startsWith('https://'));
    }

    /* ------------------------------------------------------------------
       apiRequest — the PostgREST helper every page already calls.

       v1 sent `Authorization: Bearer <anon key>`: anonymous, always, so
       the anon key was effectively a master credential. v2 sends
       `Authorization: Bearer <the caller's session token>`, which is what
       makes RLS run. With no session we fall back to the anon key, which
       0007 left with no grants — the request fails CLOSED, which is the
       correct behaviour for a signed-out browser.
       ------------------------------------------------------------------ */
    async function apiRequest(endpoint, options) {
        const opts = options || {};
        if (!isConfigured()) {
            throw new Error('Supabase is not configured yet.');
        }

        const config = getConfig();
        const baseUrl = config.supabaseUrl.replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
        const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
        const url = `${baseUrl}/rest/v1${cleanEndpoint}`;

        let bearer = null;
        try {
            bearer = await getAccessToken();
        } catch (e) {
            // supabase-js unavailable: fall through with the anon key, which
            // cannot read anything. Never throw here — a page that wants to
            // render offline should still render.
        }

        const headers = {
            'apikey': config.supabaseAnonKey,
            'Authorization': `Bearer ${bearer || config.supabaseAnonKey}`,
            'Content-Type': 'application/json',
            ...(opts.headers || {})
        };

        const response = await fetch(url, { ...opts, headers });

        if (!response.ok) {
            const errorText = await response.text();
            const err = new Error(`Supabase API error (${response.status}): ${errorText}`);
            err.status = response.status;
            // 401/403 means "the server stopped accepting this token".
            // Typed so auth.js can sign the user out instead of showing a
            // network error (the plan's Step 5 requirement).
            err.code = (response.status === 401 || response.status === 403)
                ? 'AUTH_REQUIRED' : 'API_ERROR';
            throw err;
        }

        // IMPORTANT: PostgREST answers INSERT/UPDATE/DELETE with an EMPTY body
        // (204 No Content, or 201 Created with 0 bytes) unless you explicitly ask
        // for `Prefer: return=representation`. Calling response.json() on an empty
        // body throws "Unexpected end of JSON input", which used to make every
        // "Save to Database" fail with "COULD NOT SAVE TO DATABASE" even though
        // the row WAS written. Always read the raw text first and only parse
        // when there is something to parse.
        const raw = await response.text();
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch (parseError) {
            return raw;
        }
    }

    window.EntSupabase = {
        getConfig,
        saveConfig,
        isConfigured,
        apiRequest,
        // v2 additions
        getClient,
        getAccessToken,
        currentSession,
        onAuthChange,
        PROJECT_REF,
        ANON_KEY
    };

})(window);

