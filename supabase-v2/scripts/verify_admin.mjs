/* Prove the admin role is REAL, not just a label in staff_profiles:
   sign in as each account and ask the auth-admin Edge Function what it
   thinks that account may do. Read-only (action:'capabilities' and
   action:'list' change nothing). */
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
const H = { apikey: ANON, Authorization: 'Bearer ' + ANON, 'Content-Type': 'application/json' }

const ACCOUNTS = [
  ['testadmin', 'LIVE_TESTADMIN', 'LIVE_TESTADMIN_PW'],
  ['zzbadmin', 'LIVE_ZZBADMIN', 'LIVE_ZZBADMIN_PW'],
  ['testdoc1', 'TEST_EMAIL', 'TEST_PASSWORD'],
  ['testdoc2', 'LIVE_TESTDOC2', 'LIVE_TESTDOC2_PW'],
  ['testsec1', 'LIVE_TESTSEC1', 'LIVE_TESTSEC1_PW'],
  ['zcbdoc1', 'LIVE_ZCBDOC1', 'LIVE_ZCBDOC1_PW']
]

async function fn(payload, token, origin) {
  const r = await fetch(BASE + '/functions/v1/auth-admin', {
    method: 'POST',
    headers: {
      ...H,
      Origin: origin,
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000)
  })
  const j = await r.json().catch(() => ({}))
  return { status: r.status, json: j }
}

console.log('\n==== DOES THE ROLE ACTUALLY GRANT ADMIN? (live Edge Function) ====\n')
for (const [name, ek, pk] of ACCOUNTS) {
  const email = env[ek], pw = env[pk]
  if (!email || !pw) { console.log('  ' + name.padEnd(10) + ' no creds in .env.local'); continue }

  const s = await fetch(BASE + '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: H, body: JSON.stringify({ email, password: pw }),
    signal: AbortSignal.timeout(20000)
  })
  const sj = await s.json().catch(() => ({}))
  if (!sj.access_token) { console.log('  ' + name.padEnd(10) + ' SIGN-IN REFUSED'); continue }
  const token = sj.access_token

  // 'list' is the admin-only directory read. Admin must get 200 + rows.
  const l = await fn({ action: 'list' }, token, 'http://localhost:5500')
  const rows = Array.isArray(l.json?.users) ? l.json.users.length
    : Array.isArray(l.json?.data) ? l.json.data.length : 0
  const verdict = l.status === 200 && rows > 0 ? 'ADMIN  ' : 'not admin'
  console.log('  ' + name.padEnd(10) + 'sign-in OK   auth-admin{list} -> HTTP ' +
    String(l.status).padEnd(4) + (l.json?.code ? 'code=' + l.json.code + ' ' : '') +
    'rows=' + rows + '   => ' + verdict)
}
console.log()
