#!/usr/bin/env node
/* =====================================================================
 *  test_usage_estimate.mjs — P1 + P3, measured.
 * ---------------------------------------------------------------------
 *  P1  estimateUsage() sampled `reports?select=payload&limit=60` — 284 KB
 *      of full report payloads — to compute ONE average byte figure for a
 *      number the UI already labels `exact: false`. Now samples 5 (1.4 KB).
 *
 *  P3  Stop analytics polling while the tab is hidden.
 *      *** ALREADY IMPLEMENTED. *** analyticsTick() has opened with
 *      `if (document.hidden) return;` since before this audit. An earlier
 *      audit of mine claimed otherwise and was wrong. This asserts the guard
 *      EXISTS so it cannot silently disappear, and that it works.
 *
 *  E1-E7 cover P1, E8-E12 cover P3. E3 matters most: the obvious
 *  "optimisation" is to divide by the constant instead of sample.length,
 *  and with 1 report that under-counts the estimate by 80%.
 *
 *  No network. Run: node supabase-v2/scripts/test_usage_estimate.mjs
 * ===================================================================== */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..', '..')

let passed = 0, failed = 0
const ok = (id, what, cond, d = '') => {
  if (cond) { passed++; console.log(`  PASS  ${id.padEnd(4)} ${what}${d ? ' — ' + d : ''}`) }
  else { failed++; console.log(`  FAIL  ${id.padEnd(4)} ${what}${d ? ' — ' + d : ''}`) }
}

// The byte maths, lifted verbatim from admin.js.
function estimateFrom(rows) {
  let avg = 3072
  if (Array.isArray(rows) && rows.length) {
    const bytes = rows.reduce((sum, row) => sum + JSON.stringify(row.payload || {}).length + 240, 0)
    avg = Math.max(256, Math.round(bytes / rows.length))
  }
  return avg
}
const mkPayload = n => ({ payload: { filler: 'x'.repeat(n) } })

// The true size of ONE such row, derived rather than hard-coded. An earlier
// version of this test hard-coded `1000 + 240`, which ignored the JSON
// wrapper ({"filler":"..."} is 13 characters around the filler) and so
// failed E3/E4/E5 while the SHIPPED code was correct.
const trueAvg = Math.round(JSON.stringify(mkPayload(1000).payload).length + 240)

console.log('')
console.log('==== USAGE ESTIMATE — P1 (sample size) + P3 (hidden tab) ====')
console.log('')

// ---- E1 · the shipped source asks for 5, not 60 ----------------------
const adminSrc = readFileSync(join(APP, 'function', 'admin.js'), 'utf8')
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const adminCode = strip(adminSrc)
const sampleConst = /const USAGE_SAMPLE_ROWS = (\d+);/.exec(adminCode)
ok('E1', 'the sample size is 5', !!sampleConst && sampleConst[1] === '5',
   sampleConst ? sampleConst[0] : 'USAGE_SAMPLE_ROWS not found')
ok('E1b', 'the request uses that constant, not a hard-coded 60',
   /select=payload&limit=' \+ USAGE_SAMPLE_ROWS/.test(adminCode) &&
   !/select=payload&limit=60/.test(adminCode))
ok('E1c', 'the average still divides by the rows ACTUALLY returned',
   /bytes \/ sample\.length/.test(adminCode) && !/bytes \/ USAGE_SAMPLE_ROWS/.test(adminCode))

// ---- E2 · zero reports ------------------------------------------------
ok('E2', '0 reports -> flat 3072, no crash', estimateFrom([]) === 3072, `avg=${estimateFrom([])}`)
ok('E2b', 'a null/unusable response gives the same flat estimate', estimateFrom(null) === 3072)

// ---- E3 · ONE report: the divisor must be 1 --------------------------
const one = estimateFrom([mkPayload(1000)])
ok('E3', '1 report -> divisor 1, giving the TRUE row size', one === trueAvg,
   `got ${one}, expected ${trueAvg}`)
ok('E3b', '1 report is NOT under-reported 80% (the constant-divisor bug)',
   one > trueAvg * 0.9,
   `${one} vs ${trueAvg}; dividing by 5 would give ${Math.round(trueAvg / 5)}`)

// ---- E4 / E5 · five, and many ------------------------------------------
const five = estimateFrom(Array.from({ length: 5 }, () => mkPayload(1000)))
ok('E4', '5 reports -> correct average', five === trueAvg, `avg=${five}`)

