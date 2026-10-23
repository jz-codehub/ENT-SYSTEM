// =====================================================================
//  preflight_0018_0020.mjs — READ-ONLY pre-flight against the live project.
// ---------------------------------------------------------------------
//  Runs BEFORE 0018 / 0019 / 0020 are applied, to answer "is the database
//  in the state those files expect?" without changing anything.
//
//  EVERY statement here is a SELECT or a HEAD count. There is no INSERT,
//  UPDATE, DELETE, DDL or RPC call in this file, so running it cannot alter
//  the database. All traffic is PostgREST /rest/v1 with the service key,
//  which bypasses RLS but cannot write.
//
//  The catalog questions (pg_policies, pg_proc, role_table_grants) cannot be
//  reached over REST, so those are printed at the end for the SQL Editor.
//
//  Run: node supabase-v2/scripts/preflight_0018_0020.mjs
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
const say = s => { out.push(s); console.log(s) }

async function rows(path, key) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20000),
  })
  const body = await r.text()
  let n = -1
  try { const j = JSON.parse(body); n = Array.isArray(j) ? j.length : -2 } catch { n = -3 }
  return { status: r.status, n }
}

async function count(path, extra = '') {
  const r = await fetch(`${BASE}/rest/v1/${path}?select=id${extra}`, {
    method: 'HEAD',
    headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, Prefer: 'count=exact' },
    signal: AbortSignal.timeout(20000),
  })
  const cr = r.headers.get('content-range') || ''
  return cr.includes('/') ? Number(cr.split('/')[1]) : -1
}

let fails = 0
const check = (id, label, pass, detail) => {
  if (pass) say(`  PASS  ${id.padEnd(7)} ${label}${detail ? '  — ' + detail : ''}`)
  else { fails++; say(`  FAIL  ${id.padEnd(7)} ${label}${detail ? '  — ' + detail : ''}`) }
}

say('')
say('==== PRE-FLIGHT: 0018 / 0019 / 0020 ====')
say(`project : ${BASE}`)
say('mode    : READ-ONLY (SELECT/HEAD only — no DDL, no writes)')
say('')

// ---- PF-1 the anon key must see nothing -----------------------------
say('---- PF-1  the ANON key must not read any patient row ----')
{
  if (!ANON) check('PF-1', 'anon key available', false, 'no SUPABASE_ANON_KEY')
  else {
    const r = await rows('staff_profiles?select=id&limit=5', ANON)
    check('PF-1', 'anon reads 0 staff_profiles rows', r.n === 0, `HTTP ${r.status}, ${r.n} row(s)`)
  }
}

say('')
say('---- PF-2  the ANON key must not read the patient tables ----')
{
  if (ANON) {
    for (const t of ['reports', 'report_photos']) {
      const r = await rows(`${t}?select=id&limit=5`, ANON)
      const denied = [401, 403].includes(r.status)
      check('PF-2', `anon read of ${t} denied`, denied || r.n === 0, `HTTP ${r.status}, ${r.n} row(s)`)
    }
  } else say('  SKIP  PF-2    no anon key')
}

// ---- PF-3 the tables the migrations depend on must exist ------------
say('')
say('---- PF-3  the tables the three migrations depend on ----')
{
  const tables = ['clinics', 'staff_profiles', 'reports', 'report_photos',
                  'activity_logs', 'tickets', 'ticket_messages',
                  'clinic_settings', 'system_flags', 'user_presence']
  for (const t of tables) {
    const r = await rows(`${t}?select=*&limit=1`, SVC)
    check('PF-3', `table ${t} reachable`, r.status === 200, `HTTP ${r.status}`)
  }
}

// ---- PF-4 report_access_grants must NOT exist yet -------------------
// If it already exists, 0019's DROP/CREATE would be overwriting live grants.
say('')
say('---- PF-4  report_access_grants must NOT exist yet ----')
{
  const r = await rows('report_access_grants?select=*&limit=1', SVC)
  const absent = r.status === 404
  check('PF-4', 'report_access_grants absent (0019 creates it)', absent,
        absent ? 'not present, as expected' : `HTTP ${r.status}`)
}

// ---- PF-5 baseline counts, to compare after -------------------------
say('')
say('---- PF-5  BASELINE counts (0018-0020 must not change these) ----')
const baseline = {}
for (const t of ['clinics', 'staff_profiles', 'reports', 'report_photos', 'activity_logs']) {
  const n = await count(t)
  baseline[t] = n
  check('PF-5', `${t} count readable`, n >= 0, `${n} row(s)`)
}
baseline.reports_draft = await count('reports', '&is_draft=eq.true')
baseline.reports_final = await count('reports', '&is_draft=eq.false')
check('PF-5', 'reports split by is_draft',
      baseline.reports_draft >= 0 && baseline.reports_final >= 0,
      `draft=${baseline.reports_draft}  final=${baseline.reports_final}`)

// ---- PF-6 no NULL ownership columns -------------------------------
// 0018 pins clinic_id / doctor_id from OLD. A NULL there would make that
// trigger's own comparison ambiguous, so it is worth knowing now.
say('')
say('---- PF-6  no reports row with a NULL clinic_id or doctor_id ----')
{
  const a = await rows('reports?select=id&clinic_id=is.null', SVC)
  check('PF-6', 'no NULL clinic_id', a.n === 0, `${a.n} row(s)`)
  const b = await rows('reports?select=id&doctor_id=is.null', SVC)
  check('PF-6', 'no NULL doctor_id', b.n === 0, `${b.n} row(s)`)
}

say('')
say('---- BASELINE RECORDED ----')
for (const [k, v] of Object.entries(baseline)) say(`  ${k.padEnd(18)} ${v}`)
say('')
say(fails === 0
  ? '==== PRE-FLIGHT PASSED — READY TO APPLY ===='
  : `==== ${fails} PRE-FLIGHT FAILURE(S) — DO NOT APPLY ====`)
say('')
say('CATALOG CHECKS REST CANNOT ANSWER — run in the SQL Editor:')
say('  1) anon table grants        -> must return 0 rows')
say('  2) pg_policies on reports / report_photos')
say('  3) pg_proc for ent_may_edit_report / ent_may_touch_report')
say('')

writeFileSync(join(HERE, '_preflight.txt'), out.join('\n'), 'utf8')
process.exit(fails === 0 ? 0 : 1)

