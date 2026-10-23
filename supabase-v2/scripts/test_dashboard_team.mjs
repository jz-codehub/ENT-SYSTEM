// =====================================================================
//  test_dashboard_team.mjs
//  Does the dashboard's "Your secretaries" card tell the truth?
//  ---------------------------------------------------------------------
//  The bug this locks down: the card used to read Auth.readUserCache(),
//  which v2 retired to a permanent [], so EVERY doctor saw "No secretary
//  is linked to you yet" while the admin panel showed secretaries
//  assigned and correct (2026-10-03 backup: tara -> jess). The fix is
//  rpc/my_secretaries (migration 0027). What must not regress:
//
//    1. before the answer arrives the card says it is looking - it does
//       NOT claim "no secretary" while the request is still in flight
//    2. the real answer renders every assigned secretary by name
//    3. a row for a DIFFERENT doctor is filtered out at the card too
//    4. a real answer of none keeps the "ask the admin" wording
//    5. a failed call shows an error, never "none" - and the Refresh
//       button is a working way back from it
//    6. a secretary never sees the card
//    7. the request is rpc/my_secretaries (POST, {}) and the browser
//       NEVER reads staff_profiles to build this list - a direct table
//       read is exactly what RLS would filter to nothing anyway
//
//  No network. Supabase is stubbed at the apiRequest boundary, exactly
//  the way test_view_all_ui.mjs and test_frontend_v2.mjs do it.
//
//  Run: node supabase-v2/scripts/test_dashboard_team.mjs
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

// Let every pending promise chain settle. The dashboard boots through an
// async guard(), then fire-and-forget refresh()/loadTeam() calls, so one
// macrotask turn is not always enough - three is.
const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 12))
}

// A canvas-ish context that tolerates anything. renderChart is asked for
// it when the stubbed DOM hands back a node for every id in index.html.
function looseContext() {
  const ctx = new Proxy({}, {
    get: (t, p) => (p === 'measureText' ? () => ({ width: 5 })
      : p === 'canvas' ? null
      : typeof p === 'string' ? (...a) => ctx : undefined),
    set: () => true,
  })
  return ctx
}

function makeNode(id) {
  const listeners = {}
  const node = {
    id, innerHTML: '', textContent: '', hidden: false, className: '', value: '',
    style: {}, dataset: {}, checked: false, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    listeners,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn) },
    removeEventListener() {},
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, matches: () => false,
    appendChild(c) { this.children.push(c); return c },
    insertAdjacentHTML() {}, remove() {}, scrollIntoView() {}, focus() {}, click() {},
    getContext: () => looseContext(),
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  }
  return node
}

// Every id the real index.html has, minus the chart (a fake canvas only
// invites trouble; renderChart early-returns when the node is absent).
function domIds() {
  const html = readFileSync(join(APP, 'index.html'), 'utf8')
  return [...new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]))]
    .filter(id => !/chart/i.test(id))
}

