/* temp/probe_live7.mjs — READ-ONLY control test.
   PostgREST may not list functions that RETURN `trigger`, so a 404 on
   ent_stamp_report_ownership() would be a false negative. This probe compares
   it against trigger functions that certainly exist on the live project
   (ent_touch_updated_at from 0001, ent_guard_staff_privileges from 0003). If
   the known triggers also answer 404, then "MISSING trigger" means nothing and
   only non-trigger signatures are trustworthy evidence.
   temp/ is gitignored. */
const FE = 'mkyxtlfapoiboxepkxdz'
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1reXh0bGZhcG9pYm94ZXbreGR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3OTY1MzgsImV4cCI6MjEwNjM3MjUzOH0.klFFrccrgZBIQNzK_KM0AGpxdJFeKjxMuIjZOwFcgAY'

const PROBE = [
  // returns trigger — from migrations that are DEFINITELY applied (0001, 0003)
  ['ent_touch_updated_at', '0001 trigger (control: must exist)'],
  ['ent_guard_staff_privileges', '0003 trigger (control: must exist)'],
  ['ent_guard_staff_insert', '0003 trigger (control: must exist)'],
  ['ent_sync_auth_metadata', '0003 trigger (control: must exist)'],
  ['ent_stamp_settings', '0006 trigger (control: must exist)'],
  ['ent_stamp_flag_editor', '0006 trigger (control: must exist)'],
  ['ent_audit_append_only', '0005 trigger (control: must exist)'],
  // the ones in question
  ['ent_stamp_report_ownership', '0004/0018/0028/0037 trigger'],
  ['ent_stamp_photo_ownership', '0019 trigger'],
  ['ent_stamp_deleaser', '0034 trigger (secretary bin stamp)'],
  ['ent_stamp_grant', '0025 trigger'],
  ['ent_stamp_access_request', '0031 trigger'],
  ['ent_stamp_ticket_ownership', '0012 trigger'],
  ['ent_grants_narrow_only', '0019 trigger (grants narrow-only)'],
]

console.log(`# ${FE} — trigger-function control test`)
console.log('')
let trigger404 = 0, triggerOk = 0
for (const [f, note] of PROBE) {
  const r = await fetch(`https://${FE}.supabase.co/rest/v1/rpc/${f}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: '{}',
  })
  const t = await r.text()
  let code = ''
  try { code = JSON.parse(t).code || '' } catch {}
  const missing = code === 'PGRST202' || r.status === 404
  const isControl = note.includes('control')
  if (isControl) { missing ? trigger404++ : triggerOk++ }
  console.log(`  ${missing ? '404/PGRST202' : 'listed     '}  ${f.padEnd(30)} ${note}`)
}
console.log('')
console.log(`  controls listed: ${triggerOk}   controls 404: ${trigger404}`)
console.log(trigger404 > 0
  ? '  => PostgREST does NOT expose trigger-returning functions, so a 404 on a'
    + ' trigger is NOT evidence it is missing. Only non-trigger signatures count.'
  : '  => PostgREST DOES list trigger functions, so a 404 IS meaningful evidence.')

// Tables: secretary_assignments is the 0037 junction. Its absence is the
// cleanest single proof that 0037 never landed.
for (const t of ['secretary_assignments', 'access_requests', 'tickets']) {
  const r = await fetch(`https://${FE}.supabase.co/rest/v1/${t}?select=%2A&limit=1`,
    { headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, Range: '0-0' } })
  const txt = await r.text()
  let code = ''
  try { code = JSON.parse(txt).code || '' } catch {}
  const missing = code === 'PGRST205' || r.status === 404
  console.log(`  table ${t.padEnd(24)} ${missing ? 'MISSING' : 'EXISTS'} (${r.status})`)
}
