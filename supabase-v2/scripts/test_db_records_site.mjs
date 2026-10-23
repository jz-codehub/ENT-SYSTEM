#!/usr/bin/env node
/* =====================================================================
   test_db_records_site.mjs — RMCI/CUMC hospital flag + save prompt
   ---------------------------------------------------------------------
   The hospital tabs and the save-time hospital prompt in dbRecords.js
   are FEATURE-FLAGGED to Dr. Jesus Jardin's clinic/team. This test locks
   down both halves of that promise:

     1. THE GATE. The clinic's NAME decides when a clinic_id exists (RLS
        clinics_read_member lets the member read their own row); the
        strict "jesus" + "jardin" identity match decides otherwise. Dr.
        Monique Jardin-Quing's separate clinic must NEVER trip it, and a
        clinic that is not Jardin's wins even over a matching name.
     2. THE PROMPT. Flag ON: "Save to Database" asks which hospital
        BEFORE anything is written, pre-selects the device letterhead,
        honours Cancel (zero writes), writes the answer to payload.site,
        and asks again on a re-save. Flag OFF: byte-identical legacy
        save - no dialog is ever created and no payload.site key exists
        (which is also why test_draft_photo_invariants.mjs stays green).

   No network. Supabase is stubbed at the apiRequest boundary, exactly
   the way test_draft_photo_invariants.mjs does it.

   Run: node supabase-v2/scripts/test_db_records_site.mjs
   ===================================================================== */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..', '..')

let passed = 0, failed = 0
const ok = (id, what, cond, d = '') => { passed++; console.log('  PASS  ' + id.padEnd(4) + ' ' + what + (d ? ' — ' + d : '')) }
const bad = (id, what, d = '') => { failed++; console.log('  FAIL  ' + id.padEnd(4) + ' ' + what + (d ? ' — ' + d : '')) }
const is = (id, what, cond, d = '') => (cond ? ok(id, what, d) : bad(id, what, d))

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 12))
}

console.log('')
console.log('==== HOSPITAL FLAG / SAVE PROMPT (All | CUMC | RMCI) ====')
console.log('')

/* --------------------------------------------------------------------
   A small browser. Same shape as test_draft_photo_invariants' window,
   plus two things the prompt needs:
     * body.appendChild/removeChild records every dialog, so the test
       can SEE the prompt (opened = ever shown, live = still on screen);
     * clinicSettings and clinic rows are injectable per scenario.
   -------------------------------------------------------------------- */
function makeWindow(sink, opts = {}) {
  const user = 'user' in opts ? opts.user : { username: 'probe', role: 'doctor' }
  const clinicRows = opts.clinicRows || []
  const store = new Map()
  if (opts.clinicSettings) store.set('clinicSettings', JSON.stringify(opts.clinicSettings))

  const opened = []          // every dialog ever appended (count of prompts)
  const live = []            // dialogs still on screen
  const docListeners = {}
  const body = {
    classList: { contains: () => false },
    appendChild(el) { el.parentNode = body; opened.push(el); live.push(el); return el },
    removeChild(el) {
      const i = live.indexOf(el)
      if (i >= 0) live.splice(i, 1)
      return el
    },
  }

  const win = {
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k), key: i => [...store.keys()][i] ?? null,
      get length() { return store.size },
    },
    document: {
      readyState: 'complete',
      body,
      addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn) },
      removeEventListener: (t, fn) => {
        const list = docListeners[t] || []
        const i = list.indexOf(fn)
        if (i >= 0) list.splice(i, 1)
      },
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      createElement: () => {
        const listeners = {}
        return {
          style: {}, className: '', innerHTML: '', textContent: '', value: '',
          parentNode: null, dataset: {}, hidden: false,
          classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
          appendChild(c) { return c },
          setAttribute() {}, getAttribute: () => null,
          addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn) },
          removeEventListener() {},
          querySelector: () => null, querySelectorAll: () => [],
          matches: () => false, closest: () => null,
          focus() {}, blur() {}, click() {},
          get _listeners() { return listeners },
        }
      },
    },
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {},
    location: { pathname: '/nasalEndoscopy.html', search: '', href: '', replace: () => {} },
    navigator: { userAgent: 'node-test', onLine: true },
    console, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    CustomEvent: class { constructor(t, o) { this.detail = o && o.detail } },
    alert: () => {},
    URLSearchParams, URL,
  }
  win.window = win; win.globalThis = win
  win.EntSupabase = {
    isConfigured: () => true,
    getConfig: () => ({ supabaseUrl: 'https://probe.supabase.co', supabaseAnonKey: 'anon' }),
    getAccessToken: async () => 'JWT',
    apiRequest: async (path, o = {}) => {
      if (o.method === 'POST') {
        let b = null; try { b = JSON.parse(o.body) } catch { b = null }
        if (b) sink.push({ path, rows: Array.isArray(b) ? b : [b] })
        return []
      }
      if (String(path).indexOf('clinics') === 0) return clinicRows
      if (String(path).indexOf('patient_name=ilike') !== -1) return opts.dupRows || []
      return []                       // reports lookups: no dupes, no list
    },
  }
  win.EntAuth = {
    scope: () => ({ doctorId: 'doc', seeAll: true }),
    currentUser: () => user,
    logActivity: () => Promise.resolve(),
  }
  return { win, opened, live, docListeners }
}

