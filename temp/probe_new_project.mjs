/* temp/probe_new_project.mjs — READ-ONLY status probe of the NEW Supabase
   project (bvzuraltazxtaxnmbmcr). Uses ONLY the anon key from
   scripts/.env.local and answers three questions per object:
     · table exists?   REST: 42P01/404 = missing, 42501/403 = exists (RLS/
                        grants block anon, which is correct), 200 = readable
     · rpc exists?      42883/404 = missing, others = deployed
     · row counts       Range 0-0 + count=exact = header only, no payload
   Writes nothing. Prints no key material (only ref/role claims). */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const envPath = join(HERE, '..', 'supabase-v2', 'scripts', '.env.local')
const env = {}
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
}
const BASE = (env.SUPABASE_URL || '').replace(/\/+$/, '')
const ANON = env.SUPABASE_ANON_KEY || ''
if (!BASE || !ANON) { console.error('missing .env.local'); process.exit(1) }
const ref = (() => { try { return JSON.parse(Buffer.from(ANON.split('.')[1], 'base64url').toString('utf8')).ref } catch { return '?' } })()
console.log(`NEW PROJECT: ${BASE}  (key minted for ref=${ref})`)

const H = { apikey: ANON, Authorization: `Bearer ${ANON}` }
async function table(name) {
  const r = await fetch(`${BASE}/rest/v1/${name}?select=*&limit=1`, {
    headers: { ...H, Prefer: 'count=exact', Range: '0-0' },
  })
  const txt = await r.text()
  if (r.status === 404 || txt.includes('42P01')) return { exists: false, note: 'missing' }
  if (r.status === 403 || txt.includes('42501')) return { exists: true, note: 'exists (blocked for anon = RLS/grants on)' }
  if (r.ok) {
    const m = /content-range:[^\n]*\/(\d+)/i.exec([...r.headers.entries()].map(e => e.join(':')).join('\n'))
    return { exists: true, note: `READABLE by anon (!) count=${m ? m[1] : '?'}` }
  }
  return { exists: true, note: `HTTP ${r.status} ${txt.slice(0, 120)}` }
}
async function rpc(name) {
  const r = await fetch(`${BASE}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}',
  })
  const txt = await r.text()
  if (r.status === 404 || txt.includes('42883') || txt.includes('PGRST202')) return 'missing'
  return `present (HTTP ${r.status}: ${txt.slice(0, 100)})`
}

const TABLES = ['clinics', 'staff_profiles', 'reports', 'report_photos', 'activity_logs',
  'system_flags', 'tickets', 'report_access_requests', 'report_access_grants',
  'secretary_assignments', 'user_sessions']
console.log('\n--- tables (anon probe) ---')
for (const t of TABLES) { const x = await table(t); console.log(`  ${t.padEnd(26)} ${x.exists ? 'YES' : 'no '}  ${x.note}`) }

const FNS = ['ent_default_clinic_id', 'ent_capability', 'ent_is_my_doctor',
  'ent_my_clinic_ids', 'ent_deleted_reports', 'ent_may_soft_delete',
  'set_assignments', 'get_assignments', 'ent_request_report']
console.log('\n--- functions (rpc probe) ---')
for (const f of FNS) console.log(`  ${f.padEnd(26)} ${await rpc(f)}`)

const funcs = ['auth-admin', 'patient-photos']
console.log('\n--- edge functions ---')
for (const f of funcs) {
  const r = await fetch(`${BASE}/functions/v1/${f}`, { method: 'OPTIONS' })
  console.log(`  ${f.padEnd(26)} HTTP ${r.status}`)
}

console.log('\n--- storage buckets ---')
{
  const r = await fetch(`${BASE}/storage/v1/bucket`, { headers: H })
  const txt = await r.text()
  console.log(`  GET /storage/v1/bucket -> HTTP ${r.status}: ${txt.slice(0, 300)}`)
}
