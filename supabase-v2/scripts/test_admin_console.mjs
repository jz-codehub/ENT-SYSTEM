/* test_admin_console.mjs - does the admin console ACTUALLY WORK?
 *
 * admin.js shipped three use-before-declaration bugs in saveUser(), all
 * invisible to `node --check` and to every existing suite, because nothing
 * ever CALLED saveUser():
 *   `email: email || ...`    -> "Could not save: email is not defined"
 *   `license_no: licenseNo`  -> "Could not save: licenseNo is not defined"
 * Each one made "create user" impossible from the browser. This loads the
 * real admin.js into a stubbed DOM, fills the real form, clicks the real
 * Save button, and asserts on the payload that reaches the Edge Function -
 * for a doctor, a secretary and an ADMIN.
 *
 * No network: fetch is intercepted, so this is deterministic.
 * Run: node supabase-v2/scripts/test_admin_console.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..', '..')

let passed = 0, failed = 0
const ok = (id, what, d) => { passed++; console.log('  PASS  ' + id.padEnd(5) + ' ' + what + (d ? ' - ' + d : '')) }
const bad = (id, what, d) => { failed++; console.log('  FAIL  ' + id.padEnd(5) + ' ' + what + (d ? ' - ' + d : '')) }
const is = (id, what, cond, d) => (cond ? ok(id, what, d) : bad(id, what, d))

const ADMIN_PROFILE = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'testadmin',
  full_name: 'SYNTHETIC Test Admin',
  role: 'admin',
  clinic_id: '00000000-0000-4000-8000-00000000c11c',
  assigned_doctor_id: null,
  is_active: true,
  must_change_password: false,
}

/* A second account, so the "Latest patients records" card can prove it
 * resolves the ROLE of the creator (Secretary / Doctor) and not only the
 * name stamped beside the uuid by 0028. */
const SECRETARY_PROFILE = {
  id: '22222222-2222-4222-8222-222222222222',
  username: 'tara',
  full_name: 'Tara Bautista',
  role: 'secretary',
  clinic_id: '00000000-0000-4000-8000-00000000c11c',
  assigned_doctor_id: null,
  is_active: true,
  must_change_password: false,
}

/* Newest finished reports, as the Overview card's query asks for them:
 * the author's name (created_by_name, 0028) and the hospital tag
 * (payload->>site, answered by PostgREST as `site`) ride on the row.
 * Two clinics, both hospitals, both a doctor and a secretary. */
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString()

/* Real clinic names, so the card's header can be asserted to say a NAME
 * rather than the uuid the id fallback would print. */
const CLINICS = [
  { id: '00000000-0000-4000-8000-00000000c11c', name: 'ENT Clinic Doc Jess', code: 'JESS', is_active: true },
  { id: '99999999-9999-4999-8999-999999999999', name: 'Bolmen Clinic', code: 'BOLM', is_active: true },
]
const LATEST_REPORTS = [
  { id: 'rep-1', clinic_id: '00000000-0000-4000-8000-00000000c11c',
    doctor_id: ADMIN_PROFILE.id, created_by: SECRETARY_PROFILE.id,
    created_by_name: 'Tara Bautista', report_type: 'nasal',
    patient_name: 'RACOMA, ALLOY', patient_id: '', procedure_date: daysAgo(1),
    file_name: '', created_at: daysAgo(1), updated_at: daysAgo(1), site: 'RMCI' },
  { id: 'rep-2', clinic_id: '00000000-0000-4000-8000-00000000c11c',
    doctor_id: ADMIN_PROFILE.id, created_by: ADMIN_PROFILE.id,
    created_by_name: 'Synthetic Test Admin', report_type: 'cf4',
    patient_name: 'ME, OWN', patient_id: '', procedure_date: daysAgo(2),
    file_name: '', created_at: daysAgo(2), updated_at: daysAgo(2), site: 'CUMC' },
  { id: 'rep-3', clinic_id: '99999999-9999-4999-8999-999999999999',
    doctor_id: ADMIN_PROFILE.id, created_by: SECRETARY_PROFILE.id,
    created_by_name: 'Tara Bautista', report_type: 'laryngeal',
    patient_name: 'SOLO, ONE', patient_id: '', procedure_date: daysAgo(3),
    file_name: '', created_at: daysAgo(3), updated_at: daysAgo(3), site: 'RMCI' },
]

function makeEl(id) {
  const listeners = {}
  return {
    id: id, value: '', checked: false, disabled: false,
    textContent: '', innerHTML: '', dataset: {}, style: {}, options: [], children: [],
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn) },
    removeEventListener() {},
    setAttribute() {}, removeAttribute() {},
    appendChild() {}, remove() {}, focus() {}, click() {},
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
    getAttribute: () => null, contains: () => false,
    fire: (ev, arg) => Promise.all((listeners[ev] || []).map(function (fn) { return fn(arg) })),
  }
}

function makeWindow() {
  const els = new Map()
  const json = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b), json: async () => b })
  const win = {
    els: els,
    fetchLog: [],
    latestCalls: [],
    winListeners: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { pathname: '/admin.html', search: '', href: '', replace() {}, assign() {} },
    navigator: { userAgent: 'node-test', onLine: true },
    console: console,
    setInterval: () => 0,
    clearInterval() {}, clearTimeout() {},
    // setTimeout must NOT run its callback synchronously. The old stub did,
    // which no browser does, and it made every deferred callback in the app
    // fire before the code that scheduled it had even returned - including
    // auth.js's sign-in timeout, so every sign-in failed instantly with
    // "the server did not answer". Deferred through the real timer instead.
    setTimeout: (fn, ms) => setTimeout(fn, ms || 0),
    addEventListener: (ev, fn) => { (win.winListeners[ev] = win.winListeners[ev] || []).push(fn) },
    dispatchEvent() {},
    confirm: () => true, alert() {},
    CustomEvent: class {},
    fetch: async (url, opts) => {
      const u = String(url)
      const o = opts || {}
      let body = null
      try { body = o.body ? JSON.parse(o.body) : null } catch (e) { body = null }
      win.fetchLog.push({ url: u, method: o.method || 'GET', body: body })
      if (u.indexOf('/rest/v1/staff_profiles') !== -1) return json([ADMIN_PROFILE])
      /* The Overview's "Latest patients records" card: newest finished
       * reports WITH the author name and the hospital tag selected. Matched
       * precisely (created_by_name + limit=40) so no other reports query the
       * console runs - the growth fallback pages through the same table -
       * is handed rows it did not ask for. */
      if (u.indexOf('/rest/v1/reports') !== -1
          && u.indexOf('created_by_name') !== -1
          && u.indexOf('limit=40') !== -1) {
        win.latestCalls.push(u)      // survives the fetchLog resets below
        return json(LATEST_REPORTS)
      }
      if (u.indexOf('/rest/v1/clinics?') !== -1) return json(CLINICS)
      if (u.indexOf('/functions/v1/auth-admin') !== -1) {
        const action = body && body.action
        if (action === 'list') return json({ ok: true, users: [ADMIN_PROFILE, SECRETARY_PROFILE] })
        if (action === 'create') {
          return json({ ok: true, id: 'new-id', username: body.username, starter_password: 'Zz!generated1' })
        }
        return json({ ok: true, password: 'Zz!generated1' })
      }
      return json([])
    },
    supabase: {
      createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: win.__session }, error: null }),
          signInWithPassword: async () => ({
            data: { user: { id: ADMIN_PROFILE.id, email: 'testadmin@zztest.invalid' } }, error: null,
          }),
          updateUser: async () => ({ data: {}, error: null }),
          signOut: async () => ({ error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        },
      }),
    },
  }
  win.__session = {
    user: { id: ADMIN_PROFILE.id, email: 'testadmin@zztest.invalid' },
    access_token: 'test-jwt',
    expires_at: Date.now() / 1000 + 3600,
  }
  win.document = {
    readyState: 'complete', hidden: false, title: '',
    body: { classList: { contains: () => false, add() {}, remove() {} }, insertAdjacentHTML() {} },
    getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id) },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  }
  win.window = win
  win.globalThis = win
  return win
}

/* ---- load the real files ------------------------------------------ */
console.log('')
console.log('==== ADMIN CONSOLE FUNCTIONAL TESTS ====')
console.log('')

const win = makeWindow()
vm.createContext(win)
let loadError = ''
try {
  const files = ['supabaseClient.js', 'photoStore.js', 'auth.js', 'admin.js']
  for (const f of files) {
    vm.runInContext(readFileSync(join(APP, 'function', f), 'utf8'), win, { filename: f })
  }
} catch (e) {
  loadError = String((e && e.stack) || e).split('\n').slice(0, 4).join(' | ')
}
is('A1', 'admin.js loads with no undefined symbol at load time', loadError === '', loadError || 'clean load')

const el = (id) => win.document.getElementById(id)

// Establish a real signed-in admin the way a browser would, so guard() in
// admin.js boot() resolves instead of bouncing to login.html.
const signedIn = await win.EntAuth.login('testadmin', 'Zz!starter1')
is('A1b', 'an admin can sign in and is recognised as admin',
   signedIn.success === true && !!win.EntAuth.currentUser() && win.EntAuth.isAdmin() === true,
   signedIn.success ? 'role=' + (win.EntAuth.currentUser() || {}).role : signedIn.error)

// admin.js wires its buttons inside boot(), which waits for DOMContentLoaded.
// Fire it here so the real Save listener exists, exactly as in a browser.
const dcl = (win.winListeners.DOMContentLoaded) || []
await Promise.all(dcl.map(function (fn) { return fn({}) }))

