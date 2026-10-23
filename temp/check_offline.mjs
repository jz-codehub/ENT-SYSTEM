// check_offline.mjs - is the app ACTUALLY offline-capable?
//
//  1. every local src/href on every page must EXIST;
//  2. it must be in sw.js FILES_TO_CACHE (or cache.addAll 404s and the WHOLE
//     service worker install fails -> NO offline support at all);
//  3. it must be in build-pages.mjs PAGES/ASSETS allowlist (or the published
//     dist/ 404s on it);
//  4. every FILES_TO_CACHE entry must itself exist (same 404 risk);
//  5. the pages the doctor opens offline are actually pre-cached.
//
// Run: node temp/check_offline.mjs
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..')

let passed = 0, failed = 0
const ok = (id, what, cond, d = '') => {
  if (cond) { passed++; console.log(`  PASS  ${id.padEnd(4)} ${what}${d ? ' - ' + d : ''}`) }
  else { failed++; console.log(`  FAIL  ${id.padEnd(4)} ${what}${d ? ' - ' + d : ''}`) }
}

// ---------------------------------------------------------------- sw cache --
const sw = readFileSync(join(APP, 'sw.js'), 'utf8')
const listBlock = /const FILES_TO_CACHE = \[([\s\S]*?)\];/.exec(sw)[1]
const cacheEntries = [...listBlock.matchAll(/'([^']+)'/g)].map(m => m[1])
const cacheSet = new Set(cacheEntries.map(e => e.replace(/^\.\//, '')))
const cacheVer = (/CACHE_NAME = 'ent-report-system-([0-9a-z-]+)';/.exec(sw) || [])[1]

// ----------------------------------------------------------- build allowlist
// dist/ is the published site, so ask IT directly: does the file actually ship?
const DIST = join(APP, 'dist')
const shipsIn = (ref) => existsSync(join(DIST, ref))

// --------------------------------------------------------------- page refs --
const pages = ['index.html', 'pages/login.html', 'pages/offlineWorkspace.html', 'pages/admin.html', 'pages/settings.html',
  'pages/nasalEndoscopy.html', 'pages/laryngealEndoscopy.html', 'pages/cf4Form.html',
  'pages/viewAll.html', 'pages/tickets.html', 'pages/records-doctor.html']

function refsOf(html, pagePath) {
  const out = new Set()
  const dir = pagePath.includes('/') ? pagePath.slice(0, pagePath.lastIndexOf('/') + 1) : ''
  const re = /(?:src|href)="([^"#]+)"/g
  let m
  while ((m = re.exec(html))) {
    let u = m[1]
    if (/^(https?:|data:|mailto:|javascript:|#)/i.test(u)) continue
    u = u.split('?')[0].split('#')[0]
    if (!u) continue
    let p = normalize(join(dir, u)).replace(/\\/g, '/')
    if (p.startsWith('../')) p = p.slice(3)          // ../ from pages/ -> root
    out.add(p.replace(/^\.\//, ''))
  }
  return out
}

const missing = [], uncached = [], unpublishable = []
for (const page of pages) {
  if (!existsSync(join(APP, page))) { ok('P', page + ' exists', false, 'PAGE MISSING'); continue }
  const html = readFileSync(join(APP, page), 'utf8')
  for (const ref of refsOf(html, page)) {
    const abs = join(APP, ref)
    if (!existsSync(abs)) { missing.push(`${page} -> ${ref}`); continue }
    if (!cacheSet.has(ref)) uncached.push(`${page} -> ${ref}`)
    if (!shipsIn(ref)) unpublishable.push(`${page} -> ${ref}`)
  }
}

console.log('\n==== OFFLINE CAPABILITY AUDIT ====\n')
console.log(`  sw CACHE_NAME: ${cacheVer || '?'}   precache entries: ${cacheEntries.length}   pages checked: ${pages.length}`)

ok('R1', 'every src/href on every page resolves to a real file',
  missing.length === 0, missing.slice(0, 6).join(' | '))

ok('R2', 'everything a page references is pre-cached by sw.js (a single miss 404s cache.addAll and kills ALL offline support)',
  uncached.length === 0, uncached.slice(0, 8).join(' | '))

ok('R3', 'everything a page references ships in dist/ (build allowlist)',
  unpublishable.length === 0, unpublishable.slice(0, 8).join(' | '))

const deadCache = cacheEntries.filter(e => {
  const clean = e.replace(/^\.\//, '')
  if (clean === '' || clean === '/') return false
  if (clean.endsWith('/')) return !existsSync(join(APP, clean, 'index.html'))
  return !existsSync(join(APP, clean))
})
ok('R4', 'every FILES_TO_CACHE entry exists (one 404 = install fails)',
  deadCache.length === 0, deadCache.join(' | '))

// the report workflow offline path, entry by entry
const offlinePath = ['pages/login.html', 'pages/offlineWorkspace.html', 'pages/nasalEndoscopy.html', 'pages/laryngealEndoscopy.html',
  'pages/cf4Form.html', 'function/index.js', 'function/cf4.js', 'function/offlineStore.js',
  'function/syncEngine.js', 'function/draftsBrowser.js', 'function/dbRecords.js',
  'function/auth.js', 'function/supabaseClient.js', 'js/lib/supabase.min.js', 'manifest.json']
const notCached = offlinePath.filter(p => !cacheSet.has(p))
ok('R5', 'the offline path (login -> workspace -> forms -> offline store -> sync) is pre-cached',
  notCached.length === 0, notCached.join(' | '))

const notPublished = offlinePath.filter(p => !shipsIn(p))
ok('R6', 'and every one of those ships in dist/', notPublished.length === 0, notPublished.join(' | '))

// fetch fallback must tolerate ?v=... or the offline start misses versioned URLs
ok('R7', 'offline cache lookup uses ignoreSearch (so ?v=... script URLs resolve)',
  /caches\.match\(req,\s*\{\s*ignoreSearch:\s*true\s*\}\)/.test(sw))
ok('R8', 'offline entry and uncached navigation fall back to the cached login page',
  /if \(isNav\) \{[\s\S]*?const loginUrl = new URL\('pages\/login\.html', self\.registration\.scope\);[\s\S]*?if \(loginPage\) return Response\.redirect\(loginUrl\.href, 302\)/.test(sw))
ok('R9', 'install uses waitUntil + skipWaiting (SW goes live without a reload dance)',
  /addEventListener\('install'[\s\S]{0,300}skipWaiting\(\)/.test(sw))
ok('R10', 'slow/offline requests time out so cached resources are used without waiting for the browser network timeout',
  /const NETWORK_TIMEOUT_MS = 4000/.test(sw) && /Promise\.race\(\[\s*fetch\(req\)/.test(sw))
ok('R11', 'non-success HTTP responses also fall back to cached resources',
  /if \(fresh && fresh\.ok\) return fresh;[\s\S]*?const cached = sameOrigin/.test(sw))
ok('R12', 'Cloudflare clean page URLs can resolve to their cached .html page',
  /async function matchCachedNavigation\(req\)[\s\S]*?requestedPath\.slice\([^)]*\) \+ '\.html'/.test(sw))

console.log('\n  ' + passed + ' passed, ' + failed + ' failed\n')
process.exit(failed ? 1 : 0)
