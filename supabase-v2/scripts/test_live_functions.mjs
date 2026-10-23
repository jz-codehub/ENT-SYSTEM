#!/usr/bin/env node
/* =====================================================================
   test_live_functions.mjs — LIVE tests against DEPLOYED Edge Functions.
   ---------------------------------------------------------------------
   Nothing stubbed: real HTTPS, real sign-ins, real deployed functions.

   PHASE 1 runs FIRST and is not optional bookkeeping. Every synthetic
   account is created with must_change_password = TRUE, so requireUser()
   answers 403 PASSWORD_CHANGE_REQUIRED before requireAdmin() is ever
   reached. That is CORRECT: a brand new account must not administer
   anything until it has chosen its own password.

       sign in -> assert the door is CLOSED -> updateUser(password)
       -> auth-admin finish_password_change -> assert the flag is clear

   F1  health (both functions)              F9   password change: NEW works,
   F2  anonymous refusal                         OLD refused
   F3  NON-admin (doctor) refused          F10  photo upload -> report_photos row
   F4  DEACTIVATED admin refused            F11  photo download -> bytes
   F5  capabilities -> live profile         F12  another doctor refused
   F6  admin CREATE -> password works       F13  photo flag OFF refused
   F7  admin UPDATE changes the row         F14  CORS: bad Origin -> no ACAO
   F8  set_active FALSE/TRUE                 F15  CORS: good Origin echoed

   Run: node supabase-v2/scripts/test_live_functions.mjs
   ===================================================================== */
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

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
const FN = BASE + '/functions/v1'

let passed = 0, failed = 0, skipped = 0
const ok = (id, w, d = '') => { passed++; console.log('  PASS  ' + id.padEnd(4) + ' ' + w + (d ? ' — ' + d : '')) }
const bad = (id, w, d = '') => { failed++; console.log('  FAIL  ' + id.padEnd(4) + ' ' + w + (d ? ' — ' + d : '')) }
const is = (id, w, c, d = '') => c ? ok(id, w, d) : bad(id, w, d)
// A skip is not a pass, so we must know WHICH ids were skipped and which of
// them are required. P1 covers the whole forced-password-change flow (P1a/P1b/
// P1c per account); F3-F13 are the live behaviour checks. If any of those did
// not run, the run is not a verification.
const REQUIRED = new Set(['P1', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9',
  'F10', 'F11', 'F12', 'F13'])
const skippedIds = []
const skip = (id, w, why) => {
  skipped++
  skippedIds.push(id)
  console.log('  SKIP  ' + id.padEnd(4) + ' ' + w + ' — ' + why)
}

async function call(fn, payload, opts) {
  const o = opts || {}
  const headers = { apikey: ANON, 'Content-Type': 'application/json' }
  if (o.token) headers.Authorization = 'Bearer ' + o.token
  if (o.origin) headers.Origin = o.origin
  const r = await fetch(FN + '/' + fn, { method: 'POST', headers, body: JSON.stringify(payload || {}), signal: AbortSignal.timeout(20000) })
  const text = await r.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch (e) { json = text }
  return { status: r.status, json, acao: r.headers.get('access-control-allow-origin') }
}

