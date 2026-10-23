// =====================================================================
//  test_drafts_team.mjs
//  The "My Drafts | Team Drafts" tabs - do they show the right half?
//  ---------------------------------------------------------------------
//  Reported: a doctor could not see what his secretary was working on,
//  and she could not see what he was. The drafts were ALREADY shared -
//  the LIST was narrowed to `created_by = me`, on purpose, so "My Drafts"
//  could only ever mean what this account wrote.
//
//  So the feature is a second tab that drops that one filter and lets RLS
//  answer whose shelf a row is on. These tests hold the line on what that
//  must and must not mean:
//
//    1. My Drafts is UNCHANGED - still only this account's drafts
//    2. the team read carries NO author filter, so the database (not the
//       browser) decides the scope, and it still asks for is_draft = true
//    3. the team tab shows the OTHER half: not mine again, never a
//       finished record
//    4. each team card says WHO wrote it (created_by_name, or the name the
//       sharer stamped in the payload on a database without 0028)
//    5. no delete button on somebody else's draft; still there on mine
//    6. the team tab has its own honest empties - offline, failed read,
//       and "really none" are three different sentences
//    7. the reverse direction works: a secretary sees her doctor's draft
//
//  No network. Supabase is stubbed at the apiRequest boundary, exactly
//  the way test_db_records_card.mjs and test_dashboard_team.mjs do it.
//
//  Run: node supabase-v2/scripts/test_drafts_team.mjs
// =====================================================================
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..', '..')

let passed = 0, failed = 0
const ok = (id, what, cond, d = '') => {
  if (cond) { passed++; console.log(`  PASS  ${id.padEnd(4)} ${what}${d ? ' — ' + d : ''}`) }
  else { failed++; console.log(`  FAIL  ${id.padEnd(4)} ${what}${d ? ' — ' + d : ''}`) }
}

const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 12))
}

/* --------------------------------------------------------------------
   The same tiny DOM the other UI tests use. classList is REAL here (backed
   by className) because draftsBrowser asks the modal whether it is open
   ("is-open") after an async read, and the stub has to be able to say yes.
   -------------------------------------------------------------------- */
const firstBySel = {}

function makeEl(tag) {
  const qcache = {}
  const listeners = {}
  const children = []
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    id: '', className: '', textContent: '', value: '', hidden: false,
    checked: false, disabled: false, style: {}, dataset: {}, children,
    _html: '',
    get innerHTML() { return this._html },
    set innerHTML(v) { this._html = String(v); children.length = 0 },
    _listeners: listeners,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn) },
    removeEventListener() {},
    setAttribute(k, v) { if (k === 'id') el.id = String(v); if (k === 'class') el.className = String(v) },
    getAttribute() { return null },
    appendChild(c) { children.push(c); return c },
    removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); return c },
    remove() {},
    querySelector(sel) {
      if (!firstBySel[sel]) firstBySel[sel] = makeEl('div')
      return qcache[sel] || (qcache[sel] = firstBySel[sel])
    },
    querySelectorAll() { return [] },
    closest() { return null },
    matches() { return false },
    focus() {}, blur() {}, scrollIntoView() {}, click() {},
    dispatchEvent() { return true },
    contains() { return false },
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  }
  const setOf = () => String(el.className || '').split(/\s+/).filter(Boolean)
  el.classList = {
    add: (...c) => { el.className = Array.from(new Set(setOf().concat(c))).join(' ') },
    remove: (...c) => { el.className = setOf().filter(x => !c.includes(x)).join(' ') },
    toggle: (c, on) => {
      const has = setOf().includes(c)
      const next = on === undefined ? !has : !!on
      if (next) el.classList.add(c); else el.classList.remove(c)
      return next
    },
    contains: c => setOf().includes(c),
  }
  return el
}

/* --------------------------------------------------------------------
   One fresh browser per scenario.
     mode: 'normal' | 'failName' (no 0028 column) | 'failTeam' | 'failAll'
   -------------------------------------------------------------------- */
