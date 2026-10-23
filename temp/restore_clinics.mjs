import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const env = {}
for (const l of readFileSync(join(HERE, '..', 'supabase-v2', 'scripts', '.env.local'), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)
  if (m) env[m[1]] = m[2].trim()
}
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }
const BASE = env.SUPABASE_URL.replace(/\/+$/, '')
async function call(path, opts = {}) {
  const r = await fetch(BASE + path, { headers: H, ...opts })
  const t = await r.text()
  let j = null
  try { j = JSON.parse(t) } catch { j = t }
  if (!r.ok) throw new Error(`${path} -> ${r.status}: ${String(t).slice(0, 300)}`)
  return j
}
const BK = join(HERE, '..', 'supabase-v2', 'backup', 'v2-2026-10-11T23-44-19-717Z')
const oldClinics = JSON.parse(readFileSync(join(BK, 'clinics.json'), 'utf8'))
// bokskie NEW id (admin, owner of all restored clinics)
const NEW_BOKSKIE = 'ed732a03-3aa9-491c-8fcd-0466cb818300'
// clinics to restore: skip the 2 placeholders (00000000...) + 3 test clinics
const SKIP = new Set(['00000000-0000-4000-8000-00000000c11c', '00000000-0000-4000-8000-00000000c21c',
  'f07b0583-edf0-4622-ba79-71b8d877c96b', '04bbded8-d7dc-43a7-af0f-8779d69940aa', 'e733777d-50da-479f-8fd2-71d01dbd5eaa'])
const keep = oldClinics.filter(c => !SKIP.has(c.id))
// NEW staff by username -> fix clinic_id to OLD clinic mapping
const OLD = {
  jess: '29db7cfc-4e8a-4c9e-b710-a3803e97cdb8', monique: '0100fed6-1395-41d8-bb4c-5682fbe24c5c',
  kaye: '5efde838-cfa1-41f0-aec7-27eff442ee3e', larson: '86871574-f27c-45e0-8df6-eb7db3a6bf07',
  josh: 'bed08de3-4835-4070-8547-1054c40c9302',
  elma: '29db7cfc-4e8a-4c9e-b710-a3803e97cdb8', lilian: '29db7cfc-4e8a-4c9e-b710-a3803e97cdb8',
  tara: '29db7cfc-4e8a-4c9e-b710-a3803e97cdb8', lian: '0100fed6-1395-41d8-bb4c-5682fbe24c5c',
  wafa: 'bed08de3-4835-4070-8547-1054c40c9302', gina: '29db7cfc-4e8a-4c9e-b710-a3803e97cdb8',
}
// FIX chicken-and-egg: clinics FIRST with managed_by=NULL, then staff clinic fix, then managed_by update.
console.log('restoring ' + keep.length + ' clinics (managed_by=NULL first):')
for (const c of keep) {
  const row = { id: c.id, code: c.code, name: c.name, address: c.address || '', is_active: true, managed_by: null }
  await call('/rest/v1/clinics?on_conflict=id', { method: 'POST', body: JSON.stringify(row) })
  console.log('  ok ' + c.id.slice(0, 8) + ' ' + c.name)
}
// ORDER: staff clinic fix, then managed_by update.
for (const [u, cid] of Object.entries(OLD)) {
  await call('/rest/v1/staff_profiles?username=eq.' + u, { method: 'PATCH', body: JSON.stringify({ clinic_id: cid }) })
  console.log('  staff ' + u + ' -> clinic ' + cid.slice(0, 8))
}
for (const c of keep) {
  await call('/rest/v1/clinics?id=eq.' + c.id, { method: 'PATCH', body: JSON.stringify({ managed_by: NEW_BOKSKIE }) })
}
console.log('  managed_by -> bokskie for ' + keep.length + ' clinics')
// secretary -> doctor assignments (assigned_doctor_id needs NEW doctor ids)
const staff = await call('/rest/v1/staff_profiles?select=id,username')
const byU = Object.fromEntries(staff.map(s => [s.username, s.id]))
const ASSIGN = { elma: 'jess', lilian: 'jess', tara: 'jess', gina: 'jess', lian: 'monique', wafa: 'josh' }
for (const [s, d] of Object.entries(ASSIGN)) {
  await call('/rest/v1/staff_profiles?username=eq.' + s, { method: 'PATCH', body: JSON.stringify({ assigned_doctor_id: byU[d] }) })
  console.log('  secretary ' + s + ' -> doctor ' + d)
}
console.log('CLINICS + STAFF MAPPING DONE')