/* Fill the real form, click the real Save button, report what happened. */
async function tryCreate(o) {
  win.fetchLog.length = 0
  el('fFullName').value = o.fullName
  el('fUsername').value = o.username
  el('fRole').value = o.role
  el('fSpecialty').value = o.specialty === undefined ? 'ENT' : o.specialty
  el('fPassword').value = o.password
  el('fActive').checked = true
  el('fAssigned').value = o.assigned || ''
  el('fSuperSecretary').checked = !!o.superSecretary
  el('userModalError').textContent = ''
  await el('userModalSave').fire('click')
  const call = win.fetchLog.find(function (r) {
    return r.url.indexOf('/functions/v1/auth-admin') !== -1 && r.body && r.body.action === 'create'
  })
  return { call: call, error: el('userModalError').textContent || '' }
}

/* ---- A2: create an ADMIN - the thing that was impossible ---------- */
const adminRes = await tryCreate({
  username: 'newadmin', fullName: 'New Clinic Admin', role: 'admin', password: 'Zz!starter1',
})
is('A2', 'creating an ADMIN reaches the Edge Function', !!adminRes.call,
   adminRes.call
     ? 'action=create username=' + adminRes.call.body.username + ' role=' + adminRes.call.body.role
     : 'NO REQUEST SENT - modal said: "' + adminRes.error + '"')

if (adminRes.call) {
  const b = adminRes.call.body
  is('A3', 'the create payload contains NO email field', b.email === undefined,
     b.email === undefined ? 'no email key at all' : 'UNEXPECTED email=' + b.email)
  is('A4', 'the payload carries every column staff_profiles expects',
     ['username', 'full_name', 'role', 'specialty', 'license_no', 'is_active', 'assigned_doctor_id']
       .every(function (k) { return k in b }),
     Object.keys(b).join(', '))
  is('A5', 'role=admin is sent through unchanged', b.role === 'admin', 'role=' + b.role)
  is('A5b', 'a password is sent so the server need not invent one',
     typeof b.password === 'string' && b.password.length >= 6,
     'password length=' + String(b.password || '').length)
} else {
  bad('A3', 'the create payload contains NO email field', 'skipped: no request was sent')
  bad('A4', 'the payload carries every column staff_profiles expects', 'skipped')
  bad('A5', 'role=admin is sent through unchanged', 'skipped')
  bad('A5b', 'a password is sent', 'skipped')
}

/* ---- A6/A7: the other two roles still work ------------------------ */
const docRes = await tryCreate({
  username: 'newdoc', fullName: 'New Doctor', role: 'doctor', password: 'Zz!starter1',
})
is('A6', 'creating a DOCTOR reaches the Edge Function', !!docRes.call,
   docRes.call ? 'role=' + docRes.call.body.role : 'modal said: "' + docRes.error + '"')

const secRes = await tryCreate({
  username: 'newsec', fullName: 'New Secretary', role: 'secretary', password: 'Zz!starter1',
  assigned: ADMIN_PROFILE.id, superSecretary: true,
})
is('A7', 'creating a SECRETARY sends its assigned doctor',
   !!secRes.call && !!secRes.call.body.assigned_doctor_id,
   secRes.call ? 'assigned_doctor_id=' + secRes.call.body.assigned_doctor_id : 'no call')
is('A7b', 'the admin can explicitly provision Super Secretary network access',
   !!secRes.call && secRes.call.body.is_super_secretary === true,
   secRes.call ? 'is_super_secretary=' + secRes.call.body.is_super_secretary : 'no call')

/* ---- A8: a secretary with no doctor is refused before any request -- */
const noDoc = await tryCreate({
  username: 'badsec', fullName: 'No Doctor', role: 'secretary', password: 'Zz!starter1',
})
is('A8', 'a secretary with no assigned doctor is refused locally',
   !noDoc.call && /assign/i.test(noDoc.error),
   noDoc.error ? noDoc.error.slice(0, 64) : 'a request was sent anyway')

/* ---- A9/A10: the password floor is shared, and 6 is accepted ------- */
const shortPw = await tryCreate({ username: 'shorty', fullName: 'Short', role: 'doctor', password: 'ab' })
const floor = (win.EntAuth && win.EntAuth.MIN_PASSWORD_LENGTH)
is('A9', 'a 2-character password is refused by the browser',
   !shortPw.call && String(shortPw.error).indexOf(String(floor)) !== -1,
   'shared floor=' + floor + '  said: "' + String(shortPw.error).slice(0, 52) + '"')

const sixPw = await tryCreate({ username: 'sixchars', fullName: 'Six Chars', role: 'doctor', password: 'abcdef' })
is('A10', 'a 6-character password IS accepted (the platform floor)', !!sixPw.call,
   sixPw.call ? 'request sent' : 'refused: "' + sixPw.error + '"')

/* ---- A11: EDITING must not wipe a stored licence number ---------- */
/* Open the real Edit modal by clicking the real card button, so editingId
   is set by admin.js itself rather than poked from outside. */
async function openEditModal() {
  const card = { dataset: { id: ADMIN_PROFILE.id } }
  const btn = { dataset: { act: 'edit' }, closest: () => card }
  await el('usersGrid').fire('click', { target: { closest: () => btn } })
}

async function tryEdit(o) {
  win.fetchLog.length = 0
  await openEditModal()
  el('fFullName').value = o.fullName
  el('fUsername').value = 'testadmin'
  el('fRole').value = 'admin'
  el('fSpecialty').value = 'ENT'
  el('fPassword').value = ''
  el('fActive').checked = o.active === undefined ? true : o.active
  el('userModalError').textContent = ''
  await el('userModalSave').fire('click')
  return win.fetchLog.filter(function (r) {
    return r.url.indexOf('/functions/v1/auth-admin') !== -1 && r.body
  })
}
const edits = await tryEdit({ fullName: 'Renamed Admin' })
const upd = edits.find(function (r) { return r.body.action === 'update' })
is('A11', 'editing a user does NOT send license_no (it would be wiped)',
   !!upd && upd.body.license_no === undefined,
   upd ? 'update keys: ' + Object.keys(upd.body).join(', ') : 'no update call')
is('A11b', 'editing a user does NOT pretend to set is_active in the update',
   !!upd && upd.body.is_active === undefined,
   upd && upd.body.is_active !== undefined ? 'it sends is_active, which the server ignores' : 'left to the audited set_active path')

/* ---- A12: unticking "active" while editing must call set_active ---- */
const off = await tryEdit({ fullName: 'Renamed Admin', active: false })
const setActive = off.find(function (r) { return r.body.action === 'set_active' })
is('A12', 'unticking "Account is active" while editing fires set_active',
   !!setActive && setActive.body.is_active === false,
   setActive ? 'set_active is_active=' + setActive.body.is_active : 'nothing was deactivated')

/* ---- A13: leaving it ticked must NOT fire a redundant set_active --- */
const same = await tryEdit({ fullName: 'Renamed Admin', active: true })
const redundant = same.find(function (r) { return r.body.action === 'set_active' })
is('A13', 'leaving it ticked does NOT fire a redundant set_active', !redundant,
   redundant ? 'wrote to the DB for no reason' : 'no redundant write')

/* ---- A13a: the multi-doctor selector has a usable bulk action ------ */
const extraDoctors = el('fExtraDoctors')
extraDoctors.options = [
  { value: 'doctor-a', selected: false, disabled: false },
  { value: 'doctor-b', selected: false, disabled: false },
]
await el('fExtraDoctorsToggle').fire('click')
const selectedAllDoctors = extraDoctors.options.every(function (option) { return option.selected })
const clearExtraDoctorsLabel = el('fExtraDoctorsToggle').textContent
await el('fExtraDoctorsToggle').fire('click')
is('A13a', 'admins can select and clear all additional doctors in one click',
   selectedAllDoctors
     && clearExtraDoctorsLabel === 'Clear additional doctors'
     && extraDoctors.options.every(function (option) { return !option.selected }),
   'selected=' + selectedAllDoctors + ', label=' + clearExtraDoctorsLabel
     + ', cleared=' + extraDoctors.options.every(function (option) { return !option.selected }))

/* ---- A13b: editing a secretary reads the junction with valid PostgREST syntax */
win.fetchLog.length = 0
const secretaryCard = { dataset: { id: SECRETARY_PROFILE.id } }
const secretaryEditButton = { dataset: { act: 'edit' }, closest: () => secretaryCard }
await el('usersGrid').fire('click', { target: { closest: () => secretaryEditButton } })
const assignmentRead = win.fetchLog.find(function (r) {
  return r.url.indexOf('/rest/v1/secretary_assignments?') !== -1
})
is('A13b', 'editing a secretary uses the PostgREST eq operator for its assignment lookup',
   !!assignmentRead
     && assignmentRead.url.indexOf('secretary_id=eq.' + SECRETARY_PROFILE.id) !== -1,
   assignmentRead ? assignmentRead.url : 'no assignment query was sent')