function boot({ mode = 'normal', onLine = true, search = '', user, mineRows, teamRows }) {
  for (const k of Object.keys(firstBySel)) delete firstBySel[k]
  const calls = []
  const alerts = []
  const store = new Map()
  const storage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  }

  const document = {
    readyState: 'complete', title: 'test',
    body: { style: {}, appendChild() {}, classList: { contains: () => false }, insertAdjacentHTML() {} },
    addEventListener: () => {},
    getElementById: () => null,
    createElement: tag => makeEl(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
  }

  const win = {
    document,
    location: { search, pathname: '/cf4Form.html', href: '' },
    history: { replaceState() {} },
    localStorage: storage, sessionStorage: storage,
    navigator: { onLine, userAgent: 'node-test' },
    console, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    URLSearchParams, URL,
    confirm: () => true,
    alert: m => alerts.push(String(m)),
    EntFormBridge: {
      reportType: 'cf4',
      getData: () => ({ patientName: 'x' }),
      restore: () => {},
      alert: (m, t) => alerts.push(String(t || '') + ': ' + String(m)),
    },
    EntAuth: {
      currentUser: () => user,
      readUserCache: () => [],
      logActivity: async () => true,
    },
    EntSupabase: {
      isConfigured: () => true,
      apiRequest: async (endpoint) => {
        calls.push(endpoint)
        if (mode === 'failAll') throw new Error('Supabase API error (000): unreachable')
        const wantsName = endpoint.includes('created_by_name')
        if (mode === 'failName' && wantsName) {
          throw new Error('column reports.created_by_name does not exist')
        }
        const isMine = endpoint.includes('&created_by=eq.')
        if (mode === 'failTeam' && !isMine) throw new Error('team read refused')
        return isMine ? mineRows : teamRows
      },
    },
  }
  win.window = win
  win.globalThis = win

  const src = readFileSync(join(APP, 'function', 'draftsBrowser.js'), 'utf8')
  vm.createContext(win)
  vm.runInContext(src, win, { filename: 'draftsBrowser.js' })
  return { win, calls, alerts, store }
}

/* --------------------------------------------------------------------
   Fixtures. Doc Jess, his secretary Tara, a second secretary Kaye, and
   one row already finished (dbSaved) that must stay out of both tabs.
   -------------------------------------------------------------------- */
const JESS = { id: 'doc-jess', username: 'jess', full_name: 'Jesus Jardin', role: 'doctor' }
const TARA = { id: 'sec-tara', username: 'tara', full_name: 'Tara Bautista', role: 'secretary',
               assigned_doctor_id: 'doc-jess' }

function draftRow({ key, by, byName, patient, sharedBy, saved }) {
  return {
    record_key: key, report_type: 'cf4', patient_name: patient, patient_id: '',
    case_number: '', procedure_date: '2026-10-05', file_name: patient + '_CF4_Data.json',
    created_by: by, created_by_name: byName,
    created_at: '2026-10-05T08:00:00Z', updated_at: '2026-10-05T08:00:00Z',
    payload: {
      reportType: 'cf4', reportLabel: 'CF4 Form', patientName: patient,
      sharedAt: '2026-10-05T08:00:00Z', sharedBy: sharedBy || byName,
      draftShared: true,
      dbSaved: saved === true ? true : undefined,
      formData: { patientLastName: patient.split(' ').pop(), patientFirstName: patient.split(' ')[0] },
    },
  }
}

/* What the background sync leaves behind: is_draft = TRUE, patient metadata,
   NO form. Observed live: 20 of these beside 3 real drafts, which is what
   made the Team tab look broken. */
function ghostRow({ key, by, patient }) {
  return {
    record_key: key, report_type: 'cf4', patient_name: patient, patient_id: '',
    case_number: '', procedure_date: '2026-10-05', file_name: '',
    created_by: by, created_by_name: '',
    created_at: '2026-10-05T08:00:00Z', updated_at: '2026-10-05T08:00:00Z',
    payload: { key, reportType: 'cf4', patientName: patient },
  }
}

