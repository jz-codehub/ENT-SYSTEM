// Final end-to-end validation of the offline-buttons repair.
const fs = require('fs');
const { execSync } = require('child_process');
let failures = 0;
function check(ok, label) {
    console.log((ok ? '  PASS  ' : '  FAIL  ') + label);
    if (!ok) failures++;
}

// 1. Every source JS parses (same as node --check, batched).
try {
    const files = fs.readdirSync('function').filter((f) => f.endsWith('.js')).map((f) => 'function/' + f);
    files.push('sw.js', 'build-pages.mjs');
    for (const f of files) execSync(`node --check "${f}"`, { stdio: 'pipe' });
    check(true, 'all ' + files.length + ' source JS files parse');
} catch (e) {
    check(false, 'source JS parse: ' + String(e.stderr || e.message).slice(0, 300));
}

// 2. dist/index.js is the repaired file.
const distIndex = fs.readFileSync('dist/function/index.js', 'utf8');
check(!distIndex.includes('catch (canvasError)'), 'dist index.js has no intruded catch block');
check(distIndex.includes('close: closeOfflineModal') && !distIndex.includes('closeOfflineRecordsModal'),
    'dist index.js exposes closeOfflineModal (undefined name gone)');
check(distIndex.trimEnd().endsWith('})(window);'), 'dist index.js ends with the offline-viewer IIFE');
check(distIndex.indexOf('OFFLINE RECORDS VIEWER') > distIndex.indexOf('html2canvas fallback'),
    'offline viewer lives AFTER the PDF fallback, not inside it');

// 3. dist/sw.js cache completeness.
const distSw = fs.readFileSync('dist/sw.js', 'utf8');
check(distSw.includes("ent-report-system-v35d-offline-complete"), 'sw cache name bumped to v35d');
check(distSw.includes('ignoreSearch: true'), 'offline fallback matches ignoreSearch');
const listMatch = distSw.match(/const FILES_TO_CACHE = \[([\s\S]*?)\];/);
const entries = listMatch[1].split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith("'") || l.startsWith('"'))
    .map((l) => l.replace(/^['"]|['"],?$/g, ''));
check(entries.length > 0, 'parsed ' + entries.length + ' FILES_TO_CACHE entries');
const missing = entries.filter((e) => {
    let p = e.replace(/^\.\//, '');
    if (p === '' || p === 'index.html') p = 'index.html';
    return !fs.existsSync('dist/' + p) && !fs.existsSync(p);
});
check(missing.length === 0, 'every pre-cache file exists in dist (one 404 = whole SW install dies)'
    + (missing.length ? ' | MISSING: ' + missing.join(', ') : ''));

// 4. The three form pages carry repaired script versions + button ids.
for (const page of ['pages/nasalEndoscopy.html', 'pages/laryngealEndoscopy.html', 'pages/cf4Form.html']) {
    const html = fs.readFileSync('dist/' + page, 'utf8');
    check(html.includes('draftsBrowser.js?v=v35b'), page + ': draftsBrowser at v35b');
    const needsIndex = page !== 'pages/cf4Form.html';
    check(!needsIndex || html.includes('index.js?v=v35b'), page + ': index.js at v35b');
    for (const id of ['saveDataBtn', 'localDraftsBtn', 'saveToDbBtn', 'dbRecordsBtn']) {
        check(html.includes('id="' + id + '"'), page + ': #' + id + ' present');
    }
}

// 5. Ownership handshake: draftsBrowser yields at click time, viewer claims at load.
const db = fs.readFileSync('dist/function/draftsBrowser.js', 'utf8');
check(db.includes('if (browseButton.dataset.offlineBound) return;'),
    'draftsBrowser yields localDraftsBtn at CLICK time');
check(db.includes("browseButton.dataset.draftsBound = 'true'"), 'draftsBrowser still binds cf4 path');
check(distIndex.includes("btn.dataset.offlineBound = 'true'"),
    'offline viewer claims localDraftsBtn (offlineBound)');

console.log(failures ? ('\n' + failures + ' FAILURE(S)') : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