const capped = Array.from({ length: 37 }, () => mkPayload(1000)).slice(0, 5)
ok('E5', '37 reports -> only 5 sampled and averaged',
   capped.length === 5 && estimateFrom(capped) === trueAvg,
   `sampled ${capped.length}, avg=${estimateFrom(capped)}`)

const mixed = [mkPayload(100), mkPayload(5000), mkPayload(900)]
const expectMixed = Math.max(256, Math.round(
  mixed.reduce((s, r) => s + JSON.stringify(r.payload).length + 240, 0) / 3))
ok('E5b', 'mixed payload sizes average correctly', estimateFrom(mixed) === expectMixed,
   `avg=${estimateFrom(mixed)}`)

// ---- E6 / E7 · contract and resilience -------------------------------
ok('E6', 'the result still declares exact: false', /exact:\s*false/.test(adminCode),
   'the estimate stays labelled approximate')
let threw = false
try { estimateFrom(undefined) } catch { threw = true }
ok('E7', 'an unusable response does not throw', !threw)

// ---- E8-E12 · P3 ------------------------------------------------------
console.log('')
console.log('  -- P3: hidden-tab behaviour of analyticsTick, from the real file --')

const tickBody = /async function analyticsTick\(\)\s*\{([\s\S]*?)\n    \}/.exec(adminCode)
ok('E11', 'analyticsTick exists and its body is readable', !!tickBody)

if (tickBody) {
  const body = tickBody[1]
  const guardAt = body.indexOf('if (document.hidden) return;')
  const firstFetch = body.search(/await\s+Promise\.all|loadBuckets\(|loadActivity\(/)
  ok('E8', 'analyticsTick returns immediately when the tab is hidden',
     guardAt >= 0, guardAt >= 0 ? 'guard present' : 'NO HIDDEN GUARD')
  ok('E10', 'the guard comes BEFORE every fetch in the body',
     guardAt >= 0 && firstFetch > guardAt,
     `guard@${guardAt} firstFetch@${firstFetch}`)
  ok('E11b', 'the users/sessions panel skip is still there',
     /currentPanel === 'users' \|\| currentPanel === 'sessions'/.test(body))

  // Behaviour, not only source text: evaluate the REAL body with stubs and
  // count what it actually fetches. A regex would pass on a guard that sits
  // after the work instead of before it.
  //
  // `new Function(..., 'return ' + src)` yields a FACTORY that RETURNS
  // analyticsTick. It must therefore be invoked once to get the function
  // and then invoked again to run it - awaiting the factory directly awaits
  // a function object, never its body, and every count comes back zero.
  const factory = new Function(
    'document', 'loadBuckets', 'loadActivity', 'currentPanel',
    'renderClinicViews', 'renderOverviewStats', 'renderOverviewChart',
    'renderActivity', 'renderDatabase', 'tally',
    'return ' + 'async function analyticsTick() {' + body + '\n}')

  const runTick = async (isHidden, panel) => {
    const tally = { buckets: 0, activity: 0 }
    const tick = factory(
      { hidden: isHidden },
      async () => { tally.buckets++ }, async () => { tally.activity++ },
      panel, () => {}, () => {}, () => {}, () => {}, () => {}, tally)
    await tick()
    return tally
  }

  ;(async () => {
    const hid = await runTick(true, 'overview')
    ok('E8b', 'HIDDEN tab -> zero fetches', hid.buckets === 0 && hid.activity === 0,
       `loadBuckets=${hid.buckets} loadActivity=${hid.activity}`)

    const vis = await runTick(false, 'overview')
    ok('E9', 'VISIBLE tab -> both feeds run (resumed)', vis.buckets === 1 && vis.activity === 1,
       `loadBuckets=${vis.buckets} loadActivity=${vis.activity}`)

    const users = await runTick(false, 'users')
    ok('E9b', 'the users/sessions panels still skip (unchanged)',
       users.buckets === 0 && users.activity === 0)

    ok('E12', 'ANALYTICS_REFRESH_MS still the free-plan value (120s)',
       /const ANALYTICS_REFRESH_MS = 120000/.test(adminCode), 'doubled for egress')

    console.log('')
    console.log(failed === 0
      ? `==== ALL PASSED — ${passed} passed, 0 failed ====`
      : `==== ${failed} FAILED — ${passed} passed ====`)
    console.log('')
    process.exit(failed === 0 ? 0 : 1)
  })()
} else {
  console.log('')
  console.log(`==== ${failed} FAILED — ${passed} passed ====`)
  process.exit(1)
}
