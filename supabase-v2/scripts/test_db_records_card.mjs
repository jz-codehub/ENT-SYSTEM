// =====================================================================
//  test_db_records_card.mjs
//  DB Records: does a card name its saver, and count a patient's visits?
//  ---------------------------------------------------------------------
//  The bugs this locks down (both reported from the live clinic):
//
//    1. "Saved by 94978594-afad-4c81-9e4e-8bc8b13966e3" - a raw UUID,
//       with the avatar circle holding "9", the uuid's first CHARACTER.
//       reports.created_by is server-stamped (0004); the browser cannot
//       resolve a uuid (RLS returns only its own profile row; the user
//       cache is a retired no-op). reports.created_by_name (0028) stamps
//       the display name beside the id, and savedByLabel() must prefer
//       it, answer "You" by id, prettify a legacy v1 username, and
//       NEVER print a bare uuid.
//    2. No way to see that a patient keeps coming back. The card now
//       carries a returning-patient chip ("9 records - 4 visits") from
//       loadPatientStats(), counted across ALL report types.
//
//  Also locked: the three-tier select (a database without 0028 keeps
//  today's behaviour instead of losing the draft filter), a failing
//  stats query never breaking the list, search matching the saver's
//  name, the list PAGING past the first page until the server runs dry
//  (no fixed newest-200 window), a duplicate record_key row
//  collapsing to ONE card - the freshest copy, and the SERVER-side
//  draft filter admitting exactly what isDatabaseRecord() accepts
//  (false, NULL, or payload-saved): v33af's literal is_draft=eq.false
//  hid every legacy NULL-flag row and every row whose column still
//  said TRUE while payload.dbSaved said saved - the report of a
//  secretary seeing only ONE CF4 record.
//
//  No network. Supabase is stubbed at the apiRequest boundary, exactly
//  the way test_view_all_ui.mjs and test_dashboard_team.mjs do it.
//
//  Run: node supabase-v2/scripts/test_db_records_card.mjs
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
   A tiny DOM. dbRecords builds its modal and its cards with
   createElement + innerHTML and then reaches back with querySelector
   ('.ent-db-list', '.ent-db-open', ...). There is no HTML parser here;
   querySelector hands out one SYNTHETIC node per selector (cached per
   parent), which is exactly enough for the module's fixed templates.
   Setting innerHTML clears children, mirroring the real DOM for the one
   pattern renderList uses: innerHTML = '' then appendChild every card.
   The FIRST node seen for a selector is also exported, so the test can
   reach the list, the status line and the search box.
   -------------------------------------------------------------------- */
const firstBySel = {}

function makeEl(tag) {
  const qcache = {}
  const listeners = {}
  const children = []
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    id: '', className: '', textContent: '', value: '', hidden: false,
    checked: false, style: {}, dataset: {}, children,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    _html: '',
    get innerHTML() { return this._html },
    set innerHTML(v) { this._html = String(v); children.length = 0 },
    _listeners: listeners,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn) },
    removeEventListener() {},
    setAttribute(k, v) { if (k === 'id') this.id = String(v) },
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
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  }
  return el
}

/* --------------------------------------------------------------------
   One fresh "browser" per scenario.
   mode: 'normal'     - a post-0028 database answers everything
        'failName'    - created_by_name column missing (pre-0028):
                        list tier 1 400s, tier 2 carries the page
        'failStats'   - the visit-count read is down; cards must live
        'failMove'    - the database refuses the hospital PATCH; the
                        Set/Move flow must alert and change nothing
        'failAll'     - nothing reaches the database
        'paged'       - the list endpoint honours limit/offset, and a
                        page BOUNDARY row repeats on the next page (the
                        row-shift that a save mid-paging causes)
   -------------------------------------------------------------------- */
