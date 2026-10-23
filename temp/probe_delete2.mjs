/* temp/probe_delete2.mjs — pin down WHICH UPDATE policy refuses.
   After the 0042 trigger re-stamps clinic/doctor on UPDATE, test both
   ent_may_touch_report (0008/0019 policy) and ent_may_soft_delete (0030)
   against the SAME row, as lian. Whichever is FALSE is the gate. */
import fs from 'node:fs'
const e = {}
for (const l of fs.readFileSync('supabase-v2/scripts/.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
  if (m) e[m[1]] = m[2]
}
const B = e.SUPABASE_URL, AK = e.SUPABASE_ANON_KEY
const t = await fetch(`${B}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: AK, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'lian@zztest.invalid', password: 'lian123' })
}).then(r => r.json())
const AJ = { apikey: AK, Authorization: `Bearer ${t.access_token}`, 'Content-Type': 'application/json' }
const me = (await (await fetch(`${B}/rest/v1/staff_profiles?select=id,role,clinic_id,assigned_doctor_id&username=eq.lian`, { headers: AJ })).json())[0]

const rows = await (await fetch(`${B}/rest/v1/reports?select=id,is_draft,doctor_id,clinic_id,created_by,patient_name&deleted_at=is.null&order=is_draft.desc&limit=1`, { headers: AJ })).json()
const r = Array.isArray(rows) ? rows[0] : null
if (!r) { console.log('no row'); process.exit(0) }
console.log('row:', r.id.slice(0, 8), 'draft=' + r.is_draft, 'by=' + r.created_by.slice(0, 8), 'doc=' + r.doctor_id.slice(0, 8), 'cli=' + r.clinic_id.slice(0, 8))

const rpc = async (fn, args) => {
  const res = await fetch(`${B}/rest/v1/rpc/${fn}`, { method: 'POST', headers: AJ, body: JSON.stringify(args) })
  return [res.status, (await res.text()).slice(0, 120)]
}
console.log('ent_may_soft_delete(clinic,doctor,id) =', await rpc('ent_may_soft_delete', { p_clinic: r.clinic_id, p_doctor: r.doctor_id, p_id: r.id }))
console.log('ent_may_touch_report(clinic,doctor)  =', await rpc('ent_may_touch_report', { p_clinic: r.clinic_id, p_doctor: r.doctor_id }))
console.log('ent_may_edit_report(clinic,doctor,id)=', await rpc('ent_may_edit_report', { p_clinic: r.clinic_id, p_doctor: r.doctor_id, p_id: r.id }))
console.log('ent_is_my_doctor(doctor)             =', await rpc('ent_is_my_doctor', { p_doctor: r.doctor_id }))
console.log('\nme.id       =', me.id)
console.log('me.assigned =', me.assigned_doctor_id)
console.log('row.created_by =', r.created_by, '(author of draft)')
console.log('row.doctor_id  =', r.doctor_id, '(== assigned?', r.doctor_id === me.assigned_doctor_id, ')')
console.log('DONE')
