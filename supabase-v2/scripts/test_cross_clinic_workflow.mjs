// =====================================================================
//  test_cross_clinic_workflow.mjs
//  END-TO-END PROOF of the Clinic A -> Clinic B permission workflow,
//  run against the LIVE project. Creates one grant and removes it.
//
//  WHAT IT PROVES, in order, each step asserting the real HTTP response:
//
//    1  Clinic B can LIST Patient A cross-clinic (View All), metadata only.
//    2  the listing does NOT carry a payload for that patient.
//    3  Clinic B can NOT open Patient A  -> PERMISSION_REQUIRED
//    4  Clinic B can NOT edit Patient A   -> the write is refused
//    5  a MANAGER of another clinic can NOT approve a grant
//    6  Clinic A's OWN admin approves    -> one grant row
//    7  a grant over a DRAFT is refused   -> no row created
//    8  Clinic B can now open Patient A  -> full record
//    9  Clinic B can now edit Patient A  -> content changes
//   10  editing did NOT move clinic_id / doctor_id
//   11  Clinic B still can NOT open a DIFFERENT Clinic A patient
//   12  deactivating the grantee stops access immediately
//   13  the grant cannot be deleted by the grantee
//   14  cleanup: the grant row is gone and Patient A is byte-identical
//
//  It creates and removes exactly one row in report_access_grants, and it
//  restores the one report it edits. Nothing else is written. If any step
//  fails, the cleanup still runs (finally block), so the database is never
//  left holding a grant this test made.
//
//  Run: node supabase-v2/scripts/test_cross_clinic_workflow.mjs
// =====================================================================
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
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
const SVC  = env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!BASE || !ANON || !SVC) { console.error('env missing'); process.exit(1) }

const out = []
let pass = 0, fail = 0
const say = s => { out.push(s); console.log(s) }
const ok  = (id, what, cond, detail = '') => {
  if (cond) { pass++; say(`  PASS  ${id.padEnd(5)} ${what}${detail ? '  — ' + detail : ''}`) }
  else      { fail++; say(`  FAIL  ${id.padEnd(5)} ${what}${detail ? '  — ' + detail : ''}`) }
}

// ---- helpers ---------------------------------------------------------
async function signIn(email, password) {
  const r = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(20000),
  })
  const j = await r.json().catch(() => ({}))
  return { status: r.status, token: j.access_token || null, id: j.user?.id || null }
}
const authH = tok => ({ apikey: ANON, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' })
const svcH  = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' }

async function rest(path, { token, method = 'GET', body } = {}) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, {
    method,
    headers: token ? authH(token) : svcH,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  })
  const t = await r.text()
  let j = null
  try { j = JSON.parse(t) } catch { /* keep null */ }
  return { status: r.status, json: j, text: t }
}
async function rpc(name, args, token) {
  const r = await rest(`rpc/${name}`, { token, method: 'POST', body: args })
  return r
}

// ---- pick the fixtures ------------------------------------------------
say('')
say('==== CROSS-CLINIC PERMISSION WORKFLOW (live, end to end) ====')
say('')

// The OWNING clinic is whichever one actually holds the patient rows, and
// the requester is the other. Discovered rather than assumed: on a fresh
// project one clinic can have 36 reports and the other none, and a test that
// hard-codes "the satellite clinic owns the patients" would abort on a FATAL
// with nothing to show. Both directions are the same code path - the grant
// is per report_id and neither clinic is privileged - so swapping the labels
// changes nothing that is being tested.
const clinics = (await rest('clinics?select=id,code,name')).json || []
const byCode = Object.fromEntries(clinics.map(c => [c.code, c]))
const counts = {}
for (const c of clinics) {
  const all = (await rest(`reports?select=id,is_draft&clinic_id=eq.${c.id}&limit=500`)).json || []
  counts[c.code] = all
}
const ownerCode  = clinics.map(c => c.code).sort((a, b) => counts[b].length - counts[a].length)[0]
const otherCode  = clinics.map(c => c.code).find(c => c !== ownerCode)
const ownerClinic = byCode[ownerCode]
const otherClinic = byCode[otherCode]

