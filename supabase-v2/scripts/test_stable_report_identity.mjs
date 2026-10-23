#!/usr/bin/env node
/* =====================================================================
   test_stable_report_identity.mjs — duplicate-prevention guard
   ---------------------------------------------------------------------
   record_key is a report's identity AND the cloud upsert target
   (reports UNIQUE (clinic_id, doctor_id, record_key)). It used to be
   `type|identity|date`, so editing the date minted a NEW key and a
   SECOND database row for the same report — the "275 rows for ~95
   patients" explosion. The identity is now minted once and CARRIED, so
   a re-save / autosave / date edit / photo upload of the SAME report
   updates the SAME row, while a new encounter (New Form) mints a fresh
   one. Loads the REAL patientRecords.js into a stubbed browser.

   Run: node supabase-v2/scripts/test_stable_report_identity.mjs
   ===================================================================== */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..', '..')

let passed = 0, failed = 0
const ok = (id, what, d = '') => { passed++; console.log('  PASS  ' + id.padEnd(6) + ' ' + what + (d ? ' — ' + d : '')) }
const bad = (id, what, d = '') => { failed++; console.log('  FAIL  ' + id.padEnd(6) + ' ' + what + (d ? ' — ' + d : '')) }
const is = (id, what, cond, d = '') => (cond ? ok(id, what, d) : bad(id, what, d))

console.log('')
console.log('==== STABLE REPORT IDENTITY (no duplicate rows per report) ====')
console.log('')

function makeWindow() {
  const store = new Map()
  const win = {
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k), key: i => [...store.keys()][i] ?? null,
      get length() { return store.size }
    },
    document: {
      readyState: 'complete', body: { classList: { contains: () => false } },
      addEventListener: () => {}, removeEventListener: () => {},
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false },
        appendChild() {}, setAttribute() {}, addEventListener() {}, querySelector: () => null })
    },
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {},
    location: { pathname: '/cf4Form.html', search: '', href: '', replace: () => {} },
    navigator: { userAgent: 'node-test', onLine: true },
    console, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    CustomEvent: class { constructor(t, o) { this.detail = o && o.detail } },
    alert: () => {}, crypto: undefined,
  }
  win.window = win; win.globalThis = win
  return win
}
function load(win, files) {
  vm.createContext(win)
  for (const f of files) vm.runInContext(readFileSync(join(APP, 'function', f), 'utf8'), win, { filename: f })
}
const history = win => JSON.parse(win.localStorage.getItem('entPatientRecordHistoryV1') || '[]')


/* ---- 1 · the SAME report keeps ONE key across a date change --------- */
for (const type of ['cf4', 'nasal', 'laryngeal']) {
  const win = makeWindow()
  load(win, ['patientRecords.js'])
  const PR = win.PatientRecords
  const tag = type.slice(0, 2).toUpperCase()
  const first = PR.recordSave(type, { patientLastName: 'DELA CRUZ', patientFirstName: 'JUAN', patientPin: 'PIN123' })
  const second = PR.recordSave(type, { patientLastName: 'DELA CRUZ', patientFirstName: 'JUAN', patientPin: 'PIN123', dateAdmitted: '2026-09-28', dateDischarged: '2026-09-30' })
  const third = PR.recordSave(type, { patientLastName: 'DELA CRUZ', patientFirstName: 'JUAN', patientPin: 'PIN123', dateAdmitted: '2026-10-01' })
  is(tag + '1', `${type}: a date typed in later does NOT fork the row`, first.key === second.key && second.key === third.key, `${first.key} == ${third.key}`)
  is(tag + '2', `${type}: still exactly ONE local record (no duplicate)`, history(win).length === 1, history(win).length + ' record(s)')
  is(tag + '3', `${type}: the key carries no date and no PIN (stable identity)`, !/\d{4}-\d{2}-\d{2}/.test(first.key) && !/pin/i.test(first.key), first.key)
}

/* ---- 2 · the SAME report keeps ONE key across a PIN change ---------- */
{
  const win = makeWindow(); load(win, ['patientRecords.js']); const PR = win.PatientRecords
  const a = PR.recordSave('cf4', { patientLastName: 'REYES', patientFirstName: 'ANA' })
  const b = PR.recordSave('cf4', { patientLastName: 'REYES', patientFirstName: 'ANA', patientPin: 'PIN999' })
  is('PIN1', 'adding a PIN later updates the SAME report (no fork)', a.key === b.key, `${a.key} == ${b.key}`)
  is('PIN2', 'still one local record', history(win).length === 1, history(win).length + ' record(s)')
}

