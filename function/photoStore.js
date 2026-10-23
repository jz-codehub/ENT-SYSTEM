/* =====================================================================
   PHOTO STORE  -  FINAL endoscopy photos in the private Supabase bucket
   ---------------------------------------------------------------------
   Phase A only. Drafts and local photos are untouched; this module is used
   by "Save to Database" (upload) and by opening a record (download).

   WHAT THIS MODULE DELIBERATELY DOES NOT KNOW
     * the service_role key  - it only exists inside the Edge Function
     * the clinic id         - the server reads it from the user's row
     * any bucket name       - that is the server's business

   The browser talks to the Edge Function and nothing else. It can never
   reach Supabase Storage directly, so a patient photo has no public URL.
   ===================================================================== */
(function (window) {
    'use strict';

    const FLAG_KEY = 'entFeaturePhotoStorage';
    const MAX_PHOTOS = 6;

    /* ------------------------------------------------------------------
       COMPRESSION  -  the ONE place a photograph is made small.

       A capture arrives as a 2-8 MB PNG/JPEG. Left alone it does two kinds
       of damage:
         * inline (photo_storage off) it fills the ~5 MB a browser allows
           localStorage, so two drafts exhaust the budget and
           draftsBrowser.js has to strip photos off the older drafts; and
         * in the bucket it makes every download and every reopen heavy.

       Compressing HERE, once, is also what keeps the two copies identical:
       the base64 that goes into a draft is the same file that is uploaded,
       so a draft opened on another device looks exactly like the one that
       was saved on this one.

       WebP is used whenever the browser can encode it (Chrome, Edge,
       Firefox, Safari 14+). Where it cannot, JPEG at the same quality is
       used instead - the photograph is never dropped, and never left
       uncompressed, just because the browser is old.

       Nothing here can throw. A failure hands back the ORIGINAL data URL,
       so an unsupported browser degrades to yesterday's behaviour instead
       of losing the picture.
       ------------------------------------------------------------------ */
    const COMPRESS = {
        // Longest side, px. A photo occupies about 48% of an A4 width, which
        // is roughly 1000 px at 300 dpi - so 1600 keeps real diagnostic
        // detail and still lands a typical capture inside the size band.
        maxDim: 1600,
        // Top of the 300-700 KB band. Also far inside the server's 10 MB
        // per-photo ceiling and the bucket's own limit.
        maxBytes: 700 * 1024,
        startQuality: 0.85,
        minQuality: 0.5,
        qualityStep: 0.07,
        frameStep: 0.8,
        maxFrames: 3
    };

    // Exact byte count of a base64 data URL, without decoding it.
    function dataUrlBytes(dataUrl) {
        const text = String(dataUrl || '');
        const comma = text.indexOf(',');
        if (comma < 0) return 0;
        const b64 = text.slice(comma + 1);
        const pad = b64.slice(-2) === '==' ? 2 : b64.slice(-1) === '=' ? 1 : 0;
        return Math.max(0, Math.floor(b64.length * 3 / 4) - pad);
    }

    function dataUrlMime(dataUrl) {
        const found = /^data:([^;,]+)/i.exec(String(dataUrl || ''));
        return found ? found[1].toLowerCase() : '';
    }

    // Probed once per page. A canvas that cannot encode WebP silently
    // substitutes PNG when image/webp is asked for, which is exactly how the
    // capability is detected - so no user-agent string decides this.
    let webpEncodable = null;
    function canEncodeWebp() {
        if (webpEncodable !== null) return webpEncodable;
        webpEncodable = false;
        try {
            const probe = document.createElement('canvas');
            probe.width = 1;
            probe.height = 1;
            webpEncodable = /^data:image\/webp/i.test(probe.toDataURL('image/webp'));
        } catch (error) { webpEncodable = false; }
        return webpEncodable;
    }

    function loadImage(dataUrl) {
        return new Promise(function (resolve) {
            try {
                const img = new Image();
                img.onload = function () { resolve(img); };
                img.onerror = function () { resolve(null); };
                img.src = dataUrl;
            } catch (error) { resolve(null); }
        });
    }

    function scaleToCanvas(img, width, height) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width));
        canvas.height = Math.max(1, Math.round(height));
        const ctx = canvas.getContext('2d');
        // White underneath: an endoscopy frame is often a transparent PNG,
        // and transparency turns black the moment it is coded as JPEG.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas;
    }

    // A result for a photo that is deliberately left as it came in.
    function unchanged(dataUrl, img, reason) {
        return {
            ok: true,
            dataUrl: dataUrl,
            bytes: dataUrlBytes(dataUrl),
            width: img ? img.width : 0,
            height: img ? img.height : 0,
            mime: dataUrlMime(dataUrl),
            quality: null,
            compressed: false,
            reason: reason || ''
        };
    }

    /* ------------------------------------------------------------------
       One image in, one smaller image out.

       The search is deliberately TWO-DIMENSIONAL and bounded:
         1. shrink the frame (0.8x each round, at most 3 rounds), and
         2. lower the quality (0.85 -> 0.50 in 0.07 steps)
       stopping the moment the result fits the band. Quality is spent before
       pixels only when a single quality drop is enough, because a little
       softer is far kinder to a diagnostic image than a smaller frame.

       Returns { ok, dataUrl, bytes, width, height, mime, quality,
       compressed, reason }. `ok:false` means "use the original" - it never
       means the photo failed.
       ------------------------------------------------------------------ */
    async function compressImage(input, options) {
        const config = { ...COMPRESS, ...(options || {}) };
        const original = String(input || '');
        if (!original || original.indexOf('data:image') !== 0) {
            return { ok: false, dataUrl: original, bytes: dataUrlBytes(original), reason: 'not-an-image' };
        }

        const img = await loadImage(original);
        // No dimensions to work from: leave it exactly as it is.
        if (!img || !img.width || !img.height) return unchanged(original, img, 'unreadable');

        const size = Math.max(img.width, img.height);
        const fitsAlready = size <= config.maxDim && dataUrlBytes(original) <= config.maxBytes;
        // A small photo that is already inside the band is not re-encoded:
        // every re-encode loses a little detail, so there is nothing to gain.
        if (fitsAlready) return unchanged(original, img, 'already-small');

        const ratio = size > config.maxDim ? config.maxDim / size : 1;
        const canvas = scaleToCanvas(img, img.width * ratio, img.height * ratio);
        const mime = canEncodeWebp() ? 'image/webp' : 'image/jpeg';

        let best = null;
        let quality = config.startQuality;
        let frameScale = 1;
        let scale = 1;
        let source = canvas;

        for (let frame = 0; frame < config.maxFrames; frame++) {
            quality = config.startQuality;
            while (quality >= config.minQuality - 1e-9) {
                let encoded = '';
                try { encoded = source.toDataURL(mime, Number(quality.toFixed(2))); }
                catch (error) { encoded = ''; }
                if (encoded && encoded.indexOf('data:image') === 0) {
                    const bytes = dataUrlBytes(encoded);
                    // Keep the smallest attempt seen so far: if the band is
                    // never reached, the best attempt still ships.
                    if (!best || bytes < best.bytes) {
                        best = { dataUrl: encoded, bytes, quality: Number(quality.toFixed(2)), scale };
                    }
                    if (bytes <= config.maxBytes) {
                        return {
                            ok: true,
                            dataUrl: encoded,
                            bytes,
                            width: canvas.width,
                            height: canvas.height,
                            mime,
                            quality: Number(quality.toFixed(2)),
                            compressed: true,
                            reason: ''
                        };
                    }
                }
                quality -= config.qualityStep;
            }
            // The band was not reached at this frame size, so spend pixels.
            const nextScale = scale * config.frameStep;
            if (nextScale <= 0.2) break;
            frameScale = nextScale / scale;
            source = scaleToCanvas(source, source.width * frameScale, source.height * frameScale);
            scale = nextScale;
        }

        if (!best) return unchanged(original, img, 'encode-failed');
        // Never hand back something BIGGER than what came in - that would be
        // compression that costs space, which is the one outcome nobody wants.
        const originalBytes = dataUrlBytes(original);
        if (best.bytes >= originalBytes) return unchanged(original, img, 'not-smaller');
        return {
            ok: true,
            dataUrl: best.dataUrl,
            bytes: best.bytes,
            width: canvas.width,
            height: canvas.height,
            mime,
            quality: best.quality,
            compressed: true,
            reason: ''
        };
    }

    // The whole set, in order. `onProgress(done, total)` lets a caller keep a
    // label honest on a slow phone. Order is preserved so photo 1 stays
    // photo 1 in the report.
    async function compressMany(images, options, onProgress) {
        const list = Array.isArray(images) ? images : [];
        const out = [];
        for (let i = 0; i < list.length; i++) {
            out.push(await compressImage(list[i], options));
            if (typeof onProgress === 'function') onProgress(i + 1, list.length);
        }
        return out;
    }

    function config() {
        const supa = window.EntSupabase;
        if (!supa || typeof supa.getConfig !== 'function' || !supa.isConfigured()) return null;
        const cfg = supa.getConfig();
        if (!cfg || !cfg.supabaseUrl) return null;
        return { base: String(cfg.supabaseUrl).replace(/\/+$/, ''), anonKey: cfg.supabaseAnonKey };
    }

    /* ------------------------------------------------------------------
       FEATURE FLAG - Phase A stays OFF until it is tested end to end.
       localStorage.entFeaturePhotoStorage = 'on'   turns it on.
       ------------------------------------------------------------------ */
    // The AUTHORITATIVE switch lives on the server (`system_flags.photo_storage`
    // / ent_capability() read inside the Edge Function). The localStorage key is
    // only a convenience - it lets a page show or hide a control with no round
    // trip - and it can never unlock anything the server refuses.
    //
    // `serverFlag` is the server's answer, cached for the page and refreshed by
    // refreshCapability(). It stays `null` until a probe succeeds, and `null`
    // means OFF, so a network failure keeps the previous (safe) behaviour of
    // keeping photos inline instead of accidentally switching storage on.
    let serverFlag = null;

    function isEnabled() {
        try {
            if (window.localStorage.getItem(FLAG_KEY) === 'on') return true;
        } catch (error) { /* fall through to the server's answer */ }
        return serverFlag === true;
    }

    // Ask the Edge Function what the SERVER thinks. Never throws: a failure
    // leaves the cached answer untouched, so a caller cannot be broken by it.
    async function refreshCapability() {
        try {
            const result = await call({ action: 'capabilities' });
            serverFlag = !!(result && result.capabilities && result.capabilities.photo_storage);
        } catch (error) {
            // Unreachable, signed out, or an older function without the
            // action: keep whatever was known before.
        }
        return serverFlag;
    }

    function setEnabled(on) {
        try {
            window.localStorage.setItem(FLAG_KEY, on ? 'on' : 'off');
        } catch (error) { /* ignore */ }
    }

    /* ------------------------------------------------------------------
       TOKEN — v2 has no minted bridge token.

       v1 kept `entBridgeTokenV1` in localStorage: a bearer token the
       server had minted for the browser to replay at the Edge Function.
       That was a second credential to store, steal and leak.

       v2 sends the CALLER'S OWN Supabase session JWT, read live from
       supabase-js. Nothing is stored here, so signing out really does
       take this door with it — there is no orphaned token left behind.
       ------------------------------------------------------------------ */
    async function token() {
        if (!window.EntSupabase || typeof window.EntSupabase.getAccessToken !== 'function') return '';
        try { return (await window.EntSupabase.getAccessToken()) || ''; } catch (error) { return ''; }
    }

    // Kept so auth.js's clearSession() has something to call. In v2 there is
    // nothing to clear: the session belongs to supabase-js.
    function setToken() { /* no-op in v2 — see above */ }
    function clearToken() { /* no-op in v2 — see above */ }

    // One request to the Edge Function. Nothing here can be pointed at a
    // different clinic: there is no clinic parameter to pass — the function
    // reads the caller's report and stamps the clinic server-side.
    async function call(payload) {
        const cfg = config();
        if (!cfg) throw new Error('Cloud sync is not configured on this device.');
        // v2: the caller's own Supabase JWT, not a minted bridge token.
        const jwt = await token();
        if (!jwt) throw new Error('Sign in before using photo storage.');
        const response = await fetch(`${cfg.base}/functions/v1/patient-photos`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: cfg.anonKey || '',
                Authorization: `Bearer ${jwt}`
            },
            body: JSON.stringify(payload || {})
        });
        let body = null;
        try { body = await response.json(); } catch (error) { body = null; }
        if (!response.ok || !body || body.ok === false) {
            const message = (body && body.error) || `Photo service refused the request (${response.status}).`;
            const failure = new Error(message);
            failure.status = response.status;
            failure.details = body;
            // Surface `code` as well as the message, so the caller can tell
            // "not switched on yet" from a genuine failure.
            failure.code = (body && body.code) || '';
            throw failure;
        }
        return body;
    }

    /* ------------------------------------------------------------------
       UPLOAD  -  used by "Save to Database".
       `reportRef` is the report the photos belong to: a reports.id (uuid),
       or a record_key the service will resolve. The report row MUST already
       exist - report_photos.report_id is a real foreign key - so the caller
       writes the row first and uploads second.
       Returns { ok, paths, count } or { ok:false, code, error }.
       A failure here MUST stop the database save; the caller checks ok.
       ------------------------------------------------------------------ */
    async function uploadAll(images, reportRef, onProgress) {
        const list = Array.isArray(images) ? images.filter((i) => typeof i === 'string' && i.indexOf('data:image') === 0) : [];
        if (!isEnabled()) {
            // Reached only when the caller did not check first. Answered as a
            // typed refusal rather than a generic failure, so a caller can tell
            // "not switched on yet" apart from a real upload error.
            return { ok: false, skipped: true, code: 'PHOTO_STORAGE_DISABLED', reason: 'Photo storage is switched off.' };
        }
        if (!list.length) return { ok: true, paths: [], count: 0 };
        if (list.length > MAX_PHOTOS) return { ok: false, error: `A report can hold ${MAX_PHOTOS} photos.` };
        if (!reportRef) return { ok: false, error: 'Missing report reference.' };

        if (typeof onProgress === 'function') onProgress(0, list.length);
        try {
            // Last chance to be small. The form compresses at attach time, so
            // in practice these are already WebP inside the band and
            // compressImage returns them untouched ('already-small'). This
            // catches a photo that arrived some other way - pasted from the
            // clipboard, loaded from a draft saved by an older build, or a
            // record opened for re-save.
            const sized = await compressMany(list, {}, function (done, total) {
                if (typeof onProgress === 'function') onProgress(done, total);
            });
            const ready = sized.map((result, i) => (result && result.ok && result.dataUrl) || list[i]);
            // v2 payload contract (patient-photos Edge Function). Read from the
            // function's own source rather than the design note, because the
            // two disagreed and the FUNCTION is the truth:
            //     bytes = base64ToBytes(item?.data || item?.base64)
            //     mime  = String(item?.mime || '')
            //     name  = String(item?.name || '')
            //     index = Number(item?.index)
            // So the fields are `data`, `mime` and `index` — NOT `data_base64`.
            // Sending data_base64 produced zero-length bytes and every upload
            // was rejected as "not a readable image".
            //
            // `mime` is only the DECLARED label: step 4b re-sniffs the actual
            // bytes and refuses a mismatch, so this cannot smuggle anything.
            // The EXTENSION must agree with it too. validatePhoto() in
            // _shared/auth.ts compares extFromName(name) against
            // extFromMime(mime) and rejects a disagreement, so a WebP named
            // ".jpg" would be refused on EVERY upload. Derived from the mime
            // for exactly that reason.
            const EXT_FOR_MIME = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg' };
            const photos = ready.map(function (dataUrl, i) {
                const comma = String(dataUrl).indexOf(',');
                const mime = (/^data:([^;]+);/i.exec(String(dataUrl)) || [])[1] || 'image/jpeg';
                const lower = String(mime).toLowerCase();
                return {
                    name: 'photo-' + (i + 1) + '.' + (EXT_FOR_MIME[lower] || 'jpg'),
                    data: comma > -1 ? String(dataUrl).slice(comma + 1) : String(dataUrl),
                    mime: lower,
                    index: i + 1
                };
            });
            const result = await call({
                action: 'upload',
                report_id: reportRef,
                photos: photos,
                photo_count: photos.length
            });
            if (typeof onProgress === 'function') onProgress(list.length, list.length);
            return { ok: true, paths: result.paths || [], count: result.count || 0 };
        } catch (error) {
            // Whatever went wrong, the record must not be saved. Any files that
            // did reach the bucket are left alone on purpose (Phase A never
            // deletes), and the local draft is untouched.
            if (typeof onProgress === 'function') onProgress(list.length, list.length);
            console.error('[PhotoStore] Upload failed:', error);
            return {
                ok: false,
                error: error.message,
                details: error.details || null,
                status: error.status || 0,
                // `code` is what lets a caller tell "the server has photo
                // storage switched off" (safe to ignore) apart from a real
                // failure (must not be ignored).
                code: error.code || ''
            };
        }
    }

    /* ------------------------------------------------------------------
       DOWNLOAD  -  used when opening a record.
       Gives back base64, which is exactly what the form and the PDF code
       already expect. Nothing downstream has to know where the photo came
       from.
       ------------------------------------------------------------------ */
    /* ------------------------------------------------------------------
       DOWNLOAD  -  used when opening a record.
       Gives back base64, which is exactly what the form and the PDF code
       already expect. Nothing downstream has to know where the photo came
       from.

       The Edge Function answers with an ARRAY OF OBJECTS
       `[{ path, mime, base64, bytes }]`, not an array of data URLs. Handing
       those straight to the form would make every <img> src an
       "[object Object]", and index.js restores a record with
       `data.images.filter(img => typeof img === 'string')` - so the photos
       were silently DROPPED on open. The conversion has to happen here, in
       the one place that knows the response shape.
       ------------------------------------------------------------------ */
    async function downloadAsBase64(paths) {
        const list = Array.isArray(paths) ? paths.filter(Boolean).map(String) : [];
        if (!isEnabled() || !list.length) return [];
        try {
            const result = await call({ action: 'download', paths: list });
            const rows = Array.isArray(result.images) ? result.images : [];
            return rows.map(function (row) {
                // A string is already a data URL - accept it either way so
                // this cannot break if the response shape is simplified later.
                if (typeof row === 'string') return row;
                if (!row || typeof row !== 'object') return '';
                const raw = row.base64 || row.data || row.dataUrl || '';
                if (!raw) return '';
                if (raw.indexOf('data:') === 0) return raw;
                const mime = /^image\//i.test(String(row.mime || '')) ? String(row.mime).toLowerCase() : 'image/jpeg';
                return 'data:' + mime + ';base64,' + raw;
            }).filter(Boolean);
        } catch (error) {
            console.error('[PhotoStore] Could not fetch photos:', error);
            throw error;
        }
    }

    /* ------------------------------------------------------------------
       LIST / REMOVE — v2 added these; the function resolves paths from the
       report row rather than trusting whatever the browser names.
       ------------------------------------------------------------------ */
    async function listPaths(reportId) {
        const result = await call({ action: 'list', report_id: reportId });
        const rows = Array.isArray(result.photos) ? result.photos
            : Array.isArray(result.rows) ? result.rows : [];
        return rows.map(function (r) {
            return (r && (r.object_path || r.path)) || '';
        }).filter(Boolean);
    }

    async function removeOne(path) {
        return await call({ action: 'remove', path: path });
    }

    // v1 could ask the server to mint short-lived preview URLs. v2 returns the
    // bytes (or nothing), so this is gone rather than silently broken.
    async function signedUrls() { return []; }

    /* ------------------------------------------------------------------
       Rehydrate a record before the form sees it.
       OLD records already carry base64 and are returned untouched.
       NEW records carry photo_paths and are fetched here.
       ------------------------------------------------------------------ */
    async function rehydrate(record) {
        const formData = (record && record.formData) || {};
        const existing = Array.isArray(formData.images) ? formData.images.filter(Boolean) : [];
        if (existing.length) return { ...formData, images: existing };     // old base64 record
        const paths = (record && (record.photo_paths || record.photoPaths)) || [];
        if (!paths.length) return { ...formData, images: [] };
        const images = await downloadAsBase64(paths);
        return { ...formData, images, photosFromStorage: true };
    }

    async function health() {
        // v1 asked a separate `clinic-bridge` function. v2 has two functions
        // only — auth-admin and patient-photos — and patient-photos answers
        // `health` itself, so there is no third endpoint to call.
        try {
            const jwt = await token();
            if (!jwt) return { ok: false, error: 'signed out' };
            const result = await call({ action: 'health' });
            return { ok: true, ...result };
        } catch (error) {
            return { ok: false, error: error.message, code: error.code || '' };
        }
    }

    // The anon runtime runs with the flag still off, so downloadAll would have
    // returned an empty list instead of the server's answer. Turn it on so the
    // refusal that comes back is the real one, not the feature flag.
    async function askAnyway(payload) {
        const wasOn = isEnabled();
        if (!wasOn) setEnabled(true);
        try {
            return await call(payload);
        } finally {
            if (!wasOn) setEnabled(false);
        }
    }

    window.EntPhotoStore = {
        isEnabled,
        setEnabled,
        refreshCapability,
        uploadAll,
        downloadAsBase64,
        listPaths,
        removeOne,
        rehydrate,
        health,
        askAnyway,
        call,
        // Compression - the single place a photo is made small. Exposed so
        // the forms can shrink at ATTACH time rather than only at save time,
        // which is what keeps a draft's base64 and a bucket's object
        // identical instead of two different sizes of the same photo.
        compressImage,
        compressMany,
        dataUrlBytes,
        COMPRESS,
        // Kept as no-ops so existing callers do not break; see token().
        setToken,
        clearToken,
        token,
        MAX_PHOTOS,
        FLAG_KEY
    };
})(window);
