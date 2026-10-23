/* temp/probe_live5.mjs — READ-ONLY, no row payload ever transferred.
   Two discriminators that work WITHOUT any grant:

   COLUMN: `?select=<col>&limit=0`
     42703/PGRST100 "column does not exist"  -> column MISSING
     42501 "permission denied for schema public" -> column EXISTS (caller just
                                                     may not read it, which is
                                                     the correct anon answer)
     404 PGRST205 table not in cache          -> TABLE MISSING

   FUNCTION: POST /rpc/<fn> with the RIGHT argument names
     PGRST202 "Could not find the function public.f(a,b) in the schema cache"
              -> that SIGNATURE is missing
     42501    -> deployed, caller may not execute it (REVOKEd from anon)

   PostgREST resolves overloads by argument name, so passing real names also
   rules out "404 because I sent {} to a function that needs 3 args".
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

const TABLES = {
  clinics: ['id', 'name', 'created_at'],
  staff_profiles: ['id', 'username', 'role', 'clinic_id', 'assigned_doctor_id', 'is_active'],
  reports: ['id', 'clinic_id', 'doctor_id', 'created_by', 'record_key', 'report_type',
    'is_draft', 'patient_name', 'payload', 'created_by_name', 'photo_count',
    'deleted_at', 'deleted_by', 'deleted_reason', 'saved_at', 'uploaded_by'],
  report_photos: ['id', 'report_id', 'clinic_id', 'storage_path', 'uploaded_by'],
  report_access_grants: ['id', 'report_id', 'grantee_id', 'granted_by', 'managed_by'],
  secretary_assignments: ['id', 'clinic_id', 'secretary_id', 'doctor_id'],
  tickets: ['id', 'clinic_id', 'title', 'status'],
  system_flags: ['flag_key', 'enabled'],
}

const FNS = [
  ['ent_deleted_reports', { p_limit: 10 }],
  ['ent_may_soft_delete', { p_clinic: U, p_doctor: U, p_id: U }],
  ['ent_may_touch_report', { p_clinic: U, p_doctor: U }],
  ['ent_may_edit_report', { p_clinic: U, p_doctor: U, p_id: U }],
  ['ent_is_my_doctor', { p_doctor: U }],
  ['ent_may_read_own_clinic', { p_clinic: U, p_doctor: U }],
  ['ent_has_report_grant', { p_id: U }],
  ['ent_purge_recycle_bin', { p_before: new Date().toISOString(), p_limit: 1 }],
  ['ent_capability', {}],
  ['my_secretaries', {}],
  ['ent_is_active_admin', {}],
  ['ent_visible_doctor_id', {}],
  ['ent_user_summary', {}],
  ['ent_reassign_doctor_records', { p_from: U, p_to: U }],
  ['ent_grants_narrow_only', { p_id: U }],
]

async function run(ref, key, label) {
  console.log('')
  console.log('#'.repeat(76))
  console.log(`# ${ref}   — ${label}`)
  console.log('#'.repeat(76))

  console.log('')
  console.log('--- TABLES / COLUMNS ---')
  for (const [t, cols] of Object.entries(TABLES)) {
    const parts = []
    for (const c of cols) {
      const r = await fetch(`https://${ref}.supabase.co/rest/v1/${t}?select=${c}&limit=0`,
        { headers: { apikey: key, Authorization: `Bearer ${key}`, Range: '0-0' } })
      const txt = await r.text()
      let code = ''
      try { code = JSON.parse(txt).code || '' } catch {}
      if (r.status === 404 || code === 'PGRST205') { parts.push('TABLE-MISSING'); break }
      if (r.status === 401 && /permission denied for schema/i.test(txt)) { parts.push(`${c}:ok`); continue }
      if (code === '42703' || code === 'PGRST100' || /does not exist/i.test(txt)) { parts.push(`${c}:MISSING`); continue }
      parts.push(`${c}:?${r.status}`)
    }
    console.log(`  ${t.padEnd(22)} ${parts.join('  ')}`)
  }

  console.log('')
  console.log('--- FUNCTIONS (existence, by signature) ---')
  for (const [f, body] of FNS) {
    const r = await fetch(`https://${ref}.supabase.co/rest/v1/rpc/${f}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const txt = await r.text()
    let code = '', msg = ''
    try { code = JSON.parse(txt).code || ''; msg = JSON.parse(txt).message || '' } catch {}
    const v = code === 'PGRST202' || r.status === 404 ? 'MISSING'
      : /Invalid API key/i.test(txt) ? 'wrong-key'
      : 'DEPLOYED'
    console.log(`  ${f.padEnd(30)} HTTP ${r.status}  ${v}   ${msg.slice(0, 70)}`)
  }
}

await run('mkyxtlfapoiboxepkxdz', FE_ANON, 'frontend project, frontend anon key')
await run('bvzuraltazxtaxnmbmcr', env.SUPABASE_SERVICE_ROLE_KEY, '.env.local project, service_role')
