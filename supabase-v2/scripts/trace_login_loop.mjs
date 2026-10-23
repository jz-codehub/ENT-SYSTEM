/* Read-only: replays the real URL-handling functions from auth.js and
   login.html for the URLs in question. Nothing is modified or fetched. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const auth = readFileSync(join(ROOT, 'function', 'auth.js'), 'utf8')
const login = readFileSync(join(ROOT, 'pages', 'login.html'), 'utf8')

// --- pull the REAL bodies out of the source so this cannot drift --------
const PUBLIC_PAGES = eval((auth.match(/const PUBLIC_PAGES = (\[[^\]]*\])/) || [, '[]'])[1])

const currentPageFileSrc = auth.match(/function currentPageFile\(\)\s*\{([\s\S]*?)\n    \}/)
const guardSrc = auth.match(/function guard\(options\)\s*\{([\s\S]*?)\n        if \(opts\.roles/)
const bootSrc = auth.match(/async function boot\(\)\s*\{([\s\S]*?)\n        startHeartbeat\(\)/)
const targetSrc = login.match(/function targetPage\(\)\s*\{([\s\S]*?)\n        \}/)
const landingSrc = login.match(/function landingPage\(user\)\s*\{([\s\S]*?)\n        \}/)

console.log('PUBLIC_PAGES (auth.js:37) = ' + JSON.stringify(PUBLIC_PAGES) + '\n')

function currentPageFile(pathname) {
  let path = (pathname || '').split('/').pop() || ''
  if (!path) return 'index.html'
  return decodeURIComponent(path).toLowerCase()
}
function targetPage(search) {
  const raw = new URLSearchParams(search || '').get('next') || ''
  const name = decodeURIComponent(raw).split('?')[0].split('/').pop() || ''
  return /^[a-z0-9_-]+\.html$/i.test(name) ? name : ''
}
function landingPage(user, search) {
  const next = targetPage(search)
  if (next && next !== 'login.html') return next
  return user && user.role === 'admin' ? 'admin.html' : 'index.html'
}

console.log('=== 1. currentPageFile() for each URL ===')
for (const u of [
  'http://localhost:5500/login.html',
  'http://localhost:5500/login',
  'http://localhost:5500/login.html?next=login',
  'http://localhost:5500/',
  'http://localhost:5500/admin.html',
]) {
  const p = new URL(u).pathname
  const f = currentPageFile(p)
  console.log('  ' + u.padEnd(44) + ' pathname=' + p.padEnd(16) +
    ' currentPageFile()=' + String(f).padEnd(14) +
    ' in PUBLIC_PAGES? ' + (PUBLIC_PAGES.indexOf(f) !== -1 ? 'YES -> boot() returns early' : 'NO  -> boot() PROCEEDS'))
}

console.log('\n=== 2. does any code ever navigate to a bare "/login"? ===')
const bare = [...auth.matchAll(/location\.(href|replace|assign)\(\s*[`'"]([^`'"]*)/g)]
  .map(m => ({ file: 'auth.js', line: auth.slice(0, m.index).split('\n').length, target: m[2] }))
  .concat([...login.matchAll(/location\.(href|replace|assign)\(\s*[`'"]([^`'"]*)/g)]
    .map(m => ({ file: 'login.html', line: login.slice(0, m.index).split('\n').length, target: m[2] })))
for (const r of bare) {
  const hits = /\blogin\.html\b/.test(r.target)
  console.log('  ' + (r.file + ':' + r.line).padEnd(18) + JSON.stringify(r.target).padEnd(42) +
    (hits ? 'uses login.html' : 'OTHER'))
}
console.log('  -> any target equal to bare "login" (no .html)? ' +
  (bare.some(r => r.target.trim() === '/login' || r.target.trim() === 'login') ? 'YES' : 'NO'))

console.log('\n=== 3. login.html: targetPage() / landingPage() for ?next=login ===')
for (const s of ['?next=login', '?next=admin.html', '?next=', '']) {
  console.log('  ' + (s || '(none)').padEnd(18) + ' targetPage()=' + JSON.stringify(targetPage(s)).padEnd(14) +
    ' landingPage(admin)=' + JSON.stringify(landingPage({ role: 'admin' }, s)))
}

console.log('\n=== 4. the loop, step by step (signed OUT, browser at bare /login) ===')
console.log('  1  browser at  /login  -> currentPageFile()=' + currentPageFile('/login') +
  '  NOT in PUBLIC_PAGES')
console.log('  2  boot() does NOT return early, so it awaits ready()')
console.log('  3  ready() -> buildSafeUser() -> null (no session)')
console.log('  4  auth.js:608  window.location.replace("login.html?next=login")')
console.log('  5  server rewrites /login.html back to /login')
console.log('  6  back to step 1  ->  INFINITE LOOP')
console.log('\n  signed IN at bare /login:')
console.log('  3  ready() -> a user, so boot() does NOT redirect; loop stops.')