async function signIn(email, password) {
  const r = await fetch(BASE + '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(15000) })
  const j = await r.json().catch(() => ({}))
  // GoTrue reports a bad credential as `msg`, NOT `error_description`.
  // Reading only the latter produced "sign-in refused: null", which hid the
  // actual reason and made the output unreadable. Prefer whichever is present.
  const reason = j.error_description || j.msg || j.error || j.error_code || ('HTTP ' + r.status)
  return { token: j.access_token || null, id: j.user ? j.user.id : null, error: reason }
}

async function svcPatch(query, body) {
  const r = await fetch(BASE + '/rest/v1/' + query, {
    method: 'PATCH',
    headers: { apikey: SVC, Authorization: 'Bearer ' + SVC, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000) })
  return { ok: r.ok, status: r.status }
}

async function svcDelete(query) {
  return fetch(BASE + '/rest/v1/' + query, {
    method: 'DELETE', headers: { apikey: SVC, Authorization: 'Bearer ' + SVC }, signal: AbortSignal.timeout(15000) })
}

// `apikey` and `Authorization` are NOT the same thing. PostgREST validates
// `apikey` as an API key and answers 401 "Invalid API key" when it is handed
// a user JWT instead — which is exactly what this did: a user token was put
// in BOTH headers, so the report lookup returned 401, and because
// `rows.data[0]` is undefined on an error body the suite reported
// "no testdoc1 report row visible" instead of the real 401. That hid the
// cause across three runs. This is the same split the browser uses:
// apikey = anon, Authorization = session JWT (see test T3).
async function restGet(query, token) {
  const k = token || SVC
  const r = await fetch(BASE + '/rest/v1/' + query, {
    headers: token
      ? { apikey: ANON, Authorization: 'Bearer ' + token }
      : { apikey: SVC, Authorization: 'Bearer ' + SVC },
    signal: AbortSignal.timeout(15000)
  })
  const t = await r.text()
  let data = null
  try { data = t ? JSON.parse(t) : null } catch (e) { data = t }
  // Surface a REST failure instead of letting an error body masquerade as
  // "no rows": the callers below read .data[0], which is undefined either way.
  if (!Array.isArray(data)) {
    console.log('  NOTE  restGet ' + query.slice(0, 58) + ' -> HTTP ' + r.status +
      ' ' + JSON.stringify(data).slice(0, 120))
  }
  return { status: r.status, data }
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const stamp = Date.now()
const USER = 'zzprobe' + String(stamp).slice(-6)
const created = []
const made = []
const NEW_PW = {}
console.log('')
console.log('==== LIVE EDGE FUNCTION TESTS (real HTTPS, deployed) ====')
console.log('project: ' + BASE)
console.log('')

const h = await call('auth-admin', { action: 'health' })
if (h.status === 404 || /NOT_FOUND/i.test(String(h.json))) {
  console.log('  auth-admin returned HTTP 404 � NOT DEPLOYED yet.')
  console.log('  Deploy both functions, then re-run. All further checks are blocked.')
  console.log('')
  process.exit(1)
}
is('F1', 'auth-admin health answers unauthenticated',
   h.status === 200 && h.json && h.json.schema === 'v2', 'HTTP ' + h.status + ' schema=' + (h.json && h.json.schema))
const ph = await call('patient-photos', { action: 'health' })
is('F1b', 'patient-photos health answers unauthenticated',
   ph.status === 200 && ph.json && ph.json.schema === 'v2', 'HTTP ' + ph.status)

// ==================================================================
// PHASE 1 � walk the REAL forced-password-change flow.
// Proves the gate is closed, then walks it the way a real user would.
// ==================================================================
console.log('')
console.log('---- PHASE 1 � forced password change (the real flow) ----')

// ---- controlled test-state reset -----------------------------------
// Every synthetic account must START this run in the "fresh account"
// state, i.e. must_change_password = TRUE. Without this, an account left
// unlocked by a previous run (or by a manual probe) would answer P1a
// with HTTP 200 instead of 403, and the test would report a working gate
// as broken. This is the same service-role mechanism the cleanup below
// uses; it touches ONLY the six synthetic accounts and only that column.
console.log('')
console.log('---- test-state reset (must_change_password = TRUE) ----')
const SYNTHETIC = ['testadmin', 'testdoc1', 'testdoc2', 'testsec1', 'zzbadmin', 'zcbdoc1']
// Concurrent, and each request is contained: a single slow or aborted call
// must not take the whole suite down, which is what happened when these
// were sequential and unguarded.
const armed = await Promise.allSettled(SYNTHETIC.map(function (name) {
  return fetch(BASE + '/rest/v1/staff_profiles?username=eq.' + name, {
    method: 'PATCH',
    headers: { apikey: SVC, Authorization: 'Bearer ' + SVC, 'Content-Type': 'application/json' },
    body: JSON.stringify({ must_change_password: true }),
    signal: AbortSignal.timeout(25000)
  })
}))
const armedOk = armed.filter(function (a) { return a.status === 'fulfilled' && a.value.ok }).length
console.log('  ' + armedOk + ' of ' + SYNTHETIC.length + ' synthetic accounts armed for the gate test')
if (armedOk !== SYNTHETIC.length) {
  console.log('  WARNING: ' + (SYNTHETIC.length - armedOk) + ' account(s) could not be armed;')
  console.log('           their P1a may report HTTP 200 instead of 403.')
}

console.log('')
console.log('---- credential bootstrap (known-valid passwords, service role) ----')
// The suite used to bootstrap Phase 1 from the rotated passwords in
// .env.local. That is circular: those passwords are WRITTEN BY this suite, and
// only after Phase 1 succeeds. When Phase 1 was skipped, nothing was written,
// the next run read the same stale value, and the suite deadlocked at
// "sign-in refused" forever. Nothing could ever recover except a human.
//
// Instead, mint a fresh random password per account right here and apply it
// with the service-role Admin API. This is the same admin path auth-admin's
// own "create" action uses, so it needs no new mechanism and no Edge Function
// change. It touches ONLY the four synthetic accounts Phase 1 exercises and
// ONLY the password field. .env.local becomes a pure output/cache again.
const BOOT = {}
const bootTargets = [
  { env: 'TEST_EMAIL', pw: 'TEST_PASSWORD' },
  { env: 'LIVE_TESTADMIN', pw: 'LIVE_TESTADMIN_PW' },
  { env: 'LIVE_TESTDOC2', pw: 'LIVE_TESTDOC2_PW' },
  { env: 'LIVE_TESTSEC1', pw: 'LIVE_TESTSEC1_PW' }
]
const SVC_HDR = { apikey: SVC, Authorization: 'Bearer ' + SVC, 'Content-Type': 'application/json' }
let bootOk = 0
for (const t of bootTargets) {
  const email = env[t.env]
  if (!email) { console.log('  SKIP bootstrap ' + t.env + ' — no email in .env.local'); continue }
  try {
    const lu = await (await fetch(BASE + '/auth/v1/admin/users?page=1&per_page=1000',
      { headers: SVC_HDR, signal: AbortSignal.timeout(25000) })).json()
    const u = Array.isArray(lu.users) && lu.users.find(function (x) {
      return String(x.email || '').toLowerCase() === String(email).toLowerCase()
    })
    if (!u) { console.log('  SKIP bootstrap ' + String(email).split('@')[0] + ' — not found in auth.users'); continue }
    const pw = 'Zz!bt' + randomBytes(9).toString('base64url')
    const r = await fetch(BASE + '/auth/v1/admin/users/' + u.id, {
      method: 'PUT', headers: SVC_HDR, body: JSON.stringify({ password: pw }),
      signal: AbortSignal.timeout(25000)
    })
    if (r.ok) { BOOT[t.pw] = pw; bootOk++ }
    else console.log('  SKIP bootstrap ' + String(email).split('@')[0] + ' — admin API HTTP ' + r.status)
  } catch (e) {
    console.log('  SKIP bootstrap ' + String(email).split('@')[0] + ' — ' + e.message)
  }
}
console.log('  ' + bootOk + ' of ' + bootTargets.length + ' synthetic accounts given a known-valid password')
if (bootOk !== bootTargets.length) {
  console.log('  WARNING: bootstrap incomplete; Phase 1 may SKIP the affected accounts.')
}

const ACCOUNTS = [
  { env: 'TEST_EMAIL', pw: 'TEST_PASSWORD' },
  { env: 'LIVE_TESTADMIN', pw: 'LIVE_TESTADMIN_PW' },
  { env: 'LIVE_TESTDOC2', pw: 'LIVE_TESTDOC2_PW' },
  { env: 'LIVE_TESTSEC1', pw: 'LIVE_TESTSEC1_PW' }
]
const sessions = {}

for (const acc of ACCOUNTS) {
  const email = env[acc.env]
  // Prefer the freshly minted bootstrap password. The .env.local value is only
  // a fallback for the case where bootstrap did not run for this account.
  const oldPw = BOOT[acc.pw] || env[acc.pw]
  const who = email ? String(email).split('@')[0] : acc.env
  if (!email || !oldPw) { skip('P1', 'password flow for ' + who, 'missing credentials'); continue }

  const s = await signIn(email, oldPw)
  if (!s.token) { skip('P1', 'password flow for ' + who, 'sign-in refused: ' + s.error); continue }

  const blocked = await call('auth-admin', { action: 'capabilities' }, { token: s.token })
  const code = blocked.json && blocked.json.code
  is('P1a', who + ': protected action is BLOCKED while must_change_password=true',
     blocked.status === 403 && code === 'PASSWORD_CHANGE_REQUIRED',
     'HTTP ' + blocked.status + ' code=' + (code || 'none'))

  const next = 'Zz!syn' + String(stamp).slice(-6)
  const upd = await fetch(BASE + '/auth/v1/user', {
    method: 'PUT',
    headers: { apikey: ANON, Authorization: 'Bearer ' + s.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: next }), signal: AbortSignal.timeout(15000) })

  const done = await call('auth-admin', { action: 'finish_password_change' }, { token: s.token })
  const row = await restGet('staff_profiles?id=eq.' + s.id + '&select=must_change_password')
  const flag = row.data && row.data[0] ? row.data[0].must_change_password : 'missing'
  is('P1b', who + ': updateUser + finish_password_change CLEARS the flag',
     upd.ok && done.status === 200 && flag === false,
     'updateUser=' + upd.status + ' finish=' + done.status + ' must_change_password=' + flag)

  const withNew = await signIn(email, next)
  const withOld = await signIn(email, oldPw)
  is('P1c', who + ': NEW password signs in, OLD is refused',
     !!withNew.token && !withOld.token,
     'new=' + (withNew.token ? 'ok' : 'refused') + ' old=' + (withOld.token ? 'STILL WORKS - FAIL' : 'refused'))

  NEW_PW[email] = next
  sessions[acc.env] = withNew.token ? { token: withNew.token, id: withNew.id, email } : { token: s.token, id: s.id, email }
}

const doc1 = sessions['TEST_EMAIL'] || null
const admin = sessions['LIVE_TESTADMIN'] || null
const doc2 = sessions['LIVE_TESTDOC2'] || null
console.log('')
// ---- F2 anonymous
const a1 = await call('auth-admin', { action: 'list' })
is('F2', 'auth-admin refuses an ANONYMOUS privileged action',
   a1.status === 401 && a1.json && a1.json.ok === false,
   'HTTP ' + a1.status + ' "' + ((a1.json && a1.json.error) || '') + '"')

// ---- F3 non-admin
if (doc1 && doc1.token) {
  const r = await call('auth-admin', { action: 'list' }, { token: doc1.token })
  is('F3', 'auth-admin refuses a NON-admin (doctor)',
     r.status === 403 && /administrator/i.test((r.json && r.json.error) || ''),
     'HTTP ' + r.status + ' "' + ((r.json && r.json.error) || '') + '"')
} else skip('F3', 'non-admin refusal', 'no doctor token')

// ---- F4 deactivated
if (admin && admin.token) {
  await svcPatch('staff_profiles?id=eq.' + admin.id, { is_active: false })
  const r = await call('auth-admin', { action: 'list' }, { token: admin.token })
  is('F4', 'a DEACTIVATED admin is refused despite a valid JWT',
     r.status === 401 && /authentication required/i.test((r.json && r.json.error) || ''),
     'HTTP ' + r.status + ' "' + ((r.json && r.json.error) || '') + '"')
  await svcPatch('staff_profiles?id=eq.' + admin.id, { is_active: true })
} else skip('F4', 'deactivated admin refused', 'no testadmin token')

// ---- F5 capabilities
if (doc1 && doc1.token) {
  const r = await call('auth-admin', { action: 'capabilities' }, { token: doc1.token })
  const u = r.json && r.json.user
  is('F5', 'capabilities returns the LIVE profile + server flags',
     r.status === 200 && r.json && r.json.ok === true && u && u.role === 'doctor',
     'role=' + (u && u.role) + ' photo_storage=' + (r.json && r.json.capabilities && r.json.capabilities.photo_storage))
} else skip('F5', 'capabilities', 'no doctor token')

// ---- F6 create
if (admin && admin.token) {
  const r = await call('auth-admin', {
    action: 'create', username: USER, full_name: 'SYNTHETIC PROBE',
    role: 'doctor', email: USER + '@zztest.invalid'
  }, { token: admin.token })
  // auth-admin returns the generated password as `starter_password`.
  // Reading `.password` here yielded undefined, so the length check saw 0
  // and F6 failed even though the create had succeeded. Fall back to
  // `password` only so an older response shape still works.
  const pw = r.json && (r.json.starter_password || r.json.password)
  made.push(USER + '@zztest.invalid')
  is('F6', 'admin CREATE returns a starter_password exactly once',
     r.status === 200 && r.json && r.json.ok === true && typeof pw === 'string' && pw.length >= 10,
     r.status === 200 ? ('starter_password returned (' + (pw ? pw.length : 0) + ' chars)')
                      : ('HTTP ' + r.status + ' "' + ((r.json && r.json.error) || '') + '"'))
  if (pw) {
    const s = await signIn(USER + '@zztest.invalid', pw)
    is('F6b', 'the returned password REALLY signs in', !!s.token,
       s.token ? (USER + ' signed in') : ('refused: ' + s.error))
    created.push({ id: s.id, pw: pw, token: s.token })
  }
} else skip('F6', 'admin create', 'no testadmin token')

// ---- F7 update
if (admin && admin.token && created[0]) {
  const r = await call('auth-admin', {
    action: 'update', id: created[0].id, username: USER,
    full_name: 'PROBE RENAMED', role: 'doctor', is_active: true
  }, { token: admin.token })
  const row = await restGet('staff_profiles?id=eq.' + created[0].id + '&select=full_name')
  const nm = row.data && row.data[0] ? row.data[0].full_name : null
  is('F7', 'admin UPDATE actually changes the row',
     r.status === 200 && nm === 'PROBE RENAMED', 'HTTP ' + r.status + ' full_name=' + nm)
} else skip('F7', 'admin update', 'needs F6')

// ---- F8 set_active
if (admin && admin.token && created[0]) {
  const off = await call('auth-admin', { action: 'set_active', id: created[0].id, is_active: false }, { token: admin.token })
  const blocked = await call('auth-admin', { action: 'capabilities' }, { token: created[0].token })
  is('F8', 'set_active FALSE blocks the target immediately', blocked.status === 401,
     'set_active HTTP ' + off.status + ', target now HTTP ' + blocked.status)
  const on = await call('auth-admin', { action: 'set_active', id: created[0].id, is_active: true }, { token: admin.token })
  // Admin reactivation is a STATE TRANSITION, and `set_active` answering 200
  // is only half of it — the other half is that the row actually changed.
  //
  // The old assertion read `capabilities` and wanted 200. But the account
  // created in F6 still carries must_change_password = true, so
  // `capabilities` answers 403 PASSWORD_CHANGE_REQUIRED for the password
  // gate — never for the reactivation. Phase 1 and F4 already cover that
  // gate, so asserting it here tested neither set_active nor the row.
  //
  // Ask the two questions that are actually about this action: did the call
  // succeed, and did the state persist? Read the row back over the service
  // role, exactly as F7 reads back `full_name`.
  //
  // Nothing here calls updateUser(), so must_change_password is untouched and
  // `created[0].pw` still holds the real starter password for F9 below.
  const row = await restGet('staff_profiles?id=eq.' + created[0].id + '&select=is_active')
  const activeNow = row.data && row.data[0] ? row.data[0].is_active : 'missing'
  is('F8b', 'set_active TRUE restores them (persisted)',
     on.status === 200 && activeNow === true,
     'set_active HTTP ' + on.status + ', is_active=' + activeNow)
} else skip('F8', 'set_active', 'needs F6')

// ---- F9 password change on the CREATED account
if (created[0]) {
  const NEXT = 'Zz!made' + String(stamp).slice(-5)
  const up = await fetch(BASE + '/auth/v1/user', {
    method: 'PUT', headers: { apikey: ANON, Authorization: 'Bearer ' + created[0].token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: NEXT }), signal: AbortSignal.timeout(15000) })
  const sNew = await signIn(USER + '@zztest.invalid', NEXT)
  const sOld = await signIn(USER + '@zztest.invalid', created[0].pw)
  is('F9', 'password change: NEW works, OLD is refused',
     up.ok && !!sNew.token && !sOld.token,
     'update=' + up.status + ' new=' + (sNew.token ? 'ok' : 'refused') + ' old=' + (sOld.token ? 'STILL WORKS - FAIL' : 'refused'))
} else skip('F9', 'password change on created account', 'needs F6')
// ---- F10/F11/F12 photos
let reportKey = null
let reportId = null
if (doc1 && doc1.token) {
  const rows = await restGet('reports?record_key=like.*ZZTEST-PATIENT-001&select=record_key,id&limit=1', doc1.token)
  reportKey = rows.data && rows.data[0] ? rows.data[0].record_key : null
  reportId = rows.data && rows.data[0] ? rows.data[0].id : null
}
if (doc1 && doc1.token && reportKey) {
  const up = await call('patient-photos', {
    action: 'upload', report_id: reportKey,
    photos: [{ name: 'probe.png', data: PNG.split(',')[1], mime: 'image/png', index: 1 }],
    photo_count: 1
  }, { token: doc1.token })
  const meta = await restGet('report_photos?report_id=eq.' + reportId + '&select=id,object_path,mime_type')
  const n = Array.isArray(meta.data) ? meta.data.length : 0
  is('F10', 'photo upload stores a report_photos row',
     up.status === 200 && up.json && up.json.ok === true && n > 0,
     'HTTP ' + up.status + ' ' + ((up.json && up.json.error) || '') + ' rows=' + n)

  const paths = (Array.isArray(meta.data) ? meta.data : []).map(function (r) { return r.object_path })

  // F11 and F12 report INDEPENDENTLY of each other.
  //
  // They used to be nested inside `if (paths.length)`, with only F11 in the
  // else branch. F10 failing therefore skipped F11 AND left F12 reporting
  // NOTHING at all — not even a skip — so `skippedIds` never received 'F12'
  // and the final summary could not name it. F12 is in REQUIRED: a check that
  // cannot report itself missing is worse than one that skips loudly, because
  // the run looks closer to complete than it is.
  if (paths.length) {
    const dl = await call('patient-photos', { action: 'download', paths: paths, report_id: reportKey }, { token: doc1.token })
    const imgs = dl.json && Array.isArray(dl.json.images) ? dl.json.images.length : 0
    is('F11', 'photo download returns the bytes back', dl.status === 200 && imgs > 0,
       'HTTP ' + dl.status + ' images=' + imgs)
  } else skip('F11', 'photo download', 'no object_path from F10')

  // F12's whole subject IS the path F10 was supposed to produce, so it needs
  // the same two reasons to skip: no other doctor, or no path to try.
  if (doc2 && doc2.token && paths.length) {
    const oth = await call('patient-photos', { action: 'download', paths: paths, report_id: reportKey }, { token: doc2.token })
    is('F12', 'another doctor is REFUSED for this report', oth.status === 403,
       'HTTP ' + oth.status + ' "' + ((oth.json && oth.json.error) || '') + '"')
  } else skip('F12', 'cross-doctor photo refusal',
              !doc2 || !doc2.token ? 'no testdoc2 token' : 'needs an uploaded path from F10')
} else {
  // One combined id ('F10-12') is not in REQUIRED, so losing this branch
  // silently dropped three required checks out of the summary. Name each one.
  const why = !doc1 || !doc1.token ? 'no testdoc1 token' : 'no testdoc1 report row visible'
  skip('F10', 'photo upload stores a report_photos row', why)
  skip('F11', 'photo download', why)
  skip('F12', 'cross-doctor photo refusal', why)
}

