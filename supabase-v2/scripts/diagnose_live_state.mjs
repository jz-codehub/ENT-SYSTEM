// =====================================================================
//  diagnose_live_state.mjs — READ-ONLY. Answers "what is actually on the
//  live database right now?" before any further migration decision.
//
//  NO WRITES OF ANY KIND. GET and HEAD only; the single POST is a
//  existence probe against /rpc/, and every function probed is a pure
//  SELECT wrapper, so a hit can only ever return the refusal branch.
//
//  PostgREST cannot reach pg_catalog, so the function list comes from the
//  OpenAPI schema cache at /rest/v1/. The SQL-Editor-only questions
//  (pg_policies qual text, role_table_grants) are printed at the end.
//
//  Run: node supabase-v2/scripts/diagnose_live_state.mjs
// =====================================================================
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const env = {}
const envPath = join(HERE, '.env.local')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
const BASE = (env.SUPABASE_URL || '').replace(/\/+$/, '')
const SVC = env.SUPABASE_SERVICE_ROLE_KEY || ''
const ANON = env.SUPABASE_ANON_KEY || ''
if (!BASE || !SVC) { console.error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required.'); process.exit(1) }

const out = []
const say = s => { out.push(s) }
const H = { apikey: SVC, Authorization: `Bearer ${SVC}` }

async function get(path) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, { headers: H, signal: AbortSignal.timeout(25000) })
  const t = await r.text()
  let j = null
  try { j = JSON.parse(t) } catch { /* keep null */ }
  return { status: r.status, text: t, json: j }
}
async function headCount(path) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, {
    method: 'HEAD', headers: { ...H, Prefer: 'count=exact' }, signal: AbortSignal.timeout(20000),
  })
  const cr = r.headers.get('content-range') || ''
  return cr.includes('/') ? Number(cr.split('/')[1]) : -1
}

say('=====================================================================')
say('  LIVE DATABASE STATE  -  READ-ONLY DIAGNOSTIC')
say(`  project : ${BASE}`)
say('  writes  : none')
say('=====================================================================')
say('')

// ---- 1. schema cache -------------------------------------------------
say('---- 1. SCHEMA CACHE: relations and RPCs PostgREST exposes ----')
let spec = null
{
  const r = await fetch(`${BASE}/rest/v1/`, { headers: H, signal: AbortSignal.timeout(25000) })
  spec = await r.json().catch(() => null)
  if (!spec || !spec.paths) say('  (schema cache unavailable)')
  else {
    const tables = Object.keys(spec.definitions || {}).filter(d => d !== 'definitions')
    const rpcs = Object.keys(spec.paths).filter(p => p.startsWith('/rpc/')).map(p => p.slice(5))
    say(`  relations : ${tables.length}`)
    say(`  rpcs      : ${rpcs.length}`)
    say('')
    say('  every RPC in the cache:')
    rpcs.sort().forEach(f => say('    ' + f))
  }
}
say('')

// ---- 2. report_access_grants ----------------------------------------
say('---- 2. report_access_grants ----')
const GRANT_COLS = ['report_id', 'grantee_id', 'granted_by', 'reason', 'expires_at', 'created_at']
{
  const n = await headCount('report_access_grants?select=*')
  if (n < 0) {
    const probe = await get('report_access_grants?select=*&limit=1')
    if (probe.status === 404) say('  TABLE ABSENT (HTTP 404). Nothing to audit.')
    else say(`  TABLE PRESENT but not readable over REST (HTTP ${probe.status}). Use the SQL Editor.`)
  } else {
    say(`  TABLE PRESENT.  row count = ${n}`)
    say('')
    say('  which 0019 columns exist (probed individually):')
    for (const c of GRANT_COLS) {
      const r = await get(`report_access_grants?select=${c}&limit=1`)
      say(`    ${r.status === 200 ? 'yes' : 'NO '}  ${c}${r.status !== 200 ? '   (HTTP ' + r.status + ')' : ''}`)
    }
    say('')
    say('  sample rows (up to 10):')
    const s = await get('report_access_grants?select=*&limit=10')
    if (s.status === 200 && Array.isArray(s.json)) {
      if (!s.json.length) say('    (none - empty)')
      else s.json.forEach((row, i) => say(`    [${i}] ` + JSON.stringify(row)))
    } else say(`    (HTTP ${s.status} ${s.text.slice(0, 140)})`)
  }
}

// ---- 3. which of our functions exist ---------------------------------
say('---- 3. FUNCTIONS from 0018 / 0019 / 0020 ----')
const WANTED = [
  ['ent_may_touch_report',        '0003/0016  base read rule'],
  ['ent_may_edit_report',         '0019       the edit rule'],
  ['ent_may_grant_report_access', '0019       who may approve'],
  ['ent_has_report_grant',        '0019       live grant predicate'],
  ['ent_stamp_grant',             '0019       grant self-stamp'],
  ['ent_grants_narrow_only',      '0019       narrow-only trigger'],
  ['ent_stamp_report_ownership',  '0018       ownership stamp'],
  ['ent_stamp_photo_ownership',   '0019       photo re-parent stamp'],
  ['ent_may_read_own_clinic',     '0020       strict own-clinic read'],
  ['ent_may_open_report',         '0020       may open full record'],
  ['ent_view_all_index',          '0020       View All list RPC'],
  ['ent_open_report',             '0020       full-record RPC'],
  ['ent_may_access_photo',        '0009/0020  storage authorisation'],
]
{
  // Source: the schema cache, one GET, no POSTs at all.
  const inCache = (spec && spec.paths)
    ? new Set(Object.keys(spec.paths).filter(p => p.startsWith('/rpc/')).map(p => p.slice(5)))
    : null
  for (const [fn, note] of WANTED) {
    let state
    if (inCache) state = inCache.has(fn) ? 'PRESENT' : 'absent '
    else {
      const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
        method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}',
        signal: AbortSignal.timeout(12000),
      })
      const b = await r.text().catch(() => '')
      state = (r.status === 404 || /PGRST202|does not exist/i.test(b)) ? 'absent ' : 'PRESENT'
    }
    say(`  ${state}  ${fn.padEnd(30)} ${note}`)
  }
  say('')
  say('  PRESENT means already on the live database. "absent" means only its')
  say('  own migration creates it, so this column shows how far the applied')
  say('  sequence actually got.')
}
say('')

