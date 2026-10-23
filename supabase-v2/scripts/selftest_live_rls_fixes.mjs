// Does the FIXED test_live_rls.mjs still fail when it should?
//
// A rewritten assertion that cannot fail is worse than the broken one it
// replaced: it converts a loud false alarm into a silent green light. So
// each fix is re-checked by putting the ORIGINAL DEFECT BACK and
// confirming the new assertion still catches it.
//
//   L1c  must FAIL if NO origin in the allowlist is accepted
//   L1d  must FAIL if the response carries no ACAO
//   L3e  must FAIL if one layer's floor drifts to 10 (the real historic bug)
//   L10  must FAIL if a forged row PERSISTS with foreign ownership
//
// Each decision the assertion makes is evaluated against a copy of its
// logic, so every failure path is exercised on demand. The live suite
// cannot be made to misbehave at will, but the logic can be.
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..', '..')
const T = join(HERE, 'test_live_rls.mjs')
const ORIG = T + '.selftest-backup'

let pass = 0, fail = 0
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  OK   ${n}${d ? ' — ' + d : ''}`) }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`) }
}

console.log('')
console.log('==== CAN THE FIXED ASSERTIONS STILL FAIL? ====')
console.log('')

// ---- L1c : at least one allowlisted origin must be accepted ----------
const l1cFixed = (probes) => probes.some(p => p.acao === p.origin)
ok('L1c  accepts the live allowlist',
   l1cFixed([{ origin: 'https://x.dev', acao: 'https://x.dev' }]))
ok('L1c  FAILS when every origin is refused',
   !l1cFixed([{ origin: 'https://x.dev', acao: null },
              { origin: 'http://localhost:5500', acao: null }]))
ok('L1c  FAILS on a malformed comma-joined header (the old bug)',
   !l1cFixed([{ origin: 'http://localhost:5500,https://x.dev', acao: null }]))

// ---- L1d : the response must carry ACAO; 403 is acceptable -----------
const l1dFixed = (r, origin) => {
  const echoed = r.acao === origin
  const expected403 = r.status === 403 && /PASSWORD_CHANGE_REQUIRED/.test(r.body || '')
  return echoed && (r.ok || expected403)
}
ok('L1d  accepts 200 + correct ACAO',
   l1dFixed({ status: 200, ok: true, acao: 'https://x.dev', body: '{}' }, 'https://x.dev'))
ok('L1d  accepts 403 PASSWORD_CHANGE_REQUIRED (the live answer)',
   l1dFixed({ status: 403, ok: false, acao: 'https://x.dev', body: '{"error":"PASSWORD_CHANGE_REQUIRED"}' }, 'https://x.dev'))
ok('L1d  FAILS when ACAO is ABSENT (the browser failure mode)',
   !l1dFixed({ status: 403, ok: false, acao: null, body: '{"error":"PASSWORD_CHANGE_REQUIRED"}' }, 'https://x.dev'))
ok('L1d  FAILS when ACAO is for the WRONG origin',
   !l1dFixed({ status: 200, ok: true, acao: 'https://evil.example', body: '{}' }, 'https://x.dev'))
ok('L1d  FAILS on an unexpected non-2xx that is not PASSWORD_CHANGE_REQUIRED',
   !l1dFixed({ status: 500, ok: false, acao: 'https://x.dev', body: 'boom' }, 'https://x.dev'))

// ---- L3e : all three floors equal, and >= 6 --------------------------
const l3eFixed = (floors) => {
  const vals = Object.values(floors)
  return vals.every(v => v === '6') && Number(vals[0]) >= 6
}
ok('L3e  accepts the real 6/6/6',
   l3eFixed({ 'auth.js': '6', 'admin.js': '6', 'auth-admin': '6' }))
ok('L3e  FAILS on the historic split: auth-admin=10 while auth.js=6',
   !l3eFixed({ 'auth.js': '6', 'admin.js': '6', 'auth-admin': '10' }))
ok('L3e  FAILS when a floor drops below the GoTrue minimum',
   !l3eFixed({ 'auth.js': '4', 'admin.js': '4', 'auth-admin': '4' }))

// ---- L10 : a forged row must never persist with foreign ownership ----
const l10Fixed = ({ forgeOk, echoedRow, foreign, zClinic, zcbId }) => {
  const refused = !forgeOk
  const stamped = !!echoedRow && echoedRow.clinic_id === zClinic && echoedRow.doctor_id === zcbId
  return (refused || stamped) && foreign.length === 0
}
const OK_F = { forgeOk: false, echoedRow: null, foreign: [], zClinic: 'c1', zcbId: 'd1' }
ok('L10  accepts REFUSED by policy (the live answer)', l10Fixed(OK_F))
ok('L10  accepts accepted-then-stamped',
   l10Fixed({ forgeOk: true, echoedRow: { clinic_id: 'c1', doctor_id: 'd1' }, foreign: [], zClinic: 'c1', zcbId: 'd1' }))
ok('L10  FAILS when a row persists with a FOREIGN clinic_id  <-- the real hole',
   !l10Fixed({ ...OK_F, foreign: [{ clinic_id: 'OTHER', doctor_id: 'd1', created_by: 'd1' }] }))
ok('L10  FAILS when a row persists with a FOREIGN doctor_id',
   !l10Fixed({ ...OK_F, foreign: [{ clinic_id: 'c1', doctor_id: 'OTHER', created_by: 'd1' }] }))
ok('L10  FAILS when the write succeeds but was NOT stamped to the caller',
   !l10Fixed({ forgeOk: true, echoedRow: { clinic_id: 'OTHER', doctor_id: 'd1' }, foreign: [], zClinic: 'c1', zcbId: 'd1' }))

// ---- the live file must still contain the fixes ---------------------
//
// Comments are stripped before these checks, because the file's own
// comments QUOTE the old broken code on purpose - that is how a reader
// learns what was replaced. Matching a comment would mean the check
// fails precisely because the file documents its own history well, which
// is the opposite of what it is for.
const now = stripComments(readFileSync(T, 'utf8'))
ok('live file has the per-origin L1c loop', /for \(const origin of APP_ORIGINS\)/.test(now))
ok('live file no longer uses the malformed single-Origin header',
   !/Origin:\s*APP_ORIGIN,/.test(now) && !/const APP_ORIGIN\s*=/.test(now))
ok('live file no longer has the over-broad length regex', !/length < \(\?!6\)/.test(now))
ok('live file L10 reads back with the service role', /token: SVC \}\)/.test(now))
ok('live file quotes the old bugs in comments, on purpose',
   /const APP_ORIGIN = env\.ENT_ALLOWED_ORIGIN/.test(readFileSync(T, 'utf8')))

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

console.log('')
console.log(fail === 0
  ? `==== ${pass} passed, 0 failed — the fixes are still load-bearing ====`
  : `==== ${fail} FAILED — ${pass} passed ====`)
console.log('')
process.exit(fail === 0 ? 0 : 1)
