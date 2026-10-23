/* temp/probe_insert.mjs — insert a probe report as lian (her real JWT)
   to capture the EXACT error a real save hits. Then clean it up. */
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
}).then(r => r.json()).catch(() => null)
const tok = t?.access_token
if (!tok) { console.log('NO TOKEN', JSON.stringify(t).slice(0, 200)); process.exit(1) }
const AH = { apikey: AK, Authorization: `Bearer ${tok}` }
const prof = await fetch(`${B}/rest/v1/staff_profiles?select=id,username,role,clinic_id,assigned_doctor_id&username=eq.lian`, { headers: AH }).then(r => r.json())
const p = Array.isArray(prof) ? prof[0] : null
if (!p) { console.log('NO PROFILE', JSON.stringify(prof)); process.exit(1) }
console.log('LIAN profile: clinic=', p.clinic_id, '| assigned_doc=', p.assigned_doctor_id, '| role=', p.role)

// TEST A: patient_id EMPTY, case_number EMPTY (the "new patient" path)
const now = Date.now()
const rowA = {
  clinic_id: p.clinic_id, doctor_id: p.assigned_doctor_id, created_by: p.id,
  report_type: 'nasal', patient_name: 'PROBE A ' + now,
  patient_id: '', case_number: '',
  procedure_date: new Date().toISOString().slice(0, 10),
  record_key: 'probeA_' + now, is_draft: false, file_name: '', payload: {}
}
const insA = await fetch(`${B}/rest/v1/reports`, {
  method: 'POST',
  headers: { ...AH, 'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify(rowA)
})
const bdA = await insA.json().catch(() => null)
console.log('TEST A (empty ids) status=', insA.status, 'body=', JSON.stringify(bdA).slice(0, 400))

// TEST B: with a case_number only
const rowB = { ...rowA, patient_name: 'PROBE B ' + now, case_number: 'CN' + now, record_key: 'probeB_' + now }
const insB = await fetch(`${B}/rest/v1/reports`, {
  method: 'POST',
  headers: { ...AH, 'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify(rowB)
})
const bdB = await insB.json().catch(() => null)
console.log('TEST B (case_number) status=', insB.status, 'body=', JSON.stringify(bdB).slice(0, 400))

// cleanup any rows we created
for (const [tag, st, bd] of [['A', insA.status, bdA], ['B', insB.status, bdB]]) {
  const id = Array.isArray(bd) && bd[0]?.id
  if (st >= 200 && st < 300 && id) {
    const d = await fetch(`${B}/rest/v1/reports?id=eq.${id}`, { method: 'DELETE', headers: AH })
    console.log(`cleanup ${tag} DELETE status=`, d.status)
  }
}
console.log('DONE')
