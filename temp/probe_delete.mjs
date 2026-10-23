/* temp/probe_delete.mjs — LIVE diagnosis of the 403 on soft-delete.
   Signs in as lian (secretary), lists a live row she can see, asks
   ent_may_soft_delete() about it, then performs the SAME PATCH the app
   does and captures the EXACT error. Cleans up after itself. */
import fs from 'node:fs'
const e = {}
for (const l of fs.readFileSync('supabase-v2/scripts/.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
  if (m) e[m[1]] = m[2]
}
const B = e.SUPABASE_URL, K = e.SUPABASE_SERVICE_ROLE_KEY, AK = e.SUPABASE_ANON_KEY
const SR = { apikey: K, Authorization: `Bearer ${K}`, 'Content-Type': 'application/json' }
const signIn = async (email, pw) => (await fetch(`${B}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: AK, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: pw })
}).then(r => r.json()))

const who = process.argv[2] || 'lian'
const pw = process.argv[3] || 'lian123'
const t = await signIn(`${who}@zztest.invalid`, pw)
const tok = t.access_token
if (!tok) { console.log('SIGN-IN FAILED', JSON.stringify(t).slice(0, 150)); process.exit(1) }
const AH = { apikey: AK, Authorization: `Bearer ${tok}` }
const AJ = { ...AH, 'Content-Type': 'application/json' }

const me = (await (await fetch(`${B}/rest/v1/staff_profiles?select=id,username,role,is_active,clinic_id,assigned_doctor_id&username=eq.${who}`, { headers: AH })).json())[0]
console.log(`\n=== ${who} (${me.role}) id=${me.id.slice(0, 8)} clinic=${me.clinic_id.slice(0, 8)} assigned_doc=${(me.assigned_doctor_id || 'none').slice(0, 8)} ===`)

// list live rows she can see (RLS-scoped, drafts first)
const rows = await (await fetch(`${B}/rest/v1/reports?select=id,is_draft,doctor_id,clinic_id,created_by,created_by_name,patient_name,record_key&deleted_at=is.null&order=is_draft.desc,created_at.desc&limit=6`, { headers: AH })).json()
const list = Array.isArray(rows) ? rows : []
console.log(`${list.length} live row(s) visible:`)
for (const r of list) {
  const mine = r.created_by === me.id ? 'AUTHOR' : (r.doctor_id === me.id ? 'OWN-DOC' : 'other')
  console.log(`  ${r.id.slice(0, 8)} ${r.is_draft ? 'draft   ' : 'FINISHED'} by=${(r.created_by_name || r.created_by || '?').slice(0, 18).padEnd(18)} you=${mine.padEnd(8)} ${(r.patient_name || '(unnamed)').slice(0, 22)}`)
}

// Test a DRAFT first (author-arm), then any row
for (const target of list.slice(0, 2)) {
  console.log(`\n--- testing row ${target.id.slice(0, 8)} (${target.is_draft ? 'draft' : 'finished'}) ---`)
  // ask the predicate directly
  const msd = await fetch(`${B}/rest/v1/rpc/ent_may_soft_delete`, {
    method: 'POST', headers: AJ, body: JSON.stringify({ p_clinic: target.clinic_id, p_doctor: target.doctor_id, p_id: target.id })
  }).then(async r => [r.status, await r.text()])
  console.log('  ent_may_soft_delete =', msd[0], msd[1])

  // perform the EXACT patch the app does
  const patch = await fetch(`${B}/rest/v1/reports?record_key=eq.${encodeURIComponent(target.record_key)}&deleted_at=is.null`, {
    method: 'PATCH', headers: { ...AJ, Prefer: 'return=representation' },
    body: JSON.stringify({ deleted_at: new Date().toISOString(), deleted_by: me.id, deleted_reason: 'probe' })
  })
  const pb = await patch.text()
  console.log('  PATCH soft-delete status =', patch.status)
  console.log('  PATCH body =', pb.slice(0, 300))

  // cleanup: restore it if it got soft-deleted
  if (patch.status >= 200 && patch.status < 300) {
    const restore = await fetch(`${B}/rest/v1/reports?id=eq.${target.id}`, {
      method: 'PATCH', headers: { ...SR, Prefer: 'return=representation' },
      body: JSON.stringify({ deleted_at: null, deleted_by: null, deleted_reason: '' })
    })
    console.log('  cleanup restore status =', restore.status)
  }
}
console.log('\nDONE')
