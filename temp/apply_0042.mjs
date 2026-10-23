/* temp/apply_0042.mjs — apply migration 0042 to the LIVE project via the
   SQL-over-PostgREST is not available; use the pg_net-free path: run the
   DDL through the service-role by POSTing to the /rest/v1/rpc is also not
   it. Supabase exposes DDL only through the SQL Editor / Management API.
   So this script prints the file for the user to paste, AND — because we
   cannot run DDL over REST — it re-tests the secretary insert AFTER the
   user applies it. If the helper already exists we short-circuit. */
import fs from 'node:fs'
const e = {}
for (const l of fs.readFileSync('supabase-v2/scripts/.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
  if (m) e[m[1]] = m[2]
}
const B = e.SUPABASE_URL, K = e.SUPABASE_SERVICE_ROLE_KEY, AK = e.SUPABASE_ANON_KEY
const SR = { apikey: K, Authorization: `Bearer ${K}`, 'Content-Type': 'application/json' }

// Can we detect whether ent_doctor_clinic already exists? PostgREST lists
// functions in the schema; a trigger-returning function is not callable, but
// ent_doctor_clinic RETURNS uuid, so it IS callable and listed.
const probe = await fetch(`${B}/rest/v1/rpc/ent_doctor_clinic`, {
  method: 'POST', headers: SR, body: JSON.stringify({ p_doctor: '00000000-0000-0000-0000-000000000000' })
})
console.log('ent_doctor_clinic exists:', probe.status !== 404 ? 'YES (HTTP ' + probe.status + ')' : 'NO (404) — 0042 not applied yet')
if (probe.status === 404) {
  console.log('\n>>> ACTION: paste supabase-v2/migrations/0042_fix_secretary_save.sql into the SQL Editor and Run. Then re-run this script.')
  process.exit(2)
}

// It exists — now test a real secretary insert WITH a doctor_id.
const t = await fetch(`${B}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: AK, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'lian@zztest.invalid', password: 'lian123' })
}).then(r => r.json()).catch(() => null)
const AH = { apikey: AK, Authorization: `Bearer ${t.access_token}` }
const p = (await (await fetch(`${B}/rest/v1/staff_profiles?select=id,clinic_id,assigned_doctor_id&username=eq.lian`, { headers: AH })).json())[0]
const now = Date.now()
const row = {
  clinic_id: p.clinic_id, doctor_id: p.assigned_doctor_id, created_by: p.id,
  report_type: 'nasal', patient_name: 'PROBE 0042 ' + now, patient_id: '', case_number: '',
  procedure_date: new Date().toISOString().slice(0, 10), record_key: 'p42_' + now,
  is_draft: false, file_name: '', payload: {}
}
const ins = await fetch(`${B}/rest/v1/reports`, {
  method: 'POST', headers: { ...AH, 'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify(row)
})
const bd = await ins.json().catch(() => null)
console.log('secretary insert WITH doctor_id → status', ins.status)
console.log('body:', JSON.stringify(bd).slice(0, 300))
const id = Array.isArray(bd) && bd[0]?.id
if (ins.status >= 200 && ins.status < 300 && id) {
  console.log('>>> FIXED. clinic_id =', bd[0].clinic_id, '| doctor_id =', bd[0].doctor_id)
  const d = await fetch(`${B}/rest/v1/reports?id=eq.${id}`, { method: 'DELETE', headers: SR })
  console.log('cleanup DELETE status', d.status)
} else {
  console.log('>>> STILL FAILING')
}
console.log('DONE')