const MINE_ROWS = [
  draftRow({ key: 'cf4|M1', by: 'doc-jess', byName: 'Jesus Jardin', patient: 'DELA CRUZ, BEN' }),
  // My own row that is already FINISHED - belongs nowhere in this list.
  draftRow({ key: 'cf4|M2', by: 'doc-jess', byName: 'Jesus Jardin', patient: 'DONE, PATIENT', saved: true }),
]

const TEAM_ROWS = [
  draftRow({ key: 'cf4|T1', by: 'sec-tara', byName: 'Tara Bautista', patient: 'RACOMA, ALLOY' }),
  draftRow({ key: 'cf4|T2', by: 'sec-kaye', byName: 'Kaye Santos', patient: 'SANTOS, LIZA' }),
  // Mine again (the unfiltered team read returns my own rows too).
  draftRow({ key: 'cf4|M1', by: 'doc-jess', byName: 'Jesus Jardin', patient: 'DELA CRUZ, BEN' }),
  // Finished: is_draft is still true on the row, the save marker is not.
  draftRow({ key: 'cf4|T3', by: 'sec-tara', byName: 'Tara Bautista', patient: 'SAVED, ALREADY', saved: true }),
]

// The other direction the clinic asked for: the secretary's shelf.
const SECRETARY_TEAM_ROWS = [
  draftRow({ key: 'cf4|D1', by: 'doc-jess', byName: 'Jesus Jardin', patient: 'DOCTORS, DRAFT' }),
  draftRow({ key: 'cf4|T1', by: 'sec-tara', byName: 'Tara Bautista', patient: 'RACOMA, ALLOY' }),
]

async function open(opts) {
  const env = boot(opts)
  await flush()
  env.win.EntDrafts.openModal()
  await flush()
  env.list = firstBySel['.ent-drafts-list']
  env.summary = firstBySel['.ent-drafts-summary']
  env.tabs = firstBySel['.ent-drafts-tabs']
  env.html = () => env.list.children.map(c => c.innerHTML).join('\n')
  env.text = () => env.list.children.map(c => String(c.textContent || '')).join(' | ')
  env.tab = which => {
    const fn = (env.tabs._listeners.click || [])[0]
    if (fn) fn({ target: { closest: () => ({ getAttribute: () => which }) } })
  }
  // Press the first button on the card carrying this patient name, the way
  // a reader would - the list handles its own clicks.
  env.clickCard = async (patient, action = 'open') => {
    const card = env.list.children.find(c => c.innerHTML.includes(patient))
    if (!card) return false
    const id = (card.innerHTML.match(new RegExp('data-draft-action="' + action + '"[^>]*data-draft-id="([^"]*)"'))
      || card.innerHTML.match(/data-draft-id="([^"]*)"/) || [])[1]
    const fn = (env.list._listeners.click || [])[0]
    if (!fn) return false
    fn({ target: { closest: () => ({ disabled: false, dataset: { draftId: id, draftAction: action } }) } })
    await flush()
    return true
  }
  return env
}

console.log('')
console.log('==== DRAFTS — does the team see the team? ====')
console.log('')

