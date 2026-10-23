#!/usr/bin/env node
/* =====================================================================
   test_follow_up_logic.mjs — pure-logic checks for the follow-up date
   helpers, extracted verbatim from function/dashboard.js so the test can
   never drift from the code it proves.
   ---------------------------------------------------------------------
   WHY THIS EXISTS
   The follow-up card + due-today badge rest on three small pure helpers
   (followUpOf / followUpDays / followUpState). They decide what the clinic
   sees, so an off-by-one on "today" or a bad date slipping through would
   show a patient as due a day early, or a malformed payload crashing the
   dashboard. These are the cases that matter:

     · a valid YYYY-MM-DD is accepted, a garbage one reads as "no follow-up"
     · "today" is 0 days, "tomorrow" is 1, yesterday is -1  (the whole point)
     · the urgency label/class buckets correctly (overdue / today / soon / future)
     · a malformed date never throws and never produces a row

   No network, no browser, no database: node scripts/test_follow_up_logic.mjs
   ===================================================================== */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const DASH = resolve(HERE, '..', '..', 'function', 'dashboard.js')
const src = readFileSync(DASH, 'utf8')

// Pull each helper's source out of the IIFE by name, then eval it in a tiny
// sandbox. If a function is renamed this test fails loudly instead of
// silently testing a copy that no longer exists.
function extractFn(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{')
  const m = src.match(re)
  if (!m) throw new Error('could not find function ' + name + ' in dashboard.js')
  const start = m.index
  // Walk braces from the opening { of the body to its match.
  let i = src.indexOf('{', start)
  let depth = 0, end = -1
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  if (end < 0) throw new Error('unbalanced braces in ' + name)
  return src.slice(start, end)
}

const FOLLOW_UP_KEY = 'followUpDate'
const factory = new Function(
  'FOLLOW_UP_KEY',
  extractFn('followUpOf') + '\n' +
  extractFn('followUpDays') + '\n' +
  extractFn('followUpState') + '\n' +
  'return { followUpOf, followUpDays, followUpState };'
)
const { followUpOf, followUpDays, followUpState } = factory(FOLLOW_UP_KEY)

// Local YYYY-MM-DD, n days from today.
function isoOffset(days) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    + '-' + String(d.getDate()).padStart(2, '0')
}

let pass = 0, fail = 0
function ok(name, cond) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name) }
}

console.log('==== FOLLOW-UP DATE LOGIC ====')

// --- followUpOf: which field, and only a real date -------------------
ok('reads payload->>followUpDate', followUpOf({ 'payload->>followUpDate': '2026-11-01' }) === '2026-11-01')
ok('reads a nested payload object', followUpOf({ payload: { followUpDate: '2026-11-02' } }) === '2026-11-02')
ok('reads the flat followUpDate field', followUpOf({ followUpDate: '2026-11-03' }) === '2026-11-03')
ok('a missing date is empty', followUpOf({}) === '')
ok('a null row is empty', followUpOf(null) === '')
ok('a garbage date is rejected', followUpOf({ followUpDate: 'not-a-date' }) === '')
ok('a partial date is rejected', followUpOf({ followUpDate: '2026-11' }) === '')
ok('an empty string is empty', followUpOf({ followUpDate: '' }) === '')

// --- followUpDays: today=0, tomorrow=1, yesterday=-1 -----------------
ok('today is 0 days', followUpDays(isoOffset(0)) === 0)
ok('tomorrow is 1 day', followUpDays(isoOffset(1)) === 1)
ok('yesterday is -1 day', followUpDays(isoOffset(-1)) === -1)
ok('in a week is 7 days', followUpDays(isoOffset(7)) === 7)
ok('a malformed date is null (never NaN)', followUpDays('nope') === null)

// --- followUpState: the label + colour bucket -------------------------
ok('overdue gets the red class', followUpState(-3).cls === 'is-overdue')
ok('overdue says "days overdue"', /overdue/.test(followUpState(-3).label))
ok('one day overdue is singular', followUpState(-1).label === '1 day overdue')
ok('today gets the amber class', followUpState(0).cls === 'is-today' && followUpState(0).label === 'Today')
ok('tomorrow is "soon"', followUpState(1).cls === 'is-soon' && followUpState(1).label === 'Tomorrow')
ok('in 5 days is "soon"', followUpState(5).cls === 'is-soon')
ok('in 20 days is "future"', followUpState(20).cls === 'is-future')
ok('in 3 months reads as months', followUpState(90).cls === 'is-future' && /month/.test(followUpState(90).label))
ok('a null day has no class or label', followUpState(null).cls === '' && followUpState(null).label === '')

console.log('')
console.log('==== ' + (fail === 0 ? 'ALL PASSED' : fail + ' FAILED') + ' · ' + pass + ' checks ====')
process.exit(fail === 0 ? 0 : 1)
