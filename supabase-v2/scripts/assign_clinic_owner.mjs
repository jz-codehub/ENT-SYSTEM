// FIX: the migration left managed_by = NULL on the clinics it created, so
// ent_admin_covers_clinic() stopped covering them and the admin's user list
// collapsed to one clinic. The Edge Function always sets managed_by = the
// creating admin; the script did not. This assigns the real admin.
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
const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' }
async function rest(p, o = {}) {
  const r = await fetch(`${BASE}/rest/v1/${p}`, { ...o, headers: { ...H, ...(o.headers || {}) },
    signal: AbortSignal.timeout(60000) })
  const t = await r.text()
  if (!r.ok) throw new Error(r.status + ' ' + t.slice(0, 200))
  return t ? JSON.parse(t) : null
}
const APPLY = process.argv.includes('--apply')

const staff = await rest('staff_profiles?select=id,username,full_name,role,clinic_id')
const clinics = await rest('clinics?select=id,code,name,managed_by&order=name')
// The owner is the ONE real administrator: an admin whose full_name carries no
// synthetic/test marker. Picking the first admin blindly would have handed
// every clinic to testadmin, which is the failure this avoids.
const owner = staff.find(s => s.role === 'admin'
  && !/synthetic|test|fixture|dummy/i.test(String(s.full_name || '')))
if (!owner) { console.log('No real administrator found - refusing.'); process.exit(1) }

const orphans = clinics.filter(c => !c.managed_by)
console.log('\n==== ASSIGN CLINIC OWNER ====\n')
console.log('  owner: ' + owner.username + '  (' + owner.full_name + ')')
console.log('  clinics with no owner: ' + orphans.length + '\n')
for (const c of orphans) {
  const n = staff.filter(s => s.clinic_id === c.id).length
  console.log('  ' + String(c.name).padEnd(34) + n + ' people  ->  ' + owner.username)
}
if (!APPLY) { console.log('\nDRY RUN. Re-run with --apply.'); console.log(''); process.exit(0) }

for (const c of orphans) {
  await rest('clinics?id=eq.' + c.id, {
    method: 'PATCH', body: JSON.stringify({ managed_by: owner.id })
  })
}
console.log('\n  assigned ' + orphans.length + ' clinics to ' + owner.username)

// prove it
const after = await rest('clinics?select=id,name,managed_by&order=name')
const covered = after.filter(c => c.id === owner.clinic_id || c.managed_by === owner.id)
const ids = new Set(covered.map(c => c.id))
const visible = staff.filter(s => ids.has(s.clinic_id))
console.log('  ' + owner.username + ' now sees ' + visible.length + ' of ' + staff.length + ' staff')
for (const v of staff.filter(s => !ids.has(s.clinic_id))) {
  console.log('    STILL MISSING: ' + v.username + ' (' + v.role + ')')
}
console.log('')