// ---- F13 flag off
if (doc1 && doc1.token && reportKey) {
  await svcPatch('system_flags?flag_key=eq.photo_storage', { enabled: false })
  const r = await call('patient-photos', { action: 'upload', report_id: reportKey,
    photos: [{ name: 'x.png', data: PNG.split(',')[1], mime: 'image/png', index: 1 }], photo_count: 1 },
    { token: doc1.token })
  await svcPatch('system_flags?flag_key=eq.photo_storage', { enabled: false })
  is('F13', 'photo upload is refused while the server flag is OFF',
     r.status === 503 && r.json && r.json.code === 'PHOTO_STORAGE_DISABLED',
     'HTTP ' + r.status + ' code=' + ((r.json && r.json.code) || 'none'))
} else skip('F13', 'flag-off refusal', 'no report row')

// ---- F14/F15 CORS
{
  const evil = await call('auth-admin', { action: 'health' }, { origin: 'https://evil.example.com' })
  is('F14', 'a disallowed Origin gets NO Access-Control-Allow-Origin',
     evil.acao === null, 'ACAO=' + (evil.acao === null ? 'absent (browser blocks)' : evil.acao))
  const good = await call('auth-admin', { action: 'health' }, { origin: 'http://localhost:5500' })
  is('F15', 'the allowed Origin is echoed back exactly',
     good.acao === 'http://localhost:5500', 'ACAO=' + good.acao)
}

