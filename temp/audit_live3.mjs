/* temp/audit_live3.mjs - READ-ONLY: photo_storage flag, report_photos shape,
   bucket contents, clinics/settings. Nothing is written. */
import { readFileSync } from 'node:fs'
const env = {}
for (const line of readFileSync(new URL('../supabase-v2/scripts/.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
const URL0 = env.SUPABASE_URL.replace(/\/+$/, '')
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }

console.log('\n===== system_flags =====')
try {
  const res = await fetch(`${URL0}/rest/v1/system_flags?select=*&limit=50`, { headers: H })
  console.log(' ', JSON.stringify(await res.json()).slice(0, 800))
} catch (e) { console.log('  ERROR', e.message) }

console.log('\n===== report_photos (all columns) =====')
try {
  const res = await fetch(`${URL0}/rest/v1/report_photos?select=*&limit=10`, { headers: H })
  const j = await res.json()
  console.log(' ', JSON.stringify(j).slice(0, 700))
} catch (e) { console.log('  ERROR', e.message) }

console.log('\n===== storage: objects under clinics/ =====')
try {
  const res = await fetch(`${URL0}/storage/v1/object/list/patient-photos`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: 'clinics', limit: 50 })
  })
  const j = await res.json()
  console.log(' ', Array.isArray(j) ? j.map(o => `${o.id || o.name}${o.metadata ? '(' + ((o.metadata.size || 0) / 1024).toFixed(0) + 'KB)' : ''}`).join(' ') : JSON.stringify(j).slice(0, 300))
} catch (e) { console.log('  ERROR', e.message) }

console.log('\n===== clinics + clinic_settings =====')
try {
  const res = await fetch(`${URL0}/rest/v1/clinics?select=id,name,code&limit=10`, { headers: H })
  console.log('  clinics:', JSON.stringify(await res.json()).slice(0, 400))
} catch (e) { console.log('  ERROR', e.message) }
try {
  const res = await fetch(`${URL0}/rest/v1/clinic_settings?select=clinic_id&limit=10`, { headers: H })
  console.log('  settings rows:', JSON.stringify(await res.json()).slice(0, 300))
} catch (e) { console.log('  ERROR', e.message) }

console.log('\n===== staff (role mix) =====')
try {
  const res = await fetch(`${URL0}/rest/v1/staff_profiles?select=id,username,role,is_active,assigned_doctor_name&limit=20`, { headers: H })
  console.log(' ', JSON.stringify(await res.json()).slice(0, 700))
} catch (e) { console.log('  ERROR', e.message) }
console.log('\ndone.\n')
