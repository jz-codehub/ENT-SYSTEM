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
function boot({
  user, team, onLine = true, queue = [], counters = [], directory = null,
  dashboardSummary, exportPages, assignedDoctors = [], clinicIdentityLookup
}) {
  const calls = []
  const nodes = {}
  const downloads = []
  const downloadBlobs = []
  const reportButtons = [
    { ...makeNode('abstract-action'), hidden: false, getAttribute: name => name === 'data-report-type' ? 'abstract' : null },
    { ...makeNode('certificate-action'), hidden: false, getAttribute: name => name === 'data-report-type' ? 'medicalCertificate' : null },
  ]
  const medicalDocumentFilters = [
    { ...makeNode('abstract-filter'), hidden: false },
    { ...makeNode('certificate-filter'), hidden: false },
  ]
  const profileSwitchButton = makeNode('profile-switch')
  const clinicPickerCalls = []
  const bodyClasses = new Set()
  for (const id of domIds()) nodes[id] = makeNode(id)
  nodes.dashPeriodSelect = makeNode('dashPeriodSelect')

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
      body: {
        classList: {
          add: name => bodyClasses.add(name),
          remove: name => bodyClasses.delete(name),
          contains: name => bodyClasses.has(name),
        },
        insertAdjacentHTML() {}, appendChild() {}
      },
      addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn) },
      getElementById: id => nodes[id] || null,
      querySelector: selector => selector === '#entUserChip .ent-user-switch'
        ? profileSwitchButton : null,
      querySelectorAll: selector => {
        if (selector === '[data-report-type="abstract"], [data-report-type="medicalCertificate"]') return reportButtons
        if (selector === '[data-medical-document-filter]') return medicalDocumentFilters
        return []
      },
      createElement: tag => {
        const element = makeNode('new-' + Math.random())
        if (String(tag).toLowerCase() === 'a') {
          element.click = () => downloads.push({ href: element.href, download: element.download })
        }
        return element
      },
    },
    addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn) },
    dispatchEvent: () => true,
    location: { pathname: '/index.html', search: '', href: '', replace() {}, assign() {} },
    navigator: nav,
    console, setInterval: () => 0, clearInterval: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    URL: Object.assign({}, URL, {
      createObjectURL: blob => {
        downloadBlobs.push(blob)
        return 'blob:monthly-export-test'
      },
      revokeObjectURL() {},
    }),
    URLSearchParams, Date, JSON, Math, Promise, Blob, TextEncoder,
    EntAuth: {
      guard: async () => ({ user, session: {}, expiresAt: 0 }),
      scope: () => ({
        role: user.role,
        doctorId: user.role === 'doctor' ? user.id : (user.assigned_doctor_id || ''),
        seeAll: false, label: user.full_name || user.username,
        assignedDoctorId: user.assigned_doctor_id || '',
        workingClinicId: user.workingClinicId || '',
        activeClinicId: user.activeClinicId || '',
      }),
      currentUser: () => user,
      fetchAssignedDoctors: async () => assignedDoctors,
      openClinicPicker: doctors => clinicPickerCalls.push(doctors),
      isDocJessClinic: (clinicId, clinicName, clinicCode) =>
        String(clinicId || '').trim() === '00000000-0000-4000-8000-00000000c11c'
        || ['main_clinic', 'jess', 'ent-jess'].includes(String(clinicCode || '').trim().toLowerCase())
        || ['doc jess', 'doc jess ent clinic', 'ent clinic doc jess', 'ent clinic doc jess jardin']
          .includes(String(clinicName || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()),
      getClinicIdentity: async clinicId => clinicIdentityLookup
        ? clinicIdentityLookup(clinicId)
        : { name: '', code: '' },
      getClinicName: async clinicId => clinicNameLookup ? clinicNameLookup(clinicId) : '',
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
        if (endpoint.includes('rpc/ent_dashboard_summary')) {
          if (dashboardSummary === undefined) {
            throw new Error('Supabase API error (404): PGRST202 ent_dashboard_summary does not exist')
          }
          const request = JSON.parse(opts.body || '{}')
          return typeof dashboardSummary === 'function'
            ? dashboardSummary(request)
            : dashboardSummary
        }
        if (endpoint.startsWith('reports?is_draft=eq.false&deleted_at=is.null')) {
          if (typeof exportPages === 'function') return exportPages(endpoint)
          return exportPages || []
        }
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
  return {
    win, nodes, calls, downloads, downloadBlobs, docListeners, winListeners, nav,
    bodyClasses, reportButtons, medicalDocumentFilters, clinicPickerCalls, profileSwitchButton,
  }
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
  const period = new Date()
  env.nodes.dashPeriodSelect.value = (period.getMonth() + 1) + '/' + period.getFullYear()
  const periodChange = env.nodes.dashPeriodSelect.listeners.change[0]
  if (periodChange) periodChange()
  await flush()
  ok('T27a', 'missing migration is reported instead of silently claiming exact counts',
     env.nodes.dashNotificationCenter.innerHTML.includes('Counts may be incomplete')
       && env.nodes.dashNotificationCenter.innerHTML.includes('Apply migration 0048')
       && env.nodes.dashNotificationCenter.innerHTML.includes('Activity chart may be incomplete')
       && env.nodes.dashNotificationCenter.innerHTML.includes('Activity Growth could not load exact counts')
       && !env.nodes.dashNotices.innerHTML.includes('Counts may be incomplete'))
}

/* ---- 8 · the counters answer "how many were SAVED?" ----------------- */
{
  const summaryCalls = []
  const env = boot({
    user: DOC, team: { kind: 'rows', rows: [TARA] },
    dashboardSummary: request => {
      summaryCalls.push(request)
      return request.p_windows.map(window => ({
        bucket_key: window.bucket_key, reports: 0, patient_count: 0, endo_count: 0,
        cf4_count: 0, nasal_reports: 0, laryngeal_reports: 0, cf4_reports: 0,
        other_reports: 0, mine: 0
      }))
    }
  })
  await flush()
  const windows = summaryCalls[0] && summaryCalls[0].p_windows || []
  const earliest = Math.min(...windows.map(window => Date.parse(window.starts_at)))
  const latest = Math.max(...windows.map(window => Date.parse(window.ends_at)))
  ok('T27b', 'dashboard summary ranges stay within the database 367-day limit',
     windows.length > 0 && latest - earliest <= 367 * 86400000,
     windows.length ? Math.round((latest - earliest) / 86400000) + ' days' : 'no summary windows')
  ok('T27c', 'summary windows never include future days',
     windows.length > 0 && latest <= Date.now() + 10000)
  ok('T27d', 'successful cloud summaries leave no incomplete-count warning',
     !env.nodes.dashNotificationCenter.innerHTML.includes('Counts may be incomplete')
       && !env.nodes.dashNotificationCenter.innerHTML.includes('Activity chart may be incomplete'))
}

{
  let summaryCalls = 0
  const env = boot({
    user: DOC, team: { kind: 'rows', rows: [TARA] },
    dashboardSummary: request => {
      summaryCalls++
      if (summaryCalls === 1) throw new Error('Dashboard summary time range exceeds 367 days.')
      return request.p_windows.map(window => ({
        bucket_key: window.bucket_key, reports: 0, patient_count: 0, endo_count: 0,
        cf4_count: 0, nasal_reports: 0, laryngeal_reports: 0, cf4_reports: 0,
        other_reports: 0, mine: 0
      }))
    }
  })
  await flush()
  const period = new Date()
  env.nodes.dashPeriodSelect.value = (period.getMonth() + 1) + '/' + period.getFullYear()
  const periodChange = env.nodes.dashPeriodSelect.listeners.change[0]
  if (periodChange) periodChange()
  await flush()
  ok('T27e', 'activity summary can recover after the main summary fails',
     summaryCalls > 1
       && env.nodes.dashNotificationCenter.innerHTML.includes('Counts may be incomplete')
       && !env.nodes.dashNotificationCenter.innerHTML.includes('Activity chart may be incomplete'))
}

/* ---- 9 · the counters answer "how many were SAVED?" ----------------- */
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

/* ---- 8 · exact aggregate totals do not depend on the 3,000-row window */
{
  const env = boot({
    user: DOC,
    team: { kind: 'rows', rows: [] },
    counters: [],
    dashboardSummary: request => request.p_windows.map(window => ({
      bucket_key: window.bucket_key,
      reports: window.bucket_key === 'month' ? 5001 : 0,
      patient_count: window.bucket_key === 'today' ? 4000 : 0,
      endo_count: window.bucket_key === 'today' ? 3000 : 0,
      cf4_count: window.bucket_key === 'today' ? 1000 : 0,
      nasal_reports: window.bucket_key === 'month' ? 1000 : 0,
      laryngeal_reports: window.bucket_key === 'month' ? 2000 : 0,
      cf4_reports: window.bucket_key === 'month' ? 2001 : 0,
      other_reports: 0,
      mine: 0,
    })),
  })
  await flush()
  const summaryCall = env.calls.find(call => call.endpoint.includes('rpc/ent_dashboard_summary'))
  const request = summaryCall && JSON.parse(summaryCall.body)
  const data = env.win.EntDashboard.getData()

  ok('T40', 'dashboard patient tiles use the exact server aggregate, not fetched rows',
     data.today.patientCount === 4000 && data.today.endoCount === 3000
       && data.today.cf4Count === 1000,
     'today=' + data.today.patientCount)
  ok('T41', 'monthly report totals use the full database aggregate',
     data.month.reports === 5001 && data.month.types.nasal === 1000
       && data.month.types.laryngeal === 2000 && data.month.types.cf4 === 2001,
     'month=' + data.month.reports)
  ok('T42', 'the aggregate request is scoped to the signed-in doctor and is bounded',
     !!summaryCall && summaryCall.method === 'POST'
       && request.p_doctor_id === DOC.id && request.p_scope_all === false
       && request.p_windows.length <= 64,
     summaryCall ? summaryCall.endpoint : 'no RPC request')
}

/* ---- 9 · monthly dated records download for doctors and secretaries */
{
  const records = Array.from({ length: 251 }, (_, index) => ({
    id: 'report-' + (index + 1),
    patient_name: index ? 'Sample Patient ' + (index + 1) : 'Sample Patient',
    report_type: index ? 'nasal' : 'cf4',
    is_draft: false, deleted_at: null, created_at: '2026-10-01T10:00:00Z',
    payload: { formData: index ? {} : { diagnosis: 'Test fixture only' } },
  }))
  const env = boot({
    user: DOC,
    team: { kind: 'rows', rows: [] },
    counters: [],
    dashboardSummary: request => request.p_windows.map(window => ({
      bucket_key: window.bucket_key, reports: 0, patient_count: 0, endo_count: 0,
      cf4_count: 0, nasal_reports: 0, laryngeal_reports: 0, cf4_reports: 0,
      other_reports: 0, mine: 0,
    })),
    exportPages: endpoint => {
      const offset = Number((endpoint.match(/&offset=(\d+)$/) || [])[1] || 0)
      return records.slice(offset, offset + 250)
    },
  })
  await flush()
  const notice = () => env.nodes.dashNotificationCenter.innerHTML
  ok('T42a', 'successful exact summaries do not leave stale count or activity warnings',
     !notice().includes('Counts may be incomplete')
       && !notice().includes('Activity chart may be incomplete')
       && notice().includes('data-notification-toggle')
       && !env.nodes.dashNotices.innerHTML.includes('Counts may be incomplete'))
  const bellHandler = env.nodes.dashNotificationCenter.listeners.click[0]
  if (bellHandler) bellHandler({ target: { dataset: { notificationToggle: '' } } })
  ok('T42b', 'the notification bell opens an accessible panel with its active count',
     notice().includes('aria-expanded="true"')
       && notice().includes('aria-controls="dashNotificationPanel"')
       && notice().includes('dashNotificationPanel')
       && notice().includes('ent-notification-count'))

  ok('T43', 'monthly reminder tells the user the JSON is sensitive and not a full backup',
     notice().includes('Monthly records download')
       && notice().includes('It is not a full system backup')
       && notice().includes('sensitive patient data'))

  const handler = env.nodes.dashNotificationCenter.listeners.click[0]
  const downloadButton = {
    dataset: { monthlyExportAction: 'download' },
    disabled: false,
    textContent: 'Download monthly records',
  }
  if (handler) await handler({ target: downloadButton })
  await flush()
  const reportQuery = env.calls.find(call =>
    call.endpoint.startsWith('reports?is_draft=eq.false&deleted_at=is.null'))
  const savedState = JSON.parse(env.win.localStorage.getItem('entMonthlyRecordsExportV1:' + DOC.id))
  const file = env.downloads[0]
  const content = env.downloadBlobs[0] ? await env.downloadBlobs[0].text() : ''

  ok('T44', 'export queries saved, live records with a stable page order under RLS',
     !!reportQuery && reportQuery.method === 'GET'
       && reportQuery.endpoint.includes('select=*')
       && reportQuery.endpoint.includes('order=created_at.asc,id.asc')
       && reportQuery.endpoint.includes('limit=250&offset=0')
       && !reportQuery.endpoint.includes('doctor_id=eq'))
  ok('T44a', 'the export paginates through more than one batch without truncating records',
     env.calls.some(call => call.endpoint.includes('limit=250&offset=250'))
       && env.calls.filter(call => call.endpoint.startsWith('reports?is_draft=eq.false&deleted_at=is.null')).length === 2)
  ok('T45', 'download filename includes the requested YYYY-MM-DD date',
     !!file && /^ent-records-\d{4}-\d{2}-\d{2}\.json$/.test(file.download),
     file && file.download)
  ok('T46', 'export contains the full report payload and monthly status is saved per user',
     content.includes('"diagnosis":"Test fixture only"')
       && content.includes('"id":"report-251"')
       && savedState.completedMonth === new Date().getFullYear() + '-'
         + String(new Date().getMonth() + 1).padStart(2, '0')
       && !notice().includes('Monthly records download'))
}

{
  const SEC = {
    id: 'sec-tara', username: 'tara', full_name: 'Tara Bautista', role: 'secretary',
    assigned_doctor_id: 'doc-jardin', assigned_doctor_name: 'Jesus Jardin', is_active: true
  }
  const env = boot({ user: SEC, team: { kind: 'rows', rows: [] }, counters: [] })
  await flush()
  ok('T47', 'secretaries also receive the monthly reminder and can snooze it',
     env.nodes.dashNotificationCenter.innerHTML.includes('Monthly records download')
       && !env.nodes.dashNotices.innerHTML.includes('Monthly records download'))
  const handler = env.nodes.dashNotificationCenter.listeners.click[0]
  if (handler) handler({ target: { dataset: { monthlyExportAction: 'later' } } })
  const saved = JSON.parse(env.win.localStorage.getItem('entMonthlyRecordsExportV1:' + SEC.id))
  ok('T48', 'snooze hides the reminder for seven days on this account and device',
     saved.snoozedUntil > Date.now()
       && !env.nodes.dashNotificationCenter.innerHTML.includes('Monthly records download'))
}

/* ---- 10 · a multi-doctor secretary can review every assigned shelf ---- */
{
  const SEC = {
    id: 'sec-christie', username: 'christie', full_name: 'Christie Lilli L. Bajarla',
    role: 'secretary', assigned_doctor_id: 'doc-jardin',
    assigned_doctor_name: 'Jesus Jardin', is_active: true
  }
  const assignedDoctors = [
    { doctor_id: 'doc-jardin', doctor_name: 'Jesus Jardin', is_primary: true },
    { doctor_id: 'doc-other', doctor_name: 'Other Doctor', is_primary: false },
  ]
  const counters = [
    { doctor_id: 'doc-jardin', created_at: new Date().toISOString(), report_type: 'nasal', patient_name: 'Patient One' },
    { doctor_id: 'doc-other', created_at: new Date().toISOString(), report_type: 'cf4', patient_name: 'Patient Two' },
    { doctor_id: 'doc-unassigned', created_at: new Date().toISOString(), report_type: 'laryngeal', patient_name: 'Outside Patient' },
  ]
  const env = boot({
    user: SEC, assignedDoctors, counters, team: { kind: 'rows', rows: [] },
    dashboardSummary: request => request.p_windows.map(window => ({
      bucket_key: window.bucket_key, reports: request.p_scope_all ? 2 : 1,
      patient_count: request.p_scope_all ? 2 : 1, endo_count: request.p_scope_all ? 1 : 1,
      cf4_count: request.p_scope_all ? 1 : 0, nasal_reports: 1, laryngeal_reports: 0,
      cf4_reports: request.p_scope_all ? 1 : 0, other_reports: 0, mine: 0,
    })),
  })
  await flush()
  const toggle = env.nodes.dashDoctorScopeToggle
  ok('T49', 'multi-doctor secretaries get an explicit all-assigned-doctors view',
     !toggle.hidden && /Show all 2 assigned doctors/.test(toggle.textContent))
  const indexHtml = readFileSync(join(APP, 'index.html'), 'utf8')
  ok('T49a', 'all secretaries use the same dashboard without a separate network workspace',
     !indexHtml.includes('ent-ss-workspace')
       && !env.bodyClasses.has('ent-super-secretary'))
  ok('T50', 'the default view stays on the currently selected doctor',
     env.win.EntDashboard.getRows().length === 1
       && env.win.EntDashboard.getRows()[0].doctor_id === 'doc-jardin')
  if (toggle.listeners.click && toggle.listeners.click[0]) {
    toggle.listeners.click[0]({})
    await flush()
  }
  const summaryCalls = env.calls.filter(call => call.endpoint.includes('rpc/ent_dashboard_summary'))
  const allRequest = summaryCalls.length
    ? JSON.parse(summaryCalls[summaryCalls.length - 1].body)
    : null
  ok('T51', 'all-assigned mode includes every linked doctor, but excludes an unrelated doctor',
     env.win.EntDashboard.getRows().length === 2
       && env.win.EntDashboard.getRows().every(row =>
         ['doc-jardin', 'doc-other'].includes(row.doctor_id)))
  ok('T52', 'all-assigned totals still use the server aggregate under RLS',
     !!allRequest && allRequest.p_scope_all === true && allRequest.p_doctor_id === null
       && env.nodes.dashRoleLine.textContent.includes('2 assigned doctors'))
}

/* ---- 11 · Super Secretaries see only the selected clinic ------------- */
{
  const SUPER = {
    id: 'sec-super', username: 'supersec', full_name: 'Super Secretary',
    role: 'secretary', is_super_secretary: true, assigned_doctor_id: 'doc-jardin',
    assigned_doctor_name: 'Jesus Jardin', is_active: true
  }
  const env = boot({
    user: SUPER,
    assignedDoctors: [
      { doctor_id: 'doc-jardin', doctor_name: 'Jesus Jardin', clinic_id: 'clinic-north',
        clinic_name: 'ENT North', is_primary: true },
      { doctor_id: 'doc-other', doctor_name: 'Other Doctor', clinic_id: 'clinic-north',
        clinic_name: 'ENT North', is_primary: false },
      { doctor_id: 'doc-south', doctor_name: 'South Doctor', clinic_id: 'clinic-south',
        clinic_name: 'ENT South', is_primary: false },
    ],
    counters: [
      { doctor_id: 'doc-jardin', created_at: new Date().toISOString(), report_type: 'nasal' },
      { doctor_id: 'doc-other', created_at: new Date().toISOString(), report_type: 'cf4' },
      { doctor_id: 'doc-south', created_at: new Date().toISOString(), report_type: 'cf4' },
      { doctor_id: 'doc-outside', created_at: new Date().toISOString(), report_type: 'laryngeal' },
    ],
    team: { kind: 'rows', rows: [] },
    dashboardSummary: request => request.p_windows.map(window => ({
      bucket_key: window.bucket_key, reports: request.p_scope_all ? 2 : 1,
      patient_count: request.p_scope_all ? 2 : 1, endo_count: 1,
      cf4_count: request.p_scope_all ? 1 : 0, nasal_reports: 1, laryngeal_reports: 0,
      cf4_reports: request.p_scope_all ? 1 : 0,
      other_reports: 0, mine: 0,
    })),
  })
  await flush()
  const indexHtml = readFileSync(join(APP, 'index.html'), 'utf8')
  const summaryCall = env.calls.find(call => call.endpoint.includes('rpc/ent_dashboard_summary'))
  const summaryRequest = summaryCall && JSON.parse(summaryCall.body)
  ok('T53', 'Super Secretary dashboard includes every doctor in the selected clinic only',
     env.win.EntDashboard.getRows().length === 2
       && env.win.EntDashboard.getRows().every(row =>
         ['doc-jardin', 'doc-other'].includes(row.doctor_id))
       && env.nodes.dashDoctorScopeToggle.hidden
       && env.nodes.dashScopePill.textContent === 'Super Secretary'
       && env.nodes.dashScopePill.className.includes('is-super-secretary')
       && env.nodes.dashClinicContext.hidden === false
       && env.nodes.dashClinicName.textContent === 'ENT North'
       && env.nodes.dashClinicSwitchBtn.hidden === false
       && env.profileSwitchButton.hidden === true
       && env.nodes.dashRoleLine.textContent.includes('2 doctors'))
  const superToggle = env.nodes.dashDoctorScopeToggle.listeners.click
  if (superToggle && superToggle[0]) {
    superToggle[0]({})
    await flush()
  }
  const afterToggleCall = env.calls.filter(call => call.endpoint.includes('rpc/ent_dashboard_summary')).pop()
  const afterToggleRequest = afterToggleCall && JSON.parse(afterToggleCall.body)
  ok('T53a', 'the clinic-scope toggle stays hidden and cannot expose another clinic',
     env.win.EntDashboard.getRows().length === 2
       && !!afterToggleRequest && afterToggleRequest.p_scope_all === true
       && afterToggleRequest.p_doctor_id === null)
  ok('T54', 'Super Secretary summary requests all rows, with database RLS enforcing the active clinic',
     !!summaryRequest && summaryRequest.p_scope_all === true
       && summaryRequest.p_doctor_id === null)
  ok('T55', 'Super Secretaries use the normal dashboard with a visible active-clinic switcher',
     !indexHtml.includes('ent-ss-workspace')
       && !env.bodyClasses.has('ent-super-secretary')
       && /ENT North.*New reports are filed/.test(env.nodes.dashRoleLine.textContent)
       && indexHtml.includes('id="dashQuickActions"')
       && /id="dashClinicSwitchBtn"[\s\S]*?<span>Switch clinic<\/span>/.test(indexHtml))
  const switchListeners = env.nodes.dashClinicSwitchBtn.listeners.click || []
  if (switchListeners[0]) {
    switchListeners[0]({})
    await flush()
  }
  ok('T55b', 'the visible clinic switcher opens the server-backed clinic picker',
     env.clinicPickerCalls.length === 1
       && env.clinicPickerCalls[0].length === 3)
  const dashboardCss = readFileSync(join(APP, 'style', 'dashboard.css'), 'utf8')
  const authCss = readFileSync(join(APP, 'style', 'auth.css'), 'utf8')
  ok('T55a', 'the dashboard no longer adds a separate Super Secretary layout',
     !dashboardCss.includes('ent-super-secretary')
       && !dashboardCss.includes('ent-ss-workspace'))
  ok('T55c', 'the hidden header switcher stays hidden beside the dashboard clinic switcher',
     /#entUserChip \.ent-user-switch\[hidden\]\s*\{\s*display:\s*none\s*!important;/.test(authCss))
  const serviceWorker = readFileSync(join(APP, 'sw.js'), 'utf8')
  ok('T56', 'the selected-clinic dashboard ships with fresh script, style and service-worker versions',
     /dashboard\.js\?v=v42-doc-jess-clinic-code/.test(indexHtml)
       && /dashboard\.css\?v=v38-super-secretary-polish/.test(indexHtml)
       && /auth\.js\?v=v36m-doc-jess-clinic-code/.test(indexHtml)
       && /auth\.css\?v=v33an-clinic-picker/.test(indexHtml)
       && /ent-report-system-v173-messenger-polish/.test(serviceWorker))
}

/* ---- 12 · medical documents are Doc Jess clinic-only ----------------- */
{
  const SUPER_WITH_JESS_NETWORK = {
    id: 'sec-super', username: 'jess', full_name: 'Jesus Jardin',
    role: 'secretary', is_super_secretary: true, assigned_doctor_id: 'doc-other',
    is_active: true,
  }
  const env = boot({
    user: SUPER_WITH_JESS_NETWORK,
    assignedDoctors: [
      { doctor_id: 'doc-other', doctor_name: 'Other Doctor', clinic_id: 'clinic-south',
        clinic_name: 'ENT South', is_primary: true },
      { doctor_id: 'doc-jess', doctor_name: 'Jesus Jardin', clinic_id: '00000000-0000-4000-8000-00000000c11c',
        clinic_name: 'Doc Jess', is_primary: false },
    ],
    team: { kind: 'rows', rows: [] },
    dashboardSummary: request => request.p_windows.map(window => ({
      bucket_key: window.bucket_key, reports: 1, patient_count: 1, endo_count: 1,
      cf4_count: 0, nasal_reports: 1, laryngeal_reports: 0, cf4_reports: 0,
      other_reports: 0, mine: 0,
    })),
  })
  await flush()
  ok('T57', 'Jess names and access to a Jess doctor elsewhere do not unlock documents for another active clinic',
     env.reportButtons.every(button => button.hidden === true)
       && env.medicalDocumentFilters.every(option => option.hidden === true)
       && !env.nodes.dashMix.innerHTML.includes('Clinical Abstract')
       && !env.nodes.dashMix.innerHTML.includes('Medical Certificate'))

  const JESS_ACTIVE = {
    id: 'sec-jess', username: 'secretary', full_name: 'Clinic Secretary',
    role: 'secretary', is_super_secretary: true, assigned_doctor_id: 'doc-jess',
    is_active: true,
  }
  const jessEnv = boot({
    user: JESS_ACTIVE,
    assignedDoctors: [
      { doctor_id: 'doc-jess', doctor_name: 'Jesus Jardin', clinic_id: '00000000-0000-4000-8000-00000000c11c',
        clinic_name: 'Doc Jess', is_primary: true },
    ],
    team: { kind: 'rows', rows: [] },
    dashboardSummary: request => request.p_windows.map(window => ({
      bucket_key: window.bucket_key, reports: 0, patient_count: 0, endo_count: 0,
      cf4_count: 0, nasal_reports: 0, laryngeal_reports: 0, cf4_reports: 0,
      other_reports: 0, mine: 0,
    })),
  })
  await flush()
  ok('T58', 'the same document actions are available while the active clinic is Doc Jess',
     jessEnv.reportButtons.every(button => button.hidden === false)
       && jessEnv.medicalDocumentFilters.every(option => option.hidden === false)
       && jessEnv.nodes.dashClinicSwitchBtn.hidden === true)

  const JESS_CONTEXT_WITH_TEMPORARY_LOOKUP_FAILURE = {
    id: 'sec-jess-context', username: 'secretary', full_name: 'Clinic Secretary',
    role: 'secretary', is_super_secretary: true, assigned_doctor_id: 'doc-jess',
    workingClinicId: '00000000-0000-4000-8000-00000000c11c',
    is_active: true,
  }
  const jessContextEnv = boot({
    user: JESS_CONTEXT_WITH_TEMPORARY_LOOKUP_FAILURE,
    assignedDoctors: [],
    team: { kind: 'rows', rows: [] },
    dashboardSummary: request => request.p_windows.map(window => ({
      bucket_key: window.bucket_key, reports: 0, patient_count: 0, endo_count: 0,
      cf4_count: 0, nasal_reports: 0, laryngeal_reports: 0, cf4_reports: 0,
      other_reports: 0, mine: 0,
    })),
  })
  await flush()
  ok('T59', 'Doc Jess documents remain visible from the validated active-clinic context during a doctor-list lookup failure',
     jessContextEnv.reportButtons.every(button => button.hidden === false)
       && jessContextEnv.medicalDocumentFilters.every(option => option.hidden === false))

  const JESS_LEGACY_CLINIC_ID = {
    id: 'sec-jess-legacy', username: 'secretary', full_name: 'Clinic Secretary',
    role: 'secretary', is_super_secretary: true, assigned_doctor_id: 'doc-jess-legacy',
    is_active: true,
  }
  const jessLegacyEnv = boot({
    user: JESS_LEGACY_CLINIC_ID,
    assignedDoctors: [
      { doctor_id: 'doc-jess-legacy', doctor_name: 'Doc Jess Jardin',
        clinic_id: 'legacy-main-clinic-id', clinic_name: 'Doc Jess ENT Clinic', is_primary: true },
    ],
    team: { kind: 'rows', rows: [] },
    dashboardSummary: request => request.p_windows.map(window => ({
      bucket_key: window.bucket_key, reports: 0, patient_count: 0, endo_count: 0,
      cf4_count: 0, nasal_reports: 0, laryngeal_reports: 0, cf4_reports: 0,
      other_reports: 0, mine: 0,
    })),
  })
  await flush()
  ok('T60', 'Doc Jess actions recognize the clinic display name used by the live clinic picker',
     jessLegacyEnv.reportButtons.every(button => button.hidden === false)
       && jessLegacyEnv.medicalDocumentFilters.every(option => option.hidden === false))

  const jessDoctorEnv = boot({
    user: {
      id: 'doc-jess-legacy', username: 'jess', full_name: 'Doc Jess',
      role: 'doctor', clinic_id: 'legacy-main-clinic-id', is_active: true,
    },
    team: { kind: 'rows', rows: [] },
    clinicIdentityLookup: async clinicId => clinicId === 'legacy-main-clinic-id'
      ? { name: 'ENT-clinic doc. Jess Jardin', code: 'ent-jess' }
      : { name: '', code: '' },
    dashboardSummary: request => request.p_windows.map(window => ({
      bucket_key: window.bucket_key, reports: 0, patient_count: 0, endo_count: 0,
      cf4_count: 0, nasal_reports: 0, laryngeal_reports: 0, cf4_reports: 0,
      other_reports: 0, mine: 0,
    })),
  })
  await flush()
  ok('T61', 'a Doc Jess doctor resolves its authenticated clinic code before showing document actions',
     jessDoctorEnv.reportButtons.every(button => button.hidden === false)
       && jessDoctorEnv.medicalDocumentFilters.every(option => option.hidden === false))

  const jessSecretaryByCodeEnv = boot({
    user: {
      id: 'sec-jess-code', username: 'secretary', full_name: 'Clinic Secretary',
      role: 'secretary', is_super_secretary: true, assigned_doctor_id: 'doc-jess-code',
      is_active: true,
    },
    assignedDoctors: [
      { doctor_id: 'doc-jess-code', doctor_name: 'Doc Jess Jardin',
        clinic_id: 'legacy-jess-code-id', clinic_name: 'Jess Clinic', is_primary: true },
    ],
    team: { kind: 'rows', rows: [] },
    clinicIdentityLookup: async clinicId => clinicId === 'legacy-jess-code-id'
      ? { name: 'ENT-clinic doc. Jess Jardin', code: 'ent-jess' }
      : { name: '', code: '' },
    dashboardSummary: request => request.p_windows.map(window => ({
      bucket_key: window.bucket_key, reports: 0, patient_count: 0, endo_count: 0,
      cf4_count: 0, nasal_reports: 0, laryngeal_reports: 0, cf4_reports: 0,
      other_reports: 0, mine: 0,
    })),
  })
  await flush()
  ok('T62', 'a Super Secretary resolves the active clinic code when the picker name is stale',
     jessSecretaryByCodeEnv.reportButtons.every(button => button.hidden === false)
       && jessSecretaryByCodeEnv.medicalDocumentFilters.every(option => option.hidden === false))
}

}

console.log('')
console.log(`  ${passed} passed, ${failed} failed`)
console.log('')
process.exitCode = failed ? 1 : 0
