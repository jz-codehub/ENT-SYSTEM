/* temp/probe_live6.mjs — READ-ONLY, precise-signature existence probe.
   PostgREST resolves an RPC by ARGUMENT NAME, so a wrong name yields the same
   PGRST202 as a genuinely absent function. probe_live5 used p_id for
   ent_may_edit_report (real name: p_report), so those rows were false
   negatives. Every call below uses the EXACT signature from
   supabase-v2/migrations/*.sql. Anon is REVOKEd on all of these, so
   42501 = "deployed, caller may not execute" and PGRST202 = "not deployed".
   temp/ is gitignored. */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const env = {}
const envPath = join(HERE, '..', 'supabase-v2', 'scripts', '.env.local')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
}
const FE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1reXh0bGZhcG9pYm94ZXBreGR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3OTY1MzgsImV4cCI6MjEwNjM3MjUzOH0.klFFrccrgZBIQNzK_KM0AGpxdJFeKjxMuIjZOwFcgAY'

const U = '00000000-0000-0000-0000-000000000000'
// exact signatures, with the migration that last defines each one
const FNS = [
  ['ent_auth_uid', {}, '0001'],
  ['ent_claim_clinic_id', {}, '0001'],
  ['ent_claim_role', {}, '0001'],
  ['ent_is_active_admin', {}, '0003'],
  ['ent_visible_doctor_id', {}, '0003'],
  ['ent_is_member_of', { p_clinic: U }, '0016'],
  ['ent_admin_covers_clinic', { p_clinic: U }, '0016'],
  ['ent_may_touch_report', { p_clinic: U, p_doctor: U }, '0016'],
  ['ent_stamp_report_ownership', {}, '0037'],
  ['ent_capability', { p_flag_key: 'photo_storage' }, '0010'],
  ['admin_db_usage', {}, '0014'],
  ['my_assigned_doctor_name', {}, '0015'],
  ['my_assigned_doctors', {}, '0037'],
  ['ent_may_grant_report_access', { p_report: U }, '0032'],
  ['ent_may_revoke_grant', { p_report: U }, '0032'],
  ['ent_has_report_grant', { p_report: U }, '0019'],
  ['ent_may_edit_report', { p_clinic: U, p_doctor: U, p_report: U }, '0019'],
  ['ent_may_read_own_clinic', { p_clinic: U, p_doctor: U }, '0020'],
  ['ent_may_open_report', { p_report: U }, '0020'],
  ['ent_open_report', { p_report: U }, '0020'],
  ['ent_may_access_photo', { p_operation: 'SELECT', p_object_name: 'x/y.jpg' }, '0020'],
  ['ent_may_soft_delete', { p_clinic: U, p_doctor: U, p_id: U }, '0034'],
  ['ent_deleted_reports', { p_limit: 10 }, '0037'],
  ['ent_purge_recycle_bin', { p_before: new Date().toISOString(), p_limit: 1 }, '0036'],
  ['ent_is_my_doctor', { p_doctor: U }, '0037'],
  ['my_secretaries', {}, '0037'],
  ['ent_reassign_doctor_records', { p_from: U, p_to: U }, '0035'],
  ['ent_report_duplicate_groups', {}, '0033'],
  ['ent_request_report', { p_report: U, p_reason: '' }, '0031'],
  ['ent_view_incoming_access_requests', {}, '0031'],
  ['ent_view_my_access_requests', {}, '0031'],
  ['ent_handle_access_request', { p_request_id: U, p_decision: 'approved', p_reason: '' }, '0031'],
]

async function run(ref, key, label) {
  console.log('')
  console.log('#'.repeat(78))
  console.log(`# ${ref}  —  ${label}`)
  console.log('#'.repeat(78))
  const deployed = [], missing = []
  for (const [f, body, mig] of FNS) {
    const r = await fetch(`https://${ref}.supabase.co/rest/v1/rpc/${f}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const txt = await r.text()
    let code = ''
    try { code = JSON.parse(txt).code || '' } catch {}
    const ok = !(code === 'PGRST202' || r.status === 404)
    ;(ok ? deployed : missing).push(`${f} (${mig})`)
    console.log(`  ${ok ? 'DEPLOYED ' : 'MISSING  '} ${f.padEnd(32)} last defined in ${mig}`)
  }
  console.log('')
  console.log(`  SUMMARY: ${deployed.length} deployed, ${missing.length} missing`)
  console.log(`  highest migration evident: ${migRank(deployed)}`)
}

function migRank(list) {
  const nums = list.map(s => { const m = /\((\d{4})\)/.exec(s); return m ? +m[1] : null }).filter(Boolean)
  return nums.length ? String(Math.max(...nums)).padStart(4, '0') : 'none'
}

await run('mkyxtlfapoiboxepkxdz', FE_ANON, 'frontend project, anon key')
await run('bvzuraltazxtaxnmbmcr', env.SUPABASE_SERVICE_ROLE_KEY, '.env.local project, service_role')
