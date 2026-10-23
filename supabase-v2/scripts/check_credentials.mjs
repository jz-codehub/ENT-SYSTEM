/* Verify every credential pair in .env.local against the live project.
   Sign-in only — nothing is changed. */
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
const SVC = env.SUPABASE_SERVICE_ROLE_KEY
const H = { apikey: SVC, Authorization: 'Bearer ' + SVC, 'Content-Type': 'application/json' }

const PAIRS = [
  ['TEST_EMAIL', 'TEST_PASSWORD'],
  ['LIVE_TESTADMIN', 'LIVE_TESTADMIN_PW'],
  ['LIVE_TESTDOC2', 'LIVE_TESTDOC2_PW'],
  ['LIVE_TESTSEC1', 'LIVE_TESTSEC1_PW'],
  ['LIVE_ZZBADMIN', 'LIVE_ZZBADMIN_PW'],
  ['LIVE_ZCBDOC1', 'LIVE_ZCBDOC1_PW'],
]

console.log('LIVE CREDENTIAL CHECK  (sign-in only, nothing modified)\n')
for (const [ek, pk] of PAIRS) {
  const email = env[ek], pw = env[pk]
  if (!email || !pw) { console.log(pad(ek) + '  no value'); continue }
  const r = await fetch(BASE + '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pw }), signal: AbortSignal.timeout(15000) })
  const j = await r.json().catch(() => ({}))
  let role = '?', gate = ''
  if (j.access_token) {
    const p = await (await fetch(BASE + '/rest/v1/staff_profiles?id=eq.' + j.user.id +
      '&select=username,role,must_change_password,is_active',
      { headers: { apikey: ANON, Authorization: 'Bearer ' + j.access_token } })).json()
    if (Array.isArray(p) && p[0]) {
      role = p[0].role + (p[0].is_active === false ? ' (INACTIVE)' : '')
      gate = p[0].must_change_password ? 'MUST CHANGE PASSWORD' : 'ready'
    }
  }
  const ok = !!j.access_token
  console.log(pad(ek) + '  HTTP ' + String(r.status).padEnd(4) +
    (ok ? '  SIGN-IN OK   ' : '  REFUSED      ') +
    'role=' + pad2(role) + '  ' + gate)
}
function pad(s) { return String(s).padEnd(20) }
function pad2(s) { return String(s).padEnd(16) }

console.log('\nBrowsing: open http://localhost:5500/pages/login.html')
console.log('Username may be typed as the bare name OR the full email —')
console.log('auth.js:toEmail() appends @zztest.invalid automatically.')