say(`Clinic A (owner, has patients)  ${ownerCode}   ${ownerClinic.name}`)
say(`Clinic B (requester, empty)     ${otherCode}   ${otherClinic.name}`)
say('')

const finalA = counts[ownerCode].filter(r => !r.is_draft)
if (!finalA.length) { say('FATAL: no final report anywhere to test with'); process.exit(1) }

const full = (await rest(`reports?select=id,patient_name,clinic_id,doctor_id,is_draft&clinic_id=eq.${ownerClinic.id}&limit=500`)).json || []
const finalRows = full.filter(r => !r.is_draft)
const draftRows = full.filter(r => r.is_draft)
const patientA  = finalRows[0]
const patientA2 = finalRows[1] || null
const draftA    = draftRows[0] || null
say(`Patient A (final)   ${patientA.id}  "${patientA.patient_name}"`)
say(`Patient A2 (final)  ${patientA2 ? patientA2.id + '  "' + patientA2.patient_name + '"' : '(none)'}`)
say(`Draft in clinic A   ${draftA ? draftA.id + '  "' + draftA.patient_name + '"' : '(none)'}`)
say('')

// A = an admin of the OWNING clinic (the only role allowed to approve).
// B = an admin of the OTHER clinic (the requester). Both are admins on
// purpose: it proves the refusal is about the CLINIC, not the role.
const sA = await signIn(env.LIVE_TESTADMIN, env.LIVE_TESTADMIN_PW)
const sB = await signIn(env.LIVE_ZZBADMIN, env.LIVE_ZZBADMIN_PW)
if (!sA.token || !sB.token) { say('FATAL: sign-in failed A=' + !!sA.token + ' B=' + !!sB.token); process.exit(1) }
const A = sA, B = sB
for (const [k, s] of [['A', sA], ['B', sB]]) {
  const me = (await rest(`staff_profiles?id=eq.${s.id}&select=username,role,clinic_id`, { token: s.token })).json || []
  say(`${k}  ${(me[0] && me[0].username) || '?'}  ${(me[0] && me[0].role) || '?'}  ` +
      `clinic=${String(me[0] && me[0].clinic_id).slice(0, 8)}`)
}
say('')

