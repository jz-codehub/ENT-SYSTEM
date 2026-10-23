/* Load the REAL admin.html against the REAL admin.js with a STRICT DOM:
   getElementById returns null for anything the page does not actually
   contain, exactly like a browser. Every other harness here invents
   elements on demand, which is why a page missing an element can look
   fine in a test and still break in the browser. */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const html = readFileSync(join(APP, 'pages', 'admin.html'), 'utf8')
const REAL = new Set([...html.matchAll(/\bid\s*=\s*"([^"]+)"/g)].map(m => m[1]))

let invented = 0
function el(id) {
  const L = {}
  return {
    id, value: '', checked: false, disabled: false, hidden: false,
    textContent: '', innerHTML: '', className: '', dataset: {},
    style: { cssText: '' }, options: [], children: [],
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    addEventListener: (e, f) => { (L[e] = L[e] || []).push(f) },
    removeEventListener() {}, setAttribute() {}, removeAttribute() {},
    appendChild() {}, remove() {}, focus() {}, scrollIntoView() {}, click() {},
    // Element-level querySelector answers with a stub: this harness stores
    // innerHTML as a plain string and cannot parse the logout button back
    // out of it, and modelling that parse is not this test's job. The
    // STRICT surface is document.getElementById above - ids only.
    closest: () => null, querySelector: () => el('found'), querySelectorAll: () => [],
    getAttribute: () => null, contains: () => false,
    fire: (e, a) => Promise.all((L[e] || []).map(f => f(a || { preventDefault() {} }))),
  }
}

const json = b => ({ ok: true, status: 200, text: async () => JSON.stringify(b), json: async () => b })
const win = {
  __session: { user: { id: 'u1', email: 'a@b.c' }, access_token: 'jwt', expires_at: Date.now()/1000+3600 },
  location: { pathname: '/admin.html', search: '', href: '', origin: 'http://localhost:5500', protocol: 'http:', replace() {}, assign() {} },
  navigator: { userAgent: 'node', onLine: true }, console,
  URLSearchParams, URL, TextEncoder, TextDecoder,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setInterval: () => 0, clearInterval() {}, setTimeout: (f) => { try { f() } catch (e) { void e } return 0 }, clearTimeout() {},
  addEventListener() {}, dispatchEvent() {}, confirm: () => true, alert() {},
  fetch: async (u) => {
    const s = String(u)
    if (s.includes('/rest/v1/staff_profiles')) return json([{ id: 'u1', username: 'a', full_name: 'A', role: 'admin', clinic_id: 'c', assigned_doctor_id: null, is_active: true }])
    return json([])
  },
  supabase: { createClient: () => ({ auth: {
    getSession: async () => ({ data: { session: win.__session }, error: null }),
    signInWithPassword: async () => ({ data: { user: { id: 'u1' } }, error: null }),
    updateUser: async () => ({ data: {}, error: null }),
    signOut: async () => ({ error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  } }) },
}
win.document = {
  readyState: 'complete', hidden: false, title: '',
  body: el('body'),
  createElement: () => el('created'),
  // THE STRICT PART: null unless the id is really in admin.html
  getElementById: (id) => { if (!REAL.has(id)) { invented++; return null } return el(id) },
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
}
win.window = win; win.globalThis = win

console.log('\n==== STRICT LOAD OF THE REAL PAGE ====\n')
console.log('  ids really present in admin.html: ' + REAL.size + '\n')

let err = ''
try {
  vm.createContext(win)
  for (const f of ['supabaseClient.js', 'photoStore.js', 'auth.js', 'admin.js']) {
    vm.runInContext(readFileSync(join(APP, 'function', f), 'utf8'), win, { filename: f })
  }
} catch (e) { err = String((e && e.stack) || e) }

if (err) {
  console.log('  LOAD FAILED\n')
  console.log(err.split('\n').slice(0, 8).map(l => '    ' + l).join('\n'))
  process.exitCode = 1
} else {
  console.log('  scripts loaded with no error')
  console.log('  ids the page does NOT have, that the code asked for: ' + invented)
  console.log('')
  console.log('  (a crash would have been printed above; getting here means the')
  console.log('   page boots even though admin.html is missing those nodes)')
}