/* ---- 1 · the doctor: his own work, then his secretaries' ---------- */
{
  const env = await open({ user: JESS, mineRows: MINE_ROWS, teamRows: TEAM_ROWS })
  const mineHtml = env.html()
  ok('T1', 'My Drafts shows only what this account wrote',
     mineHtml.includes('DELA CRUZ, BEN') && !mineHtml.includes('RACOMA, ALLOY'),
     env.text().slice(0, 70))
  ok('T2', 'a finished row is in neither list', !mineHtml.includes('DONE, PATIENT'))
  const mineCalls = env.calls.filter(c => c.includes('&created_by=eq.'))
  const teamCalls = env.calls.filter(c => !c.includes('&created_by=eq.'))
  ok('T3', 'two reads, and mine keeps its author filter', mineCalls.length === 1,
     mineCalls.join(' ').slice(0, 90))
  ok('T4', 'the team read carries NO author filter - the database owns the scope',
     teamCalls.length === 1 && !teamCalls[0].includes('created_by='))
  ok('T5', 'and it still asks only for unfinished rows',
     teamCalls.every(c => c.includes('is_draft=eq.true')))

  env.tab('team')
  await flush()
  const teamHtml = env.html()
  ok('T6', 'the team tab shows what the secretaries wrote',
     teamHtml.includes('RACOMA, ALLOY') && teamHtml.includes('SANTOS, LIZA'),
     env.text().slice(0, 70))
  ok('T7', 'and each card says WHO wrote it',
     teamHtml.includes('Tara Bautista') && teamHtml.includes('Kaye Santos'))
  ok('T8', 'my own draft does not reappear in the team tab',
     !teamHtml.includes('DELA CRUZ, BEN'))
  ok('T9', 'a finished row stays out of the team tab too',
     !teamHtml.includes('SAVED, ALREADY'))
  ok('T10', 'NO delete button on somebody else\'s draft',
     !/data-draft-action="delete"/.test(teamHtml))
  ok('T11', 'MY draft still has one', /data-draft-action="delete"/.test(mineHtml))
  ok('T12', 'the summary says whose shelf the tab is looking at',
     /your team/.test(env.summary.textContent), env.summary.textContent)

  env.tab('mine')
  await flush()
  ok('T13', 'my own card carries no author chip (it would only echo my name)',
     !/ent-drafts-author/.test(env.html()))
  ok('T14', 'the summary counts each side separately',
     /1 shown/.test(env.summary.textContent), env.summary.textContent)
}

/* ---- 2 · offline --------------------------------------------------- */
{
  const env = await open({ onLine: false, user: JESS, mineRows: MINE_ROWS, teamRows: TEAM_ROWS })
  env.tab('team')
  await flush()
  ok('T15', 'offline, the team tab explains itself instead of claiming "none"',
     /need an internet connection/.test(env.text()), env.text().slice(0, 90))
  env.tab('mine')
  await flush()
  ok('T16', 'offline still opens my own drafts', !/No drafts/.test(env.text()))
}

/* ---- 3 · a database without 0028 ----------------------------------- */
{
  const env = await open({ mode: 'failName', user: JESS, mineRows: MINE_ROWS, teamRows: TEAM_ROWS })
  env.tab('team')
  await flush()
  ok('T17', 'without created_by_name the author still resolves (payload.sharedBy)',
     env.html().includes('Tara Bautista'), 'fell back to the sharer name')
  ok('T18', 'and a read without the column actually happened',
     env.calls.some(c => c.includes('is_draft=eq.true') && !c.includes('created_by_name')))
}

/* ---- 4 · the team read fails, mine must not notice ------------------ */
{
  const env = await open({ mode: 'failTeam', user: JESS, mineRows: MINE_ROWS, teamRows: TEAM_ROWS })
  ok('T19', 'a failed team read leaves MY list untouched',
     env.html().includes('DELA CRUZ, BEN'))
  env.tab('team')
  await flush()
  ok('T20', 'and the team tab says it could not be read',
     /could not be read/.test(env.text()), env.text().slice(0, 90))
}

/* ---- 5 · the other direction: the secretary sees her doctor ------- */
{
  const env = await open({
    user: TARA,
    mineRows: [draftRow({ key: 'cf4|T1', by: 'sec-tara', byName: 'Tara Bautista', patient: 'RACOMA, ALLOY' })],
    teamRows: SECRETARY_TEAM_ROWS,
  })
  env.tab('team')
  await flush()
  const teamHtml = env.html()
  ok('T21', 'a secretary sees her doctor\'s unfinished draft, by name',
     teamHtml.includes('DOCTORS, DRAFT') && teamHtml.includes('Jesus Jardin'),
     env.text().slice(0, 70))
  ok('T22', 'and not her own one all over again', !teamHtml.includes('RACOMA, ALLOY'))
  ok('T23', 'still no delete button on her doctor\'s draft',
     !/data-draft-action="delete"/.test(teamHtml))
}