/* ------------------------------------------------------------------ */
/*  One fresh "browser" per scenario                                   */
/* ------------------------------------------------------------------ */
function boot({ user, team, onLine = true, queue = [], counters = [], directory = null }) {
  const calls = []
  const nodes = {}
  for (const id of domIds()) nodes[id] = makeNode(id)

  const store = new Map()
  const storage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  }

  const docListeners = {}
  const winListeners = {}
  const nav = { onLine, userAgent: 'node-test' }

  const win = {
    localStorage: storage, sessionStorage: storage,
    document: {
      readyState: 'complete', hidden: false,
      body: { classList: { contains: () => false }, insertAdjacentHTML() {}, appendChild() {} },
      addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn) },
      getElementById: id => nodes[id] || null,
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => makeNode('new-' + Math.random()),
    },
    addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn) },
    dispatchEvent: () => true,
    location: { pathname: '/index.html', search: '', href: '', replace() {}, assign() {} },
    navigator: nav,
    console, setInterval: () => 0, clearInterval: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    URL, URLSearchParams, Date, JSON, Math, Promise,
    EntAuth: {
      guard: async () => ({ user, session: {}, expiresAt: 0 }),
      scope: () => ({
        role: user.role,
        doctorId: user.role === 'doctor' ? user.id : (user.assigned_doctor_id || ''),
        seeAll: false, label: user.full_name || user.username,
        assignedDoctorId: user.assigned_doctor_id || '',
      }),
      currentUser: () => user,
      escapeHtml: v => String(v ?? '').replace(/[&<>'"]/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])),
      logActivity: async () => true,
      readUserCache: () => [],        // the retired no-op, exactly as in auth.js
      loadAllUsers: async () => [],
    },
    EntSupabase: {
      isConfigured: () => true,
      getConfig: () => ({ supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon' }),
      getAccessToken: async () => 'JWT',
      apiRequest: async (endpoint, opts = {}) => {
        calls.push({ endpoint, method: opts.method || 'GET', body: opts.body })
        if (endpoint.includes('my_secretaries')) {
          if (team.kind === 'pending') {
            return new Promise((res, rej) => { team.resolve = res; team.reject = rej })
          }
          if (team.kind === 'error') throw team.error
          return team.rows
        }
        // The team-queue query is recognisable by its select list; the
        // counters use a different one (created_at first - and, since v33ad,
        // updated_at follows so Latest patients can show the last-save time;
        // matching the "select=created_at," prefix covers both shapes).
        if (endpoint.includes('select=record_key,created_by')) return queue
        if (endpoint.includes('select=created_at,')) return counters
        // The admin preview's per-clinic card reads two directories the rest
        // of the dashboard never asks for: clinic names and staff profiles.
        // Served from the scenario's `directory` option when present, empty
        // otherwise (which must degrade to id labels, never break the card).
        if (endpoint.includes('clinics?select=')) {
          return (directory && directory.clinics) || []
        }
        if (endpoint.includes('staff_profiles')) return (directory && directory.staff) || []
        return []                    // activity - empty
      },
    },
  }
  win.window = win
  win.globalThis = win

  const src = readFileSync(join(APP, 'function', 'dashboard.js'), 'utf8')
  vm.createContext(win)
  vm.runInContext(src, win, { filename: 'dashboard.js' })
  return { win, nodes, calls, docListeners, winListeners, nav }
}


console.log('')
console.log('==== DASHBOARD "YOUR SECRETARIES" — does the card tell the truth? ====')
console.log('')

const DOC = { id: 'doc-jardin', username: 'jess', full_name: 'Jesus Jardin', role: 'doctor', is_active: true }
const TARA = { id: 'sec-tara', username: 'tara', full_name: 'Tara Bautista', role: 'secretary',
               assigned_doctor_id: 'doc-jardin', is_active: true }
const KAYE = { id: 'sec-kaye', username: 'kaye', full_name: 'Kaye Santos', role: 'secretary',
               assigned_doctor_id: 'doc-jardin', is_active: true }
const FOREIGN = { id: 'sec-other', username: 'gina', full_name: 'Gina Mercado', role: 'secretary',
                  assigned_doctor_id: 'someone-else', is_active: true }

/* ---- 1 · the reported bug, in two acts ------------------------------ */
{
  const team = { kind: 'pending' }           // the RPC has not answered yet
  const env = boot({ user: DOC, team })
  await flush()

  const hint = () => env.nodes.dashTeamHint.textContent
  const box = () => env.nodes.dashTeam.innerHTML

  ok('T1', 'the card is visible for a doctor', env.nodes.dashTeamCard.hidden === false)
  ok('T2', 'while the call is in flight the card says it is looking',
     /Looking up/.test(box()), box().slice(0, 80))
  ok('T3', 'the in-flight card does NOT claim "no secretary"',
     !/No secretary is linked/.test(box()) && !/Ask the admin/.test(hint()),
     hint())
  ok('T4', 'the card went to rpc/my_secretaries, not staff_profiles',
     env.calls.some(c => c.endpoint.includes('rpc/my_secretaries'))
     && !env.calls.some(c => c.endpoint.includes('staff_profiles')))
  const teamCall = env.calls.find(c => c.endpoint.includes('my_secretaries'))
  ok('T5', 'the call is a bare POST {} (no arguments to smuggle)',
     teamCall && teamCall.method === 'POST' && teamCall.body === '{}',
     teamCall ? `${teamCall.method} ${teamCall.body}` : 'no call')

  // The real answer arrives - two of this doctor's secretaries plus one
  // row that belongs to a DIFFERENT doctor (the card must refuse it).
  team.kind = 'rows'
  team.resolve([TARA, KAYE, FOREIGN])
  await flush()

  ok('T6', 'assigned secretaries render by real name',
     box().includes('Tara Bautista') && box().includes('Kaye Santos'))
  ok('T7', 'their usernames show as @handles', box().includes('@tara') && box().includes('@kaye'))
  ok('T8', 'a secretary assigned to ANOTHER doctor is filtered out here too',
     !box().includes('Gina Mercado'), 'invariant held at the card, not only at the server')
  ok('T9', 'the hint now says they file reports under the doctor\'s name',
     hint() === 'They file reports under your name', hint())
  ok('T10', 'the fetch runs once per page (no polling after success)',
     env.calls.filter(c => c.endpoint.includes('my_secretaries')).length === 1)
}

/* ---- 2 · a real answer of "none" ------------------------------------ */
{
  const env = boot({ user: DOC, team: { kind: 'rows', rows: [] } })
  await flush()
  const hint = env.nodes.dashTeamHint.textContent
  const box = env.nodes.dashTeam.innerHTML
  ok('T11', 'an empty ANSWER still shows the "ask the admin" wording',
     hint === 'Ask the admin to link a secretary to your account', hint)
  ok('T12', 'and the empty list says so plainly',
     box.includes('No secretary is linked to you yet.'))
}

/* ---- 3 · a failed call, and Refresh as the way back ------------------ */
{
  const team = { kind: 'error', error: new Error('Supabase API error (404): Could not find the function my_secretaries') }
  const env = boot({ user: DOC, team })
  await flush()
  const hint = () => env.nodes.dashTeamHint.textContent
  const box = () => env.nodes.dashTeam.innerHTML

  ok('T13', 'a failed call reports the failure, not "none"',
     /Could not reach the cloud database/.test(hint()) && /could not be loaded/.test(box()),
     hint())
  ok('T14', 'a failed call does NOT tell the doctor to ask the admin',
     !/Ask the admin/.test(hint()), hint())

  // The admin runs migration 0027, the doctor presses Refresh.
  team.kind = 'rows'; team.rows = [TARA]; team.error = null
  const btn = env.nodes.dashRefreshBtn
  const clicks = (btn.listeners.click || [])
  ok('T15', 'the Refresh button is wired', clicks.length === 1)
  if (clicks.length) { clicks[0]({}); await flush() }

  ok('T16', 'after Refresh the secretaries appear',
     box().includes('Tara Bautista') && !/could not be loaded/.test(box()))
  ok('T17', 'the retry went through the same rpc (no fallback table read)',
     env.calls.filter(c => c.endpoint.includes('my_secretaries')).length === 2
     && !env.calls.some(c => c.endpoint.includes('staff_profiles')))
}

/* ---- 4 · a secretary never sees the card ---------------------------- */
{
  const SEC = { id: 'sec-tara', username: 'tara', full_name: 'Tara Bautista', role: 'secretary',
                assigned_doctor_id: 'doc-jardin', is_active: true }
  const env = boot({ user: SEC, team: { kind: 'rows', rows: [TARA] } })
  await flush()
  ok('T18', 'the card stays hidden for a secretary', env.nodes.dashTeamCard.hidden === true)
  ok('T19', 'a secretary\'s page does not call the doctor-only rpc',
     !env.calls.some(c => c.endpoint.includes('my_secretaries')))
}

/* ---- 5 · offline: waiting wording, no request ----------------------- */
{
  const env = boot({ user: DOC, team: { kind: 'pending' }, onLine: false })
  await flush()
  const hint = env.nodes.dashTeamHint.textContent
  const box = env.nodes.dashTeam.innerHTML
  ok('T20', 'offline shows the online-explanation wording',
     /once this device is online/.test(hint), hint)
  ok('T21', 'offline does not claim "no secretary"',
     !/No secretary is linked/.test(box) && !/Ask the admin/.test(hint))
  ok('T22', 'offline fires no request at all',
     !env.calls.some(c => c.endpoint.includes('my_secretaries')))
}

/* ---- 6 · the queue's "who" column (same uuid bug, same fix) ---------- */
{
  const recent = new Date(Date.now() - 3600e3).toISOString()
  const env = boot({
    user: DOC, team: { kind: 'rows', rows: [TARA] },
    queue: [
      { record_key: 'cf4|Q1', created_by: '94978594-afad-4c81-9e4e-8bc8b13966e3',
        created_by_name: 'Tara Bautista', draftShared: true, doctor_id: 'doc-jardin', clinic_id: 'c1',
        report_type: 'cf4', patient_name: 'QUEUE PATIENT', case_number: '',
        procedure_date: '2026-10-05', created_at: recent, updated_at: recent, dbSaved: false },
      { record_key: 'cf4|Q2', created_by: 'doc-jardin', created_by_name: 'Jesus Jardin',
        draftShared: true, doctor_id: 'doc-jardin', clinic_id: 'c1', report_type: 'cf4',
        patient_name: 'OWN QUEUE PATIENT', case_number: '', procedure_date: '2026-10-05',
        created_at: recent, updated_at: recent, dbSaved: false },
      // The background sync's formless row: is_draft, metadata, no form.
      { record_key: 'cf4|Q3', created_by: 'sec-tara', created_by_name: '',
        doctor_id: 'doc-jardin', clinic_id: 'c1', report_type: 'cf4',
        patient_name: 'GHOST, ROW', case_number: '', procedure_date: '2026-10-05',
        created_at: recent, updated_at: recent, dbSaved: false },
    ],
  })
  await flush()
  const q = () => env.nodes.dashQueue.innerHTML

  ok('T23', 'the queue names the saver', q().includes('Tara Bautista'), q().slice(0, 60))
  ok('T24', 'the queue never prints a raw uuid', !q().includes('94978594-'))
  ok('T25', 'the doctor\'s own row stays out of "Waiting for review" (isMine by id now works)',
     q().includes('QUEUE PATIENT') && !q().includes('OWN QUEUE PATIENT'))
  ok('T25b', 'a formless draft row is not offered as work waiting for anybody',
     !q().includes('GHOST, ROW'), 'nothing in that row could ever be opened')
}

/* ---- 7 · the counters must not count drafts ------------------------ */
{
  const env = boot({ user: DOC, team: { kind: 'rows', rows: [TARA] } })
  await flush()
  const counters = env.calls.filter(c => c.endpoint.includes('select=created_at,'))
  const queue = env.calls.filter(c => c.endpoint.includes('select=record_key,created_by'))

  ok('T26', 'the counter read asks for FINISHED records only',
     counters.length === 1 && counters[0].endpoint.includes('is_draft=eq.false'),
     counters.map(c => c.endpoint).join(' ').slice(0, 90))
  ok('T27', 'the queue still asks for drafts - that is its whole job',
     queue.length === 1 && !queue[0].endpoint.includes('is_draft=eq.'),
     queue.map(c => c.endpoint).join(' ').slice(0, 90))
}

/* ---- 8 · the counters answer "how many were SAVED?" ----------------- */
{
  const nowIso = new Date().toISOString()
  const todayKey = new Date().toISOString().slice(0, 10)
  const lastMonth = new Date(); lastMonth.setMonth(lastMonth.getMonth() - 1)
  const monthKey = lastMonth.toISOString().slice(0, 10)
  const fortyDaysAgo = new Date(Date.now() - 40 * 86400000).toISOString()

  const env = boot({
    user: DOC, team: { kind: 'rows', rows: [TARA] },
    counters: [
      // Saved this morning, but the VISIT was last month: still counts today
      // (dashboard counts saves, so backfill shows up on its save day).
      { record_key: 'cf4|A', patient_name: 'BACKFILL, PATIENT', doctor_id: 'doc-jardin',
        clinic_id: 'c1', report_type: 'cf4', created_at: nowIso, updated_at: nowIso,
        created_by: 'sec-tara', procedure_date: monthKey, patient_id: 'bf-a', case_number: 'BF-A', file_name: 'bf-a.json' },
      // Saved 40 days ago: counts on its save day, not today.
      { record_key: 'cf4|B', patient_name: 'SEEN, TODAY', doctor_id: 'doc-jardin',
        clinic_id: 'c1', report_type: 'cf4', created_at: fortyDaysAgo, updated_at: fortyDaysAgo,
        created_by: 'doc-jardin', procedure_date: todayKey, patient_id: 'st-b', case_number: 'ST-B', file_name: 'st-b.json' },
      // Ordinary same-day record.
      { record_key: 'cf4|C', patient_name: 'ORDINARY, CASE', doctor_id: 'doc-jardin',
        clinic_id: 'c1', report_type: 'cf4', created_at: nowIso, updated_at: nowIso,
        created_by: 'doc-jardin', procedure_date: todayKey, patient_id: 'oc-c', case_number: 'OC-C', file_name: 'oc-c.json' },
    ],
  })
  await flush()
  const data = env.win.EntDashboard.getData()

  ok('T28', 'a record saved today counts today, whatever its visit date',
     data.today.patientCount === 2
     && Object.keys(data.today.seen || {}).some(k => k.indexOf('bf-a') !== -1),
     'today=' + data.today.patientCount + ' ' + Object.keys(data.today.seen || {}).join(' '))
  ok('T29', 'and it is still counted in the year total',
     data.year.patientCount === 3, 'year=' + data.year.patientCount)
  ok('T30', 'a record saved weeks ago counts on its save day, not today',
     data.today.patientCount === 2, 'today=' + data.today.patientCount)
  ok('T31', 'and this month holds the two saved this month (backfill + ordinary)',
     data.month.patientCount === 2, 'month=' + data.month.patientCount)

/* ---- 6 · admin: latest patients grouped by clinic ------------------ */
{
  const ADMIN_PREVIEW_KEY = 'entDashAdminPreview'
  const ADMIN = { id: 'doc-jardin', username: 'jess', full_name: 'Jesus Jardin', role: 'admin', is_active: true }
  const counters = [
    // clc-10 (Jesuit) — newest first: a nasal report saved today at RMCI by
    // the stamped author name (0028), plus an older CF4 with no hospital tag.
    { clinic_id: 'clc-10', created_by: 'jess', created_by_name: 'Jesus Jardin',
      site: 'RMCI', created_at: '2026-10-08T07:54:32.448Z',
      patient_name: 'Maria L.', report_type: 'nasal', procedure_date: '2026-10-08' },
    { clinic_id: 'clc-10', created_by: 'tara', created_by_name: 'Tara Bautista',
      created_at: '2026-10-06T12:00:00.000Z',
      patient_name: 'Joan D.', report_type: 'cf4' },
    // clc-20 (Bolmen) — newer laryngeal report at CUMC, saved by a doctor.
    { clinic_id: 'clc-20', created_by: 'armand', created_by_name: 'Armand Cruz',
      site: 'CUMC', created_at: '2026-10-09T06:00:00.000Z',
      patient_name: 'Ali B.', report_type: 'laryngeal', procedure_date: '2026-10-09' }
  ]
  // The two directories the admin branch reads: real clinic names and the
  // staff-profile table that resolves Doctor / Secretary.
  const clinicsDir = [
    { id: 'clc-10', name: 'Jesuit Clinic', code: 'JES', is_active: true },
    { id: 'clc-20', name: 'Bolmen Clinic', code: 'BOL', is_active: true },
  ]
  const staffDir = [
    { id: 'jess', role: 'doctor', username: 'jess', full_name: 'Jesus Jardin' },
    { id: 'tara', role: 'secretary', username: 'tara', full_name: 'Tara Bautista' },
    { id: 'armand', role: 'doctor', username: 'armand', full_name: 'Armand Cruz' },
  ]
  const env = boot({
    user: ADMIN, counters, onLine: true,
    directory: { clinics: clinicsDir, staff: staffDir },
  })
  // Open the admin preview gate now so guard() reveals the dashboard and
  // renderRecent() runs the per-clinic branch. `sessionStorage` is a sandbox
  // global owned by the dashboard sandbox (win.sessionStorage), not the test
  // script, so set it on the sandbox global.
  env.win.sessionStorage.setItem(ADMIN_PREVIEW_KEY, '1')
  await flush()
  env.win.EntDashboard.refresh({ push: true })
  await flush()
  // The directory reads are kicked off inside refresh() (not awaited), so one
  // more flush lets the redraw with real names land.
  await flush()
  const box = () => env.nodes.dashRecent.innerHTML

  // The admin branch is active: one entry per clinic, each with the clinic name,
  // patient count, creator name and last-save time — NOT the flat latest-records
  // list (which non-admins get).
  ok('T32', 'the card groups by clinic, no flat "latest records" list',
     box().includes('ent-clinic-head') && !box().includes('ent-recent-row'),
     box().slice(0, 200))

  ok('T33', 'each clinic shows its REAL name and patient count',
     box().includes('Jesuit Clinic') && box().includes('Bolmen Clinic')
       && box().includes('2 patient') && box().includes('1 patient'),
     box().slice(0, 400))

  ok('T34', 'each clinic shows the creator name WITH role',
     box().includes('Doctor') && box().includes('Secretary')
       && box().includes('saved by Jesus Jardin') && box().includes('saved by Tara Bautista')
       && box().includes('saved by Armand Cruz'),
     box().slice(0, 400))

  ok('T35', 'each clinic shows the newest patient name',
     box().includes('Maria L.') && box().includes('Ali B.'),
     box().slice(0, 400))

  /* The redesigned row stamps each ENTRY on the right - "Entered" label,
     the date ("Oct 9, 2026") and clock · age - replacing the old flat
     "Saved Oct 9" line. The promise T36 makes is unchanged: every clinic
     block still says WHEN its records were saved. */
  ok('T36', 'each clinic shows the last save time',
     box().includes('Oct 9, 2026') && box().includes('Oct 6, 2026')
       && (box().match(/ent-recent-entry-date/g) || []).length >= 3,
     box().slice(0, 400))

  ok('T37', 'the hospital tag (RMCI / CUMC) is on the rows that carry one',
     box().includes('>RMCI<') && box().includes('>CUMC<'),
     box().slice(0, 400))

  ok('T38', 'the branch read the clinic + staff directories exactly once each',
     env.calls.filter(c => c.endpoint.includes('clinics?select=')).length === 1
       && env.calls.filter(c => c.endpoint.includes('staff_profiles')).length === 1,
     env.calls.map(c => c.endpoint).join(' | ').slice(0, 200))
}

/* ---- 7 · admin: clinic-less rows still render, never vanish ---------- */
{
  const ADMIN_PREVIEW_KEY = 'entDashAdminPreview'
  const ADMIN = { id: 'doc-jardin', username: 'jess', full_name: 'Jesus Jardin', role: 'admin', is_active: true }
  const env = boot({
    user: ADMIN, onLine: true,
    counters: [
      { clinic_id: '', created_by: 'jess', created_by_name: 'Jesus Jardin',
        created_at: '2026-10-08T07:54:32.448Z',
        patient_name: 'No Clinic Patient', report_type: 'nasal' },
    ],
  })
  env.win.sessionStorage.setItem(ADMIN_PREVIEW_KEY, '1')
  await flush()
  env.win.EntDashboard.refresh({ push: true })
  await flush()
  await flush()
  const box = () => env.nodes.dashRecent.innerHTML
  ok('T39', 'a record with no clinic still shows under a plain "Clinic" head',
     box().includes('No Clinic Patient') && />Clinic</.test(box()),
     box().slice(0, 300))
}

}

console.log('')
console.log(`  ${passed} passed, ${failed} failed`)
console.log('')
process.exitCode = failed ? 1 : 0