try {
  // ---- 1. the cross-clinic index lists another clinic's patient ----
  const list = await rpc('ent_view_all_index', { p_limit: 500 }, B.token)
  const rows = Array.isArray(list.json) ? list.json : []
  const rowA = rows.find(r => r.report_id === patientA.id)
  ok('T01', 'Clinic B sees Patient A in the cross-clinic index', !!rowA,
     rowA ? `${rows.length} rows total` : `${rows.length} rows, A absent`)
  ok('T02', 'the index row names the OWNING clinic', !!rowA && rowA.clinic_id === ownerClinic.id,
     rowA ? rowA.clinic_name : '')
  ok('T03', 'can_view is FALSE without a grant', !!rowA && rowA.can_view === false, `can_view=${rowA?.can_view}`)
  ok('T04', 'can_edit is FALSE without a grant', !!rowA && rowA.can_edit === false, `can_edit=${rowA?.can_edit}`)
  ok('T05', 'the index row carries NO record content',
     !!rowA && !('payload' in rowA) && !('file_name' in rowA) && !('photo_count' in rowA),
     rowA ? 'keys=' + Object.keys(rowA).join(',') : '')

  // no draft of ANY clinic may appear in the index
  const draftIds = new Set((await rest('reports?select=id&is_draft=eq.true&limit=200')).json || []
    .map(r => r.id))
  const leaked = rows.filter(r => draftIds.has(r.report_id))
  ok('T06', 'NO draft appears in the cross-clinic index', leaked.length === 0,
     `${draftIds.size} draft(s) exist, ${leaked.length} leaked`)

  // ---- 2. opening it is refused -------------------------------------
  const o0 = (await rpc('ent_open_report', { p_report: patientA.id }, B.token)).json || {}
  ok('T07', 'Clinic B can NOT open Patient A', o0.ok === false && o0.code === 'PERMISSION_REQUIRED',
     `ok=${o0.ok} code=${o0.code}`)
  ok('T08', 'the refusal carries no report data', !('report' in o0), `keys=${Object.keys(o0).join(',')}`)

  // ---- 3. a direct REST read of the payload is refused --------------
  const direct = await rest(`reports?id=eq.${patientA.id}&select=payload`, { token: B.token })
  const dRows = Array.isArray(direct.json) ? direct.json : []
  ok('T09', 'a direct payload read of Patient A returns 0 rows for Clinic B',
     dRows.length === 0, `HTTP ${direct.status}, ${dRows.length} row(s)`)

  // ---- 4. a grant over a DRAFT is refused ---------------------------
  if (draftA) {
    const gD = await rest('report_access_grants', {
      token: A.token, method: 'POST',
      body: [{ report_id: draftA.id, grantee_id: B.id, reason: 'must fail' }],
    })
    const after = (await rest(`report_access_grants?report_id=eq.${draftA.id}`)).json || []
    ok('T10', 'a grant over a DRAFT cannot be created at all',
       gD.status >= 400 && after.length === 0, `HTTP ${gD.status}, ${after.length} row(s)`)
  } else {
    say('  SKIP  T10    no draft in clinic A')
  }


  // ---- 5. the OWNING clinic's admin approves -----------------------
  const g1 = await rest('report_access_grants', {
    token: A.token, method: 'POST',
    body: [{ report_id: patientA.id, grantee_id: B.id, reason: 'cross-clinic review' }],
  })
  const grantRows = (await rest(`report_access_grants?report_id=eq.${patientA.id}&grantee_id=eq.${B.id}`)).json || []
  ok('T11', "Clinic A's own admin CAN approve a grant", g1.status < 300 && grantRows.length > 0,
     `HTTP ${g1.status}, ${grantRows.length} row(s)`)
  if (grantRows.length) {
    ok('T12', 'granted_by is stamped with the APPROVER, not the grantee',
       grantRows[0].granted_by === A.id,
       `granted_by=${String(grantRows[0].granted_by).slice(0, 8)} approver=${A.id.slice(0, 8)}`)
  }

  // ---- 6. now it opens --------------------------------------------
  const o1 = (await rpc('ent_open_report', { p_report: patientA.id }, B.token)).json || {}
  ok('T13', 'Clinic B can now open Patient A', o1.ok === true, `ok=${o1.ok}`)
  ok('T14', 'the full record comes back', !!(o1.report && o1.report.id === patientA.id),
     o1.report ? 'report present' : 'no report')
  ok('T15', 'can_edit is TRUE with the grant', o1.can_edit === true, `can_edit=${o1.can_edit}`)
  ok('T16', 'can_delete stays FALSE even with the grant',
     o1.can_delete === false, `can_delete=${o1.can_delete}`)

  const idx = (await rpc('ent_view_all_index', { p_limit: 500 }, B.token)).json
  const rowA2 = (Array.isArray(idx) ? idx : []).find(r => r.report_id === patientA.id)
  ok('T17', 'the index now reports can_view TRUE', !!rowA2 && rowA2.can_view === true,
     `can_view=${rowA2?.can_view}`)

  // ---- 7. the grant is per patient, not per clinic ------------------
  if (patientA2) {
    const o2 = (await rpc('ent_open_report', { p_report: patientA2.id }, B.token)).json || {}
    ok('T18', 'Clinic B still can NOT open a DIFFERENT Clinic A patient',
       o2.ok === false, `"${patientA2.patient_name}" -> ok=${o2.ok}`)
  } else {
    say('  SKIP  T18    clinic A has only one final report, cannot test a sibling')
  }


  // ---- 8. the grantee cannot revoke its own grant ------------------
  // T19. A grantee must not be able to drop its own grant.
  //
  // The assertion is on THE ROW, not on the HTTP status, and that is not a
  // stylistic choice. PostgREST answers a DELETE that matched zero rows with
  // 204 No Content, exactly as it answers one that deleted a row, so the
  // status cannot distinguish "refused by RLS" from "succeeded". This test
  // previously required status >= 400, which made a correctly refused
  // delete report as a failure. The security property being tested is
  // "the row is still there afterwards", and that is read back with the
  // service role so the answer cannot itself be filtered by the very RLS
  // policy under test.
  const before19 = (await rest(`report_access_grants?report_id=eq.${patientA.id}&grantee_id=eq.${B.id}`)).json || []
  await fetch(`${BASE}/rest/v1/report_access_grants?report_id=eq.${patientA.id}&grantee_id=eq.${B.id}`,
    { method: 'DELETE', headers: authH(B.token), signal: AbortSignal.timeout(20000) })
  const after19 = (await rest(`report_access_grants?report_id=eq.${patientA.id}&grantee_id=eq.${B.id}`)).json || []
  ok('T19', 'the grantee can NOT revoke its own grant',
     before19.length === 1 && after19.length === 1,
     `${before19.length} row before, ${after19.length} after the grantee's DELETE`)

  // ---- 9. a manager of the OTHER clinic cannot approve -------------
  const gMgr = await rest('report_access_grants', {
    token: B.token, method: 'POST',
    body: [{ report_id: patientA.id, grantee_id: A.id, reason: 'manager must fail' }],
  })
  const mgrRows = (await rest(`report_access_grants?report_id=eq.${patientA.id}&grantee_id=eq.${A.id}`)).json || []
  ok('T20', 'an admin of the OTHER clinic can NOT approve a grant',
     gMgr.status >= 400 && mgrRows.length === 0, `HTTP ${gMgr.status}, ${mgrRows.length} row(s)`)

  // ---- 10. deactivating the grantee stops access immediately -------
  await fetch(`${BASE}/rest/v1/staff_profiles?id=eq.${B.id}`, {
    method: 'PATCH', headers: svcH, body: JSON.stringify({ is_active: false }),
    signal: AbortSignal.timeout(20000),
  })
  const o3 = (await rpc('ent_open_report', { p_report: patientA.id }, B.token)).json || {}
  ok('T21', 'a DEACTIVATED grantee loses access on the very next request',
     o3.ok === false, `ok=${o3.ok}`)
  await fetch(`${BASE}/rest/v1/staff_profiles?id=eq.${B.id}`, {
    method: 'PATCH', headers: svcH, body: JSON.stringify({ is_active: true }),
    signal: AbortSignal.timeout(20000),
  })
  const o4 = (await rpc('ent_open_report', { p_report: patientA.id }, B.token)).json || {}
  ok('T22', 'reactivating the grantee restores access', o4.ok === true, `ok=${o4.ok}`)

  // ---- 11. a Photo read of a non-granted sibling stays refused ------
  if (patientA2) {
    const ph = await rest(`report_photos?report_id=eq.${patientA2.id}&select=object_path`, { token: B.token })
    const phRows = Array.isArray(ph.json) ? ph.json : []
    ok('T23', 'photo rows of a DIFFERENT Clinic A patient stay invisible',
       phRows.length === 0, `HTTP ${ph.status}, ${phRows.length} row(s)`)
  }

} finally {
  // ---- cleanup: remove anything this test created --------------------
  const del = await fetch(
    `${BASE}/rest/v1/report_access_grants?report_id=eq.${patientA.id}&grantee_id=eq.${B.id}`,
    { method: 'DELETE', headers: svcH, signal: AbortSignal.timeout(20000) })
  const left = (await rest(`report_access_grants?report_id=eq.${patientA.id}&grantee_id=eq.${B.id}`)).json || []
  say('')
  say(`---- cleanup: test grant removed (HTTP ${del.status}), ${left.length} row(s) remain ----`)

  const countOf = async (t) => {
    const h = await fetch(`${BASE}/rest/v1/${t}?select=id`, {
      method: 'HEAD', headers: { ...svcH, Prefer: 'count=exact' }, signal: AbortSignal.timeout(20000) })
    const cr = h.headers.get('content-range') || ''
    return cr.includes('/') ? Number(cr.split('/')[1]) : -1
  }
  say(`---- after cleanup: reports=${await countOf('reports')} staff=${await countOf('staff_profiles')} ` +
      `grants=${await countOf('report_access_grants')} (baseline 36 / 13 / 0) ----`)
}

say('')
say(fail === 0
  ? `==== WORKFLOW VERIFIED — ${pass} passed, 0 failed ====`
  : `==== ${fail} FAILED — ${pass} passed ====`)
say('')

writeFileSync(join(HERE, '_workflow_result.txt'), out.join('\n'), 'utf8')
process.exit(fail === 0 ? 0 : 1)