/* ---- 3 · a NEW form starts a genuinely new report ------------------- */
{
  const win = makeWindow(); load(win, ['patientRecords.js']); const PR = win.PatientRecords
  const enc1 = PR.recordSave('cf4', { patientLastName: 'DELA CRUZ', patientFirstName: 'JUAN', dateAdmitted: '2026-09-28' })
  PR.startNewReport('cf4')
  const enc2 = PR.recordSave('cf4', { patientLastName: 'DELA CRUZ', patientFirstName: 'JUAN', dateAdmitted: '2026-10-05' })
  is('NEW1', 'a new form mints a SEPARATE report (legitimate 2nd encounter)', enc1.key !== enc2.key, `${enc1.key} != ${enc2.key}`)
  is('NEW2', 'both encounters are kept as two records', history(win).length === 2, history(win).length + ' record(s)')
  const enc2b = PR.recordSave('cf4', { patientLastName: 'DELA CRUZ', patientFirstName: 'JUAN', dateAdmitted: '2026-10-05', dateDischarged: '2026-10-06' })
  is('NEW3', 're-saving the 2nd encounter updates it (still 2 records)', enc2.key === enc2b.key && history(win).length === 2, history(win).length + ' record(s)')
}

/* ---- 4 · an OPENED cloud record keeps its own key on re-save -------- */
{
  const win = makeWindow(); load(win, ['patientRecords.js']); const PR = win.PatientRecords
  const legacyKey = 'cf4|name:santos, pedro|2026-09-20'
  PR.recordOpen('cf4', { patientLastName: 'SANTOS', patientFirstName: 'PEDRO' }, { format: 'Database', recordKey: legacyKey })
  const saved = PR.recordSave('cf4', { patientLastName: 'SANTOS', patientFirstName: 'PEDRO', dateAdmitted: '2026-09-25' })
  is('OPN1', 're-saving an opened legacy row keeps its exact record_key', saved.key === legacyKey, saved.key)
}

/* ---- 5 · opening a FILE/draft (no recordKey) cannot overwrite ------- */
{
  const win = makeWindow(); load(win, ['patientRecords.js']); const PR = win.PatientRecords
  const report = PR.recordSave('nasal', { patientLastName: 'CRUZ', patientFirstName: 'MARIA', procedureDate: '2026-10-02' })
  PR.recordOpen('nasal', { patientLastName: 'CRUZ', patientFirstName: 'MARIA', procedureDate: '2026-10-09' }, { format: 'Draft' })
  const after = PR.recordSave('nasal', { patientLastName: 'CRUZ', patientFirstName: 'MARIA', procedureDate: '2026-10-09' })
  is('FIL1', 'opening a file/draft starts a fresh identity (never overwrites)', after.key !== report.key, `${report.key} -> ${after.key}`)
}

/* ---- 6 · the identity survives a page reload (persisted) ------------ */
{
  const win = makeWindow(); load(win, ['patientRecords.js']); const PR = win.PatientRecords
  const before = PR.recordSave('laryngeal', { patientLastName: 'PEREZ', patientFirstName: 'JO', procedureDate: '2026-10-03' })
  const win2 = makeWindow()
  // Simulate a reload: same persisted storage, a fresh module instance.
  for (const k of ['entPatientRecordHistoryV1', 'entActiveReportKeyV1']) {
    const v = win.localStorage.getItem(k)
    if (v !== null) win2.localStorage.setItem(k, v)
  }
  load(win2, ['patientRecords.js'])
  const after = win2.PatientRecords.recordSave('laryngeal', { patientLastName: 'PEREZ', patientFirstName: 'JO', procedureDate: '2026-10-03', caseNumber: 'C-1' })
  is('RLD1', 'a reload mid-edit keeps updating the SAME report', after.key === before.key, `${before.key} == ${after.key}`)
}

console.log('')
console.log(`==== STABLE REPORT IDENTITY OK — ${passed} passed, ${failed} failed ====`)
process.exit(failed ? 1 : 0)

