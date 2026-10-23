/* List every live account: clinics, staff_profiles roles, auth.users.
   Read-only - prints a table, changes nothing. */
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
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY }

const clinics = await (await fetch(BASE + '/rest/v1/clinics?select=id,code,name', { headers: H })).json()
const profiles = await (await fetch(BASE +
  '/rest/v1/staff_profiles?select=id,username,full_name,role,is_active,must_change_password,specialty,license_no,clinic_id,assigned_doctor_id&order=username',
  { headers: H })).json()
const raw = await (await fetch(BASE + '/auth/v1/admin/users?per_page=200', { headers: H })).json()
const users = Array.isArray(raw) ? raw : (raw.users || [])

console.log('\n================ CLINICS ================')
for (const c of clinics) console.log('  ' + String(c.code).padEnd(18) + c.name)

console.log('\n============= STAFF PROFILES (' + profiles.length + ') =============')
console.log('  ' + 'USERNAME'.padEnd(13) + 'ROLE'.padEnd(11) + 'ACTIVE'.padEnd(9) +
  'MUSTCHG'.padEnd(9) + 'CLINIC'.padEnd(17) + 'ASSIGNED TO')
for (const p of profiles) {
  const target = p.assigned_doctor_id
    ? profiles.find(x => x.id === p.assigned_doctor_id)?.username : null
  console.log('  ' + String(p.username).padEnd(13) + String(p.role).padEnd(11) +
    String(p.is_active).padEnd(9) + String(p.must_change_password).padEnd(9) +
    String(clinics.find(c => c.id === p.clinic_id)?.code || '?').padEnd(17) + (target || '-'))
}

console.log('\n================ AUTH.USERS (' + users.length + ') ================')
for (const u of users) {
  console.log('  ' + String(u.email).padEnd(32) +
    'confirmed=' + (u.email_confirmed_at ? 'yes' : 'NO ') +
    '  meta_role=' + (u.app_metadata?.role || '-') +
    '  clinic=' + (u.app_metadata?.clinic_code || '-'))
}

const orphanUsers = users.filter(u => !profiles.some(p => p.id === u.id))
if (orphanUsers.length) {
  console.log('\n!! auth.users rows with NO staff_profiles row (orphans):')
  for (const u of orphanUsers) console.log('   ' + u.email)
}
console.log()
