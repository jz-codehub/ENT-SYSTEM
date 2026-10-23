/* temp/probe_baseupdate.mjs — does an ORDINARY (non-delete) update work as
   jess? If yes, reports_update_owner USING passes; the delete then fails
   only on the deleted_at WITH CHECK branch -> proves reports_update_own_doctor
   (0030) is missing from the live DB. Restores the value after. */
import fs from 'node:fs'
const e = {}
for (const l of fs.readFileSync('supabase-v2/scripts/.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
  if (m) e[m[1]] = m[2]
}
const B = e.SUPABASE_URL, AK = e.SUPABASE_ANON_KEY
const t = await fetch(`${B}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: AK, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'jess@zztest.invalid', password: 'jess123' })
}).then(r => r.json())
const AJ = { apikey: AK, Authorization: `Bearer ${t.access_token}`, 'Content-Type': 'application/json' }
const rows = await (await fetch(`${B}/rest/v1/reports?select=id,file_name&deleted_at=is.null&order=is_draft.desc&limit=1`, { headers: AJ })).json()
const r = Array.isArray(rows) ? rows[0] : null
if (!r) { console.log('no row'); process.exit(0) }
console.log('row', r.id.slice(0, 8), 'file_name=', JSON.stringify(r.file_name))
// ordinary update: change file_name to a probe value, then restore
const set = await fetch(`${B}/rest/v1/reports?id=eq.${r.id}`, {
  method: 'PATCH', headers: { ...AJ, Prefer: 'return=representation' },
  body: JSON.stringify({ file_name: '__probe__' })
})
console.log('ORDINARY update (file_name) status =', set.status, (await set.text()).slice(0, 160))
if (set.status >= 200 && set.status < 300) {
  const back = await fetch(`${B}/rest/v1/reports?id=eq.${r.id}`, {
    method: 'PATCH', headers: { ...AJ, Prefer: 'return=representation' },
    body: JSON.stringify({ file_name: r.file_name || '' })
  })
  console.log('restore file_name status =', back.status)
}
console.log('DONE')