// ==================================================================
// CLEANUP � leave the project as found.
//   * delete the probe account
//   * reset must_change_password = TRUE on the synthetic accounts, so a
//     re-run repeats Phase 1 from the same starting state
//   * write the rotated passwords back into .env.local (git-ignored)
// ==================================================================
// The probe account must leave NO trace. Deleting only the staff_profiles
// row used to be the whole cleanup, and that leaves the auth.users row
// behind: a live GoTrue account that still signs in but resolves to no
// role. One leaked per run, and they pile up in Admin -> Users as a wall
// of doctors. Delete the auth row; the profile cascades (ON DELETE
// CASCADE, migration 0003).
let probeDeleted = 0
for (const email of made) {
  try {
    const list = await (await fetch(BASE + '/auth/v1/admin/users?page=1&per_page=1000',
      { headers: SVC_HDR, signal: AbortSignal.timeout(25000) })).json()
    const users = Array.isArray(list) ? list : (list.users || [])
    const hit = users.find(function (x) {
      return String(x.email || '').toLowerCase() === email.toLowerCase()
    })
    if (!hit) { console.log('  probe already absent: ' + email); continue }
    const r = await fetch(BASE + '/auth/v1/admin/users/' + hit.id,
      { method: 'DELETE', headers: SVC_HDR, signal: AbortSignal.timeout(25000) })
    if (r.ok || r.status === 404) probeDeleted++
    else console.log('  WARNING: could not delete probe ' + email + ' (HTTP ' + r.status + ')')
  } catch (e) {
    console.log('  WARNING: probe delete failed for ' + email + ' - ' + e.message)
  }
}
// Reuses the SYNTHETIC list declared in the test-state reset above.
// Contained per-request, for the same reason as the arming above.
await Promise.allSettled(SYNTHETIC.map(function (name) {
  return fetch(BASE + '/rest/v1/staff_profiles?username=eq.' + name, {
    method: 'PATCH',
    headers: { apikey: SVC, Authorization: 'Bearer ' + SVC, 'Content-Type': 'application/json' },
    body: JSON.stringify({ must_change_password: true }),
    signal: AbortSignal.timeout(25000)
  })
}))
const envPath = join(HERE, '.env.local')
if (existsSync(envPath)) {
  const pairs = [
    ['TEST_PASSWORD', NEW_PW[env.TEST_EMAIL]],
    ['LIVE_TESTADMIN_PW', NEW_PW[env.LIVE_TESTADMIN]],
    ['LIVE_TESTDOC2_PW', NEW_PW[env.LIVE_TESTDOC2]],
    ['LIVE_TESTSEC1_PW', NEW_PW[env.LIVE_TESTSEC1]]
  ]
  // LINE-BASED, never regex -- and update EVERY matching line.
  //
  // The previous version built a /^KEY\s*=.*$/m regex and replaced it.
  // String.replace with a regex is not global, so only the first match
  // moved. That alone was survivable, but .env.local had accumulated a
  // DUPLICATE key (a rotated value written by an earlier run sitting
  // above the original assignment), and the loader below takes the LAST
  // occurrence:
  //
  //     for (const line of text.split('\n')) env[k] = v   // last wins
  //
  // So the writer changed line A while the reader kept reading line B.
  // The rotation was persisted, yet sign-in used the stale value and was
  // refused with invalid_credentials. That is the whole of the "testdoc1
  // sign-in refused" failure -- and the rotated password was never lost.
  //
  // Writing every matching line makes writer and reader agree on the same
  // value regardless of how many duplicates are in the file, and matching
  // a real assignment (optional indent, key, then '=') cannot hit a
  // comment the way a multiline regex could.
  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/)
  let rewritten = 0
  for (const pair of pairs) {
    if (!pair[1]) continue
    for (let i = 0; i < lines.length; i++) {
      const m = /^([ \t]*)([A-Z0-9_]+)([ \t]*)=.*$/.exec(lines[i])
      if (m && m[2] === pair[0]) {
        lines[i] = m[1] + pair[0] + '=' + pair[1]
        rewritten++
      }
    }
  }
  writeFileSync(envPath, lines.join('\n'))
  console.log('  .env.local lines rewritten     : ' + rewritten + ' (for ' +
    pairs.filter(function (x) { return x[1] }).length + ' key(s))')
}

