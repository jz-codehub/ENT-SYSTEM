// =====================================================================
//  test_growth_month.mjs
//
//  Proves the activity charts and Activity Growth card: the WHOLE selected
//  month (28/29/30/31 columns) with a visible day number under every
//  column, and a month picker that actually re-renders them. The functions are lifted OUT of
//  the real dashboard.js and executed here, so these tests break if the
//  shipped code changes - they do not test a copy.
//
//  Load-bearing check at the end: the picker scenario is re-run against
//  the OLD source where the <select> re-used its host div's id, and the
//  broken behaviour must be DETECTED (no initial render, a throwing
//  change handler). A suite that cannot go red proves nothing - that
//  duplicate id shipped once already: getElementById returned the DIV,
//  the card kept the 7-day fallback and the picker went dead.
// =====================================================================
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const dashCode = readFileSync(join(ROOT, 'function', 'dashboard.js'), 'utf8')
const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8')

let pass = 0, fail = 0
const failures = []
function ok(id, name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + id.padEnd(4) + ' ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; failures.push(id + ' ' + name); console.log('FAIL  ' + id.padEnd(4) + ' ' + name + '  ' + (detail || '')) }
}
const eq = (id, name, got, want) =>
  ok(id, name, JSON.stringify(got) === JSON.stringify(want),
     JSON.stringify(got) === JSON.stringify(want) ? '' : 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want))

console.log('')
console.log('==== ACTIVITY GROWTH - WHOLE MONTH + MONTH PICKER ====')
console.log('')

// ---- lift the real functions out of dashboard.js ----------------------
function need(re, label) {
  const m = re.exec(dashCode)
  if (!m) { console.log('ABORT: cannot lift ' + label + ' from function/dashboard.js'); process.exit(1) }
  return m[0]
}
const selSrc = need(/function renderActivitySelector\(year, month\) \{[\s\S]*?\n    \}/, 'renderActivitySelector')
const optsSrc = need(/function buildPeriodOptions\(year, month, currentYear, currentMonth\) \{[\s\S]*?\n    \}/, 'buildPeriodOptions')
const growthSrc = need(/function renderGrowthChart\(data\) \{[\s\S]*?\n    \}/, 'renderGrowthChart')
const chartSrc = need(/function renderChartInto\(chartId, hintId, series, valueOf, color, colorDim, hintLabel, periodLabel\) \{[\s\S]*?\n    \}/, 'renderChartInto')
const activitySrc = need(/function renderActivityCharts\(data\) \{[\s\S]*?\n    \}/, 'renderActivityCharts')
const computeSrc = need(/function computeActivityData\(rows, year, month\) \{[\s\S]*?\n    \}/, 'computeActivityData')
const bucketsSrc = need(/function activityBuckets\(rows, fromMs, toMs\) \{[\s\S]*?\n    \}/, 'activityBuckets')
const dayKeySrc = need(/function dayKeyOf\(date\) \{[\s\S]*?\n    \}/, 'dayKeyOf')
const dayLabelSrc = need(/function dayLabel\(key\) \{[\s\S]*?\n    \}/, 'dayLabel')
const padSrc = need(/function pad\(n\) \{[^\n]*\}/, 'pad')
const startSrc = need(/function startOfDay\(date\) \{[^\n]*\}/, 'startOfDay')
const addSrc = need(/function addDays\(date, n\) \{[^\n]*\}/, 'addDays')
const typeKeySrc = need(/function typeKey\(row\) \{[^\n]*\}/, 'typeKey')
const escSrc = need(/function esc\(value\) \{[^\n]*\}/, 'esc')
const monthNamesSrc = need(/const MONTH_NAMES = \[[\s\S]*?\];/, 'MONTH_NAMES')
// The weekday label under each chart column (v33an-era change) reads this
// table. Without it in the sandbox renderGrowthChart dies on WEEKDAY.
const weekdaySrc = need(/const WEEKDAY = \[[^\n]*\];/, 'WEEKDAY')
const typeOrderSrc = need(/const TYPE_ORDER = \[[^\n]*\];/, 'TYPE_ORDER')
const typesSrc = need(/const TYPES = \{[\s\S]*?\n    \};/, 'TYPES')