function load(win, files) {
  vm.createContext(win)
  for (const f of files) vm.runInContext(readFileSync(join(APP, 'function', f), 'utf8'), win, { filename: f })
}

/* ================= the gate ========================================== */
console.log('---- resolveHospitalFeature (the clinic gate) ----')
async function resolveGate(opts) {
  const { win } = makeWindow([], opts)
  load(win, ['dbRecords.js'])
  return win.EntDbRecords.resolveHospitalFeature()
}

is('G1', 'the clinic NAME says Jardin -> ON (covers doctor/secretary/admin)',
   await resolveGate({
     user: { id: 'u1', username: 'nobody', full_name: 'Nobody At All', role: 'doctor', clinic_id: 'c1' },
     clinicRows: [{ name: 'ENT-Clinic Doc. Jardin' }],
   }) === true)

// The clinic is the source of truth: a non-Jardin clinic answers OFF even
// when the person's own name would match. They cannot disagree in
// practice - Jesus Jardin belongs to the Jardin clinic - and if some day
// they do, the clinic is the safer answer (feature off is safe; feature
// on for the wrong team is not).
is('G2', 'a non-Jardin clinic says OFF, even over a matching name',
   await resolveGate({
     user: { id: 'u2', username: 'jesus', full_name: 'Jesus Jardin', role: 'doctor', clinic_id: 'c2' },
     clinicRows: [{ name: 'ENT-Clinic Doc. Monique' }],
   }) === false)

is('G3', 'no clinic_id: the identity fallback turns ON for Jesus Jardin',
   await resolveGate({
     user: { id: 'u3', username: 'jess', full_name: 'Jesus Jardin', role: 'doctor' },
   }) === true)

is('G4', "Dr. Monique Jardin-Quing's separate clinic stays OFF",
   await resolveGate({
     user: { id: 'u4', full_name: 'Monique Jardin-Quing', role: 'doctor' },
   }) === false)

is('G5', 'a secretary of Dr. Jardin (assigned_doctor_name) is ON',
   await resolveGate({
     user: { id: 'u5', full_name: 'Tara Bautista', role: 'secretary', assigned_doctor_name: 'Dr. Jesus Jardin' },
   }) === true)

is('G6', 'an unnamed probe user stays OFF',
   await resolveGate({ user: { username: 'probe', role: 'doctor' } }) === false)

is('G7', 'no signed-in user stays OFF',
   await resolveGate({ user: null }) === false)

/* ================= the save prompt =================================== */
console.log('')
console.log('---- saveToDatabase (the hospital prompt) ----')

const JESUS = { id: 'doc-jardin', username: 'jess', full_name: 'Jesus Jardin', role: 'doctor' }
const PROBE = { username: 'probe', role: 'doctor' }

async function saveEnv(opts) {
  const posts = []
  const env = makeWindow(posts, opts)
  load(env.win, ['patientRecords.js', 'dbRecords.js'])
  let getDataCalls = 0
  env.win.EntFormBridge = {
    reportType: 'nasal',
    // Every call after the first is a DIFFERENT visit date: the first
    // save lands in the real PatientRecords history, and a same-day
    // re-save would raise the duplicate dialog BEFORE the hospital
    // prompt, masking what this test is counting. A different date is a
    // normal repeat visit and goes straight to the prompt.
    getData: () => {
      getDataCalls += 1
      return {
        patientLastName: 'ZZSITE',
        patientFirstName: 'Prompt',
        procedureDate: getDataCalls > 1 ? '2026-10-05' : '2026-10-02',
      }
    },
    restore: () => {},
    alert: (m, t) => (env.alerts = env.alerts || []).push(String(t || '') + ': ' + String(m)),
  }
  env.posts = posts
  env.reportRows = () => posts.filter(p => p.path.startsWith('reports?')).flatMap(p => p.rows)
  return env
}

// Drive the prompt the way a click would: event.target.closest() decides
// which button was hit.
const clickChoice = (box, site) => box._listeners.click[0]({
  target: { closest: sel => (sel === '[data-site-choice]' && site ? { getAttribute: () => site } : null) },
})
const clickCancel = box => box._listeners.click[0]({
  target: { closest: sel => (sel === '.ent-site-cancel' ? {} : null) },
})