/* ---- 6 · the database is simply gone -------------------------------- */
{
  const env = await open({ mode: 'failAll', user: JESS, mineRows: MINE_ROWS, teamRows: TEAM_ROWS })
  ok('T24', 'a dead database does not crash the drafts modal',
     env.list.children.length >= 1 && env.alerts.length === 0,
     env.alerts.join(' / ').slice(0, 60))
  env.tab('team')
  await flush()
  ok('T25', 'and the team tab admits it could not be read',
     /could not be read/.test(env.text()))
}

/* ---- 7 · a draft of ANOTHER report type still opens ---------------- */
{
  const nasalDraft = draftRow({ key: 'cf4|N1', by: 'sec-tara', byName: 'Tara Bautista', patient: 'NASAL, PATIENT' })
  nasalDraft.report_type = 'nasal'
  nasalDraft.payload.reportType = 'nasal'
  nasalDraft.payload.reportLabel = 'Nasal Endoscopy'
  const env = await open({ user: JESS, mineRows: MINE_ROWS, teamRows: [nasalDraft] })
  env.tab('team')
  await flush()
  const card = env.list.children[0]
  ok('T26', 'a teammate\'s NASAL draft is openable from the CF4 page',
     card.innerHTML.includes('Open on Nasal Endoscopy'),
     (card.innerHTML.match(/ent-drafts-open[^>]*>/) || ['no button'])[0].slice(0, 80))
  await env.clickCard('NASAL, PATIENT')
  ok('T27', 'pressing Open walks to the page that owns that form',
     env.win.location.href === 'nasalEndoscopy.html?ent_draft=' + encodeURIComponent('cf4|N1'),
     env.win.location.href)
}

/* ---- 8 · arriving from the other page: it opens by itself ---------- */
{
  const mine = [draftRow({ key: 'cf4|R1', by: 'doc-jess', byName: 'Jesus Jardin', patient: 'HANDED, OVER' })]
  const env = await open({
    user: JESS,
    search: '?ent_draft=' + encodeURIComponent('cf4|R1'),
    mineRows: mine,
    teamRows: [],
  })
  ok('T28', 'arriving with ?ent_draft opens the draft with no button pressed',
     env.alerts.some(a => /DRAFT LOADED/.test(a)), env.alerts.join(' / ').slice(0, 70))
  ok('T29', 'and it read the shelf on arrival, even with no modal open',
     env.calls.some(c => c.includes('is_draft=eq.true')))
}

/* ---- 9 · who last edited it ---------------------------------------- */
{
  // Tara drafted it and Kaye (the other secretary) later carried it on, so
  // created_by_name is still Tara while the payload's sharedBy is now Kaye.
  // From Jess's seat both are "somebody else", and the card must say which.
  const handedOver = draftRow({ key: 'cf4|E1', by: 'sec-tara', byName: 'Tara Bautista',
                                patient: 'HANDED, OVER', sharedBy: 'Kaye Santos' })
  const untouched = draftRow({ key: 'cf4|E2', by: 'sec-tara', byName: 'Tara Bautista',
                               patient: 'UNTOUCHED, DRAFT' })
  // And the other direction: MY draft, which the secretary has since edited.
  const mineEdited = draftRow({ key: 'cf4|E3', by: 'doc-jess', byName: 'Jesus Jardin',
                                patient: 'SECRETARY, EDITED', sharedBy: 'Tara Bautista' })
  const env = await open({
    user: JESS,
    mineRows: MINE_ROWS.concat([mineEdited]),
    teamRows: [handedOver, untouched],
  })
  env.tab('team')
  await flush()
  const over = env.list.children.find(c => c.innerHTML.includes('HANDED, OVER')).innerHTML
  const solo = env.list.children.find(c => c.innerHTML.includes('UNTOUCHED, DRAFT')).innerHTML

  ok('T30', 'a draft a colleague carried on says WHO',
     /last edited by Kaye Santos/.test(over), (over.match(/ent-drafts-edited[^<]*</) || ['no chip'])[0])
  ok('T31', 'and it still says who drafted it',
     /Tara Bautista/.test(over) && over.includes('ent-drafts-author'))
  ok('T32', 'a draft nobody else touched does not claim an editor',
     !solo.includes('ent-drafts-edited'), solo.slice(0, 50))
  ok('T33', 'the chip carries when it happened',
     /last edited by Kaye Santos \u00b7/.test(over))

  env.tab('mine')
  await flush()
  const mineHtml = env.html()
  ok('T34', 'MY OWN draft says when the secretary last edited it',
     /last edited by Tara Bautista/.test(mineHtml), (mineHtml.match(/ent-drafts-edited[^<]*</) || ['no chip'])[0])
  ok('T35', 'and a draft I last touched myself claims no editor',
     !/last edited by Jesus Jardin/.test(mineHtml))
}