console.log('--- 1. source guards (the duplicate id never comes back) ---')
{
  ok('S1', 'renderActivitySelector present in dashboard.js', !!selSrc)
  ok('S2', 'the <select> has its own id', /<select id="dashPeriodSelect">/.test(selSrc))
  ok('S3', 'no duplicate id with the host div', !/<select id="dashPeriod">/.test(selSrc))
  ok('S4', 'getElementById targets the select id', /byId\('dashPeriodSelect'\)/.test(selSrc))
  ok('S5', 'index.html host div still owns dashPeriod', /id="dashPeriod"/.test(indexHtml))
}

// ---- sandbox A: chart + month math ------------------------------------
const AUTH = "const Auth = { escapeHtml: function (v) { return String(v == null ? '' : v)"
  + " .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')"
  + " .replace(/\"/g, '&quot;').replace(/'/g, '&#39;'); } };"
const coreBody = [
  'function pageUrl(p) { return p; }',
  typesSrc, typeOrderSrc, monthNamesSrc, weekdaySrc, AUTH,
  padSrc, startSrc, addSrc, dayKeySrc, dayLabelSrc, typeKeySrc, escSrc,
  bucketsSrc, computeSrc, growthSrc, optsSrc,
  'return { computeActivityData, renderGrowthChart, dayKeyOf, buildPeriodOptions };'
].join('\n')
const chartEl = { innerHTML: '' }
const hintEl = { textContent: '' }
const core = new Function('byId', coreBody)(id => (
  { dashChart: chartEl, dashChartHint: hintEl }[id] || null
))
const activityCharts = {
  dashChartNasal: { innerHTML: '' },
  dashChartLaryngeal: { innerHTML: '' },
  dashChartCf4: { innerHTML: '' }
}
const activityHints = {
  dashChartHintNasal: { textContent: '' },
  dashChartHintLaryngeal: { textContent: '' },
  dashChartHintCf4: { textContent: '' }
}
const activityBody = [
  'function pageUrl(p) { return p; }',
  typesSrc, typeOrderSrc, monthNamesSrc, weekdaySrc, AUTH,
  padSrc, startSrc, addSrc, dayKeySrc, dayLabelSrc, typeKeySrc, escSrc,
  bucketsSrc, computeSrc,
  chartSrc,
  'function renderGrowthStats() {}',
  'function renderGrowthChart() {}',
  activitySrc,
  'return { computeActivityData, renderActivityCharts };'
].join('\n')
const activityCore = new Function('byId', activityBody)(id =>
  activityCharts[id] || activityHints[id] || null
)

console.log('')
console.log('--- 2. computeActivityData: the WHOLE month, day by day ---')
{
  const rows = [
    { report_type: 'laryngeal', _ts: new Date(2026, 9, 1, 9).getTime() },    // in month
    { report_type: 'nasal', _ts: new Date(2026, 9, 15, 9).getTime() },       // in month
    { report_type: 'cf4', _ts: new Date(2026, 8, 30, 9).getTime() }          // September - excluded
  ]
  const oct = core.computeActivityData(rows, 2026, 10)
  eq('C1', 'October 2026 has 31 day columns', oct.monthSeries.length, 31)
  eq('C2', 'first column is Oct 1', oct.monthSeries[0].key, '2026-10-01')
  eq('C3', 'last column is Oct 31', oct.monthSeries[30].key, '2026-10-31')
  eq('C4', 'legacy 7-day fallback remains available', oct.series.length, 7)
  eq('C5', 'rows outside the month never leak in',
     oct.monthSeries.reduce((s, d) => s + d.bucket.reports, 0), 2)
  eq('C6', 'Oct 1 column carries its laryngeal save', oct.monthSeries[0].bucket.types.laryngeal, 1)
  eq('C7', 'February 2026 has 28 columns', core.computeActivityData([], 2026, 2).monthSeries.length, 28)
  eq('C8', 'February 2028 (leap) has 29 columns', core.computeActivityData([], 2028, 2).monthSeries.length, 29)
  eq('C9', 'December 2026 has 31 columns', core.computeActivityData([], 2026, 12).monthSeries.length, 31)
}

