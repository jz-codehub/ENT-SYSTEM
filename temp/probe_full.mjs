/* temp/probe_full.mjs — READ-ONLY post-migration verification of the NEW
   project. Confirms (anon key only, no secret printed):
     · tables exist (401 = exists + RLS on; 42P01 = missing)
     · the 0041 functions + key RPCs exist (rpc probe)
     · edge functions deployed (OPTIONS preflight)
     · storage bucket exists
   Writes nothing. */
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
console.log(`target: ${BASE}\n`)

async function table(name) {
  const r = await fetch(`${BASE}/rest/v1/${name}?select=*&limit=1`, {
    headers: { ...H, Prefer: 'count=exact', Range: '0-0' },
  })
  const txt = await r.text()
  if (r.status === 404 || txt.includes('42P01')) return 'MISSING'
  if (r.status === 401) return 'exists (RLS on) ✅'
  if (r.status === 403 || txt.includes('42501')) return 'exists (grants on) ✅'
  if (r.ok) return `READABLE (${txt.slice(0, 40)})`
  return `HTTP ${r.status}`
}
async function rpc(name, body = '{}') {
  const r = await fetch(`${BASE}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: H, body,
  })
  const txt = await r.text()
  if (r.status === 404 || txt.includes('42883') || txt.includes('PGRST202')) return 'MISSING'
  // A function that EXISTS but refuses (no auth / bad args) still proves it's there.
  return `present (HTTP ${r.status})`
}

console.log('--- tables ---')
for (const t of ['clinics', 'staff_profiles', 'reports', 'report_photos', 'activity_logs',
  'system_flags', 'tickets', 'report_access_requests', 'secretary_assignments']) {
  console.log(`  ${t.padEnd(24)} ${await table(t)}`)
}

console.log('\n--- functions (0041 + core RPCs) ---')
for (const f of ['ent_possible_duplicates', 'ent_is_my_doctor', 'ent_deleted_reports',
  'ent_may_soft_delete', 'ent_capability', 'ent_default_clinic_id', 'my_assigned_doctors']) {
  console.log(`  ${f.padEnd(24)} ${await rpc(f)}`)
}

console.log('\n--- edge functions ---')
for (const f of ['auth-admin', 'patient-photos']) {
  const r = await fetch(`${BASE}/functions/v1/${f}`, { method: 'OPTIONS' })
  console.log(`  ${f.padEnd(24)} HTTP ${r.status} ${r.status === 404 ? '(NOT deployed yet)' : '(deployed)'}`)
}

console.log('\n--- storage ---')
{
  const r = await fetch(`${BASE}/storage/v1/bucket`, { headers: H })
  const txt = await r.text()
  console.log(`  buckets: ${txt.slice(0, 200)}`)
}
