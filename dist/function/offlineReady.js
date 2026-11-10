/* =====================================================================
   OFFLINE READY (v36a) â€” the "Preparing offline access" / "Offline-ready"
   status pill, with verification and a Retry button.
   ---------------------------------------------------------------------
   WHY THIS EXISTS
   Phase 3 of the offline work: when the app is ONLINE it must install the
   service worker, download every required resource, and tell the truth
   about the result:

     Â· "Preparing offline access ... n/total"  while the worker pre-caches
       (progress is posted by sw.js itself during install),
     Â· "Offline-ready (N files)"               ONLY after the worker has
       answered a verification request with every single file present,
     Â· "Offline setup incomplete - N missing"  + Retry when anything is
       absent (Retry asks the worker to re-check and re-download),
     Â· "not prepared yet - connect once"       when the device is offline
       and this origin has no usable worker/cache. A browser cannot
       download an uncached site with the radio off; saying so plainly is
       the whole point of this pill.

   The verification runs INSIDE the service worker against the real cache,
   so it needs no network - a prepared device proves it is prepared in
   airplane mode, and an unprepared device never claims otherwise.

   Loaded by index.html (dashboard) and pages/login.html - the two pages a
   visit always passes through. It never throws and never blocks a page.
   Uses the app's path helper (function/paths.js, already on both pages)
   so the worker URL resolves from the app root and from pages/ alike.
   ===================================================================== */
