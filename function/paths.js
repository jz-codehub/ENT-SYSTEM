/* =====================================================================
   PATHS  —  one place that knows where this page sits.

   WHY THIS FILE EXISTS
   The app root holds index.html plus the folders below it. Every OTHER
   page lives in pages/, one level down. So the same relative link means
   two different things depending on which document you are standing in:

       from  /index.html        "style/auth.css"  ->  /style/auth.css
       from  /pages/login.html  "style/auth.css"  ->  /pages/style/auth.css  (404)

   The shared modules under function/ are loaded by BOTH kinds of page -
   auth.js guards every page, index.js and cf4.js run on the form pages -
   and a browser resolves a relative URL against the DOCUMENT, never
   against the script. So a hardcoded "js/lib/jspdf.umd.min.js" works on
   one page and 404s on the other, and the failure is silent: the page
   still renders, the library is simply missing when the user hits Print.

   Rather than scatter "../" and page-name guessing through every shared
   module, each page asks this one for the prefix it needs. The prefix is
   derived from the page's own URL, so it is correct by construction and
   needs no per-page configuration.

   USAGE
       <script src="function/paths.js"></script>     (before the others)
       EntPaths.base                 '../' or './'
       EntPaths.asset('style/x.css') '../style/x.css' or './style/x.css'
       EntPaths.page('admin.html')   '../pages/admin.html' or './pages/admin.html'
       EntPaths.page('index.html')   '../index.html' or './index.html'  <- stays at root

   index.html is deliberately NOT moved into pages/. It is the app entry
   point: the service worker falls back to it, manifest.json points
   start_url at it, and it is what a bare "/" has to serve. A page that
   lives one level deeper is just a page; the root one is the app.
   ===================================================================== */
(function (window) {
    'use strict';

    // The last path segment of this document, lowercased, no extension.
    // '' for "/" or "/index.html" -> treated as the root page.
    function currentFile() {
        var path = String((window.location && window.location.pathname) || '');
        var file = path.split('/').pop() || '';
        file = decodeURIComponent(file).toLowerCase();
        return file.replace(/\.html?$/, '');
    }

    var file = currentFile();

    // In pages/ unless this IS the root index. Anything else (a page added
    // later at the root) is treated as the root page, which is the safe
    // default: base './' resolves app-root assets correctly and only
    // page() would need a look.
    var IN_PAGES = file !== '' && file !== 'index';

    var BASE = IN_PAGES ? '../' : './';

    window.EntPaths = {
        /** '../' from a page in pages/, './' from the app root. */
        base: BASE,

        /** True when this document is inside pages/. */
        inPages: IN_PAGES,

        /**
         * A URL for a file that lives at the APP ROOT - style/, function/,
         * js/, css/, image/, sw.js, manifest.json. Used by the shared
         * modules, which must work from either depth.
         *
         * Anything that is not a plain relative path is returned untouched:
         * absolute URLs, protocol-relative ones, and data:/blob: URIs. That
         * last case is load-bearing - a clinic logo the user uploaded is
         * stored as a data: URI, and prefixing it would corrupt it.
         */
        asset: function (path) {
            if (!path) return BASE;
            if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path;   // http:, data:, blob:
            if (path.charAt(0) === '/' || path.indexOf('//') === 0) return path;
            // Already carries its own relative prefix: leave it alone.
            if (path.indexOf('./') === 0 || path.indexOf('../') === 0) return path;
            return BASE + path;
        },

        /**
         * A URL for another PAGE. index.html stays at the app root; every
         * other page lives in pages/. This is what replaces a hardcoded
         * "admin.html" in a redirect.
         */
        page: function (name) {
            if (!name) return BASE + 'index.html';
            if (/^[a-z][a-z0-9+.-]*:/i.test(name) || name.charAt(0) === '/') return name;
            if (name.indexOf('//') === 0) return name;
            if (name.indexOf('./') === 0 || name.indexOf('../') === 0) return name;
            var file2 = String(name).split('?')[0].split('#')[0].split('/').pop();
            var stem = decodeURIComponent(file2).toLowerCase().replace(/\.html?$/, '');
            if (stem === 'index') return BASE + 'index.html';
            // Already names a page inside pages/ - do not double it up.
            if (/(^|\/)pages\//i.test(name)) return BASE + name;
            return BASE + 'pages/' + name;
        },

        /** This document's own filename, lowercased, no extension. */
        current: function () {
            return file;
        }
    };

})(window);
