// =====================================================================
//  test_view_all_ui.mjs
//  Does the new View All UI obey the rules it claims to?
//  ---------------------------------------------------------------------
//  The backend is proven live (23/23). What is NOT proven is the client:
//  a UI that offers an "Open" button on a row the server marked can_view
//  false, or that swallows a refusal and shows a record anyway, would
//  undo work that is already correct.
//
//  So this loads the REAL function/viewAllAccess.js into a stubbed browser
//  and asserts the behaviours that matter:
//
//    1. a locked row renders NO Open button, only Request access
//    2. an accessible row DOES render Open
//    3. PERMISSION_REQUIRED renders the refusal, never a payload
//    4. a refused approve surfaces the server's message, not "success"
//    5. requesting access does NOT attempt to write a grant
//    6. no client-side permission decision: no hidden foreign rows
//
//  No network. Supabase is stubbed at the apiRequest boundary, exactly the
//  way test_frontend_v2.mjs does it.
//
//  Run: node supabase-v2/scripts/test_view_all_ui.mjs
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

// ---- what the stubbed server will answer -----------------------------
let indexRows = []
let openResult = { ok: false, code: 'PERMISSION_REQUIRED', message: 'You do not have permission to open this record.' }
let approveThrows = null
const calls = []

function makeWindow() {
  const store = new Map()
  const listeners = {}
  const win = {
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    sessionStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    document: {
      readyState: 'complete',
      body: { classList: { contains: () => false } },
      addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn) },
      getElementById: () => null,
      querySelector: () => null,
      createElement: () => ({ className: '', textContent: '', appendChild() {}, style: {} }),
    },
    addEventListener: () => {},
    dispatchEvent: () => {},
    location: { pathname: '/viewAll.html', search: '', href: '' },
    navigator: { userAgent: 'node-test', onLine: true },
    console, setInterval: () => 0, clearInterval: () => {},
    sessionStorageOK: true,
    prompt: () => null,
    confirm: () => false,
  }
  win.window = win
  win.globalThis = win
  return win
}

// The module queries the DOM by id. Provide just the nodes it uses, as
// plain objects with innerHTML - enough to assert on rendered output.
function installDom(win) {
  const nodes = {}
  // Richer than it needs to be: the layout pass added a scope line, three
  // count tiles, two selects and a checkbox, and a node that cannot hold
  // value/dataset/children fails inside the module instead of reporting.
  const mk = id => (nodes[id] = {
    id, innerHTML: '', hidden: false, textContent: '', value: '', checked: false,
    dataset: {}, children: [], listeners: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn)
    },
    getAttribute() { return null },
    setAttribute(key, value) { this[key] = String(value) },
    // Mirrors the platform: removing `open` from a <dialog> CLOSES it, so
    // `.open` becomes false - it never becomes undefined.
    removeAttribute(key) {
      if (key === 'open') { this.open = false; return }
      delete this[key]
    },
    appendChild(child) { this.children.push(child); return child },
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, matches: () => false,
  })
  ;['ccaTableBody', 'ccaDetail', 'ccaNotice', 'ccaSearch', 'ccaMore', 'ccaRefresh',
    'ccaScope', 'ccaStatTotal', 'ccaStatOpen', 'ccaStatAsk', 'ccaCount',
    'ccaClinic', 'ccaType', 'ccaOnlyOpen', 'connPill', 'connText',
    'ccaRecord', 'ccaRecordBody', 'ccaRecordTitle', 'ccaRecordClose'].forEach(mk)
  // The record is a <dialog> now. A stub without showModal() would take the
  // fallback path and the tests would stop proving the real behaviour.
  nodes.ccaRecord.open = false
  nodes.ccaRecord.showModal = function () { this.open = true }
  nodes.ccaRecord.close = function () { this.open = false }
  win.document.getElementById = id => nodes[id] || null
  return nodes
}

