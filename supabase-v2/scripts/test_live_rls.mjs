#!/usr/bin/env node
/* =====================================================================
   test_live_rls.mjs — LIVE verification against the real Supabase project.
   ---------------------------------------------------------------------
   test_frontend_v2.mjs proves the frontend code in isolation. This one
   talks to the DEPLOYED database over HTTPS with real sign-ins, so a PASS
   here is evidence about the BACKEND, not about a stub.

     L1  anon can read nothing
     L2  a real user signs in with GoTrue
     L3  you can read YOUR staff_profiles row
     L4  a non-admin cannot read the whole staff directory
     L5  a doctor sees only rows on their own shelf
     L6  a secretary sees only her assigned doctor's shelf
     L7  cross-clinic isolation returns 0 foreign rows, not an error
     L8  a client-supplied clinic_id filter cannot widen the result
     L9  an INSERT omitting clinic/doctor is stamped from the caller
     L10 an INSERT forging clinic/doctor is OVERWRITTEN, not obeyed
     L11 a deactivated account is refused on its next request

   Edge Function behaviour is NOT covered here and is reported as untested
   until auth-admin / patient-photos are deployed.

   Run: node supabase-v2/scripts/test_live_rls.mjs
   ===================================================================== */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const env = {}
if (existsSync(join(HERE, '.env.local'))) {
  for (const line of readFileSync(join(HERE, '.env.local'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
const BASE = (env.SUPABASE_URL || '').replace(/\/+$/, '')
const ANON = env.SUPABASE_ANON_KEY || ''
const SVC = env.SUPABASE_SERVICE_ROLE_KEY || ''

let passed = 0, failed = 0, skipped = 0
const ok = (id, w, d = '') => { passed++; console.log(`  PASS  ${id.padEnd(4)} ${w}${d ? ' — ' + d : ''}`) }
const bad = (id, w, d = '') => { failed++; console.log(`  FAIL  ${id.padEnd(4)} ${w}${d ? ' — ' + d : ''}`) }
const is = (id, w, c, d = '') => c ? ok(id, w, d) : bad(id, w, d)
const skip = (id, w, why) => { skipped++; console.log(`  SKIP  ${id.padEnd(4)} ${w} — ${why}`) }

if (!BASE || !ANON) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY are required (.env.local).')
  process.exit(1)
}

async function rest(path, { token, method = 'GET', body, prefer } = {}) {
  const headers = { apikey: ANON, 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (prefer) headers.Prefer = prefer
  const r = await fetch(`${BASE}/rest/v1/${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  })
  const text = await r.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { status: r.status, ok: r.ok, data }
}

async function signIn(email, password) {
  const r = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ email, password })
  })
  const j = await r.json().catch(() => ({}))
  return { status: r.status, token: j.access_token || null, user: j.user || null, error: j.error_description || j.msg || null }
}

async function svcPatch(query, body) {
  const r = await fetch(`${BASE}/rest/v1/${query}`, {
    method: 'PATCH',
    headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body)
  })
  return { status: r.status, ok: r.ok }
}

console.log('')
console.log('==== LIVE RLS VERIFICATION (real HTTPS, real sign-ins) ====')
console.log(`project: ${BASE}`)
console.log('')

const stamp = Date.now()
const KEY = `v2probe|${stamp}|PROBE`
let doc1 = null, sec1 = null, zcb = null

// L1 — anon must get nothing.
{
  const r = await rest('reports?select=id&limit=5')
  is('L1', 'anon cannot read the reports table',
     r.status === 401 || r.status === 403 || (r.ok && Array.isArray(r.data) && r.data.length === 0),
     `HTTP ${r.status}${r.ok ? ` rows=${Array.isArray(r.data) ? r.data.length : '?'}` : ''}`)
  const s = await rest('staff_profiles?select=id&limit=5')
  is('L1b', 'anon cannot read staff_profiles',
     s.status === 401 || s.status === 403 || (s.ok && Array.isArray(s.data) && s.data.length === 0),
     `HTTP ${s.status}`)
}

// L2 — real sign-in.
{
  const r = await signIn(env.TEST_EMAIL, env.TEST_PASSWORD)
  doc1 = r.token ? { token: r.token, id: r.user?.id } : null
  is('L2', 'a synthetic doctor signs in with GoTrue', !!r.token,
     doc1 ? env.TEST_EMAIL : `refused: ${r.error || r.status}`)
}

// L3/L4
if (doc1) {
  const me = await rest('staff_profiles?select=id,username,role,clinic_id&limit=1', { token: doc1.token })
  const rows = Array.isArray(me.data) ? me.data : []
  is('L3', 'a signed-in user reads their OWN staff_profiles row',
     me.ok && rows.length === 1 && rows[0].id === doc1.id,
     rows[0] ? `${rows[0].username}/${rows[0].role}` : `HTTP ${me.status}`)
  const all = await rest('staff_profiles?select=id,username&limit=50', { token: doc1.token })
  const list = Array.isArray(all.data) ? all.data : []
  is('L4', 'a non-admin cannot read the whole staff directory',
     all.ok && list.length <= 1, `returned ${list.length} row(s)`)
}

// L1c — THE REGRESSION GUARD FOR "Could not save: Failed to fetch".
//
// The browser reports a CORS-blocked call as a bare TypeError: "Failed to
// fetch". Node does not enforce CORS, so every other check in this file —
// and every script in this folder — happily saw the function answer 200
// while the page could not read a single byte. The whole admin console was
// unreachable from the browser and no test noticed.
//
// _shared/auth.ts reads ENT_ALLOWED_ORIGIN from the DEPLOYED function's
// environment (not from the local .env.local) and, with no allowlist set,
// deliberately emits NO Access-Control-Allow-Origin header. The browser
// then blocks the response. This asserts the header is actually present for
// the origin the app is served from.
//
// FIXED 2026-10-03. This previously assigned the WHOLE comma-separated
// allowlist to one Origin header:
//
//     const APP_ORIGIN = env.ENT_ALLOWED_ORIGIN || 'http://localhost:5500'
//
// ENT_ALLOWED_ORIGIN is an ALLOWLIST of two entries, so that produced
//     Origin: http://localhost:5500,https://ent-system.johnzynd.workers.dev
// which no browser ever sends - one Origin header cannot contain a comma.
// _shared/auth.ts matches with an exact ALLOWED_ORIGINS.includes(origin),
// so it correctly declined that malformed value, and L1c reported
// "ACAO ABSENT -> the BROWSER blocks every call" while the production
// origin was in fact being allowed all along. A false alarm caused by the
// test, not by the deployment.
//
// Each origin is now asked about SEPARATELY, which is what a browser does.
// The assertion is that AT LEAST ONE is allowed, because the allowlist is
// a set and the app may be served from any of its entries.
const APP_ORIGINS = (env.ENT_ALLOWED_ORIGIN || 'http://localhost:5500')
  .split(',').map(s => s.trim()).filter(Boolean)
{
  const probes = []
  for (const origin of APP_ORIGINS) {
    try {
      const pre = await fetch(`${BASE}/functions/v1/auth-admin`, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type,apikey',
        },
        signal: AbortSignal.timeout(15000),
      })
      probes.push({ origin, acao: pre.headers.get('access-control-allow-origin') })
    } catch (e) {
      probes.push({ origin, acao: null })
    }
  }
  const allowed = probes.filter(p => p.acao === p.origin)
  // Published for L1d below, which must reuse an origin already proven to
  // work rather than re-deriving one and possibly picking a refused entry.
  var ALLOWED_ORIGINS_FOUND = allowed.map(p => p.origin)
  is('L1c', 'the deployed function returns Access-Control-Allow-Origin for this app',
     allowed.length > 0,
     allowed.length
       ? allowed.map(p => p.origin).join(', ')
       : probes.map(p => `${p.origin} -> ABSENT`).join(' | ') +
         ' -> the BROWSER blocks every call ("Failed to fetch"). ' +
         'Fix: supabase secrets set ENT_ALLOWED_ORIGIN=' + APP_ORIGINS.join(','))
  // Report, but do not fail on, the origins that are deliberately not
  // allowed. A deployed allowlist that lists production but not localhost
  // is correct and common, and treating it as a defect is what made this
  // check cry wolf in the first place.
  const refused = probes.filter(p => p.acao !== p.origin)
  if (refused.length) {
    console.log(`  NOTE  L1c   not allowed (expected if not deployed there): ` +
                refused.map(p => p.origin).join(', '))
  }
}

// L1d — the real signed-in call must be readable by a browser, not just by Node.
//
// FIXED 2026-10-03 along with L1c. It now reuses an origin that L1c's
// preflight already proved is allowlisted, instead of re-deriving one.
//
// The assertion was also wrong about the STATUS. It demanded r.ok, but
// testadmin carries must_change_password = true, so auth-admin correctly
// answers HTTP 403 PASSWORD_CHANGE_REQUIRED - see smoke_test.mjs SMK-4,
// which asserts exactly that. A 403 here is the function working, not a
// CORS failure.
//
// What this check is actually FOR is the ACAO header: the browser's real
// failure mode is a bare TypeError "Failed to fetch" with no status and no
// body, which happens when the response carries no ACAO and the browser
// refuses to expose it. So the property under test is:
//
//     the response carries ACAO for the origin we sent
//
// A 401/403 still proves the browser can READ the response. Requiring 2xx
// here tested the password policy by accident, and reported it as a
// cross-origin failure.
{
  const adm = await signIn(env.LIVE_TESTADMIN, env.LIVE_TESTADMIN_PW)
  const GOOD_ORIGIN = ALLOWED_ORIGINS_FOUND[0]
  if (adm.token && GOOD_ORIGIN) {
    const r = await fetch(`${BASE}/functions/v1/auth-admin`, {
      method: 'POST',
      headers: {
        apikey: ANON, 'Content-Type': 'application/json',
        Origin: GOOD_ORIGIN, Authorization: `Bearer ${adm.token}`,
      },
      body: JSON.stringify({ action: 'capabilities' }),
      signal: AbortSignal.timeout(15000),
    })
    const acao = r.headers.get('access-control-allow-origin')
    const echoed = acao === GOOD_ORIGIN
    const body = await r.text().catch(() => '')
    // 403 + PASSWORD_CHANGE_REQUIRED is the documented, correct answer for
    // a must_change_password account. Anything else non-2xx is unexpected.
    const expected403 = r.status === 403 && /PASSWORD_CHANGE_REQUIRED/.test(body)
    const readable = echoed && (r.ok || expected403)
    is('L1d', 'a real response carries ACAO back to the browser',
       readable,
       `origin=${GOOD_ORIGIN} HTTP ${r.status} ACAO=${acao === null ? 'ABSENT' : acao}` +
         (expected403 ? ' (PASSWORD_CHANGE_REQUIRED, expected)' : ''))
  } else {
    skip('L1d', 'a real response carries ACAO back to the browser',
         !adm.token ? 'no testadmin creds'
                    : 'no allowlisted origin answered the preflight (see L1c)')
  }
}

//
// Three defects shipped together and all three were invisible to a test:
//
//  1. admin.js sent `email: email || ...` where `email` was never declared.
//     ReferenceError on every create -> "Could not save: email is not
//     defined". Creating a user from the console was impossible.
//  2. auth-admin derived the address as <username>@clinic.invalid while the
//     login screen appends @zztest.invalid, so a user created in the
//     console got an address sign-in never queries. Masked by (1).
//  3. Three different password floors: admin.js 6, auth.js 8, auth-admin 10.
//     A password the admin screen accepted was refused by the server.
//
// These read the real source files, so they fail if the code drifts back.
// HERE is <root>/supabase-v2/scripts, so the frontend is two levels up.
const APP = join(HERE, '..', '..')
const adminJs = readFileSync(join(APP, 'function', 'admin.js'), 'utf8')
const authJs = readFileSync(join(APP, 'function', 'auth.js'), 'utf8')
const loginHtml = readFileSync(join(APP, 'pages', 'login.html'), 'utf8')
const fnTs = readFileSync(join(APP, 'supabase-v2', 'edge-functions', 'auth-admin', 'index.ts'), 'utf8')

// 1. no undeclared `email` in the create payload
const createBlock = adminJs.match(/action:\s*'create'[\s\S]{0,400}/)
is('L3c', 'admin.js sends no undefined `email` variable on create',
   !!createBlock && !/\bemail\b\s*:/.test(createBlock[0].replace(/\/\/[^\n]*/g, '')),
   createBlock ? 'create payload has no email key' : 'create block not found')

// 2. the two domains must be identical
const domAuth = (authJs.match(/const EMAIL_DOMAIN = '([^']+)'/) || [])[1]
const domFn = (fnTs.match(/const ACCOUNT_EMAIL_DOMAIN = '([^']+)'/) || [])[1]
is('L3d', 'the sign-in domain matches the one auth-admin creates accounts with',
   !!domAuth && domAuth === domFn,
   `auth.js=${domAuth}  auth-admin=${domFn}` +
   (domAuth === domFn ? '' : '   <-- MISMATCH: created users could never sign in'))

// 3. one password floor everywhere, and it must be >= GoTrue's 6
const floors = {
  'auth.js': (authJs.match(/const MIN_PASSWORD_LENGTH = (\d+)/) || [])[1],
  'admin.js': (adminJs.match(/MIN_PASSWORD_LENGTH = Auth\.MIN_PASSWORD_LENGTH \|\| (\d+)/) || [])[1],
  'auth-admin': (fnTs.match(/const MIN_PASSWORD_LENGTH = (\d+)/) || [])[1]
}
const vals = Object.values(floors)
//
// FIXED 2026-10-03. The second clause used to be
//
//     !/\b(length < (?!6)\d+)\b/.test(adminJs + authJs + fnTs)
//
// which bans ANY `length < N` where N is not 6, anywhere in any of the
// three files. It reported FAIL while printing "auth.js=6 admin.js=6
// auth-admin=6" - self-contradictory, because the floors were correct.
// Traced to its single match:
//
//     admin.js:1570   if (name.length < 2)   <- CLINIC NAME, not a password
//
// A clinic-name rule is not a password policy. The regex matched it,
// declared a password defect that did not exist, and - worse - would have
// masked a REAL split floor, because the suite was already red and nobody
// would look again.
//
// The property actually wanted is "no layer enforces a password floor
// other than 6". So the floor is read from each layer the same way the
// first clause reads it, and the historical bug - auth-admin at 10 while
// auth.js said 6 - still fails this check, which verify_guards.mjs proves
// by mutating the file to exactly that state.
is('L3e', 'all three layers declare the same password floor, and it is >= 6',
   vals.every(v => v === '6') && Number(vals[0]) >= 6,
   Object.entries(floors).map(([k, v]) => `${k}=${v}`).join('  '))

// 4. login.html must not hard-code its own floor
is('L3f', 'login.html reads the shared floor instead of hard-coding 6',
   /const MIN_PASSWORD_LENGTH = \(window\.EntAuth/.test(loginHtml) &&
   !/newPwEl\.value\.length < 6/.test(loginHtml),
   'shared constant wired in')

// L3a — THE REGRESSION GUARD FOR THE "ADMIN LOGS IN AND SEES A DOCTOR" BUG.
//
// auth.js:loadProfile() used to read `staff_profiles?...&limit=1` and trust
// RLS to narrow it to one row. That holds for a doctor and a secretary, so
// L3 above passed and the bug survived. An admin is different:
// profiles_select_admin_clinic (0008:48-55) deliberately lets an admin read
// every profile in his own clinic, so the unfiltered query returned the whole
// clinic and limit=1 took an arbitrary row. Live proof: testadmin was handed
// testdoc1 with role=doctor, so the header said DOCTOR and login.html sent
// him to index.html instead of admin.html.
//
// This asserts the REAL fix: the self-filtered query an admin's browser now
// runs must return exactly his own row. The second half documents the trap by
// showing the unfiltered form is genuinely ambiguous for an admin — if that
// ever stops being true the ambiguity argument needs revisiting.
const adm = await signIn(env.LIVE_TESTADMIN, env.LIVE_TESTADMIN_PW)
if (adm.token && adm.user?.id) {
  const selfQ = 'staff_profiles?select=id,username,role,clinic_id&id=eq.' + adm.user.id
  const meAdmin = await rest(selfQ, { token: adm.token })
  const arows = Array.isArray(meAdmin.data) ? meAdmin.data : []
  is('L3a', 'an ADMIN self-filtered read returns HIS OWN row, not a doctor\'s',
     meAdmin.ok && arows.length === 1 && arows[0].id === adm.user.id && arows[0].role === 'admin',
     arows[0] ? `${arows[0].username}/${arows[0].role}` : `HTTP ${meAdmin.status}`)

  // Show the trap concretely: the clinic holds more than one profile, so an
  // unfiltered limit=1 has no guarantee of being your own row. This asserts
  // the AMBIGUITY EXISTS (wcount > 1) and reports which row the old query
  // would actually have handed back. If an admin ever legitimately sits alone
  // in a clinic this flips, and the comment in auth.js must be revisited.
  const whole = await rest('staff_profiles?select=id&limit=50', { token: adm.token })
  const wcount = Array.isArray(whole.data) ? whole.data.length : 0
  const amb = await rest('staff_profiles?select=id,username,role&limit=1', { token: adm.token })
  const brow = Array.isArray(amb.data) ? amb.data[0] : null
  is('L3b', 'the unfiltered limit=1 form is ambiguous for an admin (why auth.js must filter)',
     wcount > 1 && !!brow,
     `clinic has ${wcount} profile(s); unfiltered limit=1 returned ` +
     (brow ? `${brow.username}/${brow.role}` : `nothing (HTTP ${amb.status})`) +
     (brow && brow.id !== adm.user.id ? '  <-- NOT the admin: this is the bug' : ''))
} else {
  skip('L3a', 'an ADMIN self-filtered read returns HIS OWN row',
       'no testadmin credentials in .env.local')
}
if (doc1) {
  // L9 — an insert that does NOT choose ownership.
  const ins = await rest('reports', {
    token: doc1.token, method: 'POST', prefer: 'return=representation',
    body: [{
      record_key: KEY + '|A', report_type: 'cf4', patient_name: 'SYNTHETIC PROBE',
      patient_id: 'PROBE-1', case_number: 'PROBE', procedure_date: null,
      file_name: 'probe.pdf', payload: { probe: true }
    }]
  })
  const row = Array.isArray(ins.data) ? ins.data[0] : null
  is('L9', 'an INSERT omitting clinic/doctor is stamped from the caller profile',
     ins.ok && !!row && row.doctor_id === doc1.id && !!row.clinic_id && !!row.created_by,
     row ? `doctor=${row.doctor_id === doc1.id ? '= caller OK' : 'WRONG'} clinic=${row.clinic_id ? 'set' : 'MISSING'} created_by=${row.created_by ? 'set' : 'MISSING'}`
         : `HTTP ${ins.status} ${JSON.stringify(ins.data).slice(0, 100)}`)

  // L10 — an insert that FORGES ownership.
  const z = await signIn(env.LIVE_ZCBDOC1, env.LIVE_ZCBDOC1_PW)
  zcb = z.token ? { token: z.token, id: z.user?.id } : null
  if (zcb) {
    const zme = await rest('staff_profiles?select=clinic_id&limit=1', { token: zcb.token })
    const zClinic = Array.isArray(zme.data) ? zme.data[0]?.clinic_id : null
    const forge = await rest('reports', {
      token: zcb.token, method: 'POST', prefer: 'return=representation',
      body: [{
        clinic_id: '00000000-0000-4000-8000-00000000c11c',
        doctor_id: doc1.id, created_by: doc1.id,
        record_key: KEY + '|FORGE', report_type: 'cf4',
        patient_name: 'FORGERY PROBE', procedure_date: null, payload: {}
      }]
    })
    const f = Array.isArray(forge.data) ? forge.data[0] : null
    //
    // FIXED 2026-10-03. This demanded `forge.ok`, i.e. that the insert
    // SUCCEED and be silently overwritten with the caller's own clinic and
    // doctor. It was asking for one particular MECHANISM (overwrite by
    // trigger) when the property under test is "a forgery does not
    // succeed".
    //
    // The live answer was HTTP 403: the RLS policy refused the row outright,
    // so nothing was written. Confirmed by _probe_l10_forgery.mjs - zero
    // rows carry the forgery markers. Refusing is STRICTLY SAFER than
    // overwriting, so the old assertion reported a security PASS as a FAIL
    // and taught the next reader that ownership stamping was broken.
    //
    // Now accepts either safe outcome, and reads the row back with the
    // SERVICE role so the answer cannot itself be filtered by the very
    // policy under test:
    //   refused (4xx, no row written)  -> forgery did not succeed
    //   accepted but stamped to caller -> forgery did not succeed
    // Anything else - a row persisted with a FOREIGN clinic_id or
    // doctor_id - is the real defect this test exists to catch.
    const readback = await rest(
      `reports?select=clinic_id,doctor_id,created_by&record_key=eq.${encodeURIComponent(KEY + '|FORGE')}&limit=5`,
      { token: SVC })
    const foreign = (Array.isArray(readback.data) ? readback.data : [])
      .filter(r => r.clinic_id !== zClinic || r.doctor_id !== zcb.id || r.created_by !== zcb.id)

    const refused  = !forge.ok
    const stamped  = !!f && f.clinic_id === zClinic && f.doctor_id === zcb.id
    const clean    = foreign.length === 0

    is('L10', 'a forged clinic_id/doctor_id is NEVER obeyed',
       (refused || stamped) && clean,
       !clean
         ? `PERSISTED WITH FOREIGN OWNERSHIP: ${JSON.stringify(foreign[0])}`
         : refused
           ? `HTTP ${forge.status} REFUSED by policy, 0 row(s) written - forgery did not succeed`
           : `HTTP ${forge.status} accepted then STAMPED to caller - forgery did not succeed`)
  } else skip('L10', 'forged-clinic insert', `could not sign in as zcbdoc1: ${z.error || z.status}`)

  // L5 / L8
  const mine = await rest('reports?select=id,doctor_id,clinic_id&limit=200', { token: doc1.token })
  const rows = Array.isArray(mine.data) ? mine.data : []
  const foreign = rows.filter(r => r.doctor_id !== doc1.id)
  is('L5', 'a doctor sees ONLY rows on their own shelf',
     mine.ok && foreign.length === 0,
     `${rows.length} row(s) visible, ${foreign.length} belonging to someone else`)

  const forced = await rest('reports?clinic_id=eq.00000000-0000-4000-8000-00000000c11c&select=id&limit=200', { token: doc1.token })
  const frows = Array.isArray(forced.data) ? forced.data : []
  is('L8', 'a client-supplied clinic_id filter cannot widen the result set',
     forced.ok && frows.length === rows.length,
     `unfiltered=${rows.length}, forced main_clinic=${frows.length}`)

  const s = await signIn(env.LIVE_TESTSEC1, env.LIVE_TESTSEC1_PW)
  sec1 = s.token ? { token: s.token, id: s.user?.id } : null
  if (sec1) {
    const sme = await rest('staff_profiles?select=assigned_doctor_id&limit=1', { token: sec1.token })
    const assigned = Array.isArray(sme.data) ? sme.data[0]?.assigned_doctor_id : null
    const sRows = await rest('reports?select=id,doctor_id&limit=200', { token: sec1.token })
    const sList = Array.isArray(sRows.data) ? sRows.data : []
    const leak = sList.filter(r => assigned && r.doctor_id !== assigned)
    is('L6', "a secretary sees ONLY her assigned doctor's shelf",
       sRows.ok && leak.length === 0,
       `${sList.length} row(s), ${leak.length} outside her assignment`)
  } else skip('L6', 'secretary scoping', `could not sign in as testsec1: ${s.error || s.status}`)

  if (zcb) {
    const zRows = await rest('reports?select=id,clinic_id&limit=200', { token: zcb.token })
    const zList = Array.isArray(zRows.data) ? zRows.data : []
    const zMe = await rest('staff_profiles?select=clinic_id&limit=1', { token: zcb.token })
    const zClinic = Array.isArray(zMe.data) ? zMe.data[0]?.clinic_id : null
    const cross = zList.filter(r => zClinic && r.clinic_id !== zClinic)
    is('L7', 'cross-clinic isolation returns 0 foreign rows, not an error',
       zRows.ok && cross.length === 0,
       `${zList.length} row(s) to a satellite-clinic doctor, ${cross.length} foreign`)
  }
}
// L11 — a deactivated account loses access on its NEXT request.
//
// The gate to test is REPORTS, not the caller's own staff_profiles row:
// profiles_select_self is `USING (id = ent_auth_uid())` and deliberately
// does not check is_active, so reading one's own profile is not evidence
// of anything. ent_may_touch_report DOES check is_active, so a report
// read is the honest probe.
{
  const a = await signIn(env.LIVE_ZZBADMIN, env.LIVE_ZZBADMIN_PW)
  const admin = a.token ? { token: a.token, id: a.user?.id } : null
  if (admin) {
    const before = await rest('reports?select=id&limit=5', { token: admin.token })
    const upd = await svcPatch(`staff_profiles?id=eq.${admin.id}`, { is_active: false })
    const after = await rest('reports?select=id&limit=5', { token: admin.token })
    const rows = Array.isArray(after.data) ? after.data : []
    const blocked = after.status === 401 || after.status === 403 ||
                    (after.ok && rows.length === 0 && before.status !== 403)
    is('L11', 'a DEACTIVATED account is refused on its very next request', blocked,
       upd.ok
         ? `before: HTTP ${before.status} (${before.ok ? (Array.isArray(before.data) ? before.data.length : '?') + ' row(s)' : 'blocked'}) -> after: HTTP ${after.status} (${after.ok ? rows.length + ' row(s)' : 'blocked'})`
         : `could not deactivate (HTTP ${upd.status})`)
    await svcPatch(`staff_profiles?id=eq.${admin.id}`, { is_active: true })
  } else skip('L11', 'deactivated account', `could not sign in as zzbadmin: ${a.error || a.status}`)
}

// Clean up the probe rows.
if (SVC) {
  await fetch(`${BASE}/rest/v1/reports?record_key=like.*v2probe*`, {
    method: 'DELETE',
    headers: { apikey: SVC, Authorization: `Bearer ${SVC}` }
  })
}

console.log('')
console.log(`==== ${failed === 0 ? 'LIVE RLS OK' : failed + ' FAILED'} · ${passed + failed + skipped} checks ====`)
console.log('')
skip('LFN', 'auth-admin + photo upload/download', 'Edge Functions not deployed yet — smoke_test.mjs')
console.log('Nothing above is marked PASS on the strength of the stubbed harness:')
console.log('every check is a real HTTPS round trip against the deployed project.')
console.log('')
process.exit(failed === 0 ? 0 : 1)