/* temp/audit_live.mjs - READ-ONLY audit of the LIVE Supabase project.
   Uses the SERVICE-ROLE key that already lives in supabase-v2/scripts/.env.local
   (never printed, never written anywhere). Nothing is inserted, updated or
   deleted: only GET / HEAD requests and one STABLE rpc (admin_db_usage). */
import { readFileSync } from 'node:fs'

const envPath = new URL('../supabase-v2/scripts/.env.local', import.meta.url)
const env = {}
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
const URL0 = env.SUPABASE_URL.replace(/\/+$/, '')
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
const ORIGINS = String(env.ENT_ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean)
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const gb = n => (n / 1024 / 1024 / 1024).toFixed(3) + ' GB'
const mb = n => (n / 1024 / 1024).toFixed(2) + ' MB'

/* ---------- 1. admin_db_usage: sizes, rows, MAU vs plan limits ---------- */
console.log('\n===== 1. PLAN USAGE (admin_db_usage rpc) =====')
try {
  const res = await fetch(`${URL0}/rest/v1/rpc/admin_db_usage`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}'
  })
  const j = await res.json()
  if (res.ok) {
    console.log('  db        :', mb(j.db_bytes ?? j.database_bytes ?? 0), 'of', mb(j.db_limit_bytes ?? 524288000))
    console.log('  storage   :', mb(j.storage_bytes ?? 0), 'of', mb(j.storage_limit_bytes ?? 1073741824), '| files:', j.storage_files ?? '?')
    console.log('  egress    :', gb(j.egress_bytes ?? 0), 'of', gb(j.egress_limit_bytes ?? 5368709120))
    console.log('  auth MAU  :', j.mau ?? j.active_monthly_users ?? '?', '| auth users:', j.auth_users ?? '?')
    console.log('  app rows  :', j.app_rows ?? '?', '| app bytes:', mb(j.app_bytes ?? 0))
    console.log('  rows      :', JSON.stringify(j.rows ?? j.table_rows ?? {}).slice(0, 600))
    console.log('  keys      :', Object.keys(j).join(', '))
  } else {
    console.log('  HTTP', res.status, JSON.stringify(j).slice(0, 300))
  }
} catch (e) { console.log('  ERROR', e.message) }

/* ---------- 2. schema: which tables/columns are really deployed ---------- */
console.log('\n===== 2. DEPLOYED SCHEMA (OpenAPI) =====')
try {
  const res = await fetch(`${URL0}/rest/v1/`, { headers: H })
  const j = await res.json()
  const tables = Object.keys(j.paths || {}).filter(p => p.startsWith('/'))
  console.log('  HTTP', res.status, '| exposed:', tables.join(' '))
  const rep = (j.paths['/reports']?.get?.parameters || []).map(p => p.name)
  const need = ['record_key', 'is_draft', 'photo_count', 'created_by_name', 'deleted_at', 'saved_at', 'doctor_id', 'clinic_id']
  const missing = need.filter(c => !rep.includes(c))
  console.log('  reports columns:', rep.length, '| missing of the v2 set:', missing.length ? missing.join(',') : 'NONE')
} catch (e) { console.log('  ERROR', e.message) }

/* ---------- 3. exact counters (HEAD + count=exact, never the rows) ---------- */
async function countOf(query) {
  const res = await fetch(`${URL0}/rest/v1/${query}`, { method: 'HEAD', headers: { ...H, Prefer: 'count=exact' } })
  const cr = res.headers.get('content-range') || ''
  return cr.split('/')[1] ?? ('HTTP ' + res.status)
}
console.log('\n===== 3. ROW COUNTERS (HEAD only) =====')
console.log('  reports total        :', await countOf('reports?select=id'))
console.log('  reports is_draft=true:', await countOf('reports?select=id&is_draft=eq.true'))
console.log('  reports is_draft=null:', await countOf('reports?select=id&is_draft=is.null'))
console.log('  reports soft-deleted :', await countOf('reports?select=id&deleted_at=not.is.null'))
console.log('  report_photos        :', await countOf('report_photos?select=id'))
console.log('  staff_profiles       :', await countOf('staff_profiles?select=id'))
console.log('  clinics              :', await countOf('clinics?select=id'))
console.log('  tickets              :', await countOf('tickets?select=id'))
console.log('  activity_logs        :', await countOf('activity_logs?select=id'))
for (const t of ['cf4', 'nasal', 'laryngeal']) {
  console.log(`  reports ${t.padEnd(16)}:`, await countOf(`reports?select=id&report_type=eq.${t}`))
}


console.log('\nproject audited:', URL0)

/* ---------- 4. storage: is the photo bucket private? how many objects? ---- */
console.log('\n===== 4. STORAGE =====')
try {
  const res = await fetch(`${URL0}/storage/v1/bucket`, { headers: H })
  const j = await res.json()
  const list = Array.isArray(j) ? j : (j.buckets || [])
  console.log('  buckets:', list.map(b => `${b.id}(public=${b.public}, cap=${b.file_size_limit ?? '-'})`).join(' ') || '(none)')
} catch (e) { console.log('  ERROR', e.message) }
try {
  const res = await fetch(`${URL0}/storage/v1/object/list/patient-photos`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 100 })
  })
  const j = await res.json()
  console.log('  patient-photos objects (first page):', Array.isArray(j) ? j.length : JSON.stringify(j).slice(0, 200))
} catch (e) { console.log('  ERROR', e.message) }

/* ---------- 5. auth users (free-plan MAU) ---------- */
console.log('\n===== 5. AUTH USERS =====')
try {
  const res = await fetch(`${URL0}/auth/v1/admin/users?page=1&per_page=200`, { headers: H })
  const j = await res.json()
  console.log('  HTTP', res.status, '| users returned:', (j.users || []).length, '| total:', j.total ?? '?')
} catch (e) { console.log('  ERROR', e.message) }

/* ---------- 6. edge functions: deployed? CORS allowlist live? ---------- */
console.log('\n===== 6. EDGE FUNCTIONS / CORS =====')
for (const fn of ['auth-admin', 'patient-photos']) {
  for (const origin of [...ORIGINS, 'https://evil.example.com']) {
    try {
      const res = await fetch(`${URL0}/functions/v1/${fn}`, {
        method: 'OPTIONS', headers: {
          Origin: origin, 'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'apikey,authorization,content-type,x-client-info'
        }
      })
      const acao = res.headers.get('access-control-allow-origin')
      console.log(`  ${fn.padEnd(15)} ${String(origin).padEnd(38)} -> HTTP ${res.status}  ACAO=${acao === null ? 'ABSENT' : acao}`)
    } catch (e) { console.log(`  ${fn} ${origin} ERROR ${e.message}`) }
  }
}

/* ---------- 7. newest rows really carry the v2 columns (wiring proof) ---- */
console.log('\n===== 7. SAMPLE ROW (newest 3 reports) =====')
try {
  const res = await fetch(`${URL0}/rest/v1/reports?select=report_type,patient_name,procedure_date,is_draft,created_by_name,photo_count,deleted_at&order=created_at.desc&limit=3`, { headers: H })
  console.log(' ', JSON.stringify(await res.json()).slice(0, 500))
} catch (e) { console.log('  ERROR', e.message) }
console.log('\ndone.\n')
