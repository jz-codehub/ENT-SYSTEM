/* temp/probe_0039.mjs — did 0039 actually apply? If reports_update_own_doctor
   is missing (the delete bug), 0039 likely rolled back. Test ent_deleted_reports
   (0039's bin fn) as jess: 0037 version REFUSES a doctor; 0039 version lets a
   doctor read his own shelf. A 'refused' RAISE vs a row list tells us which. */
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
const bin = await fetch(`${B}/rest/v1/rpc/ent_deleted_reports`, {
  method: 'POST', headers: AJ, body: JSON.stringify({ p_limit: 5 })
}).then(async r => [r.status, (await r.text()).slice(0, 200)])
console.log('ent_deleted_reports as jess (doctor):', bin[0])
console.log('  body:', bin[1])
// 0039 doctor arm => HTTP 200 with a JSON array (possibly empty)
// 0037 only    => HTTP 200 empty, but the doctor arm is ABSENT -> still 200 [] actually
// The real tell is the POLICY, so also probe whether reports_update_own_doctor
// exists by testing an UPDATE that ONLY it could allow. That is the soft-delete
// itself, already shown to 403. So here we just log the bin result.
console.log('DONE')
