/* temp/probe_live.mjs — READ-ONLY probe. No writes, no RPC that mutates.
   Reads each project's PostgREST OpenAPI schema cache (public metadata) to see
   which functions/columns are actually deployed. temp/ is gitignored. */
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

const FRONTEND_REF = 'mkyxtlfapoiboxepkxdz'
const FRONTEND_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1reXh0bGZhcG9pYm94ZXBreGR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3OTY1MzgsImV4cCI6MjEwNjM3MjUzOH0.klFFrccrgZBIQNzK_KM0AGpxdJFeKjxMuIjZOwFcgAY'

const targets = [
  { name: '.env.local project', url: (env.SUPABASE_URL || '').replace(/\/+$/, ''), key: env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '' },
  { name: 'frontend project ', url: `https://${FRONTEND_REF}.supabase.co`, key: FRONTEND_ANON },
]

const WANT_FN = [
  'ent_deleted_reports', 'ent_may_soft_delete', 'ent_may_touch_report',
  'ent_may_edit_report', 'ent_is_my_doctor', 'my_secretaries',
  'ent_purge_recycle_bin', 'ent_is_active_admin', 'ent_stamp_deleaser',
  'ent_capability',
]
const WANT_COL = ['deleted_at', 'deleted_by', 'deleted_reason', 'is_draft', 'created_by_name', 'photo_count', 'record_key', 'saved_at']

for (const t of targets) {
  console.log('')
  console.log('='.repeat(72))
  console.log(`${t.name}  ->  ${t.url}`)
  console.log('='.repeat(72))
  if (!t.url || !t.key) { console.log('  SKIP: no url/key available'); continue }
  let spec
  try {
    const r = await fetch(t.url + '/rest/v1/', { headers: { apikey: t.key } })
    if (!r.ok) { console.log(`  OpenAPI HTTP ${r.status} ${(await r.text()).slice(0, 160)}`); continue }
    spec = await r.json()
  } catch (e) { console.log('  FETCH FAILED: ' + e.message); continue }

  const defs = spec.definitions || spec.components?.schemas || {}
  const tables = Object.keys(defs).filter(k => k !== 'rpc_' && !String(k).startsWith('_'))
  console.log(`  tables/views: ${tables.join(', ')}`)

  const reps = defs.reports && defs.reports.properties ? Object.keys(defs.reports.properties) : []
  if (!reps.length) console.log('  reports: NOT EXPOSED to this key')
  else {
    console.log(`  reports columns (${reps.length}): ${reps.join(', ')}`)
    const missing = WANT_COL.filter(c => !reps.includes(c))
    console.log(missing.length ? `  MISSING reports cols: ${missing.join(', ')}` : '  all expected reports columns present')
  }

  const rpcs = Object.keys(spec.paths || {}).filter(p => p.startsWith('/rpc/')).map(p => p.slice(5))
  console.log(`  rpc count: ${rpcs.length}`)
  for (const f of WANT_FN) {
    const p = spec.paths?.[`/rpc/${f}`]
    const params = p?.post?.parameters || []
    const sig = params.filter(x => x.in === 'body').map(x => (x.schema?.properties && Object.keys(x.schema.properties).join(',')) || '').join(' ')
    console.log(`    ${p ? 'YES' : ' no'}  ${f}${p && sig ? ' (' + sig + ')' : ''}`)
  }
}
