/* temp/probe_0043.mjs — is migration 0043 applied yet? Detect the
   reports_update_own_doctor policy by doing the exact soft-delete the app
   does, as the row's doctor. If it 200s, 0043 is live and delete works. */
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
  body: JSON.stringify({ email: 'jess@zztest.invalid', password: 'jess123' })
}).then(r => r.json())
const AJ = { apikey: AK, Authorization: `Bearer ${t.access_token}`, 'Content-Type': 'application/json' }
const rows = await (await fetch(`${B}/rest/v1/reports?select=id,record_key&deleted_at=is.null&order=is_draft.desc&limit=1`, { headers: AJ })).json()
const r = Array.isArray(rows) ? rows[0] : null
if (!r) { console.log('no live row for jess'); process.exit(0) }
const patch = await fetch(`${B}/rest/v1/reports?record_key=eq.${encodeURIComponent(r.record_key)}&deleted_at=is.null`, {
  method: 'PATCH', headers: { ...AJ, Prefer: 'return=representation' },
  body: JSON.stringify({ deleted_at: new Date().toISOString(), deleted_by: null, deleted_reason: 'probe' })
})
console.log('soft-delete as jess:', patch.status, (await patch.text()).slice(0, 140))
if (patch.status >= 200 && patch.status < 300) {
  console.log('>>> 0043 IS LIVE — delete works.')
  const restore = await fetch(`${B}/rest/v1/reports?id=eq.${r.id}`, {
    method: 'PATCH', headers: { ...SR, Prefer: 'return=representation' },
    body: JSON.stringify({ deleted_at: null, deleted_by: null, deleted_reason: '' })
  })
  console.log('cleanup restore:', restore.status)
} else {
  console.log('>>> 0043 NOT APPLIED YET — still 403. Paste it in the SQL Editor.')
}
console.log('DONE')