function boot({ mode = 'normal', user, listRows, statsRows, rpcAvailable = false }) {
  // Each scenario builds a NEW modal; the exported selector nodes must
  // belong to THIS browser, not to the previous one's.
  for (const k of Object.keys(firstBySel)) delete firstBySel[k]
  const calls = []
  const rpcCalls = []
  const patches = []        // bodies the Set/Move button PATCHed, for assertions
  const alerts = []
  const docListeners = {}

  const store = new Map()
  const storage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  }

  const dialogs = []
  const docBody = {
    appendChild(el) { el.parentNode = docBody; dialogs.push(el); return el },
    removeChild(el) {
      const i = dialogs.indexOf(el)
      if (i >= 0) dialogs.splice(i, 1)
      el.parentNode = null
      return el
    },
    classList: { contains: () => false },
    insertAdjacentHTML() {},
  }

  const document = {
    readyState: 'complete', title: 'test',
    // Dialogs appended to the body (the hospital prompt, confirm boxes...)
    // are recorded here, the way test_db_records_site's body does it, so a
    // test can SEE the prompt and click its buttons.
    body: docBody,
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn) },
    removeEventListener: (t, fn) => {
      const list = docListeners[t] || []
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    },
    getElementById: () => null,
    createElement: tag => makeEl(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
  }

  const win = {
    document,
    location: { search: '', pathname: '/cf4Form.html', href: '' },
    history: { replaceState() {} },
    localStorage: storage, sessionStorage: storage,
    navigator: { onLine: true, userAgent: 'node-test' },
    console: { warn() {}, error() {}, log() {} },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    URLSearchParams, URL,
    alert: m => alerts.push(String(m)),
    EntFormBridge: {
      reportType: 'cf4',
      getData: () => ({ patientName: 'x' }),
      restore: () => {},
      alert: (m, t) => alerts.push(String(t || '') + ': ' + String(m)),
    },
    EntAuth: {
      currentUser: () => user,
      readUserCache: () => [],          // the retired no-op, as in auth.js
      logActivity: async () => true,
      escapeHtml: v => String(v ?? '').replace(/[&<>'"]/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])),
    },
    EntSupabase: {
      isConfigured: () => true,
      apiRequest: async (endpoint, opts = {}) => {
        calls.push((opts.method ? opts.method + ' ' : '') + endpoint)
        if (mode === 'failAll') throw new Error('Supabase API error (000): unreachable')
        if (opts.method === 'PATCH') {
          // The Set/Move hospital button's write. 'failMove' refuses it,
          // so the failure alert path is locked down too.
          if (mode === 'failMove') throw new Error('permission denied for table reports')
          try { patches.push(JSON.parse(opts.body)) } catch (e) { patches.push(null) }
          return [{}]
        }
        if (endpoint.includes('record_key=eq.')) {        // startSiteMove's row read
          const m = /record_key=eq\.([^&]+)/.exec(endpoint)
          const key = m ? decodeURIComponent(m[1]) : ''
          return [{ id: 'row-' + key,
                    payload: { dbSaved: true, formData: { keep: 1 }, images: [] } }]
        }
        const isList = endpoint.includes('report_type=eq.')
        const wantsName = endpoint.includes('created_by_name')
        // Honour the admission filter EXACTLY like PostgREST, in both
        // spellings the code has used:
        //   · v33ah three-clause or= form - false OR IS NULL OR saved
        //     (the NULL and the TRUE-column-but-saved rows were the
        //     secretary's missing CF4 records under the old literal)
        //   · v33af literal is_draft=eq.false - STRICT: drops NULL rows,
        //     so reverting the query string re-fails C81 for real
        // Queries with NEITHER (the plain pre-0017 tier) pass through
        // unfiltered, as in production.
        const hasOrNull = endpoint.includes('or=(is_draft')
        const hasOldLiteral = endpoint.includes('is_draft=eq.false')
        const admitted = r => {
          if (hasOrNull) {
            return r.is_draft === false
              || r.is_draft == null
              || String(r.dbSaved ?? r['payload->>dbSaved'] ?? '') === 'true'
          }
          if (hasOldLiteral) return r.is_draft === false
          return true
        }
        if (endpoint === 'rpc/ent_db_record_page') {
          if (!rpcAvailable) throw new Error('PGRST202 Could not find function public.ent_db_record_page')
          const args = JSON.parse(opts.body || '{}')
          rpcCalls.push(args)
          let rows = listRows.filter(admitted)
          if (args.p_report_type) rows = rows.filter(row => row.report_type === args.p_report_type)
          if (args.p_site) rows = rows.filter(row => String(row.site || '').toUpperCase() === args.p_site)
          if (args.p_search) {
            const needle = args.p_search.toLowerCase()
            rows = rows.filter(row => [row.patient_name, row.patient_id, row.case_number,
              row.record_key, row.created_by, row.created_by_name]
              .some(value => String(value || '').toLowerCase().includes(needle)))
          }
          rows = rows.slice().sort(args.p_sort === 'name'
            ? (a, b) => String(a.patient_name || '').localeCompare(String(b.patient_name || ''))
              || String(b.updated_at || '').localeCompare(String(a.updated_at || ''))
            : (a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
          const offset = Number(args.p_offset || 0)
          const limit = Number(args.p_limit || 100)
          return rows.slice(offset, offset + limit)
        }
        if (endpoint === 'rpc/ent_patient_record_stats') {
          if (!rpcAvailable) throw new Error('PGRST202 Could not find function public.ent_patient_record_stats')
          const keys = new Set(JSON.parse(opts.body || '{}').p_patient_keys || [])
          const groups = new Map()
          statsRows.filter(admitted).forEach(row => {
            const pid = String(row.patient_id || '').replace(/\s+/g, ' ').trim().toLowerCase()
            const name = String(row.patient_name || '').replace(/\s+/g, ' ').trim().toLowerCase()
            const key = pid ? `id:${pid}` : (name ? `name:${name}` : '')
            if (!keys.has(key)) return
            const day = String(row.procedure_date || String(row.created_at || '').slice(0, 10)).slice(0, 10)
            const group = groups.get(key) || { records: 0, days: new Set() }
            group.records++
            if (day) group.days.add(day)
            groups.set(key, group)
          })
          return [...groups].map(([stats_key, group]) => ({
            stats_key, records: group.records, visits: Math.max(1, group.days.size)
          }))
        }
        if (isList) {
          if (mode === 'failName' && wantsName) {
            throw new Error('column reports.created_by_name does not exist')
          }
          const rows = listRows.filter(admitted)
          if (mode === 'paged') {
            // Honour the real paging contract so fetchAllPages is exercised:
            // slice by offset/limit, and when a page comes back FULL, repeat
            // the previous page's last row on it - the row-shift a save
            // mid-paging causes, which cross-page dedupe must absorb.
            const off = Number((/[?&]offset=(\d+)/.exec(endpoint) || [0, 0])[1])
            const lim = Number((/[?&]limit=(\d+)/.exec(endpoint) || [0, 500])[1])
            const page = rows.slice(off, off + lim)
            if (off > 0 && page.length === lim) page.push(rows[off - 1])
            return page
          }
          return rows
        }
        // The visit-count read: reports?select=patient_name,... - routed by
        // its SELECT, never by the draft filter, because that filter is an
        // or=(...) expression now (v33ah) and routing on the old literal
        // is_draft=eq.false would silently stop matching.
        if (endpoint.includes('reports?select=patient_name')) {
          if (mode === 'failStats') throw new Error('stats endpoint down')
          return statsRows.filter(admitted)
        }
        return []
      },
    },
  }
  win.window = win
  win.globalThis = win

  const src = readFileSync(join(APP, 'function', 'dbRecords.js'), 'utf8')
  vm.createContext(win)
  vm.runInContext(src, win, { filename: 'dbRecords.js' })
  return { win, calls, rpcCalls, patches, alerts, docListeners, dialogs }
}

/* --------------------------------------------------------------------
   Fixtures. The uuid in row 1 is the exact one from the clinic report.
   -------------------------------------------------------------------- */
const UUID_TARA = '94978594-afad-4c81-9e4e-8bc8b13966e3'
const UUID_ORPHAN = '11111111-2222-3333-4444-555555555555'
const USER = { id: 'doc-jardin', username: 'jess', full_name: 'Jesus Jardin', role: 'doctor' }
// A DIFFERENT clinic's doctor. "jardin" alone must never trip Dr. Jesus
// Jardin's feature flag - the strict both-words fallback is what keeps
// Dr. Monique Jardin-Quing's separate clinic out of this feature.
// (test_db_records_site.mjs covers the clinic-NAME path of the gate.)
const OFF_USER = { id: 'doc-monic', full_name: 'Monique Jardin-Quing', role: 'doctor' }

const base = { report_type: 'cf4', case_number: '', doctor_id: 'doc-jardin',
               is_draft: false, dbSaved: 'true' }

const LIST_ROWS = [
  { ...base, record_key: 'cf4|A1', patient_name: 'RACOMA, ALLOY', patient_id: '',
    procedure_date: '2026-10-02', created_by: UUID_TARA, created_by_name: 'Tara Bautista',
    site: 'RMCI',
    created_at: '2026-10-05T09:32:00Z', updated_at: '2026-10-05T09:32:00Z' },
  { ...base, record_key: 'cf4|A2', patient_name: 'ME, OWN', patient_id: '',
    procedure_date: '2026-10-01', created_by: 'doc-jardin', created_by_name: 'Jesus Jardin',
    created_at: '2026-10-04T10:00:00Z', updated_at: '2026-10-04T10:00:00Z' },
  { ...base, record_key: 'cf4|A3', patient_name: 'V1, LEGACY', patient_id: '',
    procedure_date: '2026-09-30', created_by: 'joy', created_by_name: '',
    created_at: '2026-10-03T10:00:00Z', updated_at: '2026-10-03T10:00:00Z' },
  { ...base, record_key: 'cf4|A4', patient_name: 'ORPHAN, UUID', patient_id: '',
    procedure_date: '2026-09-29', created_by: UUID_ORPHAN, created_by_name: '',
    created_at: '2026-10-02T10:00:00Z', updated_at: '2026-10-02T10:00:00Z' },
  { ...base, record_key: 'cf4|A5', patient_name: 'SOLO, ONE', patient_id: '',
    procedure_date: '2026-09-28', created_by: UUID_TARA, created_by_name: 'Tara Bautista',
    site: 'CUMC',
    created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z' },
]

// RACOMA on file: 9 saved records across 4 distinct visit dates, some of
// them other report types - the count the chip promises to cover.
const RACOMA_DAYS = ['2026-10-02', '2026-10-02', '2026-08-05', '2026-08-05', '2026-08-05',
                     '2026-07-01', '2026-07-01', '2026-06-15', '2026-06-15']
const STATS_ROWS = RACOMA_DAYS.map(d => ({
  patient_name: 'RACOMA, ALLOY', patient_id: '', procedure_date: d,
  created_at: d + 'T08:00:00Z', is_draft: false, dbSaved: 'true',
})).concat([
  { patient_name: 'ME, OWN', patient_id: '', procedure_date: '2026-10-01',
    created_at: '2026-10-04T10:00:00Z', is_draft: false, dbSaved: 'true' },
  { patient_name: 'V1, LEGACY', patient_id: '', procedure_date: '2026-09-30',
    created_at: '2026-10-03T10:00:00Z', is_draft: false, dbSaved: 'true' },
  { patient_name: 'ORPHAN, UUID', patient_id: '', procedure_date: '2026-09-29',
    created_at: '2026-10-02T10:00:00Z', is_draft: false, dbSaved: 'true' },
  { patient_name: 'SOLO, ONE', patient_id: '', procedure_date: '2026-09-28',
    created_at: '2026-10-01T10:00:00Z', is_draft: false, dbSaved: 'true' },
])

async function open(mode) {
  const env = boot({ mode, user: USER, listRows: LIST_ROWS, statsRows: STATS_ROWS })
  await flush()
  env.win.EntDbRecords.openRecordsModal()
  await flush()
  env.list = firstBySel['.ent-db-list']
  env.status = firstBySel['.ent-db-status']
  env.search = firstBySel['.ent-db-search']
  env.html = () => env.list.children.map(c => c.innerHTML).join('\n')
  env.cardOf = name => env.list.children.find(c => c.innerHTML.includes(name))
  return env
}

console.log('')
console.log('==== DB RECORDS CARD — does it name its saver and count visits? ====')
console.log('')

/* ---- 1 · the reported card, exactly as the clinic described it ------- */
{
  const env = await open('normal')
  const all = env.html()

  ok('C1', 'five cards render', env.list.children.length === 5,
     'got ' + env.list.children.length)
  const racomaCard = env.cardOf('RACOMA, ALLOY')
  const racoma = racomaCard ? racomaCard.innerHTML : ''
  ok('C2', 'the card says WHO saved it, by real name',
     racoma.includes('Saved by <strong>Tara Bautista</strong>'), racoma.slice(0, 90))
  ok('C3', 'the raw uuid appears nowhere on the card',
     !racoma.includes(UUID_TARA) && !all.includes(UUID_TARA))
  ok('C4', 'the avatar is the saver\'s initial, not the uuid\'s "9"',
     !/aria-hidden="true">9</.test(all) && /aria-hidden="true">T</.test(racoma))
  const mineCard = env.cardOf('ME, OWN')
  const mine = mineCard ? mineCard.innerHTML : ''
  ok('C5', 'my own record reads "You" (matched by ID, not username)',
     mine.includes('Saved by <strong>You</strong>'))
  const legacyCard = env.cardOf('V1, LEGACY')
  const legacy = legacyCard ? legacyCard.innerHTML : ''
  ok('C6', 'a v1 username row still shows a readable name',
     legacy.includes('Saved by <strong>Joy</strong>'), legacy.slice(0, 90))
  const orphanCard = env.cardOf('ORPHAN, UUID')
  const orphan = orphanCard ? orphanCard.innerHTML : ''
  ok('C7', 'a uuid with no name on file says Unknown, never the uuid',
     orphan.includes('Saved by <strong>Unknown</strong>') && !orphan.includes(UUID_ORPHAN))
}

/* ---- 2 · the returning-patient chip ---------------------------------- */
{
  const env = await open('normal')
  const racomaCard = env.cardOf('RACOMA, ALLOY')
  const racoma = racomaCard ? racomaCard.innerHTML : ''
  ok('C8', 'the returning patient carries the counts',
     racoma.includes('ent-db-card-visits') && /9 records/.test(racoma) && /4 visits/.test(racoma),
     (racoma.match(/title="On file[^"]*"/) || ['no chip'])[0])
  ok('C9', 'the count spans all report types, not just this list',
     racoma.includes('across 4 visit date(s)'))
  const soloCard = env.cardOf('SOLO, ONE')
  const solo = soloCard ? soloCard.innerHTML : ''
  ok('C10', 'a one-record patient shows no chip (nothing to return from)',
     !solo.includes('ent-db-card-visits'))
  ok('C11', 'the status line still counts the list',
     /5 saved patients/.test(env.status.textContent), env.status.textContent)
}

/* ---- 3 · the visit-count read is down: cards must live ---------------- */
{
  const env = await open('failStats')
  const all = env.html()
  ok('C12', 'every card still renders when the stats query fails',
     env.list.children.length === 5, 'got ' + env.list.children.length)
  ok('C13', 'a dead stats read means NO chip, never a wrong count',
     !all.includes('ent-db-card-visits'))
  ok('C14', 'and the list is not reported as broken',
     !/Could not load/.test(env.status.textContent), env.status.textContent)
}

/* ---- 4 · a database without 0028 (pre-migration) -------------------- */
{
  const env = await open('failName')
  const all = env.html()
  ok('C15', 'without the created_by_name column the list still loads',
     env.list.children.length === 5, 'got ' + env.list.children.length)
  ok('C16', 'and it still never falls back to printing a uuid',
     !all.includes(UUID_TARA) && !all.includes(UUID_ORPHAN))
  const orphanCard = env.cardOf('ORPHAN, UUID')
  ok('C17', 'the unresolvable uuid reads Unknown, not the id',
     orphanCard && orphanCard.innerHTML.includes('Unknown'))
  const mineCard = env.cardOf('ME, OWN')
  ok('C18', '"You" still works by ID without the name column',
     mineCard && mineCard.innerHTML.includes('You'))
  ok('C19', 'the visits chip survives (its query never needed the column)',
     all.includes('ent-db-card-visits'))
  const tiered = env.calls.some(c => c.includes('report_type=eq.')
    && c.includes('created_by_name') && c.includes('is_draft'))
  const fellBack = env.calls.some(c => c.includes('report_type=eq.')
    && c.includes('payload->>dbSaved') && !c.includes('created_by_name'))
  ok('C20', 'it asked for the name first, then the flag tier',
     tiered && fellBack, env.calls.filter(c => c.includes('report_type=eq.')).join(' | ').slice(0, 140))
}

/* ---- 5 · nothing reaches the database -------------------------------- */
{
  const env = await open('failAll')
  ok('C21', 'a dead database reports the failure in the status line',
     /Could not load records/.test(env.status.textContent), env.status.textContent)
  ok('C22', 'it does not fake an empty "no records yet" without saying why',
     env.alerts.length === 0, env.alerts.join(' / '))
}

/* ---- 6 · search by the SAVer's name ---------------------------------- */
{
  const env = await open('normal')
  const input = (env.search._listeners.input || [])
  ok('C23', 'the search box is wired', input.length === 1)
  env.search.value = 'tara'
  input.forEach(fn => fn())
  ok('C24', 'typing the saver\'s name finds her records',
     env.list.children.length === 2, 'got ' + env.list.children.length)
  ok('C25', 'and the two hits are exactly hers',
     env.html().includes('RACOMA, ALLOY') && env.html().includes('SOLO, ONE'))
}

/* ---- 7 · the hospital tabs, flag ON for this user --------------------- */
{
  const env = await open('normal')
  const tabs = firstBySel['.ent-db-sites']
  const on = await env.win.EntDbRecords.resolveHospitalFeature()
  ok('C26', 'the gate resolves ON for Dr. Jesus Jardin', on === true)
  ok('C27', 'the hospital tab bar exists and is shown', tabs && tabs.hidden === false)
  ok('C28', 'the tabs read All / CUMC Records / RMCI Records, in that order',
     tabs && /data-site-tab="">All<\/button><button[^>]*data-site-tab="CUMC">CUMC Records<\/button><button[^>]*data-site-tab="RMCI">RMCI Records</.test(tabs.innerHTML),
     tabs ? tabs.innerHTML.replace(/\s+/g, ' ').slice(0, 200) : 'no tab bar')
  ok('C29', 'All is the active tab to start',
     /is-active" data-site-tab=""/.test(tabs.innerHTML))

  env.win.EntDbRecords.setSiteFilter('RMCI')
  ok('C30', 'the RMCI tab narrows the list to RMCI-tagged rows',
     env.list.children.length === 1 && env.html().includes('RACOMA, ALLOY'),
     'got ' + env.list.children.length)
  ok('C31', 'that card wears the RMCI badge',
     env.html().includes('ent-drafts-site-badge is-rmci'))
  ok('C32', 'the status line says which hospital is showing',
     /1 saved patient . RMCI/.test(env.status.textContent), env.status.textContent)

  env.win.EntDbRecords.setSiteFilter('CUMC')
  ok('C33', 'the CUMC tab narrows to CUMC-tagged rows',
     env.list.children.length === 1 && env.html().includes('SOLO, ONE'),
     'got ' + env.list.children.length)
  ok('C34', 'that card wears the CUMC badge',
     env.html().includes('ent-drafts-site-badge is-cumc'))
  ok('C35', 'the active tab follows the filter',
     /is-active" data-site-tab="CUMC"/.test(tabs.innerHTML))

  env.win.EntDbRecords.setSiteFilter('')
  ok('C36', 'All shows every record again', env.list.children.length === 5,
     'got ' + env.list.children.length)
  const untagged = env.cardOf('ME, OWN')
  ok('C37', 'an untagged row is never guessed into a hospital',
     untagged && !untagged.innerHTML.includes('ent-drafts-site-badge'))
}

/* ---- 8 · the flag is OFF: no tabs, no badges -------------------------- */
{
  const env = boot({ mode: 'normal', user: OFF_USER, listRows: LIST_ROWS, statsRows: STATS_ROWS })
  await flush()
  const on = await env.win.EntDbRecords.resolveHospitalFeature()
  ok('C38', "Dr. Jardin-Quing's name does not trip Dr. Jardin's flag", on === false)
  env.win.EntDbRecords.openRecordsModal()
  await flush()
  env.list = firstBySel['.ent-db-list']
  env.status = firstBySel['.ent-db-status']
  const tabs = firstBySel['.ent-db-sites']
  ok('C39', 'the hospital tab bar stays hidden', tabs && tabs.hidden === true)
  ok('C40', 'the list itself is untouched', env.list.children.length === 5,
     'got ' + env.list.children.length)
  const html = env.list.children.map(c => c.innerHTML).join('\n')
  ok('C41', 'tagged rows show NO badge when the flag is off',
     !html.includes('ent-drafts-site-badge'))
}

/* ---- 9 · the hospital zone sits beside the PATIENT'S NAME ------------- */
{
  const env = await open('normal')
  const racoma = env.cardOf('RACOMA, ALLOY') || { innerHTML: '' }
  const html = racoma.innerHTML
  const iName = html.indexOf('<h4 class="ent-db-card-name">RACOMA, ALLOY</h4>')
  const iZone = html.indexOf('<div class="ent-db-card-site">')
  const iBadge = html.indexOf('ent-drafts-site-badge is-rmci')
  const iBy = html.indexOf('ent-db-card-by')
  ok('C42', 'the name and the hospital zone share one row',
     html.includes('<div class="ent-db-card-namerow"><h4 class="ent-db-card-name">RACOMA, ALLOY</h4><div class="ent-db-card-site">'),
     html.slice(Math.max(0, iName - 70), iName + 90))
  ok('C43', 'the RMCI badge sits INSIDE that zone - right of the name, before the saver line',
     iName !== -1 && iZone > iName && iBadge > iZone && iBadge < iBy,
     `name@${iName} zone@${iZone} badge@${iBadge} by@${iBy}`)
  ok('C44', 'a tagged card offers Move, not Set',
     /ent-db-site-move[^>]*>Move</.test(html))
  const untagged = env.cardOf('ME, OWN') || { innerHTML: '' }
  ok('C45', 'an untagged card SAYS "No hospital" instead of showing nothing',
     untagged.innerHTML.includes('ent-db-site-none')
       && untagged.innerHTML.includes('>No hospital</span>'))
  ok('C46', 'and it offers the Set button - still never a guessed badge',
     /ent-db-site-move[^>]*>Set</.test(untagged.innerHTML)
       && !untagged.innerHTML.includes('ent-drafts-site-badge'))
}

/* ---- 10 · Set an untagged record's hospital from its card ------------- */
{
  const env = await open('normal')
  // The button is wired: buildCard attached a click handler per card.
  // (The tiny DOM hands every card ONE shared synthetic button node, so
  // which card a handler belongs to is not knowable here - the real
  // button simply calls startSiteMove(record), which is driven below.)
  const moveNode = firstBySel['.ent-db-site-move']
  ok('C47', 'every rendered card wires its Set/Move button',
     moveNode && (moveNode._listeners.click || []).length >= 5,
     moveNode ? String((moveNode._listeners.click || []).length) + ' handler(s)' : 'button node never created')

  const target = LIST_ROWS.find(r => r.patient_name === 'ME, OWN')
  const moving = env.win.EntDbRecords.startSiteMove(target)
  await flush()
  const box = env.dialogs.find(d => String(d.className).includes('ent-site-modal'))
  ok('C48', 'Set opens the hospital dialog', !!box)
  ok('C49', 'it explains the record has no hospital and offers both hospitals',
     !!box && box.innerHTML.includes('Which hospital does this patient belong to?')
       && box.innerHTML.includes('data-site-choice="RMCI"')
       && box.innerHTML.includes('data-site-choice="CUMC"')
       && box.innerHTML.includes('This record has no hospital yet'))
  if (box) {
    box._listeners.click[0]({
      target: { closest: sel => (sel === '[data-site-choice]' ? { getAttribute: () => 'CUMC' } : null) },
    })
  }
  const moved = await moving
  await flush()
  ok('C50', 'the row is PATCHed with payload.site = CUMC, payload MERGED not replaced',
     moved === true && env.patches.length === 1 && env.patches[0] && env.patches[0].payload
       && env.patches[0].payload.site === 'CUMC'
       && env.patches[0].payload.dbSaved === true
       && env.patches[0].payload.formData && env.patches[0].payload.formData.keep === 1,
     JSON.stringify(env.patches))
  const movedCard = env.cardOf('ME, OWN')
  ok('C51', 'the card re-renders with the CUMC badge immediately',
     !!movedCard && movedCard.innerHTML.includes('ent-drafts-site-badge is-cumc'))
  ok('C52', 'the status line says where it went',
     /now belongs to CUMC/.test(env.status.textContent), env.status.textContent)
  ok('C53', 'the dialog closed itself', !env.dialogs.find(d => String(d.className).includes('ent-site-modal')))
}

/* ---- 11 · the database refuses the move: say so, change nothing ------- */
{
  const env = boot({ mode: 'failMove', user: USER, listRows: LIST_ROWS, statsRows: STATS_ROWS })
  await flush()
  env.win.EntDbRecords.openRecordsModal()
  await flush()
  const list = firstBySel['.ent-db-list']
  const cardOf = name => list.children.find(c => c.innerHTML.includes(name))
  const target = LIST_ROWS.find(r => r.patient_name === 'RACOMA, ALLOY')
  const moving = env.win.EntDbRecords.startSiteMove(target)
  await flush()
  const box = env.dialogs.find(d => String(d.className).includes('ent-site-modal'))
  if (box) {
    box._listeners.click[0]({
      target: { closest: sel => (sel === '[data-site-choice]' ? { getAttribute: () => 'CUMC' } : null) },
    })
  }
  const moved = await moving
  await flush()
  ok('C54', 'a refused PATCH resolves false', moved === false)
  ok('C55', 'the alert explains the failure and the alternative',
     env.alerts.some(a => a.includes('COULD NOT MOVE THIS RECORD') && a.includes('Save to Database')),
     env.alerts.join(' / '))
  const racoma = cardOf('RACOMA, ALLOY')
  ok('C56', 'the card is NOT re-tagged when nothing was written',
     !!racoma && racoma.innerHTML.includes('ent-drafts-site-badge is-rmci')
       && !racoma.innerHTML.includes('is-cumc'))
}

/* ---- 12 · flag OFF: no name-row wrapper, no chip, no button ----------- */
{
  const env = boot({ mode: 'normal', user: OFF_USER, listRows: LIST_ROWS, statsRows: STATS_ROWS })
  await flush()
  env.win.EntDbRecords.openRecordsModal()
  await flush()
  const list = firstBySel['.ent-db-list']
  const html = list.children.map(c => c.innerHTML).join('\n')
  ok('C57', 'flag OFF cards carry no zone, no chip and no Set/Move button',
     !html.includes('ent-db-card-namerow') && !html.includes('ent-db-site-none')
       && !html.includes('ent-db-site-move'),
     html.slice(0, 140))
}

/* ---- 13 · the row-key shape that broke the refresh --------------------- */
{
  // The fixtures above now mirror the LIVE API: PostgREST names a
  // JSON-extracted field after its LAST key, so select=payload->>site
  // answers { site: "RMCI" } - never { 'payload->>site': ... }. Reading
  // the expression key only is exactly the bug that let Set/Move SHOW a
  // badge while every fresh load showed "No hospital" again, so every
  // badge/tab test above runs on the real shape. This block drives the
  // OPPOSITE shape - the literal expression key - because older rows and
  // in-memory writes still produce it and siteOf() accepts both. Built
  // from an explicit map, NOT LIST_ROWS as-is: earlier blocks drive
  // startSiteMove against those shared fixture objects, which touch()
  // then mutates in place.
  const PRISTINE_SITE = { 'cf4|A1': 'RMCI', 'cf4|A5': 'CUMC' }
  const oldShape = LIST_ROWS.map(r => {
    const copy = { ...r }
    delete copy.site
    delete copy['payload->>site']
    const site = PRISTINE_SITE[r.record_key]
    if (site) copy['payload->>site'] = site
    return copy
  })
  const env = boot({ mode: 'normal', user: USER, listRows: oldShape, statsRows: STATS_ROWS })
  await flush()
  env.win.EntDbRecords.openRecordsModal()
  await flush()
  const list = firstBySel['.ent-db-list']
  const cardOf = name => list.children.find(c => c.innerHTML.includes(name))
  const racoma = cardOf('RACOMA, ALLOY')
  ok('C58', 'a row keyed with the literal expression still wears its badge',
     !!racoma && racoma.innerHTML.includes('ent-drafts-site-badge is-rmci'))
  env.win.EntDbRecords.setSiteFilter('CUMC')
  const shown = list.children.map(c => c.innerHTML).join('\n')
  ok('C59', 'and the tabs still filter such rows',
     list.children.length === 1 && shown.includes('SOLO, ONE'),
     'got ' + list.children.length + ' :: ' + shown.replace(/\s+/g, ' ').slice(0, 300))
}

/* ---- 14 · sorting: latest first by default, A-Z on demand -------------- */
{
  const env = await open('normal')
  const bar = firstBySel['.ent-db-sortbar']
  const order = () => env.list.children.map(c =>
    (String(c.innerHTML).match(/ent-db-card-name">([^<]+)/) || ['?'])[1])
  const is = arr => JSON.stringify(order()) === JSON.stringify(arr)
  // updated_at DESC as the fixtures were written: 10-05, 10-04, 10-03,
  // 10-02, 10-01. A-Z is the same five names in plain alphabetical order.
  const byDate = ['RACOMA, ALLOY', 'ME, OWN', 'V1, LEGACY', 'ORPHAN, UUID', 'SOLO, ONE']
  const byName = ['ME, OWN', 'ORPHAN, UUID', 'RACOMA, ALLOY', 'SOLO, ONE', 'V1, LEGACY']

  ok('C60', 'the sort bar is present and visible - sorting is NOT flag-gated',
     !!bar && bar.hidden === false)
  ok('C61', 'Latest is the active chip to start',
     !!bar && /class="ent-db-sort is-active" data-sort-mode="date"/.test(bar.innerHTML),
     bar ? bar.innerHTML.replace(/\s+/g, ' ').slice(0, 220) : 'no sort bar')
  ok('C62', 'the default order puts the LATEST saved patient first',
     is(byDate), order().join(' | '))

  env.win.EntDbRecords.setSortMode('name')
  ok('C63', 'A-Z reorders every card alphabetically',
     is(byName), order().join(' | '))
  ok('C64', 'the active chip follows to A-Z',
     /class="ent-db-sort is-active" data-sort-mode="name"/.test(bar.innerHTML))

  // The order composes with the other two views instead of fighting them.
  env.win.EntDbRecords.setSiteFilter('RMCI')
  ok('C65', 'A-Z still applies under a hospital tab',
     order().length === 1 && order()[0] === 'RACOMA, ALLOY', order().join(' | '))
  env.win.EntDbRecords.setSiteFilter('')

  const input = (env.search._listeners.input || [])
  env.search.value = 'legacy'
  input.forEach(fn => fn())
  ok('C66', 'a search narrows within the A-Z order',
     order().length === 1 && order()[0] === 'V1, LEGACY', order().join(' | '))
  env.search.value = ''
  input.forEach(fn => fn())
  ok('C67', 'clearing the search restores the full A-Z list',
     is(byName), order().join(' | '))

  // Flag OFF: the bar is still there and still works - sorting belongs to
  // every clinic, unlike the hospital tabs it sits beside.
  const off = boot({ mode: 'normal', user: OFF_USER, listRows: LIST_ROWS, statsRows: STATS_ROWS })
  await flush()
  off.win.EntDbRecords.openRecordsModal()
  await flush()
  const offBar = firstBySel['.ent-db-sortbar']
  ok('C68', 'flag OFF clinics see the sort bar too',
     !!offBar && offBar.hidden === false)
  off.win.EntDbRecords.setSortMode('name')
  const offOrder = firstBySel['.ent-db-list'].children.map(c =>
    (String(c.innerHTML).match(/ent-db-card-name">([^<]+)/) || ['?'])[1])
  ok('C69', 'and sorting works for them, A-Z included',
     offOrder[0] === 'ME, OWN', offOrder.join(' | '))
}

/* ---- 15 · the Final Saved <-> Editable toggle writes by UUID id -------- */
{
  const env = await open('normal')
  // Every fixture row is final saved (dbSaved: 'true'), so the toggle must
  // flip this one to EDITABLE. record_key is TEXT and legacy rows carry
  // composite keys ("nasal|id:1306280|2026-08-25") while reports.id is a
  // UUID PK - PATCHing id=eq.<record_key> bounces off postgres with 22P02
  // ("invalid input syntax for type uuid"), the live bug this locks down.
  // The write must resolve the real row ids through record_key first, then
  // patch by id, exactly like startSiteMove does above.
  const target = { ...LIST_ROWS.find(r => r.patient_name === 'SOLO, ONE') }
  const toggled = await env.win.EntDbRecords.toggleFinalSaved(target)
  await flush()

  const keyReads = env.calls.filter(c => c.includes('record_key=eq.'))
  const patchCalls = env.calls.filter(c => c.startsWith('PATCH reports?id=eq.'))
  ok('C70', 'the toggle resolves row ids by record_key, then PATCHes by id',
     toggled === true && keyReads.length === 1 && patchCalls.length === 1
       && patchCalls[0].includes('row-'),          // the mock's UUID stand-in
     JSON.stringify(env.calls.slice(-3)))
  ok('C71', 'the TEXT record_key is NEVER sent as the uuid id (the 22P02 bug)',
     !env.calls.some(c => c.startsWith('PATCH reports?id=eq.cf4')),
     JSON.stringify(patchCalls))
  const body = env.patches[0]
  ok('C72', 'the row payload is merged and flipped to editable',
     !!body && !!body.payload
       && body.payload.dbSaved === false
       && body.payload.is_draft === true
       && body.payload.formData && body.payload.formData.keep === 1,
     JSON.stringify(env.patches))
  const solo = env.cardOf('SOLO, ONE')
  ok('C73', 'the card re-renders with the Editable chip right away',
     !!solo && solo.innerHTML.includes('ent-db-card-editable')
       && /Status: editable/.test(env.status.textContent),
     solo ? solo.innerHTML.replace(/\s+/g, ' ').slice(0, 200) : 'no card')
}

/* ---- 16 · bounded lazy pages; a duplicate row is ONE card --------------
   The first response is bounded to 100 rows. The user can keep requesting
   pages; the mock repeats a page boundary as if a save shifted the result. */
{
  const now = Date.parse('2026-10-05T09:32:00Z')
  const BIG = []
  for (let i = 0; i < 1200; i++) {
    BIG.push({ ...base, record_key: `cf4|BIG${i}`, patient_name: `PAGE, ROW${i}`,
      patient_id: '', procedure_date: '2026-10-02', created_by: 'doc-jardin',
      created_by_name: 'Jesus Jardin',
      created_at: new Date(now - i * 60000).toISOString(),
      updated_at: new Date(now - i * 60000).toISOString() })
  }
  // Same record_key as BIG0, slightly older: the duplicate copy the clinic
  // actually has in the table. Server order is updated_at desc, so it sits
  // right behind its fresher twin.
  BIG.splice(1, 0, { ...BIG[0], updated_at: new Date(now - 30000).toISOString() })

  const env = boot({ mode: 'paged', user: USER, listRows: BIG, statsRows: STATS_ROWS })
  await flush()
  env.win.EntDbRecords.openRecordsModal()
  await flush()
  const list = firstBySel['.ent-db-list']
  const status = firstBySel['.ent-db-status']
  const firstPageCount = list.children.length
  for (let i = 0; i < 20; i++) await env.win.EntDbRecords.loadMoreRecords()
  const html = list.children.map(c => c.innerHTML).join('\n')
  const listCalls = env.calls.filter(c => c.includes('report_type=eq.'))

  ok('C74', 'the initial read is bounded and older pages are loaded explicitly',
     firstPageCount === 99 && listCalls.length === 13 && listCalls.every(c => c.includes('offset=')),
     `first=${firstPageCount}; ${JSON.stringify(listCalls.map(c => (/[?&]offset=\d+/.exec(c) || [''])[0]))}`)
  ok('C75', 'pages carry the id.desc tie-break so rows cannot reshuffle',
     listCalls.every(c => c.includes('order=updated_at.desc,id.desc')),
     (listCalls[0] || 'no list call').slice(0, 120))
  ok('C76', 'loading more reaches every saved row beyond the initial page',
     list.children.length === 1200, 'got ' + list.children.length)
  ok('C77', 'the OLDEST row, far below any newest-N window, still has a card',
     html.includes('PAGE, ROW1199'))
  ok('C78', 'the duplicate record_key gets ONE card and the count agrees',
     (html.match(/PAGE, ROW0</g) || []).length === 1
       && /1200 saved patients/.test(status.textContent),
     status.textContent)
}

/* ---- 16a · server page RPC bounds and filters the list ---------------- */
{
  const env = boot({
    mode: 'normal', user: USER, listRows: LIST_ROWS, statsRows: STATS_ROWS,
    rpcAvailable: true
  })
  await flush()
  env.win.EntDbRecords.openRecordsModal()
  await flush()
  const first = env.rpcCalls[0]
  ok('C78a', 'the server page is limited to 100 rows and begins at offset zero',
     first.p_limit === 100 && first.p_offset === 0,
     JSON.stringify(first))
  const initialHtml = firstBySel['.ent-db-list'].children.map(c => c.innerHTML).join('\n')
  ok('C78b', 'server-side aggregation preserves exact patient record and visit counts',
     initialHtml.includes('9 records') && initialHtml.includes('4 visits'),
     initialHtml.match(/9 records[^<]*/)?.[0] || 'chip missing')

  env.search = firstBySel['.ent-db-search']
  env.search.value = 'RACOMA'
  env.win.EntDbRecords.setSiteFilter('RMCI')
  await flush()
  const filtered = env.rpcCalls[env.rpcCalls.length - 1]
  ok('C78c', 'search and hospital filtering stay server-side and restart pagination',
     filtered.p_search === 'RACOMA' && filtered.p_site === 'RMCI' && filtered.p_offset === 0,
     JSON.stringify(filtered))
  ok('C78d', 'search returns only matching records from the selected hospital',
     firstBySel['.ent-db-list'].children.length === 1,
     String(firstBySel['.ent-db-list'].children.length))
}

/* ---- 17 · the SERVER draft filter admits exactly what the card admits ---
   The live bug behind "secretary sees ONE CF4 record": the list's
   server-side filter was the literal is_draft=eq.false, but SQL says
   NULL = false is UNKNOWN, and a row whose column still reads TRUE
   while payload.dbSaved says it was SAVED also fails eq.false. Those
   rows never reached the browser - isDatabaseRecord() would have shown
   them, but it never got the chance. The query now carries
   or=(is_draft.eq.false,is_draft.is.null,payload->>dbSaved.eq.true),
   the mock enforces it the way PostgREST does (and still enforces the
   OLD literal strictly, so reverting the query re-fails C80), and a
   genuine draft still never appears. */
{
  const SPECIAL = [
    // Legacy row: the flag was NEVER written (NULL). eq.false hid it;
    // only the IS NULL clause admits it - so this row carries no
    // dbSaved either, proving the null clause alone does the work.
    { ...base, record_key: 'cf4|S1', patient_name: 'NULL, FLAG',
      patient_id: '', procedure_date: '2026-09-27',
      created_by: 'doc-jardin', created_by_name: 'Jesus Jardin',
      is_draft: null, dbSaved: undefined,
      created_at: '2026-10-05T11:00:00Z', updated_at: '2026-10-05T11:00:00Z' },
    // Column says TRUE (a writer that never flipped it, or the old
    // payload-only toggle) but the payload says saved: the payload
    // clause admits it - eq.false alone hid it.
    { ...base, record_key: 'cf4|S2', patient_name: 'STALE, TRUEFLAG',
      patient_id: '', procedure_date: '2026-09-26',
      created_by: 'doc-jardin', created_by_name: 'Jesus Jardin',
      is_draft: true, dbSaved: 'true',
      created_at: '2026-10-05T10:00:00Z', updated_at: '2026-10-05T10:00:00Z' },
    // A REAL draft: TRUE column, nothing saved in the payload. Must
    // stay in My Drafts - no clause admits it, no card shows it.
    { ...base, record_key: 'cf4|S3', patient_name: 'REAL, DRAFT',
      patient_id: '', procedure_date: '2026-09-25',
      created_by: 'doc-jardin', created_by_name: 'Jesus Jardin',
      is_draft: true, dbSaved: undefined,
      created_at: '2026-10-05T09:00:00Z', updated_at: '2026-10-05T09:00:00Z' },
  ]
  const env = boot({ mode: 'normal', user: USER, listRows: SPECIAL, statsRows: STATS_ROWS })
  await flush()
  env.win.EntDbRecords.openRecordsModal()
  await flush()
  const list = firstBySel['.ent-db-list']
  const status = firstBySel['.ent-db-status']
  const html = list.children.map(c => c.innerHTML).join('\n')
  const listCalls = env.calls.filter(c => c.includes('report_type=eq.'))
  const statsCalls = env.calls.filter(c => c.includes('reports?select=patient_name'))

  ok('C79', 'the list asks the server with the three-clause or= filter',
     listCalls.length > 0 && listCalls.every(c =>
       c.includes('or=(is_draft.eq.false,is_draft.is.null,payload->>dbSaved.eq.true)')),
     (listCalls[0] || 'no list call').slice(0, 170))
  ok('C80', 'a NULL-flag legacy row - invisible to eq.false - renders',
     html.includes('NULL, FLAG'), html.replace(/\s+/g, ' ').slice(0, 160))
  ok('C81', 'a TRUE-column row whose payload says saved renders',
     html.includes('STALE, TRUEFLAG'))
  ok('C82', 'a real draft still never renders', !html.includes('REAL, DRAFT'))
  ok('C83', 'the status counts exactly the admitted rows',
     /2 saved patients/.test(status.textContent), status.textContent)
  ok('C84', 'the visit-count read carries the same admission filter',
     statsCalls.length > 0 && statsCalls.every(c =>
       c.includes('or=(is_draft.eq.false,is_draft.is.null,payload->>dbSaved.eq.true)')),
     (statsCalls[0] || 'no stats call').slice(0, 170))
}

/* ---- 18 · the toggle writes the COLUMN, not only the payload copy ------ */
{
  const env = await open('normal')
  // Force the final-saved starting point: section 15 already flipped
  // SOLO ONE's LIST_ROWS object to editable IN PLACE (the toggle mutates
  // currentRecords, which share the fixture's references), so without
  // this the direction here would depend on test order.
  const target = { ...LIST_ROWS.find(r => r.patient_name === 'SOLO, ONE'),
                   dbSaved: 'true' }
  await env.win.EntDbRecords.toggleFinalSaved(target)
  await flush()
  const body = env.patches[0]
  // body.payload.is_draft flips TRUE (editable) - but the TOP-LEVEL
  // column must stay FALSE: TRUE would fail the list's admission
  // filter on the next load and the record would VANISH, which is the
  // exact bug v33ah fixes. Finished-vs-editable lives in payload.dbSaved.
  ok('C85', 'the PATCH carries the top-level is_draft column = false (never TRUE)',
     !!body && body.is_draft === false
       && body.payload && body.payload.is_draft === true
       && body.payload.dbSaved === false,
     JSON.stringify(body))
}

console.log('')
console.log(`  ${passed} passed, ${failed} failed`)
console.log('')
process.exitCode = failed ? 1 : 0
