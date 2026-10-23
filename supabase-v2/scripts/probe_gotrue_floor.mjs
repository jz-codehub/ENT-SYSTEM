/* auth-admin blocked everything under 10, so the live probe never reached
   GoTrue. This asks GoTrue DIRECTLY (service-role createUser) what its own
   floor is, so lowering the app limit to 3 cannot land on a confusing
   server-side rejection. Every account made here is deleted afterwards. */
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
const SVC = env.SUPABASE_SERVICE_ROLE_KEY
const AH = { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }
const SH = { apikey: SVC, Authorization: 'Bearer ' + SVC, 'Content-Type': 'application/json' }

const stamp = Date.now().toString().slice(-7)
const created = []

console.log('\n==== GoTrue\'S OWN PASSWORD FLOOR (direct createUser) ====\n')
for (const pw of ['a', 'ab', 'abc', 'abcd', 'abcde', 'abcdef']) {
  const email = 'zzfloor' + pw.length + stamp + '@zztest.invalid'
  const r = await fetch(BASE + '/auth/v1/admin/users', {
    method: 'POST', headers: SH,
    body: JSON.stringify({ email, password: pw, email_confirm: true }),
    signal: AbortSignal.timeout(20000)
  })
  const j = await r.json().catch(() => ({}))
  const ok = r.ok && !!j.id
  if (ok) created.push(j.id)
  console.log('  ' + String(pw.length).padStart(2) + ' chars  ' + pw.padEnd(8) +
    'HTTP ' + String(r.status).padEnd(4) + (ok ? 'ACCEPTED' : (j.msg || j.message || j.error_description || JSON.stringify(j)).slice(0, 64)))
}

// And prove an accepted one really signs in, then delete them all.
console.log('')
for (const pw of ['abc', 'abcdef']) {
  const email = 'zzfloor' + pw.length + stamp + '@zztest.invalid'
  const s = await fetch(BASE + '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: AH,
    body: JSON.stringify({ email, password: pw }), signal: AbortSignal.timeout(15000)
  })
  console.log('  sign-in with ' + pw.length + ' chars -> HTTP ' + s.status +
    (s.ok ? '  WORKS' : '  refused'))
}

console.log('')
if (created.length) {
  for (const id of created) {
    await fetch(BASE + '/auth/v1/admin/users/' + id,
      { method: 'DELETE', headers: SH, signal: AbortSignal.timeout(20000) })
  }
  console.log('  cleaned up ' + created.length + ' probe account(s)')
}
console.log()
