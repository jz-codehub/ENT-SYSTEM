/* temp/probe_login.mjs — READ-ONLY login-path diagnostic of the NEW
   project. Answers, without a browser:
     1. is GoTrue alive?      POST /auth/v1/token with dummy creds
     2. does the schema exist? GET /rest/v1/staff_profiles (anon)
     3. do the login page's tables exist? (clinics, system_flags …)
   No secret is printed. */
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
console.log(`target: ${BASE}`)
const H = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }

// 1. GoTruth
try {
  const r = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ email: 'probe@ent-clinic.invalid', password: 'WrongPassword123!' }),
  })
  console.log(`  1. GoTrue /auth/v1/token  -> HTTP ${r.status}  ${(await r.text()).slice(0, 160)}`)
} catch (e) { console.log(`  1. GoTrue ERROR: ${e.message}`) }

// 2. the schema the login page needs
for (const t of ['staff_profiles', 'clinics', 'system_flags', 'secretary_assignments']) {
  try {
    const r = await fetch(`${BASE}/rest/v1/${t}?select=id&limit=1`, { headers: H })
    const txt = await r.text()
    let verdict
    if (r.status === 404 || txt.includes('42P01')) verdict = 'MISSING (schema not applied)'
    else if (r.status === 401) verdict = 'HTTP 401 (no valid token — normal for anon without login)'
    else if (r.status === 403 || txt.includes('42501')) verdict = 'EXISTS (blocked for anon = RLS/grants on)'
    else if (r.ok) verdict = `READABLE: ${txt.slice(0, 80)}`
    else verdict = `HTTP ${r.status}: ${txt.slice(0, 120)}`
    console.log(`  2. ${t.padEnd(22)} ${verdict}`)
  } catch (e) { console.log(`  2. ${t.padEnd(22)} ERROR: ${e.message}`) }
}
