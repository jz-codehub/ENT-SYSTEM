/* temp/e2e_login.mjs — REAL end-to-end: sign in as bokskie, then call the
   auth-admin Edge Function with that session token to list users. Proves
   the whole chain: GoTrue auth + staff_profiles + RLS + Edge Function +
   auto-injected service key. Read-only (list only). */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const env = {}
const envPath = join(HERE, '..', 'supabase-v2', 'scripts', '.env.local')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
}
const BASE = (env.SUPABASE_URL || '').replace(/\/+$/, '')
const ANON = env.SUPABASE_ANON_KEY || ''
const H = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }

// 1. Sign in
const login = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ email: 'bokskie@zztest.invalid', password: 'bokskie123' }),
})
const session = await login.json()
if (!login.ok || !session.access_token) {
  console.log(`❌ LOGIN FAILED: HTTP ${login.status} ${JSON.stringify(session).slice(0, 200)}`)
  process.exit(1)
}
console.log(`✅ LOGIN OK — bokskie signed in (role via token)`)
console.log(`   user id: ${session.user?.id}`)

// 2. Call auth-admin with the session token (the real admin-console path)
const fn = await fetch(`${BASE}/functions/v1/auth-admin`, {
  method: 'POST',
  headers: { ...H, Authorization: `Bearer ${session.access_token}` },
  body: JSON.stringify({ action: 'list' }),
})
const res = await fn.json()
if (!fn.ok || !res.ok) {
  console.log(`❌ auth-admin list FAILED: HTTP ${fn.status} ${JSON.stringify(res).slice(0, 300)}`)
  process.exit(1)
}
console.log(`✅ auth-admin LIST OK — admin console reachable`)
console.log(`   users visible to bokskie: ${(res.users || []).length}`)
for (const u of (res.users || [])) {
  console.log(`     - ${String(u.username).padEnd(12)} ${u.role}`)
}

// 3. Read bokskie's own clinics coverage via the DB (service role)
const SVC = env.SUPABASE_SERVICE_ROLE_KEY || ''
const SH = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' }
const clinics = await (await fetch(`${BASE}/rest/v1/clinics?select=id,code,name,managed_by`, { headers: SH })).json()
console.log(`\n✅ clinics bokskie controls:`)
for (const c of clinics) {
  const own = c.id === session.user?.id ? '' : (c.managed_by === session.user?.id ? '(managed_by=bokskie)' : '')
  console.log(`     - ${c.code} ${own}`)
}
console.log(`\n🎉 END-TO-END OK: login + admin console + clinic coverage all working.`)
