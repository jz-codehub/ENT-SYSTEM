#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = readFileSync(join(ROOT, 'function', 'dashboard.js'), 'utf8')
const html = readFileSync(join(ROOT, 'index.html'), 'utf8')

function extractFunction(name) {
  const start = source.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('Missing function: ' + name)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1)
  }
  throw new Error('Unclosed function: ' + name)
}

const core = new Function(
  'return {startOfDay, addDays, monthStart, reportMixRange};\n'
    + 'function startOfDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }\n'
    + 'function addDays(date, n) { const d = new Date(date.getTime()); d.setDate(d.getDate() + n); return d; }\n'
    + 'function monthStart(date) { return new Date(date.getFullYear(), date.getMonth(), 1); }\n'
    + extractFunction('reportMixRange')
)()

let pass = 0
function equal(name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(name + ': got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected))
  }
  pass++
  console.log('PASS ' + name)
}

const july = core.reportMixRange('7days', new Date(2026, 6, 4, 12))
equal('7-day filter includes today and six previous calendar days', [
  july.start.getFullYear(), july.start.getMonth(), july.start.getDate(),
  july.end.getFullYear(), july.end.getMonth(), july.end.getDate(), july.label
], [2026, 5, 28, 2026, 6, 5, 'Last 7 days'])

const february = core.reportMixRange('month', new Date(2028, 1, 29, 12))
equal('month filter uses first of month through tomorrow', [
  february.start.getFullYear(), february.start.getMonth(), february.start.getDate(),
  february.end.getFullYear(), february.end.getMonth(), february.end.getDate(), february.label
], [2028, 1, 1, 2028, 2, 1, 'This month'])

const year = core.reportMixRange('year', new Date(2026, 10, 12, 12))
equal('year filter is calendar year-to-date', [
  year.start.getFullYear(), year.start.getMonth(), year.start.getDate(),
  year.end.getFullYear(), year.end.getMonth(), year.end.getDate(), year.label
], [2026, 0, 1, 2026, 10, 13, 'This year'])

const selector = /<select id="dashMixPeriod"[^>]*>([\s\S]*?)<\/select>/.exec(html)
if (!selector) throw new Error('Report types period selector is missing.')
equal('This month is selected by default', /<option value="month" selected>This month<\/option>/.test(selector[1]), true)
equal('all requested periods are available', [
  /value="7days"/.test(selector[1]),
  /value="month"/.test(selector[1]),
  /value="year"/.test(selector[1])
], [true, true, true])

console.log('All ' + pass + ' report type period checks passed.')
