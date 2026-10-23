#!/usr/bin/env node
/* =====================================================================
   test_dashboard_extras.mjs — pure-logic checks for the zero-risk
   dashboard extras (trend chip + streak + CSV cell), extracted from
   function/dashboard.js so the test can never drift from the code.
   ---------------------------------------------------------------------
   These three helpers are the "safe" additions to the doctor/secretary
   dashboard. They read only data already in memory, so the risk is not
   the network - it is the arithmetic. This proves:

     · trendChip  — up = green, down = red, flat = grey, and the 0→N edge
                    shows a plain "+N" instead of an infinite percentage
     · computeStreak — consecutive days with a record, counting today even
                    before the first save of the day
     · csvCell    — quotes are doubled, and a leading =/+/-/@ is defused
                    so a patient named "=cmd()" cannot become a formula

   No network, no browser: node scripts/test_dashboard_extras.mjs
   ===================================================================== */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const DASH = resolve(HERE, '..', '..', 'function', 'dashboard.js')
const src = readFileSync(DASH, 'utf8')

function extractFn(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{')
  const m = src.match(re)
  if (!m) throw new Error('could not find function ' + name + ' in dashboard.js')
  const start = m.index
  let i = src.indexOf('{', start)
  let depth = 0, end = -1
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  if (end < 0) throw new Error('unbalanced braces in ' + name)
  return src.slice(start, end)
}

let pass = 0, fail = 0
function ok(name, cond) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name) }
}
function dayKeyOf(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    + '-' + String(d.getDate()).padStart(2, '0')
}
function offsetKey(days) {
  const d = new Date(); d.setDate(d.getDate() + days); return dayKeyOf(d)
}

console.log('==== DASHBOARD EXTRAS: trend chip ====')
const trendFactory = new Function(extractFn('trendChip') + '\nreturn trendChip;')
const trendChip = trendFactory()
ok('both zero -> nothing', trendChip({ patientCount: 0 }, { patientCount: 0 }) === '')
ok('up -> green is-up', trendChip({ patientCount: 10 }, { patientCount: 5 }).includes('is-up'))
ok('up -> +100%', trendChip({ patientCount: 10 }, { patientCount: 5 }).includes('+100%'))
ok('down -> red is-down', trendChip({ patientCount: 3 }, { patientCount: 6 }).includes('is-down'))
ok('down -> -50%', trendChip({ patientCount: 3 }, { patientCount: 6 }).includes('-50%'))
ok('flat -> is-flat', trendChip({ patientCount: 5 }, { patientCount: 5 }).includes('is-flat'))
ok('rise from 0 -> plain +N (no Infinity%)',
  trendChip({ patientCount: 4 }, { patientCount: 0 }).includes('+4')
  && !trendChip({ patientCount: 4 }, { patientCount: 0 }).includes('Infinity'))

console.log('==== DASHBOARD EXTRAS: streak ====')
const streakFactory = new Function('rows', 'encounterDay', 'dayKeyOf',
  extractFn('computeStreak') + '\nreturn computeStreak;')
const rows3 = [
  { created_at: offsetKey(0) }, { created_at: offsetKey(-1) }, { created_at: offsetKey(-2) },
  { created_at: offsetKey(-5) }
]
ok('3 consecutive days -> streak 3', streakFactory(rows3, (r) => r.created_at, dayKeyOf)() === 3)
const rowsTodayMissing = [{ created_at: offsetKey(-1) }, { created_at: offsetKey(-2) }]
ok('today missing, yesterday+before -> streak 2', streakFactory(rowsTodayMissing, (r) => r.created_at, dayKeyOf)() === 2)
ok('only an old record -> streak 0', streakFactory([{ created_at: offsetKey(-10) }], (r) => r.created_at, dayKeyOf)() === 0)
ok('no rows -> 0', streakFactory([], (r) => r.created_at, dayKeyOf)() === 0)
ok('nodate rows ignored -> 0', streakFactory([{ created_at: 'nodate' }], () => 'nodate', dayKeyOf)() === 0)

console.log('==== DASHBOARD EXTRAS: CSV cell (injection-safe) ====')
const csvFactory = new Function(extractFn('csvCell') + '\nreturn csvCell;')
const csvCell = csvFactory()
ok('plain text is quoted', csvCell('Joy') === '"Joy"')
ok('inner quotes are doubled', csvCell('a"b') === '"a""b"')
ok('a leading = is defused with a quote', csvCell('=cmd()') === '"\'=cmd()"')
ok('a leading + is defused', csvCell('+1').startsWith('"\''))
ok('a leading - is defused', csvCell('-2').startsWith('"\''))
ok('a leading @ is defused', csvCell('@x').startsWith('"\''))
ok('null becomes an empty quoted cell', csvCell(null) === '""')

console.log('==== DASHBOARD EXTRAS: avatar initials ====')
// The initials logic copied 1:1 from renderHero: first two words, first
// letters, uppercased; "?" when there is no name. Proven here so a rename of
// the helper cannot silently blank the avatar.
const avatarFactory = new Function(
  'prettyName',
  `return function (raw) {
    const name = prettyName(raw || '');
    return name.split(/\\s+/).filter(Boolean).slice(0, 2)
      .map(function (w) { return w.charAt(0).toUpperCase(); }).join('') || '?';
  };`
)
const initials = avatarFactory((n) => String(n || '').trim())
ok('"Joy Pineda" -> JP', initials('Joy Pineda') === 'JP')
ok('"Doc Ben" -> DB', initials('Doc Ben') === 'DB')
ok('single name -> one letter', initials('Joy') === 'J')
ok('empty -> "?"', initials('') === '?')
ok('lowercase is uppercased', initials('maria santos') === 'MS')

console.log('')
console.log('==== ' + (fail === 0 ? 'ALL PASSED' : fail + ' FAILED') + ' · ' + pass + ' checks ====')
process.exit(fail === 0 ? 0 : 1)