(function (window, document) {
    'use strict';

    const ACTIVE_WAIT_MS = 25000;   // wait for a worker to activate
    const VERIFY_MS = 15000;        // wait for the worker's cache report
    const DISMISS_MS = 5000;        // error pill auto-hides after 5s
    const DISMISS_KEY = 'entOfflineReadyDismissedV1'; // sessionStorage: shown once per session
    let pill = null;
    let textEl = null;
    let detailsEl = null;
    let detailsBtn = null;
    let retryBtn = null;
    let running = false;
    let lastState = '';
    let hideTimer = null;

    function swUrl() {
        return (window.EntPaths && typeof window.EntPaths.asset === 'function')
            ? window.EntPaths.asset('sw.js')
            : 'sw.js';
    }

    /* ------------------------------------------------------------------
       Pill UI. Built with DOM calls only (no innerHTML), injected once.
       The <style> block is inline - allowed by this app's CSP
       (style-src 'self' 'unsafe-inline') - and hidden on print.
       ------------------------------------------------------------------ */
    function ensurePill() {
        if (pill && document.body.contains(pill)) return pill;
        try {
            if (!document.getElementById('entOfflineReadyStyle')) {
                const style = document.createElement('style');
                style.id = 'entOfflineReadyStyle';
                style.textContent = [
                    '#entOfflineReady{position:fixed;right:14px;bottom:14px;z-index:9999;',
                    'display:inline-flex;align-items:center;gap:8px;padding:7px 13px;',
                    'border-radius:999px;font:600 12px/1.3 system-ui,-apple-system,sans-serif;',
                    'background:#0f172a;color:#e2e8f0;box-shadow:0 4px 14px rgba(15,23,42,.35);',
                    'max-width:min(92vw,380px);transition:background .2s}',
                    '#entOfflineReady .ent-or-dot{width:9px;height:9px;border-radius:50%;',
                    'background:#64748b;flex:0 0 auto}',
                    '#entOfflineReady [hidden]{display:none!important}',
                    '#entOfflineReady.is-ready{gap:7px;padding:5px 8px 5px 9px;',
                    'font-size:11px;max-width:min(82vw,190px)}',
                    '#entOfflineReady.is-ready .ent-or-dot{width:8px;height:8px}',
                    '#entOfflineReady .ent-or-details{display:none;max-width:100%;',
                    'color:#cbd5e1;font:500 11px/1.45 system-ui,-apple-system,sans-serif}',
                    '#entOfflineReady.is-expanded{display:grid!important;grid-template-columns:9px 1fr auto;',
                    'align-items:center;column-gap:8px;row-gap:7px;max-width:min(90vw,320px)}',
                    '#entOfflineReady.is-expanded .ent-or-details{display:block;grid-column:2/4}',
                    '#entOfflineReady .ent-or-more{display:none;width:24px;height:24px;min-width:0;min-height:0;',
                    'box-sizing:border-box;',
                    'align-items:center;justify-content:center;padding:0;border:1px solid rgba(226,232,240,.25);',
                    'border-radius:50%;background:transparent;color:#e2e8f0;font:700 12px/1 system-ui,sans-serif;',
                    'cursor:pointer}',
                    '#entOfflineReady.is-ready .ent-or-more{display:inline-flex}',
                    '#entOfflineReady.is-ready .ent-or-more:hover{background:rgba(255,255,255,.12)}',
                    '#entOfflineReady.is-ready.is-expanded .ent-or-more{grid-column:3;grid-row:1}',
                    '#entOfflineReady.is-preparing .ent-or-dot{background:#38bdf8;',
                    'animation:entOrPulse .9s infinite alternate}',
                    '#entOfflineReady.is-ready .ent-or-dot{background:#22c55e}',
                    '#entOfflineReady.is-failed .ent-or-dot,',
                    '#entOfflineReady.is-needs-internet .ent-or-dot,',
                    '#entOfflineReady.is-needs-grant .ent-or-dot{background:#f59e0b}',
                    '#entOfflineReady.is-needs-internet{background:#7c2d12}',
                    '#entOfflineReady .ent-or-retry{border:0;border-radius:999px;padding:3px 10px;',
                    'font:inherit;background:#f59e0b;color:#111827;cursor:pointer}',
                    '#entOfflineReady .ent-or-retry:hover{background:#fbbf24}',
                    '@keyframes entOrPulse{from{opacity:.3}to{opacity:1}}',
                    '@media print{#entOfflineReady{display:none!important}}'
                ].join('');
                (document.head || document.body).appendChild(style);
            }
            pill = document.createElement('div');
            pill.id = 'entOfflineReady';
            pill.className = 'no-print';
            pill.setAttribute('role', 'status');
            pill.setAttribute('aria-live', 'polite');
            const dot = document.createElement('span');
            dot.className = 'ent-or-dot';
            dot.setAttribute('aria-hidden', 'true');
            textEl = document.createElement('span');
            textEl.className = 'ent-or-text';
            textEl.textContent = 'Checking offline access\u2026';
            detailsEl = document.createElement('span');
            detailsEl.className = 'ent-or-details';
            detailsEl.hidden = true;
            detailsBtn = document.createElement('button');
            detailsBtn.type = 'button';
            detailsBtn.className = 'ent-or-more';
            detailsBtn.textContent = 'i';
            detailsBtn.setAttribute('aria-label', 'Show offline access details');
            detailsBtn.setAttribute('aria-expanded', 'false');
            detailsBtn.addEventListener('click', function () {
                const expanded = pill.classList.toggle('is-expanded');
                detailsEl.hidden = !expanded;
                detailsBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
                detailsBtn.setAttribute('aria-label', expanded
                    ? 'Hide offline access details'
                    : 'Show offline access details');
            });
            retryBtn = document.createElement('button');
            retryBtn.type = 'button';
            retryBtn.className = 'ent-or-retry';
            retryBtn.textContent = 'Retry';
            retryBtn.hidden = true;
            retryBtn.addEventListener('click', function () {
                // Re-check AND ask the browser to re-download the worker
                // (update()), which restarts a failed install - the only way
                // an incomplete cache can repair itself while online.
                try {
                    navigator.serviceWorker.getRegistration().then(function (reg) {
                        if (reg && reg.update) reg.update().catch(function () { /* offline */ });
                    }).catch(function () { /* ignore */ });
                } catch (e) { /* ignore */ }
                prepare();
            });
            pill.appendChild(dot);
            pill.appendChild(textEl);
            pill.appendChild(detailsEl);
            pill.appendChild(detailsBtn);
            pill.appendChild(retryBtn);
            document.body.appendChild(pill);
        } catch (e) {
            pill = null;
        }
        return pill;
    }

    function setState(kind, text) {
        if (!ensurePill()) return;
        const stateChanged = kind !== lastState;
        if (stateChanged && hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        pill.className = 'no-print is-' + kind;
        pill.style.display = 'inline-flex';
        const isReady = kind === 'ready';
        textEl.textContent = isReady ? 'Offline-ready \u2713' : text;
        textEl.title = isReady ? text : '';
        detailsEl.textContent = text;
        detailsEl.hidden = true;
        detailsBtn.hidden = !isReady;
        detailsBtn.setAttribute('aria-expanded', 'false');
        detailsBtn.setAttribute('aria-label', 'Show offline access details');
        // Retry helps whenever something is missing or could not start; it
        // is hidden only for "ready" and for "this browser has no service
        // worker support at all" (retrying would not change that).
        retryBtn.hidden = (kind === 'ready' || kind === 'no-sw' || kind === 'needs-grant');
        lastState = kind;
        // Keep preparation and actionable states visible until the user can
        // see whether this device is ready; only transient failures fade.
        if (stateChanged && kind === 'failed') {
            hideTimer = setTimeout(function () {
                hideTimer = null;
                pill.classList.remove('is-visible');
                try { pill.style.display = 'none'; } catch (e) { /* ignore */ }
                lastState = '';
            }, DISMISS_MS);
        }
    }

    function alreadyDismissed() {
        try { return sessionStorage.getItem(DISMISS_KEY) === '1'; } catch (e) { return false; }
    }
    function markDismissed() {
        try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch (e) { /* ignore */ }
    }

    // Small introspection surface for the diagnostics panel / console.
    window.EntOfflineReady = {
        verify: function () { return prepare(); },
        state: function () { return lastState; }
    };

    /* ------------------------------------------------------------------
       Worker plumbing
       ------------------------------------------------------------------ */
    // Resolves with an ACTIVE worker for this scope, or null on timeout.
    function firstActive(ms) {
        return new Promise(function (resolve) {
            let done = false;
            const timer = setTimeout(function () { finish(null); }, ms);
            const poll = setInterval(function () {
                try {
                    navigator.serviceWorker.getRegistration().then(function (reg) {
                        if (reg && reg.active) finish(reg.active);
                    }).catch(function () { /* ignore */ });
                } catch (e) { /* ignore */ }
            }, 250);
            try {
                navigator.serviceWorker.ready.then(function (reg) {
                    if (reg && reg.active) finish(reg.active);
                }).catch(function () { /* ignore */ });
            } catch (e) { /* ignore */ }
            function finish(worker) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                clearInterval(poll);
                resolve(worker);
            }
        });
    }

    // Asks the worker to verify its own cache. MessageChannel keeps the
    // reply targeted; the timeout covers a worker that died mid-answer.
    function askWorker(worker, ms) {
        return new Promise(function (resolve) {
            let done = false;
            let channel = null;
            const timer = setTimeout(function () { finish(null); }, ms);
            function finish(report) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                try { if (channel) channel.port1.close(); } catch (e) { /* ignore */ }
                resolve(report);
            }
            try {
                if (typeof MessageChannel !== 'function') { finish(null); return; }
                channel = new MessageChannel();
                channel.port1.onmessage = function (event) {
                    const data = (event && event.data) || {};
                    finish(data.type === 'ent-offline-report' ? data : null);
                };
                worker.postMessage({ type: 'ent-verify-offline' }, [channel.port2]);
            } catch (e) {
                finish(null);
            }
        });
    }

    /* ------------------------------------------------------------------
       The whole preparation flow: register -> wait for activation ->
       verify every pre-cached file -> report honestly. Each failure mode
       gets its own wording; nothing is ever reported as ready without the
       worker's per-file proof.
       ------------------------------------------------------------------ */
    async function prepare() {
        if (running) return;
        if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
            setState('no-sw', 'Offline mode unavailable: this browser has no service worker support.');
            return;
        }
        running = true;
        try {
            const goingOffline = (navigator.onLine === false);
            setState('preparing', goingOffline
                ? 'Checking this device\u2019s offline copy\u2026'
                : 'Preparing offline access\u2026');
            let registered = true;
            try {
                await navigator.serviceWorker.register(swUrl());
            } catch (e) {
                // Offline with no registration yet, or a broken script URL:
                // firstActive below times out fast and the wording below
                // explains what is actually needed.
                registered = false;
            }
            const worker = await firstActive(registered ? ACTIVE_WAIT_MS : 4000);
            if (!worker) {
                if (navigator.onLine === false) {
                    setState('needs-internet', 'This device is not prepared for offline use yet \u2014 connect to the internet once and open the app to download it.');
                } else if (!alreadyDismissed()) {
                    markDismissed();
                    setState('failed', 'Offline setup did not finish \u2014 check your connection, then Retry.');
                }
                return;
            }
            const report = await askWorker(worker, VERIFY_MS);
            if (!report) {
                if (!alreadyDismissed()) {
                    markDismissed();
                    setState('failed', 'Could not verify the offline files \u2014 tap Retry.');
                }
                return;
            }
            if (report.ok) {
                const grant = window.EntAuth && typeof window.EntAuth.getOfflineGrant === 'function'
                    ? window.EntAuth.getOfflineGrant()
                    : null;
                if (!grant) {
                    setState('needs-grant', 'App files ready. Sign in online on this device as a Doctor or assigned Secretary to prepare offline access.');
                    return;
                }
                const expiry = new Date(grant.expiresAt);
                const date = Number.isNaN(expiry.getTime()) ? '' : ' \u00b7 access through ' +
                    new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(expiry);
                setState('ready', 'Offline-ready \u2713 (' + report.total + ' files saved)' + date);
                return;
            }
            const missing = (report.missing || []).length;
            if (navigator.onLine === false) {
                setState('needs-internet', missing + ' offline file' + (missing === 1 ? '' : 's') +
                    ' missing \u2014 connect to the internet once to repair.');
            } else if (!alreadyDismissed()) {
                setState('failed', 'Offline setup incomplete \u2014 ' + missing + ' of ' +
                    report.total + ' files missing. Tap Retry.');
                markDismissed();
            }
        } catch (e) {
            if (!alreadyDismissed()) {
                markDismissed();
                setState('failed', 'Offline setup hit a problem \u2014 tap Retry.');
            }
        } finally {
            running = false;
        }
    }

    /* ------------------------------------------------------------------
       Boot + live progress
       ------------------------------------------------------------------ */
    function start() {
        try { ensurePill(); } catch (e) { /* ignore */ }
        // Live progress posted by sw.js while it pre-caches. Guarded on
        // lastState so a late progress message from a background UPDATE can
        // never overwrite the finished "Offline-ready" state.
        try {
            navigator.serviceWorker.addEventListener('message', function (event) {
                const data = (event && event.data) || {};
                if (data.type !== 'ent-precache-progress') return;
                if (lastState !== 'preparing') return;
                if (typeof data.done === 'number' && typeof data.total === 'number') {
                    setState('preparing', 'Preparing offline access\u2026 ' + data.done + '/' + data.total);
                }
            });
        } catch (e) { /* ignore */ }
        // Re-check on connectivity changes: coming online repairs, going
        // offline re-proves the cache still holds (both answers are local).
        window.addEventListener('online', function () { prepare(); });
        window.addEventListener('offline', function () { prepare(); });
        prepare();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }

})(window, document);