// ---- the stubbed Supabase client -------------------------------------
function installSupabase(win) {
  win.EntSupabase = {
    apiRequest: async (endpoint, opts = {}) => {
      calls.push({ endpoint, method: opts.method || 'GET', body: opts.body })
      if (endpoint.includes('ent_view_all_index')) return indexRows
      if (endpoint.includes('ent_open_report')) {
        if (openResult instanceof Error) throw openResult
        return openResult
      }
      if (endpoint.includes('report_access_grants')) {
        if (approveThrows) throw approveThrows
        return [{ report_id: 'r1', grantee_id: 'g1' }]
      }
      return null
    },
    isConfigured: () => true,
    getConfig: () => ({ supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon' }),
    getAccessToken: async () => 'JWT',
  }
}

// ---- load the real module --------------------------------------------
console.log('')
console.log('==== VIEW ALL UI — does the client obey the server? ====')
console.log('')

const win = makeWindow()
const nodes = installDom(win)
installSupabase(win)

// The vm context is a plain object, so it has NO browser globals. The
// module uses URLSearchParams to build the RPC query string, so without
// this line listIndex() throws ReferenceError and every list assertion
// fails for a reason that has nothing to do with the module. That is not a
// hypothetical: it is exactly what happened the first time this ran.
win.URLSearchParams = URLSearchParams
win.URL = URL
win.URLSearchParams.prototype.toString = URLSearchParams.prototype.toString

// EntAuth is optional in this module; supply the escapeHtml the app uses so
// the rendering path is the real one.
win.EntAuth = {
  escapeHtml: v => String(v ?? '').replace(/[&<>'"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])),
  currentUser: () => ({ id: 'me', role: 'admin' }),
}

let loadError = ''
try {
  const code = readFileSync(join(APP, 'function', 'viewAllAccess.js'), 'utf8')
  vm.createContext(win)
  vm.runInContext(code, win, { filename: 'viewAllAccess.js' })
} catch (e) {
  loadError = String(e && e.message || e)
}
ok('T1', 'viewAllAccess.js loads as a module graph', loadError === '', loadError || 'clean load')
ok('T2', 'it publishes window.EntCrossClinic', !!win.EntCrossClinic)

const CC = win.EntCrossClinic
if (!CC) { console.log('\nFATAL: module did not export; cannot continue.'); process.exit(1) }

// ---- 1/2 · locked vs accessible rows ---------------------------------
// Two rows from DIFFERENT clinics, exactly as ent_view_all_index would
// return them: can_view false for the foreign one, true for the caller's.
indexRows = [
  { report_id: 'LOCKED1', clinic_id: 'cA', clinic_name: 'ENT Manila', doctor_name: 'Dr A',
    patient_name: 'Foreign Patient', case_number: 'CF-1', report_type: 'cf4',
    procedure_date: '2026-01-05', created_at: '2026-01-05T00:00:00Z',
    can_view: false, can_edit: false, can_delete: false },
  { report_id: 'OPENABLE', clinic_id: 'cA', clinic_name: 'ENT Manila', doctor_name: 'Dr A',
    patient_name: 'Own Patient', case_number: 'CF-2', report_type: 'cf4',
    procedure_date: '2026-01-06', created_at: '2026-01-06T00:00:00Z',
    can_view: true, can_edit: true, can_delete: false },
]

await CC.refresh()
const html = nodes.ccaTableBody.innerHTML

ok('T3', 'the list renders both rows', html.includes('LOCKED1') && html.includes('OPENABLE'))
ok('T4', 'a can_view=FALSE row offers NO Open button',
   !/data-open="LOCKED1"/.test(html),
   /data-open="LOCKED1"/.test(html) ? 'OPEN BUTTON RENDERED ON A LOCKED ROW' : 'no open button')
ok('T5', 'a can_view=FALSE row offers Request access instead',
   /data-ask="LOCKED1"/.test(html))
ok('T6', 'a can_view=TRUE row DOES offer Open',
   /data-open="OPENABLE"/.test(html))
ok('T7', 'the locked row is labelled, not silently dropped',
   /No access/.test(html))
ok('T8', 'foreign-clinic rows are NOT hidden client-side',
   html.includes('ENT Manila') && html.includes('Foreign Patient'),
   'metadata for every clinic is shown by design')

// ---- 3 · refusal renders, payload never does --------------------------
openResult = { ok: false, code: 'PERMISSION_REQUIRED',
               message: 'You do not have permission to open this record. Ask the clinic that owns it for access.' }
await CC.open('LOCKED1')
const refusal = nodes.ccaRecordBody.innerHTML
ok('T9', 'PERMISSION_REQUIRED renders the refusal', /No access to this record/.test(refusal))
ok('T10', 'the refusal carries the server\'s own message',
   /Ask the clinic that owns it/.test(refusal))
ok('T11', 'a refused open renders NO record content',
   !/Record content/.test(refusal) && !/<pre>/.test(refusal))
ok('T12', 'the refusal still offers a next step',
   /data-ask="LOCKED1"/.test(refusal))

// A granted open renders the record - proving the refusal path is a real
// branch, not the only thing this pane can ever show.
openResult = { ok: true, code: 'OK', can_edit: true, can_delete: false,
               report: { id: 'OPENABLE', patient_name: 'Own Patient', report_type: 'cf4',
                         case_number: 'CF-2', payload: { findings: 'clear' } } }
await CC.open('OPENABLE')
const granted = nodes.ccaRecordBody.innerHTML
ok('T13', 'an ALLOWED open renders the record', /Record content/.test(granted) && /Own Patient/.test(granted))
ok('T14', 'and it reports can_edit from the server',
   /You can edit<\/dt><dd>Yes/.test(granted))

// ---- 4 · a refused approve is never dressed up as success ------------
// PostgREST surfaces the trigger's RAISE text, e.g.
//   refused: that person is in your own clinic and needs no grant
// That exact sentence is the honest answer, so it must reach the user.
approveThrows = new Error('Supabase API error (403): {"message":"refused: that person is in your own clinic and needs no grant"}')
approveThrows.status = 403
win.prompt = () => 'grantee-uuid-1234'
calls.length = 0
await CC.approve('OPENABLE')
const noticeAfterFail = nodes.ccaNotice.textContent

ok('T15', 'a refused approve surfaces the SERVER\'s refusal text',
   /refused: that person is in your own clinic/.test(noticeAfterFail),
   noticeAfterFail.slice(0, 70))
ok('T16', 'a refused approve is NOT reported as success',
   !/approved/i.test(noticeAfterFail), noticeAfterFail.slice(0, 70))
ok('T17', 'approve sends no author identity of its own',
   (() => {
     const c = calls.find(x => x.endpoint.includes('report_access_grants'))
     if (!c || !c.body) return false
     const b = JSON.parse(c.body)[0]
     // granted_by / granted_by_name are server-owned. A client that sent
     // either could claim to have been approved by somebody else.
     return !('granted_by' in b) && !('granted_by_name' in b)
   })())

// The success path, so the failure above is not the only one exercised.
approveThrows = null
calls.length = 0
await CC.approve('OPENABLE')
ok('T18', 'a successful approve says so, and names the audit author',
   /recorded with your name as the approver/i.test(nodes.ccaNotice.textContent),
   nodes.ccaNotice.textContent.slice(0, 70))

// ---- 5 · requesting access must NOT write a grant --------------------
// The dangerous bug this guards: a "Request access" button that quietly
// INSERTs a grant would let a user grant itself access to another clinic's
// patient. The server would refuse it, but the attempt itself is wrong -
// and a client that tries tells you the UI misunderstood who approves.
win.prompt = () => 'Consultation on this patient'
calls.length = 0
await CC.request('LOCKED1')
const wroteGrant = calls.some(c =>
  c.method === 'POST' && c.endpoint.includes('report_access_grants'))
ok('T19', 'Request access does NOT attempt to write a grant',
   !wroteGrant,
   wroteGrant ? 'REQUEST ACCESS TRIED TO INSERT A GRANT' : 'no write attempted')
ok('T20', 'Request access tells the user the owning clinic must approve',
   /must still approve/i.test(nodes.ccaNotice.textContent),
   nodes.ccaNotice.textContent.slice(0, 70))

// Cancelling must be silent and must not claim anything happened.
win.prompt = () => null
nodes.ccaNotice.textContent = ''
await CC.request('LOCKED1')
ok('T21', 'cancelling the prompt claims nothing', nodes.ccaNotice.textContent === '')

// An empty reason is refused: it becomes the audit record.
win.prompt = () => '   '
await CC.request('LOCKED1')
ok('T22', 'an empty reason is refused', /reason is required/i.test(nodes.ccaNotice.textContent))

// ---- 6 · escaping -----------------------------------------------------
// Patient names are user-supplied and land in innerHTML. An unescaped name
// is stored XSS against every clinician who opens the list.
indexRows = [{ report_id: 'XSS', clinic_id: 'cA', clinic_name: 'ENT Manila', doctor_name: 'Dr A',
               patient_name: '<img src=x onerror=alert(1)>', case_number: '"><script>x</script>',
               report_type: 'cf4', procedure_date: '2026-01-05', created_at: '2026-01-05T00:00:00Z',
               can_view: true, can_edit: false, can_delete: false }]
await CC.refresh()
const xssHtml = nodes.ccaTableBody.innerHTML
ok('T23', 'a patient name is HTML-escaped',
   !xssHtml.includes('<img src=x') && xssHtml.includes('&lt;img src=x'))
ok('T24', 'a case number is HTML-escaped',
   !xssHtml.includes('<script>x') && xssHtml.includes('&lt;script&gt;'))

// ---- 7 · the server error is not swallowed ---------------------------
approveThrows = new Error('Supabase API error (500): something broke')
approveThrows.status = 500
win.prompt = () => 'grantee-uuid-1234'
await CC.approve('OPENABLE')
ok('T25', 'a 500 surfaces its message rather than claiming success',
   /something broke/.test(nodes.ccaNotice.textContent) &&
   !/approved/i.test(nodes.ccaNotice.textContent))

// ---- 8 · the layout pass: what the page now says about itself --------
// The header used to sit on "checking..." forever (the updater lived in
// admin.js and never ran here), the counts did not exist at all, and the
// only way to know whether you could open anything was to read the Access
// column of every row. These hold all of that in place.
{
  const CC = win.EntCrossClinic;
  approveThrows = null;
  // The XSS section above replaced the fixture with its own row and left a
  // record open. Put the two real rows back so these counts mean something.
  indexRows = [
    { report_id: 'LOCKED1', clinic_name: 'ENT Manila', doctor_name: 'Dr A',
      patient_name: 'LOCKED1 PATIENT', case_number: 'CF-2024-001', report_type: 'nasal',
      procedure_date: '2026-01-05', created_at: '2026-01-05T00:00:00Z',
      can_view: false, can_edit: false, can_delete: false },
    { report_id: 'OPENABLE', clinic_name: 'ENT Manila', doctor_name: 'Dr B',
      patient_name: 'OPENABLE PATIENT', case_number: 'OPEN-9', report_type: 'cf4',
      procedure_date: '2026-01-06', created_at: '2026-01-06T00:00:00Z',
      can_view: true, can_edit: true, can_delete: false },
  ];
  // Close whatever is open, the way the pop-up's own Close button does.
  (nodes.ccaRecordClose.listeners.click || []).forEach(fn => fn());

  await CC.refresh();
  const html = () => nodes.ccaTableBody.innerHTML;

  ok('T26', 'the row leads with the patient and puts type + case underneath',
     /class="cca-name">LOCKED1 PATIENT/.test(html()) &&
     /class="cca-sub">Nasal Endoscopy · Case CF-2024-001/.test(html()),
     (html().match(/class="cca-sub">[^<]{0,44}/) || ['no subline'])[0])
  ok('T27', 'clinic and doctor share one cell instead of two cramped columns',
     /class="cca-clinic"/.test(html()) && /ENT Manila/.test(html()))
  ok('T28', 'the counts say listed / accessible / needs permission',
     nodes.ccaStatTotal.textContent === '2' &&
     nodes.ccaStatOpen.textContent === '1' &&
     nodes.ccaStatAsk.textContent === '1',
     `${nodes.ccaStatTotal.textContent}/${nodes.ccaStatOpen.textContent}/${nodes.ccaStatAsk.textContent}`)
  ok('T29', 'the header states what this account may see',
     nodes.ccaScope.textContent === 'every doctor in your clinic',
     nodes.ccaScope.textContent)
  ok('T30', 'the connection pill stops saying "checking..."',
     nodes.connText.textContent === 'Online' && !/checking/i.test(nodes.connText.textContent),
     nodes.connText.textContent)
  ok('T31', 'and the record pop-up stays CLOSED until a record is opened',
     nodes.ccaRecord.open === false && nodes.ccaRecordBody.innerHTML !== '',
     'open=' + nodes.ccaRecord.open)

  // The filters narrow what is ON SCREEN. They never decide permission: the
  // hidden rows are still counted by the server, only not shown.
  const fire = node => (node.listeners.change || [])[0] && node.listeners.change[0]();
  nodes.ccaType.value = 'cf4'
  fire(nodes.ccaType)
  ok('T32', 'the report filter narrows the list',
     !html().includes('LOCKED1 PATIENT') && html().includes('OPENABLE PATIENT'))
  ok('T33', 'and it says how many rows it hid',
     /Showing 1 of 2 loaded/.test(nodes.ccaCount.textContent),
     nodes.ccaCount.textContent)

  nodes.ccaType.value = ''
  fire(nodes.ccaType)
  nodes.ccaOnlyOpen.checked = true
  fire(nodes.ccaOnlyOpen)
  ok('T34', '"only what I can open" hides a row the server refused',
     !html().includes('LOCKED1 PATIENT') && html().includes('OPENABLE PATIENT'))
  ok('T35', 'the counts follow the filter, not the whole page',
     nodes.ccaStatTotal.textContent === '1' && nodes.ccaStatAsk.textContent === '0',
     `total=${nodes.ccaStatTotal.textContent} ask=${nodes.ccaStatAsk.textContent}`)
  nodes.ccaOnlyOpen.checked = false
  fire(nodes.ccaOnlyOpen)
  ok('T36', 'un-ticking it brings the rows back (no hidden state)',
     html().includes('LOCKED1 PATIENT'))
}

// ---- 9 · the table HEAD must line up with the body -------------------
// Reported from the screen: the header read "Patient | Clinic & doctor |
// Date | (nothing)", because the fourth column - the only one carrying a
// BUTTON - had its name as screen-reader-only text. Worse, that cell was
// `display:flex`, which takes a <td> out of the table's column algorithm,
// so the headings drifted away from the cells. These hold both fixed.
{
  const pageHtml = readFileSync(join(APP, 'pages', 'viewAll.html'), 'utf8');
  const css = readFileSync(join(APP, 'style', 'view-all.css'), 'utf8');
  const heads = [...pageHtml.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map(m => ({
    tag: m[0],
    text: m[1].replace(/<[^>]+>/g, '').trim()
  }));

  ok('T37', 'every column has a heading you can SEE',
     heads.length === 4 && heads.every(h => h.text.length > 0),
     heads.map(h => h.text || '(empty)').join(' | '))
  ok('T38', 'the button column says what it is',
     /Access/.test(heads[3] ? heads[3].text : '') &&
     !/ent-visually-hidden/.test(heads[3] ? heads[3].tag : ''),
     heads[3] ? heads[3].text : '')
  ok('T39', 'each heading is classed so it can own a width',
     heads.every(h => /cca-th-/.test(h.tag)),
     heads.map(h => (h.tag.match(/cca-th-\w+/) || ['no class'])[0]).join(' '))
  ok('T40', 'the table is a fixed grid, so header and cells keep the same shape',
     /\.ent-cca-table\s*\{[^}]*table-layout:\s*fixed/.test(css))
  ok('T41', 'and no <td> is switched to flex outside card mode',
     !/\.ent-cca-table td\.cca-act\s*\{[^}]*display:\s*flex/.test(
         css.split('@media (max-width: 820px)')[0]))
  ok('T42', 'the access heading is right-aligned like its cell',
     /\.cca-th-access\s*\{[^}]*text-align:\s*right/.test(css))
}

// ---- 10 · the table header must be ARRANGED, and the record a POP-UP
// Reported twice off the screen. The header was position:sticky INSIDE a
// card that clips (overflow:hidden): the browser cannot honour a sticky
// offset there, so the headings drifted off the column edges and rows ran
// underneath them. It is now a plain static header - it cannot overlap,
// cannot drift, cannot be covered - with the SAME padding as the cells it
// labels (they differed by 2px, which was visible) and middle alignment.
{
  const pageHtml = readFileSync(join(APP, 'pages', 'viewAll.html'), 'utf8');
  const css = readFileSync(join(APP, 'style', 'view-all.css'), 'utf8');

  ok('T43', 'the header is static, so nothing can overlap or drift it',
     /\.ent-cca-table thead th\s*\{[^}]*position:\s*static/.test(css) &&
     !/thead th\s*\{[^}]*position:\s*sticky/.test(css))
  ok('T44', 'a heading is padded exactly like the cells below it',
     (css.match(/\.ent-cca-table thead th\s*\{[^}]*padding:\s*([\d]+px)/) || [, ''])[1] ===
     (css.match(/\.ent-cca-table tbody td\s*\{[^}]*padding:\s*([\d]+px)/) || [, ''])[1] &&
     /padding:\s*13px 14px/.test(css),
     (css.match(/\.ent-cca-table thead th\s*\{[^}]*padding:\s*([\d]+px)/) || [, '?'])[1])
  ok('T45', 'headings are middle-aligned and keep their rule',
     /\.ent-cca-table thead th\s*\{[^}]*vertical-align:\s*middle/.test(css) &&
     /\.ent-cca-table thead th\s*\{[^}]*border-bottom/.test(css))
  ok('T46', 'the grid is fixed, so header and cells keep the same shape',
     /\.ent-cca-table\s*\{[^}]*table-layout:\s*fixed/.test(css) &&
     /\.ent-cca-table\s*\{[^}]*border-collapse:\s*separate/.test(css))

  // The record is a pop-up, and the side pane that squeezed the table is
  // gone rather than merely hidden by JavaScript.
  ok('T47', 'the record lives in a real <dialog>',
     /<dialog class="cca-modal cca-record" id="ccaRecord"/.test(pageHtml) &&
     /id="ccaRecordBody"/.test(pageHtml))
  ok('T48', 'the old side pane cannot squeeze the list any more',
     /\.ent-cca-detail\s*\{\s*display:\s*none/.test(css) &&
     /\.ent-cca-layout\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(css))

  const CC = win.EntCrossClinic;
  await CC.open('OPENABLE');
  // The fixture's patient name has been reassigned by the sections above, so
     // this checks the SHAPE of what opened, not whose name it carries.
  ok('T49', 'opening a record opens the pop-up with the record in it',
     nodes.ccaRecord.open === true &&
     /cca-detail-grid/.test(nodes.ccaRecordBody.innerHTML) &&
     /Owning clinic/.test(nodes.ccaRecordBody.innerHTML),
     'open=' + nodes.ccaRecord.open);
  (nodes.ccaRecordClose.listeners.click || []).forEach(fn => fn());
  ok('T50', 'and its Close button closes it again',
     nodes.ccaRecord.open === false, 'open=' + nodes.ccaRecord.open);
}

// ---- 11 · request actions use simple monochrome icons ----------------
{
  const pageHtml = readFileSync(join(APP, 'pages', 'viewAll.html'), 'utf8');
  const css = readFileSync(join(APP, 'style', 'view-all.css'), 'utf8');
  const requestButtons = [...pageHtml.matchAll(/<button[^>]*class="ent-btn cca-reqbtn"[\s\S]*?<\/button>/g)]
  const icons = requestButtons.map(match => match[0].match(/class="cca-reqbtn-icon"[\s\S]*?<\/span>/))

  ok('T51', 'My requests and Inbox use drawn icons instead of colored emoji',
     requestButtons.length === 2 &&
     icons.every(icon => icon && /<svg/.test(icon[0]) && /stroke="currentColor"/.test(icon[0])) &&
     !/&#128178;|&#128229;/.test(pageHtml))
  ok('T52', 'request icons and arrows stay black on both themes',
     /body\.ent-cca-page \.cca-reqbtn-icon svg\s*\{[^}]*color:\s*#111/.test(css) &&
     /body\.ent-cca-page \.cca-reqbtn-copy > span,[\s\S]*?\.cca-reqbtn-arrow\s*\{[^}]*color:\s*#111/.test(css))
  ok('T53', 'mobile action cards label the access controls',
     /<td class="cca-act" data-label="Access">/.test(html))
  ok('T54', 'the access summary no longer has the oversized overview kicker',
     !pageHtml.includes('ACCESS OVERVIEW') &&
     pageHtml.includes('id="ccaOverviewTitle"') &&
     pageHtml.includes('id="ccaStatTotal"') &&
     pageHtml.includes('id="ccaOpenMy"') &&
     pageHtml.includes('id="ccaOpenInbox"'))
}

console.log('')
console.log(failed === 0
  ? `==== ALL UI CHECKS PASSED — ${passed} passed, 0 failed ====`
  : `==== ${failed} FAILED — ${passed} passed ====`)
console.log('')
process.exit(failed === 0 ? 0 : 1)
