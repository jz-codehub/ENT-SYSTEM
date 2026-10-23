/* temp/check_clinic_owner.mjs — verify (and repair) admin clinic coverage.
   An admin covers a clinic when ent_admin_covers_clinic() is true, i.e.
   me.clinic_id = p_clinic OR clinics.managed_by = me.id.
   The main_clinic seeded by 0002 has managed_by = NULL, so we set
   managed_by = <admin> on EVERY clinic, guaranteeing the admin owns
   them all. Uses the service-role key from .env.local (local, gitignored).
   READ first, then WRITE only the managed_by repair. */
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
const SVC = env.SUPABASE_SERVICE_ROLE_KEY || ''
const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' }
const j = async (p, o = {}) => {
  const r = await fetch(BASE + '/rest/v1/' + p, { headers: H, ...o })
  const t = await r.text()
  if (!r.ok) throw new Error(`${o.method || 'GET'} ${p} -> ${r.status}: ${t.slice(0, 200)}`)
  return t ? JSON.parse(t) : null
}

console.log('--- clinics ---')
const clinics = await j('clinics?select=id,code,name,managed_by')
for (const c of clinics) console.log(`  ${c.code.padEnd(20)} managed_by=${c.managed_by || 'NULL'}  ${c.name}`)

console.log('\n--- admins ---')
const admins = await j('staff_profiles?select=id,username,role,clinic_id&role=eq.admin')
for (const a of admins) console.log(`  ${a.username.padEnd(12)} id=${a.id}  clinic_id=${a.clinic_id}`)

if (!admins.length) { console.log('\nNo admin found.'); process.exit(0) }
const admin = admins.find(a => a.username === 'bokskie') || admins[0]

console.log(`\nRepairing: setting managed_by = ${admin.username} (${admin.id}) on ALL ${clinics.length} clinic(s)...`)
let fixed = 0
for (const c of clinics) {
  if (c.managed_by === admin.id) { console.log(`  = ${c.code} already owned`); continue }
  await j(`clinics?id=eq.${c.id}`, {
    method: 'PATCH',
    headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify({ managed_by: admin.id }),
  })
  console.log(`  + ${c.code} now managed_by ${admin.username}`)
  fixed++
}

console.log(`\n--- after ---`)
const after = await j('clinics?select=id,code,name,managed_by')
for (const c of after) console.log(`  ${c.code.padEnd(20)} managed_by=${c.managed_by || 'NULL'}`)
console.log(`\nDONE. ${admin.username} now covers all ${after.length} clinic(s).`)