console.log('')
console.log('--- 2b. per-type activity charts show the full selected month ---')
{
  const november = core.computeActivityData([], 2026, 11)
  activityCore.renderActivityCharts(november)
  for (const [id, label, testId] of [
    ['dashChartNasal', 'Nasal', 'N'],
    ['dashChartLaryngeal', 'Laryngeal', 'L'],
    ['dashChartCf4', 'CF4', 'C']
  ]) {
    const markup = activityCharts[id].innerHTML
    eq('A' + testId, label + ' draws all 30 November days',
      (markup.match(/class="ent-chart-col/g) || []).length, 30)
    ok('H' + testId, label + ' names the selected month and day count',
      activityHints[id.replace('dashChart', 'dashChartHint')].textContent === 'November 2026 · 30 days',
      activityHints[id.replace('dashChart', 'dashChartHint')].textContent)
    ok('T' + testId, label + ' has day 01 through day 30',
      markup.includes('>01</span>') && markup.includes('>30</span>'))
  }
  activityCore.renderActivityCharts(core.computeActivityData([], 2026, 2))
  eq('A28', 'February charts use 28 days', (activityCharts.dashChartNasal.innerHTML.match(/class="ent-chart-col/g) || []).length, 28)
  activityCore.renderActivityCharts(core.computeActivityData([], 2028, 2))
  eq('A29', 'leap-year February charts use 29 days', (activityCharts.dashChartCf4.innerHTML.match(/class="ent-chart-col/g) || []).length, 29)
  activityCore.renderActivityCharts(core.computeActivityData([], 2026, 12))
  eq('A31', '31-day month charts use all 31 days', (activityCharts.dashChartLaryngeal.innerHTML.match(/class="ent-chart-col/g) || []).length, 31)
}

console.log('')
console.log('--- 3. renderGrowthChart: a day number under every column ---')
{
  const rows = [
    { report_type: 'laryngeal', _ts: new Date(2026, 9, 1, 9).getTime() },
    { report_type: 'nasal', _ts: new Date(2026, 9, 15, 9).getTime() }
  ]
  const oct = core.computeActivityData(rows, 2026, 10)
  chartEl.innerHTML = ''; hintEl.textContent = ''
  core.renderGrowthChart({ series: oct.monthSeries })
  const cols = (chartEl.innerHTML.match(/class="ent-chart-col/g) || []).length
  eq('G1', 'chart draws 31 columns', cols, 31)
  const xs = chartEl.innerHTML.match(/<span class="ent-chart-x">[^<]*<\/span>/g) || []
  eq('G2', 'a day-number span under EVERY column', xs.length, 31)
  ok('G3', 'day 01 is written', xs[0] !== undefined && xs[0].includes('>01<'), xs[0])
  ok('G4', 'day 31 is written', xs[30] !== undefined && xs[30].includes('>31<'), xs[30])
  ok('G5', 'hint spans to day 31', hintEl.textContent.includes('31'), hintEl.textContent)
  ok('G6', 'hint carries the month total', hintEl.textContent.includes('2 saved'), hintEl.textContent)
  // Today's own column keeps the lit marker, whatever the month is.
  // The class list may continue after is-today (a weekend column also
  // carries is-weekend), so match on the boundary, not on the closing quote.
  chartEl.innerHTML = ''
  core.renderGrowthChart({ series: [
    { key: core.dayKeyOf(new Date()), bucket: { types: { nasal: 1, laryngeal: 0, cf4: 0 }, reports: 1 } }
  ] })
  ok('G7', "today's column is lit (is-today)", /class="ent-chart-col is-today[\s"]/.test(chartEl.innerHTML))
}

// ---- sandbox B: the picker, against a getElementById-first-match DOM ---
// The registry keeps the FIRST node registered under an id, exactly like
// document.getElementById - so a re-used id hands back the host div.
function makeDom() {
  const nodes = {}
  function selectable(id) {
    return {
      id: id, _isSelect: true, value: '', listeners: {},
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn) },
      fire(t) { (this.listeners[t] || []).slice().forEach(fn => fn()) }
    }
  }
  const host = {
    id: 'dashPeriod', _html: '', _select: null, listeners: {},
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn) },
    // A div handler that throws behaves like the browser's: the error is
    // reported per dispatch and does not crash the caller.
    fire(t) {
      let threw = null
      ;(this.listeners[t] || []).slice().forEach(fn => { try { fn() } catch (e) { threw = e } })
      return threw
    },
    set innerHTML(v) {
      this._html = v
      // innerHTML replacement drops the old <select> and its listeners.
      const old = this._select
      if (old && nodes[old.id] === old) delete nodes[old.id]
      this._select = null
      const sel = /<select id="([^"]+)"/.exec(v)
      if (!sel) return
      const fresh = selectable(sel[1])
      const on = /<option value="([^"]+)"[^>]*selected/.exec(v)
      fresh.value = on ? on[1] : ''
      this._select = fresh
      if (!(sel[1] in nodes)) nodes[sel[1]] = fresh
      // else: the id is already taken (the host div) - getElementById
      // keeps returning that first match, exactly like the browser.
    },
    get innerHTML() { return this._html }
  }
  nodes['dashPeriod'] = host
  return {
    nodes, host,
    byId(id) { return nodes[id] || null },
    currentSelect() { return host._select }
  }
}
function runPicker(source) {
  const dom = makeDom()
  const calls = []
  const body = [
    'let growthPeriod = null;',
    source,
    'return { renderActivitySelector: renderActivitySelector, growth: function () { return growthPeriod } };'
  ].join('\n')
  const picker = new Function('byId', 'buildPeriodOptions', 'renderActivityPeriod', body)(
    dom.byId, core.buildPeriodOptions, (y, m) => calls.push(String(y) + '/' + String(m))
  )
  picker.renderActivitySelector(2026, 10)               // first paint, live month
  const initial = calls.slice()
  const selectId = /<select id="([^"]+)"/.exec(source)[1]
  const el = dom.byId(selectId)                          // what getElementById returns
  const firstValue = el && el.value
  // The user picks November 2026 on the REAL select; change bubbles up.
  const realSelect = dom.currentSelect()
  if (realSelect) realSelect.value = '11/2026'
  let changeThrew = null
  try { if (realSelect) realSelect.fire('change') } catch (e) { changeThrew = e }
  if (!changeThrew) changeThrew = dom.host.fire('change')
  const afterChange = calls.slice()
  const growthAfter = JSON.stringify(picker.growth())
  // The 60s refresh re-enters with the LIVE month; the pick must stick.
  picker.renderActivitySelector(2026, 10)
  const afterRefresh = calls.slice()
  const refreshValue = dom.currentSelect() && dom.currentSelect().value
  return { initial, firstValue, changeThrew, afterChange, growthAfter, afterRefresh, refreshValue }
}

console.log('')
console.log('--- 4. month picker wiring (renderActivitySelector, real source) ---')
const shipped = runPicker(selSrc)
{
  eq('P1', 'initial paint renders the live month', shipped.initial, ['2026/10'])
  eq('P2', 'the select lands on October 2026', shipped.firstValue, '10/2026')
  eq('P3', 'changing the month re-renders it', shipped.afterChange, ['2026/10', '2026/11'])
  ok('P4', 'the change handler does not throw', shipped.changeThrew === null,
     shipped.changeThrew ? String(shipped.changeThrew) : '')
  eq('P5', 'the pick is remembered', shipped.growthAfter, JSON.stringify({ y: '2026', m: '11' }))
  eq('P6', 'the 60s refresh keeps the picked month', shipped.afterRefresh,
     ['2026/10', '2026/11', '2026/11'])
  eq('P7', 'refresh repaints the PICKED month, not the live one', shipped.refreshValue, '11/2026')
}

console.log('')
console.log('--- 5. LOAD-BEARING: the old duplicate-id source must break here ---')
{
  // The pre-v33ab selector, put back to the bug it shipped with:
  // <select id="dashPeriod"> inside <div id="dashPeriod">. If the
  // assertions above also passed against this, they would be measuring
  // the wrong thing entirely.
  const brokenSrc = selSrc.replace(/dashPeriodSelect/g, 'dashPeriod')
  ok('L0', 'the mutant really carries the duplicate id',
     /<select id="dashPeriod">/.test(brokenSrc) && /byId\('dashPeriod'\)/.test(brokenSrc))
  const broken = runPicker(brokenSrc)
  eq('L1', 'NO initial render fires (getElementById returned the DIV)', broken.initial, [])
  ok('L2', 'the change handler throws on div.value.split', broken.changeThrew !== null,
     broken.changeThrew ? String(broken.changeThrew) : 'NO THROW')
  eq('L3', 'nothing ever re-renders - the picker is dead', broken.afterChange, [])
}

console.log('')
console.log(fail === 0
  ? '==== ALL PASSED — ' + pass + ' passed, 0 failed ===='
  : '==== ' + fail + ' FAILED — ' + pass + ' passed, ' + fail + ' failed ====')
if (fail) { failures.forEach(f => console.log('   - ' + f)); process.exitCode = 1 }
console.log('')
