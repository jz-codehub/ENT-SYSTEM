// =====================================================================
//  selftest_view_all_ui.mjs
//  Can the UI tests still fail?
//  ---------------------------------------------------------------------
//  T4 ("a can_view=FALSE row offers NO Open button") PASSED on its very
//  first run - while seven other assertions FAILED, because the list was
//  rendering empty. An empty table trivially contains no Open button, so
//  the most security-critical check in the file reported success while
//  proving nothing at all. A green light that cannot go red is worse than
//  no test.
//
//  So this mutates the REAL module in memory - the exact edits someone
//  could plausibly make later - and confirms the suite catches each one:
//
//    M1  render Open for EVERY row            -> T4 must fail
//    M2  render neither button                -> T5 must fail
//    M3  drop the escapeHtml call             -> T23/T24 must fail
//    M4  hide foreign clinics client-side     -> T8 must fail
//    M5  swallow a refused approve            -> T16 must fail
//    M6  let "Request access" write a grant   -> T19 must fail
//    M7  render the payload after a refusal   -> T11 must fail
//
//  Each mutation is applied to a COPY on disk, the suite is run against
//  it in a child process, and the real file is restored from a backup
//  taken immediately beforehand - so a crash cannot leave a mutated
//  module behind.
//
//  Run: node supabase-v2/scripts/selftest_view_all_ui.mjs
// =====================================================================
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..', '..')
const TARGET = join(APP, 'function', 'viewAllAccess.js')
const SUITE = join(HERE, 'test_view_all_ui.mjs')

let pass = 0, fail = 0
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  OK   ${n}${d ? ' — ' + d : ''}`) }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`) }
}

const original = readFileSync(TARGET, 'utf8')

// Run the UI suite against a mutated module and report which assertion ids
// went red. The suite's own output is parsed, so this proves the REAL
// assertions failed rather than trusting a hand-written expectation.
function runSuite(mutate) {
  const mutated = mutate(original)
  if (mutated === original) return { changed: false, failedIds: [] }
  const backup = TARGET + '.selftest-backup'
  writeFileSync(backup, original, 'utf8')
  try {
    writeFileSync(TARGET, mutated, 'utf8')
    const r = spawnSync(process.execPath, [SUITE], { encoding: 'utf8' })
    const out = (r.stdout || '') + (r.stderr || '')
    return { changed: true, failedIds: [...out.matchAll(/^\s*FAIL\s+(\S+)/gm)].map(m => m[1]) }
  } finally {
    writeFileSync(TARGET, original, 'utf8')
    if (existsSync(backup)) unlinkSync(backup)
  }
}

function mustFail(label, mutate, expectedIds) {
  const res = runSuite(mutate)
  if (!res.changed) { ok(label, false, 'mutation did not apply - source changed shape'); return }
  const hit = expectedIds.some(id => res.failedIds.includes(id))
  ok(label, hit, res.failedIds.length
     ? `caught by ${res.failedIds.slice(0, 4).join(', ')}`
     : 'NOTHING WENT RED')
}

console.log('')
console.log('==== CAN THE VIEW ALL UI TESTS STILL FAIL? ====')
console.log('')

// ---- M1 · render Open on every row, locked or not ---------------------
// The single worst bug this suite exists to catch: offering to open a
// record the database has already refused.
mustFail('M1  "Open" on a locked row is caught',
  s => s.replace(
    /const action = row\.can_view[\s\S]*?Request access<\/button>`;/,
    'const action = `<button type="button" class="cca-btn cca-btn-open" ' +
    'data-open="${esc(row.report_id)}">Open</button>`;'),
  ['T4'])

// ---- M2 · offer nothing on a locked row -------------------------------
mustFail('M2  a locked row with no Request-access button is caught',
  s => s.replace(/data-ask="\$\{esc\(row\.report_id\)\}">Request access/,
                 'data-x="none">Request access'),
  ['T5'])

// ---- M3 · stop escaping -----------------------------------------------
// The renderer moved into a <span class="cca-name"> in c165d7f; the
// mutation follows the REAL current line, or it applies to nothing and
// the selftest would report a false red for the wrong reason.
mustFail('M3  unescaped patient name is caught',
  s => s.replace(
    /<span class="cca-name">\$\{esc\(row\.patient_name \|\| 'Unnamed patient'\)\}<\/span>/,
    `<span class="cca-name">\${row.patient_name || 'Unnamed patient'}</span>`),
  ['T23'])

// ---- M4 · hide foreign clinics client-side ----------------------------
// Tempting "tidy-up" that would remove the feature's whole point.
// (The loop variable is `rows`, not `state.rows`, since the same rework.)
mustFail('M4  client-side hiding of other clinics is caught',
  s => s.replace(
    "body.innerHTML = rows.map(renderRow).join('');",
    "body.innerHTML = rows.filter(r => r.can_view).map(renderRow).join('');"),
  ['T8'])

// ---- M5 · swallow a refused approve ------------------------------------
mustFail('M5  reporting a refused approve as success is caught',
  s => s.replace(
    /(async function doApprove[\s\S]*?\} catch \(err\) \{)\s*[\s\S]*?(state\.notice = friendlyError\(err\);)/,
    "$1\n            state.notice = 'Access approved. The grant is recorded with your name as the approver.';"),
  ['T16', 'T15'])

// ---- M6 · let "Request access" write a grant -------------------------
// The dangerous one: a request button that quietly grants itself access.
// The old anchor (a sessionStorage write) is gone since the request flow
// moved to the ent_request_report RPC - the mutation now poisons that
// exact call instead, with a plain uuid so it needs no currentUser stub.
mustFail('M6  "Request access" writing a grant is caught',
  s => s.replace(
    "await Supabase.apiRequest('/rpc/ent_request_report', {",
    "approveGrant(reportId, 'grantee-uuid-1234', tr);\n            await Supabase.apiRequest('/rpc/ent_request_report', {"),
  ['T19'])

// ---- M7 · show a payload after a refusal ------------------------------
mustFail('M7  rendering content after PERMISSION_REQUIRED is caught',
  s => s.replace("if (state.detail.code === 'PERMISSION_REQUIRED') {", 'if (false) {'),
  ['T11'])

// ---- and the real file must still be intact ---------------------------
const now = readFileSync(TARGET, 'utf8')
ok('viewAllAccess.js is byte-identical on disk', now === original)
ok('the can_view branch still exists', /const action = row\.can_view/.test(now))
ok('the row renderer still escapes the patient name',
   /cca-name">\$\{esc\(row\.patient_name/.test(now))
ok('the refusal branch is still reachable',
   /if \(state\.detail\.code === 'PERMISSION_REQUIRED'\)/.test(now))
ok('request() still does not call approveGrant', (() => {
  const body = now.slice(now.indexOf('function doAsk'), now.indexOf('async function doApprove'))
  return !/approveGrant\(/.test(body)
})())

console.log('')
console.log(fail === 0
  ? `==== ${pass} passed, 0 failed — the UI tests are load-bearing ====`
  : `==== ${fail} FAILED — ${pass} passed ====`)
console.log('')
process.exit(fail === 0 ? 0 : 1)
