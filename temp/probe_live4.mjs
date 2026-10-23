/* temp/probe_live4.mjs — READ-ONLY function-existence probe.
   PostgREST answers PGRST202 when a function is NOT in the schema cache, and
   42501/403 when it exists but the caller may not execute it. That difference
   tells us what is DEPLOYED without any privileged call and without moving a
   single patient row. Body {} only; every call is a no-op probe.
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

const FNS = [
  'ent_deleted_reports', 'ent_may_soft_delete', 'ent_may_touch_report',
  'ent_may_edit_report', 'ent_is_my_doctor', 'my_secretaries',
  'ent_purge_recycle_bin', 'ent_is_active_admin', 'ent_capability',
  'ent_may_read_own_clinic', 'ent_has_report_grant', 'ent_user_summary',
  'ent_stamp_deleter', 'ent_reassign_doctor_records', 'ent_visible_doctor_id',
  'definitely_not_a_real_function_zzz',
]

async function probe(ref, key, label) {
  console.log('')
  console.log('='.repeat(76))
  console.log(`${ref}  — ${label}`)
  console.log('='.repeat(76))
  for (const f of FNS) {
    try {
      const r = await fetch(`https://${ref}.supabase.co/rest/v1/rpc/${f}`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: '{}',
      })
      const t = await r.text()
      let code = ''
      try { code = JSON.parse(t).code || '' } catch {}
      const verdict =
        code === 'PGRST202' || r.status === 404 ? 'NOT DEPLOYED'
        : /Invalid API key/i.test(t) ? 'wrong key for project'
        : 'DEPLOYED (exists)'
      console.log(`  ${f.padEnd(30)} HTTP ${r.status}  ${verdict}`)
    } catch (e) { console.log(`  ${f.padEnd(30)} FETCH FAILED ${e.message}`) }
  }
}

await probe('mkyxtlfapoiboxepkxdz', FE_ANON, 'frontend anon key')
await probe('bvzuraltazxtaxnmbmcr', env.SUPABASE_SERVICE_ROLE_KEY, '.env.local service_role')