// Every save now ends with the OPTIONAL follow-up prompt ("When should
// this patient come back?") — for EVERY clinic, not just the flagged
// one — and it waits for a click. Every save driven below must dismiss
// it the same way, and the "no hospital prompt" assertions must count
// only hospital prompts (a dismissed follow-up stays in `opened`).
const FU_HEADING = 'When should this patient come back?'
const dismissFollowUp = (env) => {
  const d = env.live[env.live.length - 1] || null
  if (d && d.innerHTML.includes(FU_HEADING)) clickCancel(d)
}
const nonFollowUpPrompts = (env) =>
  env.opened.filter(d => !d.innerHTML.includes(FU_HEADING)).length

/* ---- flag ON: the prompt gates the write ----------------------------- */
{
  const env = await saveEnv({ user: JESUS, clinicSettings: { hospitalHeader: 'rever' } })
  const saving = env.win.EntDbRecords.saveToDatabase()
  await settle()

  is('P1', 'the prompt appears BEFORE anything is written',
     env.opened.length === 1 && env.reportRows().length === 0,
     env.opened.length + ' dialog(s), ' + env.reportRows().length + ' row(s)')
  const box = env.opened[0]
  is('P2', 'it asks which hospital this visit belongs to',
     box.innerHTML.includes('Which hospital is this visit?'))
  is('P3', "the device's letterhead (rever -> RMCI) is pre-selected, not assumed",
     box.innerHTML.includes('is-rmci is-guess') && !box.innerHTML.includes('is-cumc is-guess'))

  clickChoice(box, 'CUMC')
  await settle()
  dismissFollowUp(env)
  await saving
  await settle()

  const final = env.reportRows().filter(r => r.is_draft === false)
  is('P4', 'the record is saved after the choice', final.length === 1,
     final.length + ' finalizing row(s)')
  is('P5', "the choice lands in payload.site (CUMC, despite the RMCI guess)",
     final.length === 1 && final[0].payload && final[0].payload.site === 'CUMC',
     final[0] ? 'site=' + final[0].payload.site : 'no row')
  is('P6', 'the dialog closed itself', env.live.length === 0)

  // Re-saving must re-ask: that is how a record gets MOVED later.
  const saving2 = env.win.EntDbRecords.saveToDatabase()
  await settle()
  const siteBox2 = env.live[0] || null
  is('P7', 'a re-save asks again (so a record can be moved hospitals)',
     env.live.length === 1
       && siteBox2 && siteBox2.innerHTML.includes('Which hospital is this visit?'),
     env.live.length + ' live dialog(s)')
  clickCancel(siteBox2)
  await settle()
  dismissFollowUp(env)
  await saving2
  await settle()
  is('P8', 'the re-save cancel still writes nothing new',
     env.reportRows().filter(r => r.is_draft === false).length === 1)

  // The tag also rides into THIS device's local history: the background
  // sync uploads an entry as a whole payload (payload = localRec), so
  // without the stamp a later sync of an unmarked key could drop
  // payload.site from the cloud row.
  const hist = JSON.parse(env.win.localStorage.getItem('entPatientRecordHistoryV1') || '[]')
  is('P15', 'the choice is stamped into the local record history as well',
     Array.isArray(hist) && hist.some(e => e && e.site === 'CUMC'),
     Array.isArray(hist) ? hist.length + ' local record(s)' : 'no history')
}

/* ---- flag ON: Cancel means nothing was saved ------------------------- */
{
  const env = await saveEnv({ user: JESUS })
  const saving = env.win.EntDbRecords.saveToDatabase()
  await settle()
  is('P9', 'the prompt is up', env.opened.length === 1 && env.live.length === 1)
  clickCancel(env.opened[0])
  await settle()
  dismissFollowUp(env)
  await saving
  await settle()
  is('P10', 'Cancel writes NOTHING to the database', env.reportRows().length === 0,
     env.reportRows().length + ' row(s)')
  is('P11', 'the dialog closed', env.live.length === 0)
}

/* ---- flag OFF: byte-identical legacy save ---------------------------- */
{
  const env = await saveEnv({ user: PROBE })
  const p12 = env.win.EntDbRecords.saveToDatabase()
  await settle()
  dismissFollowUp(env)
  await p12
  await settle()
  const final = env.reportRows().filter(r => r.is_draft === false)
  is('P12', 'the save completes normally', final.length === 1,
     final.length + ' finalizing row(s)')
  is('P13', 'NO hospital prompt is ever created for other clinics', nonFollowUpPrompts(env) === 0,
     nonFollowUpPrompts(env) + ' hospital dialog(s)')
  is('P14', 'and no payload.site key exists (payload untouched)',
     final.length === 1 && final[0].payload
       && !Object.prototype.hasOwnProperty.call(final[0].payload, 'site'))
  const hist = JSON.parse(env.win.localStorage.getItem('entPatientRecordHistoryV1') || '[]')
  is('P16', 'and the local history never grows a site key either',
     Array.isArray(hist) && hist.every(e => !e || !Object.prototype.hasOwnProperty.call(e, 'site')))
}