console.log('')
console.log('---- cleanup ----')
console.log('  probe accounts deleted      : ' + probeDeleted + ' of ' + made.length)
console.log('  must_change_password -> TRUE : ' + SYNTHETIC.length + ' synthetic accounts')
console.log('  rotated passwords saved      : ' + Object.keys(NEW_PW).length + ' (in .env.local, git-ignored)')
console.log('')
console.log('---- final summary ----')

// A skip is NOT a pass. The old summary keyed off `failed` alone, so a run in
// which 13 of 18 checks were skipped still printed "LIVE FUNCTIONS OK" and
// exited 0 -- that is how a suite that had stopped testing anything could
// still look green. Every Phase 1 / F3-F13 check is required: if it did not
// actually execute, the run did not test what it claims to test and must not
// be reported as success.
const missingRequired = skippedIds.filter(function (id) { return REQUIRED.has(id) })
const optionalSkips = skippedIds.filter(function (id) { return !REQUIRED.has(id) })
if (optionalSkips.length) {
  console.log('  optional skips (informational) : ' + optionalSkips.join(', '))
}
if (missingRequired.length) {
  console.log('  REQUIRED checks NOT executed   : ' + missingRequired.join(', '))
}
console.log('')
const parts = []
if (failed) parts.push(failed + ' FAILED')
if (missingRequired.length) parts.push(missingRequired.length + ' REQUIRED NOT RUN')
console.log('==== ' + (parts.length ? parts.join(' / ') : 'LIVE FUNCTIONS OK') +
  ' — ' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped (' +
  (passed + failed + skipped) + ' checks) ====')
console.log('')
if (missingRequired.length) {
  console.log('NOTE: SKIP is not a pass. Those checks never executed, so the')
  console.log('      behaviour they cover is still UNVERIFIED against the live project.')
  console.log('')
}
process.exit(failed || missingRequired.length ? 1 : 0)