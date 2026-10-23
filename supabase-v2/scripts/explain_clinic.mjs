/* What is a clinic_id? Show both clinics, who belongs to each, and how
   many reports each holds. Read-only. */
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

const clinics = await (await fetch(BASE + '/rest/v1/clinics?select=id,code,name,is_active&order=code', { headers: H })).json()
const staff = await (await fetch(BASE + '/rest/v1/staff_profiles?select=username,role,clinic_id&order=username', { headers: H })).json()
const reports = await (await fetch(BASE + '/rest/v1/reports?select=clinic_id&limit=1000', { headers: H })).json()

console.log('\n==== WHAT IS A clinic_id? ====\n')
for (const c of clinics) {
  const members = staff.filter(s => s.clinic_id === c.id)
  const count = (Array.isArray(reports) ? reports : []).filter(r => r.clinic_id === c.id).length
  console.log(c.id)
  console.log('  code    : ' + c.code)
  console.log('  name    : ' + c.name)
  console.log('  active  : ' + c.is_active)
  console.log('  staff   : ' + members.length + '  ->  ' +
    members.map(s => s.username + '(' + s.role + ')').join(', '))
  console.log('  reports : ' + count)
  console.log('')
}

// The helper the migration ships for "give me the main clinic".
console.log('  helper: public.ent_default_clinic_id() -> SELECT id FROM clinics WHERE code=\'main_clinic\'')
console.log('  (a real clinic is a ROW you can change; the uuid here is only a fixed seed value)\n')