// ---- 4. clinic + staff fixtures --------------------------------------
say('---- 4. CLINIC AND STAFF FIXTURES ----')
{
  const c = await get('clinics?select=id,code,name,managed_by&order=code')
  if (c.status === 200 && Array.isArray(c.json)) {
    c.json.forEach(r => say(`  clinic  ${String(r.code).padEnd(14)} ${String(r.name).padEnd(26)} ` +
      (r.managed_by ? `managed_by=${r.managed_by.slice(0, 8)}` : 'managed_by=NULL')))
  } else say(`  (HTTP ${c.status})`)
  say('')
  const s = await get('staff_profiles?select=id,username,role,clinic_id,assigned_doctor_id,is_active&order=username')
  if (s.status === 200 && Array.isArray(s.json)) {
    s.json.forEach(r => say(`  staff   ${String(r.username).padEnd(12)} ${String(r.role).padEnd(10)} ` +
      `clinic=${String(r.clinic_id || 'NULL').slice(0, 8)}  active=${r.is_active}` +
      (r.assigned_doctor_id ? `  assigned=${r.assigned_doctor_id.slice(0, 8)}` : '')))
  } else say(`  (HTTP ${s.status})`)
}
say('')

// ---- 5. counts --------------------------------------------------------
say('---- 5. CURRENT ROW COUNTS ----')
for (const t of ['clinics', 'staff_profiles', 'reports', 'report_photos', 'activity_logs'])
  say(`  ${t.padEnd(18)} ${await headCount(t + '?select=id')}`)
say(`  ${'reports (draft)'.padEnd(18)} ${await headCount('reports?select=id&is_draft=eq.true')}`)
say(`  ${'reports (final)'.padEnd(18)} ${await headCount('reports?select=id&is_draft=eq.false')}`)
say('')

say('')

// ---- 6. anon reachability --------------------------------------------
say('---- 6. ANON KEY reachability (expect DENIED everywhere) ----')
{
  if (!ANON) say('  no anon key in .env.local')
  else for (const t of ['clinics', 'staff_profiles', 'reports', 'report_photos', 'activity_logs', 'report_access_grants']) {
    const r = await fetch(`${BASE}/rest/v1/${t}?select=*&limit=1`, {
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}` }, signal: AbortSignal.timeout(15000),
    })
    let n = -1
    try { const j = JSON.parse(await r.text()); n = Array.isArray(j) ? j.length : -2 } catch { n = -3 }
    const denied = [401, 403].includes(r.status) || n === 0
    say(`  ${denied ? 'DENIED   ' : 'REACHABLE'} ${t.padEnd(22)} HTTP ${r.status}, ${n} row(s)`)
  }
}
say('')
say('=====================================================================')
say('  SQL-EDITOR-ONLY CHECKS (PostgREST cannot read pg_catalog).')
say('  Paste these next; they are the remaining unknowns.')
say('=====================================================================')
say('')
say('-- A) functions WITH FULL SIGNATURES')
say("SELECT p.proname,")
say('       pg_get_function_identity_arguments(p.oid) AS args,')
say('       pg_get_function_result(p.oid)             AS returns,')
say('       p.prosecdef                               AS security_definer')
say('  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace')
say(" WHERE n.nspname = 'public'")
say("   AND p.proname IN ('ent_may_touch_report','ent_may_edit_report',")
say("       'ent_may_grant_report_access','ent_has_report_grant','ent_stamp_grant',")
say("       'ent_grants_narrow_only','ent_stamp_report_ownership',")
say("       'ent_stamp_photo_ownership','ent_may_read_own_clinic','ent_may_open_report',")
say("       'ent_view_all_index','ent_open_report','ent_may_access_photo')")
say(' ORDER BY p.proname;')
say('')
say('-- B) the SELECT policies verbatim (the qual text decides everything)')
say('SELECT tablename, policyname, cmd, roles::text,')
say("       regexp_replace(qual, '\\s+', ' ', 'g') AS qual")
say("  FROM pg_policies")
say(" WHERE schemaname = 'public'")
say("   AND tablename IN ('reports','report_photos')")
say(' ORDER BY tablename, cmd, policyname;')
say('')
say('-- C) anon table grants -- MUST return 0 rows')
say('SELECT table_name FROM information_schema.role_table_grants')
say(" WHERE grantee = 'anon' AND table_schema = 'public';")
say('')
say('-- D) every trigger on the three tables')
say('SELECT c.relname AS tbl, t.tgname, pg_get_triggerdef(t.oid) AS def')
say('  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid')
say(' WHERE NOT t.tgisinternal')
say("   AND c.relname IN ('reports','report_photos','report_access_grants')")
say(' ORDER BY c.relname, t.tgname;')
say('')
say('-- E) the grant table REAL columns and constraints')
say('SELECT column_name, data_type, is_nullable, column_default')
say('  FROM information_schema.columns')
say(" WHERE table_schema='public' AND table_name='report_access_grants'")
say(' ORDER BY ordinal_position;')
say('')

writeFileSync(join(HERE, '_diagnose.txt'), out.join('\n'), 'utf8')
console.log('wrote _diagnose.txt (' + out.length + ' lines)')