/* ---- 10 · formless rows (the sync's stubs) are not drafts ---------- */
{
  const env = await open({
    user: JESS,
    mineRows: MINE_ROWS.concat([ghostRow({ key: 'cf4|G1', by: 'doc-jess', patient: 'GHOST, MINE' })]),
    teamRows: TEAM_ROWS.concat([ghostRow({ key: 'cf4|G2', by: 'sec-tara', patient: 'GHOST, THEIRS' })]),
  })
  ok('T36', 'a formless row of mine is not listed (nothing there to open)',
     !env.html().includes('GHOST, MINE'), env.text().slice(0, 50))
  env.tab('team')
  await flush()
  ok('T37', 'nor is a formless row from a colleague',
     !env.html().includes('GHOST, THEIRS') && env.html().includes('RACOMA, ALLOY'),
     env.text().slice(0, 50))
}

/* ---- 11 · a draft with no patient name is REFUSED ------------------ */
// Requested: saving a draft without a patient name is not allowed. It is
// not only untidy: extractMeta() falls back to the literal "Unnamed
// patient", so buildKey() produces `cf4|unnamed patient|<date>` and two
// nameless drafts on the same day OVERWRITE each other.
{
  const KEY = 'entSavedDraftsV1'
  const env = boot({ user: JESS, mineRows: MINE_ROWS, teamRows: TEAM_ROWS })
  const saved = () => env.win.localStorage.getItem(KEY)

  ok('T38', 'a form with no patient name cannot be saved as a draft',
     await env.win.EntDrafts.saveAndOpen('cf4',
       { patientLastName: '  ', patientFirstName: '', procedureDate: '2026-10-05' }, 'x.json') === null)
  ok('T39', 'and NOTHING is written to the device',
     saved() === null, String(saved()).slice(0, 40))
  ok('T40', 'the refusal says the name is what is missing',
     env.alerts.some(a => /without a patient name/i.test(a)),
     env.alerts.join(' / ').slice(0, 70))
  ok('T41', 'a middle name on its own does not count as a patient',
     env.win.EntDrafts.saveDraft('cf4',
       { patientMiddleName: 'D', procedureDate: '2026-10-05' }, 'y.json') === null &&
     saved() === null)

  const alertsBefore = env.alerts.length
  const ok1 = env.win.EntDrafts.saveAndOpen('cf4',
    { patientLastName: 'DELA CRUZ', patientFirstName: 'BEN', procedureDate: '2026-10-05' }, 'ben.json')
  ok('T42', 'with a name it saves as before', Boolean(ok1) && /DELA CRUZ/.test(String(saved())))
  ok('T43', 'and a successful save adds no refusal of its own',
     env.alerts.length === alertsBefore,
     'new alerts: ' + (env.alerts.length - alertsBefore))
}

console.log('')
console.log(`  ${passed} passed, ${failed} failed`)
console.log('')
process.exitCode = failed ? 1 : 0