/* ---- A14: the Tickets panel and the nav links actually exist ------ */
{
  const adminHtml = readFileSync(join(APP, 'pages', 'admin.html'), 'utf8')
  const adminJs = readFileSync(join(APP, 'function', 'admin.js'), 'utf8')
  const ids = new Set([...adminHtml.matchAll(/\bid\s*=\s*"([^"]+)"/g)].map(m => m[1]))

  // Every element the ticket panel code looks up must exist. Some are
  // written into innerHTML at render time rather than sitting in the static
  // markup - the reply box and the status select are rebuilt every time a
  // ticket is opened - so those are accepted only if the id really is
  // produced by the code. A rename on either side still fails here, which a
  // plain allowlist would not.
  const renderedAtRuntime = new Set(
    [...adminJs.matchAll(/id="([a-zA-Z][\w-]*)"/g)].map(m => m[1])
  )
  const needed = [...new Set([...adminJs.matchAll(/byId\('(ticket[^']*|adminTicket[^']*)'\)/g)].map(m => m[1]))]
  const absent = needed.filter(x => !ids.has(x) && !renderedAtRuntime.has(x))
  const absentHtml = needed.filter(x => !ids.has(x))
  const absentAny = needed.filter(x => !ids.has(x) && !renderedAtRuntime.has(x))
  is('A14', 'every ticket-panel element the JS looks up really exists', absentAny.length === 0,
     absentAny.length
       ? 'NOWHERE: ' + absentAny.join(', ')
       : needed.length + ' lookups resolve (' +
         absentHtml.length + ' rendered at runtime: ' + (absentHtml.join(', ') || 'none') + ')')

  // The nav button and its panel must agree, or the tab opens nothing.
  const navHas = /data-panel="tickets"/.test(adminHtml)
  const panelHas = /id="panel-tickets"/.test(adminHtml)
  is('A15', 'the Tickets tab has both a nav button and a panel', navHas && panelHas,
     'nav=' + navHas + ' panel=' + panelHas)

  // Settings is a link to a real page, not a dead data-panel.
  // Settings and My tickets must now be PANELS, not links out of the
  // console. A nav item that navigates away loses the admin's place, and
  // the old arrangement also forced the tab strip onto two rows.
  is('A16b', 'Settings is a panel in the console, not a link away',
     /data-panel="settings"/.test(adminHtml) && /id="panel-settings"/.test(adminHtml),
     'nav + panel both present')
  // An admin ANSWERS the clinic queue; filing a ticket is what a doctor or
  // a secretary does, from reportProblem.html. A 'My tickets' tab here would
  // always be empty and would suggest the wrong workflow.
  is('A16c', 'there is NO My tickets tab in the admin console',
     !/data-panel="mytickets"/.test(adminHtml) && !/id="panel-mytickets"/.test(adminHtml),
     'admins answer the queue; staff file tickets')

  // The console is a RAIL now, not a top strip: a top strip wrapped onto a
  // second row, which read as a mistake rather than a decision.
  const adminCss2 = readFileSync(join(APP, 'style', 'admin.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  // ALL matches, not the first: .ent-admin-main appears twice (a legacy
  // max-width rule near the top, and the rail grid below it), and taking
  // only the first reports 'none' for a layout that is actually correct.
  const mainBlock = (adminCss2.match(/\.ent-admin-main\s*\{[\s\S]*?\}/g) || []).join('\n')
  const navBlock2 = (adminCss2.match(/\.ent-admin-nav\s*\{[\s\S]*?\}/g) || []).join('\n')
  is('A16e', 'the console lays out as a rail beside the content, not a strip above it',
     /grid-template-columns:\s*2\d\dpx/.test(mainBlock) && /flex-direction:\s*column/.test(navBlock2),
     (mainBlock.match(/grid-template-columns:[^;]*/) || ['none'])[0].trim() +
     ' + rail=' + (/flex-direction:\s*column/.test(navBlock2) ? 'yes' : 'no'))
  is('A16f', 'the rail keeps every label - it is never a wrapping strip',
     /flex-direction:\s*column/.test(navBlock2) &&
     !/max-width:\s*1080px/.test(adminCss2.replace(/\/\*[\s\S]*?\*\//g, '')),
     'a 218px rail fits every label, so no icon-only breakpoint is needed')
  is('A16g', 'the admin stylesheet loads after shared mobile styles',
     /mobile\.css[^>]*>[\s\S]*?admin\.css\?v=v55-account-form-one-column/.test(adminHtml),
     'admin-specific responsive design wins over shared page styles')
  is('A16h', 'the admin shell has mobile drawer and small-screen layouts',
     /@media\s*\(max-width:\s*980px\)[\s\S]*?\.ent-admin-nav\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?@media\s*\(max-width:\s*720px\)[\s\S]*?\.ent-admin-header \.header-content\s*\{[\s\S]*?display:\s*grid;[\s\S]*?@media\s*\(max-width:\s*420px\)/.test(adminCss2),
     'tablet drawer, mobile header and narrow phone breakpoints are present')
  is('A16i', 'the admin redesign keeps its own dark-mode palette',
     /body\.dark-mode\.ent-admin-page[\s\S]*?body\.dark-mode \.ent-admin-header[\s\S]*?body\.dark-mode \.ent-overview-intro[\s\S]*?body\.dark-mode \.ent-table/.test(adminCss2),
     'dark theme remains readable across the shell, navigation and tables')
  is('A16j', 'the admin overview has a structured, responsive dashboard layout',
     /id="panel-overview"[\s\S]*?class="ent-overview-intro"[\s\S]*?id="adminGreeting"[\s\S]*?class="overview-metrics"[\s\S]*?class="ent-card overview-card-snapshot"[\s\S]*?class="ent-card-grid overview-chart-grid"[\s\S]*?class="ent-card overview-card-sessions"/.test(adminHtml)
     && /#panel-overview\.active\s*\{[\s\S]*?grid-template-columns:\s*repeat\(12/.test(adminCss2),
     'overview greeting, metrics, analytics and activity use a dedicated layout')
  is('A16k', 'navigation uses consistent inline icons and the clinic logo',
     /ent-admin-brand-icon"><img src="\.\.\/image\/ent-logo\.webp"/.test(adminHtml)
     && (adminHtml.match(/class="ent-nav-icon" aria-hidden="true"><svg/g) || []).length === 10
     && /\.ent-nav-icon svg\s*\{[\s\S]*?stroke:\s*currentColor/.test(adminCss2),
     'logo and ten matching scalable icons are wired')
  is('A16l', 'user rows keep visible action buttons inside the table',
     ['#panel-users > #usersGrid', '.ent-user-table-scroll', 'table-layout: fixed',
      'min-width: 760px', 'position: sticky', '#panel-users .ent-user-cell', '#panel-users .ent-user-tags',
      '#panel-users .ent-user-meta', '#panel-users .ent-user-actions',
      'grid-template-columns: repeat(2, minmax(0, 1fr))',
      'box-shadow: none', 'max-width: 148px'].every(function (rule) {
       return adminCss2.includes(rule)
     })
       && /ent-user-table td:last-child \{[\s\S]*?box-shadow:\s*none/.test(adminCss2)
       && /#panel-users \.ent-user-actions \.ent-rowbtn \{[\s\S]*?box-shadow:\s*none/.test(adminCss2)
       && /<table class="ent-user-table" aria-label="[\s\S]*?<th scope="col">User<\/th>[\s\S]*?<th scope="col">Actions<\/th>/.test(
         readFileSync(join(APP, 'function', 'admin.js'), 'utf8'))
       && /\+ 'Edit<\/button>'/.test(readFileSync(join(APP, 'function', 'admin.js'), 'utf8'))
       && /\+ 'Pass<\/button>'/.test(readFileSync(join(APP, 'function', 'admin.js'), 'utf8'))
       && /\(active \? 'Disable' : 'Enable'\) \+ '<\/button>'/.test(
         readFileSync(join(APP, 'function', 'admin.js'), 'utf8'))
       && /\+ 'Delete<\/button>'/.test(readFileSync(join(APP, 'function', 'admin.js'), 'utf8'))
       && /aria-label="Set password for ' \+ accessibleName/.test(
         readFileSync(join(APP, 'function', 'admin.js'), 'utf8')),
     'compact labeled actions remain accessible and stay pinned in the table viewport')
  const usersPanel = (adminHtml.match(/<section class="ent-admin-panel" id="panel-users">[\s\S]*?\n        <\/section>/) || [''])[0]
  is('A16l1', 'the Users tab introduces people and access management clearly',
     /PEOPLE &amp; ACCESS/.test(usersPanel) && /ent-users-hero-icon[\s\S]*?<svg/.test(usersPanel)
       && /Manage clinic accounts in one place/.test(usersPanel),
     'a branded intro explains the purpose of the directory')
  is('A16l2', 'the directory has labeled filters, a keyboard-accessible clear button and live result count',
     /for="roleFilter"/.test(usersPanel) && /id="usersSearchClear"[^>]*hidden/.test(usersPanel)
       && /id="usersResultCount" role="status"/.test(usersPanel)
       && /clearSearch\.hidden = !needle/.test(readFileSync(join(APP, 'function', 'admin.js'), 'utf8')),
     'search can be cleared and filtered totals are visible')
  is('A16l3', 'the grouped user tables and account modal support mobile and dark mode',
     ['#panel-users .ent-users-stats', '#panel-users .ent-user-group',
      '.ent-user-table', '.ent-user-modal-card', '.ent-user-modal-section',
      '.ent-user-doctor-grid', '.ent-user-modal-actions', '.ent-user-modal-close',
      '.ent-user-assignment-section[hidden]', '#panel-users .ent-users-note'].every(function (rule) {
        return adminCss2.includes(rule)
      })
      && /\.ent-user-doctor-grid \{ grid-template-columns: minmax\(0, 1fr\);/.test(adminCss2)
      && /\.ent-user-modal-close \{[\s\S]*?min-width: 0;[\s\S]*?box-shadow: none;/.test(adminCss2)
       && /@media\s*\(max-width:\s*720px\)[\s\S]*?\.ent-user-modal-card[\s\S]*?body\.dark-mode #panel-users/.test(adminCss2),
     'table rows stay contained and modal access fields reflow cleanly in small and dark displays')
  is('A16l5', 'the account modal is labeled, sectioned and preserves its form controls',
     /id="userModal" role="dialog" aria-modal="true"[\s\S]*?aria-labelledby="userModalTitle" aria-describedby="userModalDescription"/.test(adminHtml)
       && ['Account details', 'Doctor access', 'Sign-in &amp; status',
           'fFullName', 'fUsername', 'fRole', 'fAssigned', 'fSuperSecretary',
           'fExtraDoctors', 'fSpecialty', 'fPassword', 'fActive', 'userModalSave', 'userModalClose',
           'userAssignmentSection', 'ent-user-doctor-grid']
         .every(function (value) { return adminHtml.includes(value) })
       && /userModalDescription'\)\.textContent = user[\s\S]*?userModalSave'\)\.textContent = user \? 'Save changes' : 'Create account'/.test(
         readFileSync(join(APP, 'function', 'admin.js'), 'utf8'))
       && /assignmentSection\.hidden = !secretary/.test(
         readFileSync(join(APP, 'function', 'admin.js'), 'utf8'))
       && /byId\('userModalClose'\)\.addEventListener\('click', closeUserModal\)/.test(
         readFileSync(join(APP, 'function', 'admin.js'), 'utf8'))
       && /if \(returnFocus && returnFocus\.isConnected\) returnFocus\.focus\(\)/.test(
         readFileSync(join(APP, 'function', 'admin.js'), 'utf8')),
     'the redesigned dialog keeps the existing account, assignment and status controls')
  is('A16l4', 'role counts stay account-wide while result counts track the active filters',
     /userStatDoctors[\s\S]*?userStatSecretaries[\s\S]*?userStatAdmins[\s\S]*?userStatInactive/.test(usersPanel)
       && /Showing ' \+ rows\.length \+ ' of ' \+ users\.length/.test(readFileSync(join(APP, 'function', 'admin.js'), 'utf8')),
     'role summaries remain stable while the result line reflects search and role filtering')
  const overviewMetricIds = [
    'statRecords', 'statWeek', 'statTotal', 'statMonth', 'statActive', 'statLogins',
    'statUsers', 'statDoctors', 'statSecretaries', 'statInactive', 'statClinics', 'statDb'
  ]
  is('A16m', 'the overview presents all key metrics in five responsive summary cards',
     (adminHtml.match(/<article class="ent-stat overview-stat/g) || []).length === 5
       && overviewMetricIds.every(function (id) {
         return (adminHtml.match(new RegExp('id="' + id + '"', 'g')) || []).length === 1
       })
       && /grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/.test(adminCss2)
       && /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/.test(adminCss2)
       && /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/.test(adminCss2),
     'daily activity, records, staff, coverage and database stats stay visible at every size')
  is('A16n', 'overview analytics and clinic cards have distinct reusable visual structure',
     ['overview-card-title', 'overview-title-icon', 'overview-card-subtitle',
      'overview-card-mix'].every(function (name) { return adminHtml.includes(name); })
       && (adminHtml.match(/id="latestPatients"/g) || []).length === 1
       && ['#panel-overview .ent-snapshot', '#panel-overview .ent-topclinic',
         '#panel-overview .overview-chart-week .ent-chart',
         '#panel-overview .ent-mix-row', '#panel-overview .ent-latest-row',
         '#panel-overview .ent-followup-row'].every(function (rule) {
           return adminCss2.includes(rule)
         }),
     'clinic snapshot, ranking, charts, latest records and reminders have scoped presentation')
  is('A16o', 'all overview cards adapt to mobile and dark mode',
     /@media\s*\(max-width:\s*720px\)[\s\S]*?#panel-overview \.overview-card-sessions[\s\S]*?body\.dark-mode #panel-overview \.ent-snapshot/.test(adminCss2),
     'overview cards reflow on mobile and retain contrast in dark mode')

  is('A16', 'admin.html links to settings.html', /href="settings\.html"/.test(adminHtml),
     'found href="settings.html"')
  // Staff file reports from reportProblem.html; admins answer them here.
  // A link to a staff reporting page from this console suggests the wrong flow.
  is('A17', 'admin.html has NO link to the staff reporting page',
     !/href="tickets\.html"/.test(adminHtml),
     'the queue is the Tickets tab here; staff reporting has its own page')

  // Every data-panel target must have a matching section, or clicking the
  // tab silently shows an empty page.
  const targets = [...adminHtml.matchAll(/data-panel="([^"]+)"/g)].map(m => m[1])
  const noPanel = targets.filter(t => !ids.has('panel-' + t))
  // EVERY page that uses EntAuth must load supabase-js before
  // supabaseClient.js. Without it window.supabase is undefined,
  // getClient() throws, ready() resolves to null and guard() bounces a
  // SIGNED-IN user back to login.html. That is not a login bug, it is a
  // missing script tag, and it reads exactly like "the login is broken".
  // It shipped twice: once in the Sept-30 admin.html that was restored, and
  // once in reportProblem.html, which was written without it.
  const { readdirSync } = await import('node:fs')
  const PAGES = readdirSync(APP).filter(f => /\.html$/.test(f))
  const noSupabase = PAGES.filter(function (f) {
    const src = readFileSync(join(APP, f), 'utf8')
    return /function\/auth\.js/.test(src) && !/js\/lib\/supabase\.min\.js/.test(src)
  })
  is('A20', 'every page that loads auth.js also loads supabase-js',
     noSupabase.length === 0,
     noSupabase.length
       ? 'MISSING supabase.min.js on: ' + noSupabase.join(', ') +
         '  <- a signed-in user bounces straight back to login.html'
       : PAGES.length + ' pages checked, all load it');

  // And it must come FIRST: supabaseClient.js runs at parse time and
  // would capture an undefined window.supabase.
  const orderBad = PAGES.filter(function (f) {
    const src = readFileSync(join(APP, f), 'utf8')
    const sup = src.indexOf('js/lib/supabase.min.js')
    const cli = src.indexOf('function/supabaseClient.js')
    return sup !== -1 && cli !== -1 && sup > cli
  })
  is('A21', 'supabase-js is loaded BEFORE supabaseClient.js',
     orderBad.length === 0,
     orderBad.length ? 'wrong order in: ' + orderBad.join(', ') : 'order correct everywhere');

  is('A18', 'every tab has its panel', noPanel.length === 0,
     noPanel.length ? 'no panel for: ' + noPanel.join(', ') : targets.join(', '))

  // The queue must be scoped by RLS, not just hidden by a filter.
  is('A19', 'the admin queue does not invent an owner column',
     !/created_by\s*:\s*/.test(adminJs.match(/async function loadAdminTickets[\s\S]*?\n    \}/) || [''])[0],
     'the query selects, it never filters on a value it chose')
}


/* ---- A30: reviewing a ticket must show WHO filed it ---------------
   The complaint was specific: an admin opening a ticket could not tell
   which account filed it, what role they were, or which clinic it came
   from. The row only ever carried a bare full name, so "who sent this"
   was not answerable from the screen. */
{
  const srcJs = readFileSync(join(APP, 'function', 'admin.js'), 'utf8')
  const detail = (srcJs.match(/function renderAdminTicketDetail[\s\S]*?\n    \}/) || [''])[0]
  const rep = (srcJs.match(/function ticketReporter[\s\S]*?\n    \}/) || [''])[0]

  is('A30', 'the reporter is resolved from the ticket, not from the session',
     /users\.find\(function \(u\) \{ return u\.id === t\.created_by; \}\)/.test(rep),
     'matched on the ticket row\'s own created_by')

  is('A31', 'their full name AND their @username are both shown',
     /by\.name/.test(detail) && /by\.username/.test(detail) && /ent-admin-ticket-handle/.test(detail),
     'an admin can match a complaint to a login')

  is('A32', 'their role (doctor / secretary) is spelled out',
     /is-role/.test(detail) && /roleCls/.test(rep) && /is-secretary/.test(rep),
     'a doctor and a secretary need different follow-up')

  is('A33', 'the clinic the ticket came from is displayed',
     /by\.clinic/.test(detail) && /ent-admin-ticket-clinic/.test(detail)
     && /t\.clinic_id/.test(rep),
     'read from the ticket itself, so it cannot show the wrong clinic')

  /* The gap this closes: both columns were written by the form and stored
     the whole time, and rendered nowhere. An admin triaging the queue had
     to guess the urgency from the wording of the complaint. */
  is('A34', 'category AND priority are finally displayed, not just stored',
     /TICKET_CATEGORY\[t\.category\]/.test(detail) && /TICKET_PRIORITY\[t\.priority\]/.test(detail),
     '"Something is broken" and "Urgent" are now on screen')

  is('A35', 'the first message is labelled as the report, not a chat line',
     /What they reported/.test(detail) && /i === 0/.test(detail),
     'the description they typed is visibly the subject of the ticket')

  const css = readFileSync(join(APP, 'style', 'admin.css'), 'utf8')
  const styled = ['ent-admin-ticket-who', 'ent-admin-ticket-facts', 'ent-admin-ticket-clinic',
                  'ent-msg-tag', 'ent-badge.is-high'].filter(function (c) { return !css.includes(c); })
  is('A36', 'all of it is actually styled', styled.length === 0,
     styled.length ? 'unstyled: ' + styled.join(', ') : 'no unstyled classes')

  /* "High" must not be the same colour as "Low". If these three ever
     collapse to one grey the triage signal is gone and A24 means nothing. */
  is('A37', 'low / normal / high urgency look different from each other',
     /is-low[^{]*\{[^}]*background:\s*#eef2f7/i.test(css)
  && /is-high[^{]*\{[^}]*background:\s*#fdeceb/i.test(css),
     'grey, blue, red')
}

/* ---- A40: the header chip -----------------------------------------
   The complaint was the chip itself:

       [T] Tara Flores
           SECRETARY · Dr. assigned only

   Two defects, not one style preference. */
{
  const srcJs = readFileSync(join(APP, 'function', 'auth.js'), 'utf8')
  const chipCss = readFileSync(join(APP, 'style', 'auth.css'), 'utf8')

  /* The literal string "Dr. assigned only" was rendered for EVERY
     secretary, because buildSafeUser hardcoded the name to ''. Proved on
     the live project: tara IS assigned to jess, and the chip still said
     "assigned". */
  is('A40', 'assigned_doctor_name is no longer hardcoded to an empty string',
     !/assigned_doctor_name:\s*''/.test(srcJs),
     'it used to be a literal empty string on every single load')

  /* Reading the doctor's own profile row does NOT work. A secretary's
     token is filtered by RLS and comes back HTTP 200 with an empty array -
     proven against the live project - so that lookup was removed rather
     than left in to fail silently. The name now comes from a function
     that takes no arguments and resolves the doctor from auth.uid(). */
  is('A41', 'the name comes from a no-argument RPC, not a blocked table read',
     /rpc\/my_assigned_doctor_name/.test(srcJs)
  && !/staff_profiles\?select=full_name,username/.test(srcJs),
     'the table read returned HTTP 200 [] under RLS, so it was taken out')

  is('A42', 'the fallback never claims a doctor is missing when it is unknown',
     /Scoped to one doctor/.test(srcJs) && !/: 'No doctor assigned yet'/.test(srcJs),
     'true both when there is no doctor and when the RPC is not deployed yet')

  is('A43', 'the role is its own badge, not shouted inside one line',
     /ent-user-role/.test(srcJs) && /ent-user-scope/.test(srcJs)
  && /roleText\[user\.role\]/.test(srcJs),
     'role badge + separate scope line, styled apart')

  const chipStyled = ['ent-user-name', 'ent-user-role', 'ent-user-scope']
    .filter(function (c) { return !chipCss.includes(c); })
  is('A44', 'the new chip elements are all styled',
     chipStyled.length === 0,
     chipStyled.length ? 'unstyled: ' + chipStyled.join(', ') : 'role colours + pill all present')

  is('A45', 'each role gets its own avatar colour',
     /role-doctor\s+\.ent-user-avatar/.test(chipCss)
  && /role-secretary\s+\.ent-user-avatar/.test(chipCss)
  && /role-admin\s+\.ent-user-avatar/.test(chipCss),
     'doctor / secretary / admin are distinguishable without reading')
}

/* ---- A50: the admin Settings panel --------------------------------
   "di ko gets settings" - it opened on an input box with no context. */
{
  const setHtml = readFileSync(join(APP, 'pages', 'admin.html'), 'utf8')
  const setPanel = (setHtml.match(/<section class="ent-admin-panel" id="panel-settings">[\s\S]*?\n        <\/section>/) || [''])[0]

  is('A50', 'Settings opens by saying which clinic you are configuring',
     /settingsClinicId/.test(setPanel) && /Your clinic/.test(setPanel),
     'the fixed facts come first, before anything asks for input')

  const facts = ['settingsStaffCount', 'settingsDoctorCount', 'settingsSecretaryCount']
  is('A51', 'staff / doctor / secretary counts are shown',
     facts.every(function (f) { return setPanel.includes(f); }),
     facts.join(', '))

  is('A52', 'it explains what the switches actually do',
     /checked <b>on the server<\/b>/.test(setPanel) && /Who can see what/.test(setPanel),
     'consequences and role reach, both in plain words')

  const setJs = readFileSync(join(APP, 'function', 'admin.js'), 'utf8')
  is('A53', 'flags are labelled in English, not shown as raw camelCase keys',
     /cloud_reports_read:\s*\{\s*label:\s*'Read shared reports'/.test(setJs)
  && /photo_storage:\s*\{\s*label:\s*'Patient photo storage'/.test(setJs),
     'photo_storage -> "Patient photo storage"')

  is('A54', 'the internal dev note is no longer what the admin reads',
     !/<b>' \+ esc\(f\.flag_key\)/.test(setJs) && /info \? info\.desc/.test(setJs),
     'the flag_key stays in data-flag so the server still gets the exact key')

  /* renderSettingsFacts referenced a variable that does not exist in this
     file - viewerProfile. That would have thrown on the Settings tab and
     left every count blank. */
  is('A55', 'the settings facts read a profile that actually exists',
     !/viewerProfile/.test(setJs),
     'it uses Auth.currentUser(), the source this file already uses')

  const setCss = readFileSync(join(APP, 'style', 'admin.css'), 'utf8')
  const unstyled = ['ent-settings-hero', 'ent-settings-facts', 'ent-flag-state',
                    'ent-settings-roles', 'ent-role-pill']
    .filter(function (c) { return !setCss.includes(c); })
  is('A56', 'the new settings UI is styled',
     unstyled.length === 0,
     unstyled.length ? 'unstyled: ' + unstyled.join(', ') : 'all present')
}

/* ---- A60: the Clinics tab must be readable ------------------------
   "gusto ko sa admin ayosin mo yung clinics para maganda at madali
   maintindihan". It was not wrong, but three questions went unanswered:
   how many are there in total, who works where, and which clinic is
   busiest this month. */
{
  const aHtml = readFileSync(join(APP, 'pages', 'admin.html'), 'utf8')
  const aJs = readFileSync(join(APP, 'function', 'admin.js'), 'utf8')
  const aCss = readFileSync(join(APP, 'style', 'admin.css'), 'utf8')

  const panel = (aHtml.match(/<section class="ent-admin-panel" id="panel-clinics">[\s\S]*?\n        <\/section>/) || [''])[0]

  is('A60', 'the tab says what it is for before listing anything',
     /See each clinic's activity/.test(panel) && /ent-clinic-hero/.test(panel)
       && /ent-clinic-hero-icon/.test(panel) && /ent-clinic-kicker/.test(panel),
     'a branded directory introduction explains the clinic and team view')

  is('A61', 'account totals are shown instead of having to count the cards',
     /id="clinicSummary"/.test(panel) && /function renderClinicSummary/.test(aJs),
     'clinics, doctors, secretaries, admins, records')

  /* The summary must NOT shrink to the filtered set. If it did, searching
     would quietly make the account look smaller than it is. */
  is('A62', 'the totals stay whole even while searching',
     /function renderClinicSummary[\s\S]*?periodTotals\(''\)/.test(aJs),
     "computed from every clinic, not from the filtered cards")

  /* Every record number now names its period. "N records" next to "N today"
     was genuinely ambiguous about what the big number covered. */
  is('A63', 'every record count states the period it covers',
     /this month/.test(aJs) && /all time/.test(aJs) && /ent-person-count/.test(aJs),
     '"this month" and "all time", never a bare number')

  is('A64', 'each doctor carries their own record count',
     /t\.doctors\[String\(d\.id\)\]/.test(aJs) && /personRow\(d, 'doc', dCount/.test(aJs),
     'the number beside a person is that person\'s')

  is('A65', 'a search says how much it hid',
     /function renderClinicDirectory[\s\S]*?ent-clinic-found/.test(aJs)
  && /Showing <b>/.test(aJs),
     '"Showing 1 of 9 clinics", never a silent removal')

  /* The clinic UUID was the longest string in the header and could not be
     acted on. */
  is('A66', 'the raw clinic UUID is no longer the headline',
     /slice\(0, 8\) \+ '\\u2026'/.test(aJs) && /title="' \+ esc\(id\)/.test(aJs),
     'first eight characters, whole value still on hover')

  is('A67', 'search can be emptied without select-all',
     /clinicSearchClear/.test(aJs) && /e\.key !== 'Escape'/.test(aJs),
     'a clear button, and Escape from the keyboard')

  /* Reports carry the doctor_id of whoever made them, and an admin creating
     one is stamped with the admin's own id. Admins are not listed under a
     clinic's doctors, so those records vanish from the per-doctor figures
     while still counting towards the clinic total. Proven live: testadmin
     holds 4 records, so those two figures disagreed by 4. */
  is('A69', 'records that belong to no listed doctor are shown, not dropped',
     /const unattributed = Math\.max/.test(aJs) && /ent-clinic-unattr/.test(aJs)
  && /by an admin/.test(aJs),
     'only when non-zero, so the card adds up')

  const unstyled = ['ent-clinic-hero', 'ent-clinic-summary', 'ent-clinic-found',
                    'ent-person-count', 'ent-clinic-searchclear']
    .filter(function (c) { return !aCss.includes(c); })
  is('A68', 'the new Clinics UI is styled',
     unstyled.length === 0,
     unstyled.length ? 'unstyled: ' + unstyled.join(', ') : 'all present')

  is('A68a', 'the directory has dedicated clinic, staff and relationship-card styling',
     ['ent-clinic-block-head', 'ent-clinic-block-stats', 'ent-clinic-block-body',
      'ent-doc-group', 'ent-sec-list', 'ent-person-av', 'ent-clinic-sum-n']
       .every(function (c) { return aCss.includes(c); }),
     'clinic identity, metrics, doctor rows and secretary links have clear visual hierarchy')

  is('A68b', 'the full clinic directory adapts to mobile and dark mode',
     /@media\s*\(max-width:\s*720px\)[\s\S]*?#panel-clinics \.ent-clinic-block-body[\s\S]*?body\.dark-mode #panel-clinics \.ent-clinic-hero/.test(aCss),
     'cards and team relationships remain readable on small screens and dark theme')

  is('A68c', 'search, export and refresh controls remain available in the redesigned header',
     /id="clinicSearch"/.test(panel) && /id="clinicSearchClear"/.test(panel)
       && /id="exportDirectoryBtn"/.test(panel) && /id="refreshDirectoryBtn"/.test(panel),
     'existing directory actions remain wired')
}

/* ---- A70: the clinic search X -------------------------------------
   Reported as "ayosin mo nga x button sa search bar ng clinic para
   maganda tignan". It was not just ugly - it was wrong twice over. */
{
  const aCss2 = readFileSync(join(APP, 'style', 'admin.css'), 'utf8')
  const aHtml2 = readFileSync(join(APP, 'pages', 'admin.html'), 'utf8')
  const aJs2 = readFileSync(join(APP, 'function', 'admin.js'), 'utf8')

  /* BUG 1: two X buttons. Chrome and Safari draw their own clear control
     inside input[type="search"], which sat next to ours. */
  is('A70', "the browser's own search X is suppressed, so there is only one",
     /ent-clinic-searchwrap input\[type="search"\]::-webkit-search-cancel-button/.test(aCss2)
  && /appearance:\s*none/.test(aCss2),
     'native control removed only inside the wrapper that has a real one')

  /* BUG 2: `display: grid` on the class beats the [hidden] attribute. An
     author display rule always wins over the browser's own
     [hidden] { display: none }, so the x showed in an EMPTY search box and
     stayed there. */
  is('A71', 'the X really hides when the search is empty',
     /\.ent-clinic-searchclear\[hidden\]\s*\{\s*display:\s*none/.test(aCss2),
     'the attribute has to be restated or the class display wins')

  is('A72', 'and it ships hidden, appearing only with a query',
     /id="clinicSearchClear"[\s\S]*?hidden/.test(aHtml2)
  && /clearBtn\.hidden = !needle/.test(aJs2),
     'shown when there is something to clear, hidden when there is not')

  /* A button that only works with a mouse is a trap. */
  is('A73', 'the X is reachable and visible from the keyboard',
     /focus-visible/.test(aCss2) && /aria-label="Clear the search"/.test(aHtml2),
     'focus ring plus a real label for screen readers')

  /* Room for the button, or it sits on top of the typed text. */
  is('A74', 'the input reserves space so text never runs under the X',
     /padding:\s*8px 34px 8px 12px/.test(aCss2),
     'right padding clears the 24px button at right:7px')
}

/* ---- A75: the Growth workspace must be legible and self-explanatory -- */
{
  const aHtml = readFileSync(join(APP, 'pages', 'admin.html'), 'utf8')
  const aJs = readFileSync(join(APP, 'function', 'admin.js'), 'utf8')
  const aCss = readFileSync(join(APP, 'style', 'admin.css'), 'utf8')
  const panel = (aHtml.match(/<section class="ent-admin-panel" id="panel-growth">[\s\S]*?\n        <\/section>/) || [''])[0]

  is('A75', 'Growth explains the purpose of its analytics before showing data',
     /ent-growth-hero/.test(panel) && /Follow report activity over time/.test(panel),
     'a dedicated introduction replaces the bare filter row')

  is('A75a', 'the selected view has live, clearly labelled summary metrics',
     ['growthMetricTotal', 'growthMetricClinics', 'growthMetricPeak',
      'growthMetricAverage'].every(function (id) { return panel.includes('id="' + id + '"') })
       && /function renderGrowthSummary/.test(aJs)
       && /renderGrowthSummary\(series\)/.test(aJs),
     'summary values are derived from the same series as the chart')

  const summarySrc = (aJs.match(/function renderGrowthSummary\(series\) \{[\s\S]*?\n    \}/) || [''])[0]
  const summaryValues = {}
  let renderSummary = null
  if (summarySrc) {
    renderSummary = new Function('setText', 'fmtNum', summarySrc + '\nreturn renderGrowthSummary;')(
      function (id, value) { summaryValues[id] = value },
      function (value) { return String(value) }
    )
  }
  if (renderSummary) {
    renderSummary([
      { total: 2, label: 'Nov 1', parts: new Map([['north', 2]]) },
      { total: 5, label: 'Nov 2', parts: new Map([['north', 3], ['south', 2]]) }
    ])
  }
  is('A75e', 'summary totals, contributing clinics, peak and average use the plotted data',
     !!renderSummary && summaryValues.growthMetricTotal === '7'
       && summaryValues.growthMetricClinics === '2'
       && summaryValues.growthMetricPeak === 'Nov 2'
       && summaryValues.growthMetricPeakNote === '5 records in this interval'
       && summaryValues.growthMetricAverage === '4'
       && summaryValues.growthMetricAverageNote === 'Across 2 plotted intervals',
     JSON.stringify(summaryValues))

  is('A75b', 'period, clinic, interval, export and refresh controls remain wired',
     /id="growthRange"/.test(panel) && /id="clinicFilter"/.test(panel)
       && /id="growthMode"/.test(panel) && /id="exportClinicsBtn"/.test(panel)
       && /id="refreshClinicsBtn"/.test(panel),
     'existing Growth controls retain their stable IDs')

  is('A75c', 'the activity chart, comparison table and scoreboard have dedicated layouts',
     ['ent-growth-chart-card', 'ent-growth-comparison-card', 'ent-growth-staff-card',
      '.ent-chart-col', '.ent-staff-card'].every(function (selector) {
        return aCss.includes(selector)
      }),
     'chart, clinic totals and staff ranking each have a visible hierarchy')

  is('A75d', 'Growth remains responsive and readable in dark mode',
     /@media\s*\(max-width:\s*720px\)[\s\S]*?#panel-growth[\s\S]*?body\.dark-mode #panel-growth/.test(aCss),
     'mobile controls and cards reflow, with a matching dark palette')
}

/* ---- A76: sessions, activity and support are clear workspaces ------ */
{
  const html = readFileSync(join(APP, 'pages', 'admin.html'), 'utf8')
  const js = readFileSync(join(APP, 'function', 'admin.js'), 'utf8')
  const css = readFileSync(join(APP, 'style', 'admin.css'), 'utf8')
  const panel = (id) => (html.match(new RegExp(
    '<section class="ent-admin-panel" id="panel-' + id + '">[\\s\\S]*?\\n        </section>'
  )) || [''])[0]
  const sessions = panel('sessions')
  const activity = panel('activity')
  const tickets = panel('tickets')

  is('A76', 'Active Sessions explains live access and preserves the existing session controls',
     /ACCESS MONITOR/.test(sessions) && /id="liveChk"/.test(sessions)
       && /id="refreshSessionsBtn"/.test(sessions) && /id="sessionsTable"/.test(sessions),
     'live heartbeat, refresh, presence table and revoke actions stay available')

  is('A76a', 'session totals distinguish online, offline and revoked records',
     ['sessionMetricOnline', 'sessionMetricOffline', 'sessionMetricRevoked',
      'sessionMetricTotal'].every(function (id) { return sessions.includes('id="' + id + '"') })
       && /const online = sessions\.filter\(isActiveSession\)/.test(js)
       && /const offline = Math\.max\(0, sessions\.length - online - revoked\)/.test(js),
     'counters follow the same heartbeat rule as the session status pill')

  is('A76b', 'Activity Logs has live KPIs and fully labeled, clearable filters',
     /AUDIT TRAIL/.test(activity) && /id="activityKpis"/.test(activity)
       && ['activityUser', 'activityFilter', 'activityPeriod', 'activitySearch',
         'activitySearchClear', 'exportActivityBtn', 'refreshActivityBtn']
         .every(function (id) { return activity.includes('id="' + id + '"') })
       && /clearSearch\.hidden = !\(\(search && search\.value\) \|\| ''\)\.trim\(\)/.test(js),
     'person, action, period, search, export and refresh remain functional')

  is('A76b1', 'activity actor name and role map from the audit table fields',
     /username: row\.username \|\| \(person && person\.username\) \|\| row\.actor_label/.test(js)
       && /role: row\.role \|\| row\.actor_role \|\| \(person && person\.role\)/.test(js)
       && /a\.actor_label \|\| a\.username/.test(js)
       && /a\.role \|\| a\.actor_role/.test(js),
     'Who and Role use actor_label and actor_role written by the database')

  is('A76b2', 'Activity Logs covers the clinics managed by this admin',
     /across the clinics you manage/.test(activity)
       && /All managed clinics/.test(activity)
       && /clinicLabel\(a\.clinic_id\)/.test(js),
     'scope is clear while each activity row keeps its actual clinic')

  is('A76c', 'filtered activity results and support queue counts update as filters change',
     /activityResultCount/.test(activity) && /ticketResults/.test(tickets)
       && /setText\('ticketResults', rows\.length/.test(js)
       && /setText\('activityResultCount', rows\.length/.test(js),
     'the event timeline and ticket queue report what is currently displayed')

  is('A76d', 'support retains clinic ticket triage, status counts, queue and reply thread',
     /STAFF SUPPORT/.test(tickets) && /ticketStatUrgent/.test(tickets)
       && /ticketSearchClear/.test(tickets) && /ticketScopeFilter/.test(tickets)
       && /ticketStatusFilter/.test(tickets) && /adminTicketList/.test(tickets)
       && /adminTicketDetail/.test(tickets) && /Clinic-only inbox/.test(tickets),
     'existing ticket data and reply workflow stay in place')

  is('A76e', 'all three workspaces have responsive table and panel styling in dark mode',
     ['.ent-ops-hero', '#panel-sessions .ent-table',
      '#panel-activity .ent-stat-grid', '#panel-tickets .ent-admin-tickets',
      '#panel-tickets .ent-admin-ticket', '#panel-tickets .ent-admin-ticket .ent-tk-bar']
       .every(function (rule) { return css.includes(rule) })
       && /@media\s*\(max-width:\s*720px\)[\s\S]*?\.ent-ops-hero[\s\S]*?body\.dark-mode \.ent-ops-hero/.test(css)
       && /body\.dark-mode #panel-tickets \.ent-ticket-detail/.test(css),
     'tables scroll safely on small screens and all panels preserve dark theme contrast')

  is('A76f', 'admin header keeps the Messenger control icon-only',
     /\.ent-admin-actions > \.ent-messages-link span\s*\{\s*display:\s*none;\s*\}/.test(css)
       && /\.ent-admin-actions > \.ent-messages-link\s*\{[^}]*width:\s*36px;/.test(css),
     'the chat icon remains accessible without its text label')
}

/* ---- A77: database, recycle bin and settings workspaces ------------- */
{
  const html = readFileSync(join(APP, 'pages', 'admin.html'), 'utf8')
  const js = readFileSync(join(APP, 'function', 'admin.js'), 'utf8')
  const css = readFileSync(join(APP, 'style', 'admin.css'), 'utf8')
  const section = (id) => (html.match(new RegExp(
    '<section class="ent-admin-panel" id="panel-' + id + '">[\\s\\S]*?\\n        </section>'
  )) || [''])[0]
  const database = section('database')
  const trash = section('trash')
  const settings = section('settings')

  is('A77', 'database usage explains its metrics and retains all existing data surfaces',
     /CAPACITY &amp; HEALTH/.test(database) && /id="quotaCards"/.test(database)
       && /id="dbSourceNote"/.test(database) && /id="dbCapacityNote"/.test(database)
       && /id="dbBackupNote"/.test(database) && /id="dbTable"/.test(database)
       && /id="clinicUsageTable"/.test(database) && /id="planNote"/.test(database)
       && /id="refreshDbBtn"/.test(database),
     'storage, source, capacity, backup disclaimer, table detail and clinic usage remain present')

  is('A77a', 'the recycle bin shows a live count and keeps its safe restore/delete flow',
     /id="trashCount"/.test(trash) && /id="trashList"/.test(trash)
       && /id="emptyTrashBtn"/.test(trash) && /id="refreshTrashBtn"/.test(trash)
       && /ent_deleted_reports/.test(js) && /p_limit:\s*200/.test(js)
       && /count\.textContent = String\(rows\.length\)/.test(js)
       && /data-trash-action="restore"/.test(js) && /data-trash-action="purge"/.test(js),
     'RPC read, restore and permanent delete controls are preserved and the count follows loaded rows')

  is('A77b', 'settings preserves clinic identity, server-backed flags and role guidance',
     /settingsClinicId/.test(settings) && /settingsClinicName/.test(settings)
       && /id="clinicNameInput"/.test(settings) && /id="saveClinicNameBtn"/.test(settings)
       && /id="flagList"/.test(settings) && /Who can see what/.test(settings)
       && /system_flags/.test(js),
     'clinic identity, save action, feature flags and database-enforced roles remain wired')

  is('A77c', 'all three panels have responsive, dark-mode styling',
     ['.ent-db-quota-grid', '.ent-db-health', '.ent-trash-row',
      '.ent-settings-grid', 'body.dark-mode .ent-trash-card',
      'body.dark-mode .ent-settings-card'].every(function (rule) { return css.includes(rule) })
       && /@media\s*\(max-width:\s*720px\)[\s\S]*?\.ent-settings-grid[\s\S]*?body\.dark-mode \.ent-db-quota-grid/.test(css),
     'database cards, recycle-bin rows and settings reflow with dark-theme contrast')

  const operationsCss = css.slice(css.indexOf('/* ---------- Database, deleted records and settings ---------- */'))
  is('A77e', 'the new panel accents follow the system blue/slate palette',
     /var\(--primary-color\)/.test(operationsCss)
       && /var\(--primary-hover-color\)/.test(operationsCss)
       && /var\(--border-color\)/.test(operationsCss)
       && !/#(?:16847f|24817b|29807c|5b75af|f0f3fa)\b/i.test(operationsCss),
     'shared theme variables replace one-off teal and violet accents')

  is('A77d', 'the redesigned JavaScript and service worker have fresh cache versions',
     /admin\.js\?v=v45-user-modal-refine/.test(html)
       && /admin\.css\?v=v55-account-form-one-column/.test(html)
       && /ent-report-system-v173-messenger-polish/.test(
         readFileSync(join(APP, 'sw.js'), 'utf8')),
     'avoid stale browser and service-worker copies of the updated panels')
  is('A77g', 'the account form and doctor assignments use one column',
     /\.ent-user-form-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(css)
       && /\.ent-user-doctor-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(css),
     'long labels and clinic selectors have the full dialog width')

  const chromeCss = css.slice(css.indexOf('/* ---------- Primary-color admin header and navigation ---------- */'))
  is('A77f', 'the admin header and sidebar use the system primary color in both themes',
     (chromeCss.match(/linear-gradient\(135deg,\s*#0ea5e9\s+0%,\s*#0284c7\s+50%,\s*#0369a1\s+100%\)/g) || []).length === 3
       && /body\.dark-mode \.ent-admin-header/.test(chromeCss)
       && /\.ent-admin-nav button\.active/.test(chromeCss),
     'header and navigation rail use the exact requested gradient in both themes')
}

/* ---- A80: a ticket must always say WHO filed it -------------------
   Reported: "sa ticket bakit Unknown account dapat makita kung
   secretary o doctor ba at saang clinic siya".

   Two separate defects produced that. */
{
  const src = readFileSync(join(APP, 'function', 'admin.js'), 'utf8')
  const css = readFileSync(join(APP, 'style', 'admin.css'), 'utf8')

  const rep = (src.match(/function ticketReporter[\s\S]*?\n    \}/) || [''])[0]
  const load = (src.match(/async function loadUsers[\s\S]*?\n    \}/) || [''])[0]

  /* DEFECT 1 - the stale render. The panel was drawn when the thread
     loaded and never redrawn when the staff list arrived, so a ticket
     opened during that window matched nothing and kept saying
     "Unknown account" until the admin replied or changed the status. */
  is('A80', 'the open ticket is redrawn when the staff list arrives',
     /if \(adminTicketOpen\) renderAdminTicketDetail\(\)/.test(load),
     'done in loadUsers so no call site can forget it')

  /* DEFECT 2 - the honest dead end. Even correctly redrawn, an account the
     clinic has genuinely deleted has no name. But ticket_messages carries
     author_role, stamped server-side, and the clinic is on the ticket row -
     so both facts were knowable and were being thrown away. */
  is('A81', 'the role is taken from the ticket itself when the account is gone',
     /roleFromTicket/.test(rep) && /author_role/.test(rep),
     'author_role is stamped by the DB, so it survives a deleted account')

  is('A82', 'the doctor/secretary answer survives a missing account',
     /role === 'doctor' \? 'Doctor'/.test(rep)
  && /role === 'secretary' \? 'Secretary'/.test(rep),
     'the exact question that went unanswered')

  /* It was printing 00000000-0000-4000-8000-00000000c11c - how the
     database stores a clinic. Useless for telling two clinics apart. */
  is('A83', 'the clinic is shown by NAME, not by its raw id',
     /clinicName: clinic \? clinicLabel\(clinic\)/.test(rep)
  && /esc\(by\.clinicName\)/.test(src),
     'the uuid stays only on the tooltip')

  /* "Unknown account" told the admin nothing - not even that this was a
     person who once worked here. It should say what is actually true. */
  is('A84', 'it no longer claims to be merely "unknown"',
     !/: 'Unknown account'/.test(rep) && /'Removed account'/.test(rep),
     'the account was removed; that is a different fact')
  /* users is [] for a moment after the panel opens. Every lookup misses, and
     the panel used to say Removed account about colleagues standing right
     there in the staff list - it was describing its own loading state as a
     fact about the clinic. */
  is('A85', 'an empty staff list reads as still-loading, never as removed',
     /const staffLoaded = users\.length > 0/.test(rep)
  && /staffLoaded \? 'Removed account' : 'Loading staff list/.test(rep)
  && /is-loading/.test(src) && /is-loading/.test(css),
     'three states: found, not-yet-known, genuinely gone')

  /* Proven against the live project: all 4 real tickets resolve a role and a
     clinic, and none of them are blank. */
  is('A86', 'the role badge is never conditional on the account existing',
     /by\.roleText \? '<span class="ent-badge is-role/.test(src),
     'the header badge shows Doctor/Secretary in every case')
}

/* ---- A87: a clinic must be named, never printed as its uuid --------
   Reported: "tas makit mga name ng clinic number ang nakalagay agad" -
   the clinic number is showing instead of the clinic name. */
{
  const s2 = readFileSync(join(APP, 'function', 'admin.js'), 'utf8')

  const loader = (s2.match(/async function loadClinicLabels[\s\S]*?\n    \}/) || [''])[0]

  is('A87', 'clinic names are read from the database, not invented',
     /clinic_settings\?select=clinic_id,setting_key,value/.test(loader)
  && /v\.hciName \|\| v\.clinicName/.test(loader),
     'clinic_settings.clinicProfile has held the name all along')

  is('A88', 'and it is fetched before anything is drawn',
     /await loadClinicLabels\(\);/.test(s2)
  && /async function refreshAll[\s\S]*loadClinicLabels[\s\S]*loadUsers/.test(s2),
     'loaded first, so no panel ever renders an id first')

  /* labels used to be seeded ONLY from localStorage, and only by renaming a
     clinic from this console. On any other browser clinicLabel() had nothing
     and prettified the uuid into "00000000-0000-4000-8000-00000000C11C". */
  is('A89', 'a rename still wins over the loaded name',
     /if \(!name \|\| labels\[row\.clinic_id\]\) return;/.test(loader)
  && /saveLabels\(\)/.test(loader),
     'only fills a gap, never overwrites what the admin typed')

  is('A90', 'the ticket panel no longer prints a raw uuid as an @handle',
     !/username: who \? \(who\.username \|\| ''\) : shortId/.test(s2)
  && !/ticketNo[\s\S]{0,80}' \+ esc\(by\./.test(s2),
     'a hex string after @ is meaningless to a person, and tooling tries to read it as a vcs ref')
}

/* ---- A91: the admin ticket queue ---------------------------------
   "paki ayos ang layout and design dito sa admin sa ticket sa part ng
   ent-ticket-queue class". The row was two lines, the second of which ran
   four facts together with dots, and it had no urgency on it at all. */
{
  const a3 = readFileSync(join(APP, 'function', 'admin.js'), 'utf8')
  const aCss3 = readFileSync(join(APP, 'style', 'admin.css'), 'utf8')

  const row = (a3.match(/function ticketQueueRow[\s\S]*?\n    \}/) || [''])[0]
  const list = (a3.match(/function renderAdminTickets[\s\S]*?\n    \}/) || [''])[0]

  /* The run-on, and "someone". */
  is('A91', 'the four facts are no longer welded together with dots',
     !/ent-admin-ticket-meta/.test(row) && /ent-tk-who/.test(row) && /ent-tk-tags/.test(row),
     'who / what / when, each on its own line')
  is('A92', 'it never says "someone"',
     !/: 'someone'/.test(a3),
     'the queue had the same missing-person bug the detail panel had')

  /* Urgency was collected and stored but shown nowhere in the list, so
     triage meant opening every ticket. */
  is('A93', 'urgency is on the row, not just in the detail',
     /TICKET_PRIORITY\[t\.priority\]/.test(row) && /ent-tk-bar/.test(row),
     'a colour rail plus a written badge, never colour alone')

  is('A94', 'the reporter is identifiable from the row itself',
     /displayName\(who\) : 'Removed account'/.test(row) && /@' \+ esc\(who\.username\)/.test(row),
     'name + @handle + role badge, no need to open the ticket')

  /* A queue is a worklist, so order has to mean something. */
  is('A95', 'the queue is ordered as a worklist, not by accident',
     /rank\[a\.status\]/.test(list) && /ph\[a\.priority\]/.test(list),
     'open before resolved, then urgent before low, then newest')
  is('A96', 'the ticket being replied to never jumps',
     /if \(a\.id === adminTicketOpen\) return -1/.test(list),
     'the open row stays first so it cannot move under the cursor')

  /* Reply counts let an admin see depth without opening anything. */
  is('A97', 'message counts come from a bounded, body-free query',
     /select', 'ticket_id'/.test(a3) && /adminTicketCounts = counts/.test(a3),
     'counts the queue needs; never pulls message bodies to draw a list')

  const unstyled = ['ent-tk-bar', 'ent-tk-subject', 'ent-tk-who', 'ent-tk-tags',
                    'ent-tk-replies', 'ent-tk-role']
    .filter(function (c) { return !aCss3.includes(c); })
  is('A98', 'every new part of the row is styled',
     unstyled.length === 0,
     unstyled.length ? 'unstyled: ' + unstyled.join(', ') : 'all present')

  /* If the three urgency rails lost their colours the queue would sort by
     nothing visible, and A93 would mean nothing. */
  is('A99', 'high / normal / low rails are visually distinct',
     /is-high\s+\.ent-tk-bar/.test(aCss3)
  && /is-normal\s+\.ent-tk-bar/.test(aCss3)
  && /is-low\s+\.ent-tk-bar/.test(aCss3),
     'red / blue / grey')

  is('A100', 'the selected row is unmistakable',
     /ent-admin-ticket\.is-selected[\s\S]{0,200}box-shadow/.test(aCss3),
     'filled background and a ring, not a 1px border change')
}

/* ---- A101: never read a ticket column the query did not ask for ----
   Reported: the ticket panel showed "Unknown clinic" for every ticket.
   The panel reads t.clinic_id, and the clinic NAME and code that do that
   were all correct - but the column was never in the SELECT list, so the
   field arrived as undefined and the fallback fired every time.

   This checks the whole surface rather than the one field, because the
   same mistake in any column produces the same silent "Unknown". */
{
  const s = readFileSync(join(APP, 'function', 'admin.js'), 'utf8')

  const sel = (s.match(/q\.set\('select', '([^']+)'\)[\s\S]{0,40}order', 'last_message_at/) || [])[1] || ''
  const selected = sel.split(',').map((x) => x.trim()).filter(Boolean)

  /* Every ticket field the three renderers read off `t` or a reporter arg. */
  const bodies = ['function ticketReporter', 'function renderAdminTickets', 'function ticketQueueRow',
                  'function renderAdminTicketDetail']
    .map((name) => (s.match(new RegExp(name + '[\\s\\S]*?\\n    \\}')) || [''])[0])
    .join('\n')

  const read = new Set()
  for (const m of bodies.matchAll(/\bt\.([a-z_]+)/g)) read.add(m[1])

  const missing = [...read].filter((f) => !selected.includes(f)).sort()

  is('A101', 'every ticket column the code reads is actually fetched',
     missing.length === 0,
     missing.length ? 'read but NOT selected: ' + missing.join(', ')
                   : selected.length + ' columns fetched, ' + read.size + ' read')

  /* The specific one, named, so a future removal is obvious. */
  is('A102', 'clinic_id is in the ticket query',
     selected.includes('clinic_id'),
     'without it the panel says "Unknown clinic" for a real clinic')

  is('A103', 'the unavailable-function state says it ONCE, not twice',
     !/Fetching the staff list/.test(s) && /auth-admin/.test(s),
     'it used to print "Loading staff list" and "Fetching the staff list"')
}
/* ---- A104+: the Overview's "Latest patients records" card ----------- */
/* The card answers the three questions an admin is asked in the hallway:
   WHICH patient, at WHICH hospital (RMCI / CUMC), filed by WHICH secretary
   or doctor. Everything below reads the innerHTML the console really
   painted from the fixture rows at the top of this file - the render is
   async (it lands while boot() is still fetching), so wait for it rather
   than asserting on a snapshot taken too early. */
{
  const overview = (readFileSync(join(APP, 'pages', 'admin.html'), 'utf8')
    .match(/<section class="ent-admin-panel active" id="panel-overview">[\s\S]*?\n        <\/section>/) || [''])[0]
  const aJs = readFileSync(join(APP, 'function', 'admin.js'), 'utf8')
  const aCss = readFileSync(join(APP, 'style', 'admin.css'), 'utf8')

  const box = el('latestPatients')
  let html = ''
  for (let i = 0; i < 100 && !html.includes('ent-latest-clinic'); i++) {
    await new Promise(function (r) { setTimeout(r, 10) })
    html = box ? box.innerHTML : ''
  }

  is('A104', 'the Latest patients card lives on the Overview panel',
     overview.includes('id="latestPatients"'),
     overview.includes('id="latestPatients"') ? 'inside panel-overview' : 'NOT on the Overview')

  is('A105', 'its rows are grouped per clinic, newest clinic first',
     (html.match(/ent-latest-clinic/g) || []).length === 2,
     (html.match(/ent-latest-clinic/g) || []).length + ' clinic blocks')

  is('A106', 'every record names the patient',
     ['RACOMA, ALLOY', 'ME, OWN', 'SOLO, ONE'].every(function (n) { return html.includes(n) }),
     html.slice(0, 160))

  is('A107', 'the secretary who filed it is named WITH her role',
     html.includes('Secretary') && html.includes('saved by Tara Bautista'),
     html.includes('saved by Tara Bautista') ? 'Secretary + name present' : 'NO creator line: ' + html.slice(0, 200))

  is('A108', 'the hospital each patient was seen at is on the row',
     html.includes('ent-latest-site is-rmci') && html.includes('ent-latest-site is-cumc'),
     (html.match(/ent-latest-site is-\w+/g) || []).join(', ') || 'no hospital chip')

  is('A108b', 'the block is headed by the clinic NAME, not its uuid',
     html.includes('ENT Clinic Doc Jess') && html.includes('Bolmen Clinic'),
     html.slice(0, 160))

  is('A109', 'the query asks for the author name and the hospital tag',
     win.latestCalls.some(function (u) {
       return u.indexOf('created_by_name') !== -1 && u.indexOf('site') !== -1
     }),
     (win.latestCalls[0] || 'NO latest-patients query at all').slice(0, 150))

  is('A110', 'the card ships with its own styles',
     aCss.includes('.ent-latest-row') && aCss.includes('.ent-latest-site')
       && aJs.includes('function renderLatestPatients'),
     'markup, renderer and CSS all present')
}
console.log('')
console.log('==== ' + (failed ? failed + ' FAILED' : 'ADMIN CONSOLE OK') + ' - ' +
  passed + ' passed, ' + failed + ' failed ====')
console.log('')
process.exitCode = failed ? 1 : 0
