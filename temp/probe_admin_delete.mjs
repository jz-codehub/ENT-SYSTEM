/* temp/probe_admin_delete.mjs — can the ADMIN soft-delete? reports_update_owner
   has an admin branch (deleted_at IS NOT NULL AND ent_is_active_admin AND
   clinic_id = claim_clinic_id). If the admin CAN but the doctor/secretary
   CANNOT, then reports_update_own_doctor (0030/0039) is MISSING from the live
   DB — the only consistent explanation. Restores after. */
import fs from 'node:fs'
const e = {}
for (const l of fs.readFileSync('supabase-v2/scripts/.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
  if (m) e[m[1]] = m[2]
}
const B = e.SUPABASE_URL, K = e.SUPABASE_SERVICE_ROLE_KEY, AK = e.SUPABASE_ANON_KEY
const SR = { apikey: K, Authorization: `Bearer ${K}`, 'Content-Type': 'application/json' }
const t = await fetch(`${B}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: AK, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'bokskie@zztest.invalid', password: 'bokskie123' })
}).then(r => r.json())
const AJ = { apikey: AK, Authorization: `Bearer ${t.access_token}`, 'Content-Type': 'application/json' }
const rows = await (await fetch(`${B}/rest/v1/reports?select=id,record_key,is_draft&deleted_at=is.null&order=is_draft.desc&limit=1`, { headers: AJ })).json()
const r = Array.isArray(rows) ? rows[0] : null
if (!r) { console.log('no row'); process.exit(0) }
console.log('admin testing soft-delete on', r.id.slice(0, 8), 'draft=' + r.is_draft)
const patch = await fetch(`${B}/rest/v1/reports?record_key=eq.${encodeURIComponent(r.record_key)}&deleted_at=is.null`, {
  method: 'PATCH', headers: { ...AJ, Prefer: 'return=representation' },
  body: JSON.stringify({ deleted_at: new Date().toISOString(), deleted_by: null, deleted_reason: 'probe' })
})
console.log('ADMIN soft-delete status =', patch.status, (await patch.text()).slice(0, 160))
if (patch.status >= 200 && patch.status < 300) {
  const restore = await fetch(`${B}/rest/v1/reports?id=eq.${r.id}`, {
    method: 'PATCH', headers: { ...SR, Prefer: 'return=representation' },
    body: JSON.stringify({ deleted_at: null, deleted_by: null, deleted_reason: '' })
  })
  console.log('cleanup restore status =', restore.status)
}
console.log('DONE')