/* ---- the duplicate prompt is TYPE-AWARE ------------------------------ */
/* Reported from the clinic: "hindi na hihingi ng popup replace/update pag
   ibang type of report" - a cf4 saved for a patient who already has a
   nasal today used to raise the duplicate dialog. record_key is
   `type|patient|date`, so a cross-type pair are two rows that never touch
   each other: there is nothing to replace and nothing to ask. The dialog
   belongs to exactly one case - SAME type, SAME date - and to no other. */
async function dupEnv(dupRows) {
  const posts = []
  const env = makeWindow(posts, { user: PROBE, dupRows })
  load(env.win, ['patientRecords.js', 'dbRecords.js'])
  env.win.EntFormBridge = {
    reportType: 'nasal',
    getData: () => ({
      patientLastName: 'ZZDUP',
      patientFirstName: 'Cross',
      procedureDate: '2026-10-02',
    }),
    restore: () => {},
    alert: (m, t) => (env.alerts = env.alerts || []).push(String(t || '') + ': ' + String(m)),
  }
  env.posts = posts
  env.reportRows = () => posts.filter(p => p.path.startsWith('reports?')).flatMap(p => p.rows)
  return env
}
const dupRow = (type, date, key) => ({
  record_key: key || (type + '|zzdup, cross|' + date),
  patient_name: 'ZZDUP, Cross',
  procedure_date: date,
  report_type: type,
  created_by: 'someone',
  updated_at: '2026-10-01T08:00:00Z',
})
const clickDupNew = box => box._listeners.click[0]({
  target: { closest: sel => (sel === '.ent-dup-new' ? {} : null) },
})

console.log('')
console.log('---- the duplicate prompt (type-aware) ----')

/* A cf4 already on file for this patient and date. The nasal being saved
   now is a DIFFERENT key - it must save in silence. */
{
  const env = await dupEnv([dupRow('cf4', '2026-10-02', 'cf4|zzdup, cross|2026-10-02')])
  const x1 = env.win.EntDbRecords.saveToDatabase()
  await settle()
  dismissFollowUp(env)
  await x1
  await settle()
  const final = env.reportRows().filter(r => r.is_draft === false)
  is('X1', 'a different report type on the SAME day asks NOTHING',
     nonFollowUpPrompts(env) === 0 && final.length === 1,
     nonFollowUpPrompts(env) + ' dialog(s), ' + final.length + ' row(s)')
}

/* The same type on the same date IS the same record_key: the dialog must
   appear, must name its type, and "Replace" must finish the save. */
{
  const env = await dupEnv([dupRow('nasal', '2026-10-02')])
  const saving = env.win.EntDbRecords.saveToDatabase()
  await settle()
  is('X2', 'the same type on the same day raises the dialog',
     env.opened.length === 1
       && env.opened[0].innerHTML.includes('Already a record on this date'),
     env.opened.length + ' dialog(s)')
  is('X3', 'the dialog says WHICH type of record it is',
     env.opened.length === 1
       && env.opened[0].innerHTML.includes('Nasal Endoscopy record'))
  clickDupNew(env.opened[0])
  await settle()
  dismissFollowUp(env)
  await saving
  await settle()
  const final = env.reportRows().filter(r => r.is_draft === false)
  is('X4', 'choosing Replace completes the save', final.length === 1,
     final.length + ' row(s)')
}

/* The same type on an EARLIER day is a repeat visit: saved in silence,
   and the post-save toast (repeats) is what mentions it - never a modal. */
{
  const env = await dupEnv([dupRow('nasal', '2026-09-01')])
  const x5 = env.win.EntDbRecords.saveToDatabase()
  await settle()
  dismissFollowUp(env)
  await x5
  await settle()
  const final = env.reportRows().filter(r => r.is_draft === false)
  is('X5', 'the same type on an earlier day saves without asking',
     nonFollowUpPrompts(env) === 0 && final.length === 1,
     nonFollowUpPrompts(env) + ' dialog(s), ' + final.length + ' row(s)')
}

console.log('')
const parts = []
if (failed) parts.push(failed + ' FAILED')
console.log('==== ' + (parts.length ? parts.join(' / ') : 'HOSPITAL FLAG / PROMPT OK') +
  ' — ' + passed + ' passed, ' + failed + ' failed (' + (passed + failed) + ' checks) ====')
console.log('')
process.exit(failed ? 1 : 0)



