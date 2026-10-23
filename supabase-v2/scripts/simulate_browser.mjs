/* End-to-end simulation of what the BROWSER now does, using the real
   query from auth.js and the real landingPage() from login.html.
   Read-only: signs in and reads, writes nothing. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const env = {}
for (const line of readFileSync(join(HERE, '.env.local'), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const BASE = env.SUPABASE_URL.replace(/\/+$/, '')
const ANON = env.SUPABASE_ANON_KEY
const ROOT = join(HERE, '..', '..')

/* --- the real select list, read out of auth.js --- */
const authSrc = readFileSync(join(ROOT, 'function', 'auth.js'), 'utf8')
const block = authSrc.match(/'staff_profiles\?select=id,username[\s\S]*?must_change_password'/)
const SELECT = block[0].replace(/'staff_profiles\?select=/, '')
  .replace(/'\s*\+\s*$/, '').replace(/';/, '')
  .replace(/'\s*\+\s*'/g, '').replace(/'/g, '')

/* --- the real landingPage(), rebuilt from login.html --- */
const loginSrc = readFileSync(join(ROOT, 'pages', 'login.html'), 'utf8')
function extractFn(src, name) {
  const at = src.indexOf('function ' + name + '(')
  const open = src.indexOf('{', at)
  let d = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++
    else if (src[i] === '}') { d--; if (d === 0) return src.slice(at, i + 1) }
  }
}
globalThis.window = { location: { search: '' } }
const landingPage = new Function('return (function(){' +
  extractFn(loginSrc, 'targetPage') + '\n' + extractFn(loginSrc, 'landingPage') +
  '\nreturn landingPage;})()')()

const ACCOUNTS = [
  ['testadmin', 'LIVE_TESTADMIN', 'LIVE_TESTADMIN_PW'],
  ['zzbadmin', 'LIVE_ZZBADMIN', 'LIVE_ZZBADMIN_PW'],
  ['testdoc1', 'TEST_EMAIL', 'TEST_PASSWORD'],
  ['testdoc2', 'LIVE_TESTDOC2', 'LIVE_TESTDOC2_PW'],
  ['testsec1', 'LIVE_TESTSEC1', 'LIVE_TESTSEC1_PW'],
  ['zcbdoc1', 'LIVE_ZCBDOC1', 'LIVE_ZCBDOC1_PW']
]

console.log('\n==== FULL BROWSER SIMULATION (auth.js query + login.html redirect) ====\n')
let bad = 0
for (const [name, ek, pk] of ACCOUNTS) {
  const s = await fetch(BASE + '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env[ek], password: env[pk] }),
    signal: AbortSignal.timeout(20000)
  })
  const sj = await s.json().catch(() => ({}))
  if (!sj.access_token) { console.log('  ' + name.padEnd(11) + 'SIGN-IN REFUSED'); bad++; continue }

  // Step 1 - loadProfile(): the self-filtered read
  const r = await fetch(BASE + '/rest/v1/staff_profiles?select=' + SELECT +
    '&id=eq.' + encodeURIComponent(sj.user.id), {
    headers: { apikey: ANON, Authorization: 'Bearer ' + sj.access_token },
    signal: AbortSignal.timeout(20000)
  })
  const row = (await r.json().catch(() => []))[0]

  // Step 2 - buildSafeUser() then landingPage()
  const user = row ? Object.assign({}, row, { id: row.id, email: sj.user.email }) : null
  const chip = user
    ? (user.role === 'admin' ? 'ADMIN + gear link' : user.role.toUpperCase())
    : 'no user'

  // Two ways in: typed the URL, or bounced off index.html
  globalThis.window.location.search = ''
  const direct = landingPage(user)
  globalThis.window.location.search = '?next=index.html'
  const bounced = landingPage(user)

  const want = user && user.role === 'admin' ? 'admin.html' : 'index.html'
  const good = direct === want && bounced === want
  if (!good) bad++
  console.log('  ' + name.padEnd(11) + (good ? 'PASS' : 'FAIL') +
    '  chip=' + chip.padEnd(16) +
    'typed->' + direct.padEnd(13) + 'bounced->' + bounced.padEnd(13) +
    (good ? '' : ' EXPECTED ' + want))
}
console.log('\n  ' + (bad ? bad + ' account(s) FAILED' : 'all 6 accounts route correctly, typed and bounced'))
console.log()
process.exitCode = bad ? 1 : 0
