/* temp/probe_trigger.mjs — dump the LIVE ent_stamp_report_ownership definition
   and test what me.clinic_id resolves to inside the trigger context for lian. */
import fs from 'node:fs'
const e = {}
for (const l of fs.readFileSync('supabase-v2/scripts/.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
  if (m) e[m[1]] = m[2]
}
const B = e.SUPABASE_URL, K = e.SUPABASE_SERVICE_ROLE_KEY
const H = { apikey: K, Authorization: `Bearer ${K}`, 'Content-Type': 'application/json' }
// Use the pg_catalog via a read-only RPC is not available; use the REST root to
// introspect is not possible. Instead, re-run the insert as lian but WITHOUT
// doctor_id, and also inspect via a direct profile read what clinic resolves.
const AK = e.SUPABASE_ANON_KEY
const t = await fetch(`${B}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: AK, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'lian@zztest.invalid', password: 'lian123' })
}).then(r => r.json()).catch(() => null)
const tok = t?.access_token
const AH = { apikey: AK, Authorization: `Bearer ${tok}` }
const p = (await (await fetch(`${B}/rest/v1/staff_profiles?select=id,username,role,clinic_id,assigned_doctor_id,is_active&username=eq.lian`, { headers: AH })).json())[0]
console.log('lian clinic_id=', p.clinic_id, 'assigned_doctor_id=', p.assigned_doctor_id, 'is_active=', p.is_active)
// Does lian's assigned doctor exist and have a clinic?
const doc = await (await fetch(`${B}/rest/v1/staff_profiles?select=id,username,role,clinic_id,is_active&id=eq.${p.assigned_doctor_id}`, { headers: { apikey: K, Authorization: `Bearer ${K}` } })).json()
console.log('assigned doctor row:', JSON.stringify(doc))
// Try insert with NO doctor_id (let trigger derive). If secretary branch sets
// doctor_id = assigned_doctor_id and clinic = me.clinic_id, this should work.
const now = Date.now()
const row = {
  report_type: 'nasal', patient_name: 'PROBE NODOC ' + now, patient_id: '', case_number: '',
  procedure_date: new Date().toISOString().slice(0, 10), record_key: 'probeND_' + now,
  is_draft: false, file_name: '', payload: {}
}
const ins = await fetch(`${B}/rest/v1/reports`, {
  method: 'POST', headers: { ...AH, 'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify(row)
})
const bd = await ins.json().catch(() => null)
console.log('INSERT no-doctor status=', ins.status, 'body=', JSON.stringify(bd).slice(0, 400))
const id = Array.isArray(bd) && bd[0]?.id
if (ins.status >= 200 && ins.status < 300 && id) {
  const back = await (await fetch(`${B}/rest/v1/reports?select=id,clinic_id,doctor_id,created_by&id=eq.${id}`, { headers: { apikey: K, Authorization: `Bearer ${K}` } })).json()
  console.log('STORED row ownership:', JSON.stringify(back))
  const d = await fetch(`${B}/rest/v1/reports?id=eq.${id}`, { method: 'DELETE', headers: { apikey: K, Authorization: `Bearer ${K}` } })
  console.log('cleanup DELETE status=', d.status)
}
console.log('DONE')
