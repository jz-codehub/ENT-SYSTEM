// smoke_wiring.mjs - end-to-end wiring smoke test for the three form pages.
//
// Boots the REAL pages/*.html parsed into a DOM stub inside a node:vm context,
// then runs the REAL function/*.js files in page order and asserts that:
//   * every header button actually got a click handler bound;
//   * window.EntFormBridge / EntDbRecords / EntDrafts / EntOfflineViewer exist;
//   * the sticky header collapse works: scrollY > 10 -> .header-scrolled,
//     back to 0 -> class removed.
//
// No network, no browser.  Run:  node temp/smoke_wiring.mjs
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
// ENT_APP_ROOT lets the same checks run against the Cloudflare build output
// (dist/) instead of the repo root:  ENT_APP_ROOT=dist node temp/smoke_wiring.mjs
const APP = process.env.ENT_APP_ROOT ? resolve(process.env.ENT_APP_ROOT) : resolve(HERE, '..')

let passed = 0, failed = 0
// an async DOMContentLoaded body that rejects would otherwise vanish silently
const bootRejections = []
process.on('unhandledRejection', (err) => { bootRejections.push(String((err && err.stack) || err).split('\n').slice(0, 4).join(' | ')) })
const ok = (id, what, cond, d = '') => {
  if (cond) { passed++; console.log(`  PASS  ${id.padEnd(4)} ${what}${d ? ' — ' + d : ''}`) }
  else { failed++; console.log(`  FAIL  ${id.padEnd(4)} ${what}${d ? ' — ' + d : ''}`) }
}

function attrsOf(tag) {
  const a = {}; const re = /([a-zA-Z-]+)="([^"]*)"/g; let m
  while ((m = re.exec(tag))) a[m[1]] = m[2]
  return a
}


function boot(htmlFile, scripts) {
  const HTML = readFileSync(join(APP, 'pages', htmlFile), 'utf8')
  // index.js picks currentReportType from document.title ("Nasal Endoscopy
  // Report" / "Laryngeal ..."), so the REAL title has to be in the stub.
  const realTitle = (/<title>([^<]*)<\/title>/i.exec(HTML) || [null, htmlFile])[1].trim()
  const elements = []; const byId = {}
  const docListeners = {}; const winListeners = {}

  function makeEl(tagName, attrs) {
    const el = {
      tag: tagName, id: attrs.id || '', name: attrs.name || '',
      tagName: String(tagName).toUpperCase(),
      className: attrs.class || '', value: attrs.value !== undefined ? attrs.value : '',
      type: attrs.type || tagName, checked: /\bchecked\b/.test(attrs._raw || ''),
      src: attrs.src || '', textContent: '', title: attrs.title || '',
      style: {}, dataset: {}, children: [], hidden: false, innerHTML: '', files: [],
      _listeners: {},
      offsetWidth: 0, scrollWidth: 0, scrollHeight: 0, scrollTop: 0,
      parentNode: null, parentElement: null
    }
    el.classList = {
      add(...cs) { const s = new Set(String(el.className).split(/\s+/).filter(Boolean)); cs.forEach(c => s.add(c)); el.className = [...s].join(' ') },
      remove(...cs) { const s = new Set(String(el.className).split(/\s+/).filter(Boolean)); cs.forEach(c => s.delete(c)); el.className = [...s].join(' ') },
      toggle(c, force) { const has = el.classList.contains(c); const want = force === undefined ? !has : !!force; want ? el.classList.add(c) : el.classList.remove(c); return want },
      contains(c) { return String(el.className).split(/\s+/).includes(c) }
    }
    el.addEventListener = (type, fn) => { (el._listeners[type] = el._listeners[type] || []).push(fn) }
    el.removeEventListener = (type, fn) => { const a = el._listeners[type]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1) } }
    el.dispatchEvent = () => true
    el.fire = (type, ev) => { (el._listeners[type] || []).slice().forEach(fn => fn.call(el, ev || { type, target: el, preventDefault() {}, stopPropagation() {} })) }
    el.clickCount = () => (el._listeners.click || []).length
    el.setAttribute = (k, v) => { if (k === 'id') { el.id = v; byId[v] = el } if (k === 'class') el.className = v }
    el.removeAttribute = () => {}
    el.getAttribute = () => null
    el.appendChild = c => { el.children.push(c); if (c) c.parentNode = el; return c }
    el.replaceChildren = () => { el.children = [] }
    el.remove = () => {}
    el.focus = () => {}; el.blur = () => {}; el.select = () => {}; el.click = () => el.fire('click')
    el.closest = (sel) => { let n = el; while (n) { if (n.matches && n.matches(sel)) return n; n = n.parentNode } return null }
    el.matches = (sel) => matchSelector(el, sel)
    el.contains = (n) => { let c = n; while (c) { if (c === el) return true; c = c.parentNode } return false }
    el.querySelector = s => matchAll(s)[0] || null
    el.querySelectorAll = s => matchAll(s)
    el.getElementsByTagName = () => []
    el.getContext = () => null
    el.scrollIntoView = () => {}
    el.getBoundingClientRect = () => ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 })
    el.insertAdjacentHTML = () => {}
    el.attrs = attrs
    el.insertBefore = (node) => { if (node) { el.children.push(node); node.parentNode = el; node.parentElement = el } return node }
    el.append = (...ns) => ns.forEach(n => el.appendChild(n))
    el.prepend = (...ns) => ns.slice().reverse().forEach(n => el.appendChild(n))
    el.before = () => {}; el.after = () => {}; el.replaceWith = () => {}
    el.hasAttribute = k => !!(attrs && k in attrs)
    el.toggleAttribute = () => {}
    el.nextElementSibling = null; el.previousElementSibling = null
    el.firstChild = null; el.lastChild = null; el.childNodes = []
    el.clientWidth = 0; el.clientHeight = 0; el.offsetTop = 0; el.offsetHeight = 0
    el.disabled = false; el.readOnly = false; el.placeholder = attrs.placeholder || ''
    el.options = []
    el.insertAdjacentElement = () => {}
    el.animate = () => ({ finished: Promise.resolve(), cancel() {} })
    elements.push(el)
    if (el.id) byId[el.id] = el
    return el
  }

  // selector matching good enough for closest()/matches() in the flat stub DOM
  function matchSelector(el, sel) {
    sel = String(sel).trim()
    if (!sel) return false
    if (sel.includes(',')) return sel.split(',').some(p => matchSelector(el, p))
    const parts = sel.split(/\s+/)
    const s = parts[parts.length - 1]
    const m = /^([a-zA-Z][a-zA-Z0-9-]*)((?:[.#][a-zA-Z0-9_-]+)*)$/.exec(s)
    if (!m) return false
    const tag = m[1]; const tokens = m[2] || ''
    if (tag && el.tag !== tag.toLowerCase()) return false
    const re = /([.#])([a-zA-Z0-9_-]+)/g; let t
    while ((t = re.exec(tokens))) {
      if (t[1] === '.') { if (!el.classList.contains(t[2])) return false }
      else if ((el.id || '') !== t[2]) return false
    }
    return !!(tag || tokens)
  }

  function matchAll(sel) {
    sel = String(sel).trim(); let m
    if (sel.startsWith('.')) { const cls = sel.slice(1).split(/\s+/)[0]; return elements.filter(e => e.classList.contains(cls)) }
    if (sel.startsWith('#')) { const id = sel.slice(1); return byId[id] ? [byId[id]] : [] }
    if ((m = /^input\[name="([^"]+)"\]\[value="([^"]+)"\]$/.exec(sel))) return elements.filter(e => e.tag === 'input' && e.name === m[1] && e.value === m[2])
    if ((m = /^input\[name="([^"]+)"\]:checked$/.exec(sel))) return elements.filter(e => e.name === m[1] && e.checked)
    if ((m = /^input\[name="([^"]+)"\]$/.exec(sel))) return elements.filter(e => e.tag === 'input' && e.name === m[1])
    if ((m = /^\[name="([^"]+)"\]$/.exec(sel))) return elements.filter(e => e.name === m[1])
    if ((m = /^input\[type="([^"]+)"\]$/.exec(sel))) return elements.filter(e => e.tag === 'input' && e.type === m[1])
    if (sel.includes(',')) { const out = []; sel.split(',').forEach(p => { for (const e of matchAll(p)) if (!out.includes(e)) out.push(e) }); return out }
    if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(sel)) return elements.filter(e => e.tag === sel.toLowerCase())
    return []
  }


  const tagRe = /<(input|textarea|select|form|button|div|span|a|label|img|header|nav|section|fieldset|table|tr|td|ul|li|h1|h2|h3|p|canvas|dialog)\b[^>]*>/g
  let t
  while ((t = tagRe.exec(HTML))) {
    const attrs = attrsOf(t[0])
    const isFormControl = /^input$/i.test(t[1]) && (attrs.type === 'radio' || attrs.type === 'checkbox' || attrs.id)
    if (!attrs.id && !attrs.class && !isFormControl) continue
    attrs._raw = t[0]
    makeEl(t[1].toLowerCase(), attrs)
  }

  const store = new Map()
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k), clear: () => store.clear(),
    key: i => [...store.keys()][i] ?? null, get length() { return store.size }
  }

  const document = {
    readyState: 'complete', hidden: false, title: realTitle,
    documentElement: makeEl('html', { class: '' }),
    head: makeEl('head', { class: '' }),
    body: makeEl('body', { class: '' }),
    getElementById: id => byId[id] || null,
    createElement: tag => makeEl(String(tag).toLowerCase(), {}),
    createTextNode: () => ({}),
    createDocumentFragment: () => makeEl('fragment', {}),
    addEventListener: (ev, fn) => { (docListeners[ev] = docListeners[ev] || []).push(fn) },
    removeEventListener: () => {},
    dispatchEvent: () => true,
    querySelector: s => matchAll(s)[0] || null,
    querySelectorAll: s => matchAll(s),
    getElementsByClassName: () => [],
    getElementsByTagName: () => [],
    location: { pathname: '/pages/' + htmlFile, search: '', hash: '', href: 'http://localhost:5500/pages/' + htmlFile, replace() {}, assign() {} }
  }

  // every parsed element needs a parent (the page markup implies document.body)
  elements.forEach(e => {
    if (e === document.body || e === document.documentElement || e === document.head) return
    if (!e.parentNode) { e.parentNode = document.body; e.parentElement = document.body }
  })
  // ...and body itself hangs off documentElement, which hangs off a root stub,
  // so `el.parentNode.insertBefore(...)` never hits null.
  document.body.parentNode = document.documentElement
  document.documentElement.parentNode = document.head
  document.head.parentNode = {
    insertBefore(n) { return n }, appendChild(n) { return n }, removeChild() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    classList: { contains: () => false, add() {}, remove() {} }
  }
  document.head.parentNode.parentNode = null

  // HTMLFormElement.elements - the auto-save wiring iterates it
  const reportFormEl = byId['report-form']
  if (reportFormEl) {
    reportFormEl.elements = elements.filter(e => e.tag === 'input' || e.tag === 'textarea' || e.tag === 'select')
  }

  function makeSupabaseStub() {
    const chain = () => {
      const p = Promise.resolve({ data: null, error: null, count: 0 })
      for (const k of ['select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'or', 'ilike', 'like',
        'contains', 'match', 'in', 'gte', 'lte', 'is', 'not', 'filter', 'limit', 'order', 'range',
        'single', 'maybeSingle', 'abortSignal']) p[k] = () => p
      return p
    }
    return {
      auth: {
        getSession: () => Promise.resolve({ data: { session: null }, error: null }),
        getUser: () => Promise.resolve({ data: { user: null }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        signInWithPassword: () => Promise.resolve({ data: {}, error: null }),
        signOut: () => Promise.resolve({ error: null }), setSession: () => Promise.resolve({ data: {}, error: null })
      },
      from: () => chain(), rpc: () => chain(),
      functions: { invoke: () => Promise.resolve({ data: {}, error: null }) },
      storage: { from: () => ({ upload: () => Promise.resolve({ data: null, error: null }), download: () => Promise.resolve({ data: null, error: null }), getPublicUrl: () => ({ data: { publicUrl: '' } }), remove: () => Promise.resolve({ data: null, error: null }) }) },
      removeChannel: () => {}, channel: () => ({ on() { return this }, subscribe() { return this }, unsubscribe() {} })
    }
  }


  const win = {
    document, localStorage, sessionStorage: localStorage,
    location: document.location,
    navigator: { onLine: true, userAgent: 'node-smoke', clipboard: { writeText: () => Promise.resolve() } },
    console,
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout,
    setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: cb => setTimeout(() => cb(Date.now()), 0), cancelAnimationFrame: () => {},
    addEventListener: (ev, fn) => { (winListeners[ev] = winListeners[ev] || []).push(fn) },
    removeEventListener: () => {},
    dispatchEvent: () => true,
    scrollX: 0, scrollY: 0, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
    alert() {}, confirm: () => true, prompt: () => '', open() {}, close() {}, focus() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '', paddingTop: '0px' }),
    scrollTo() {}, scroll() {},
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    FileReader: class { readAsDataURL() { setTimeout(() => this.onload && this.onload({ target: { result: 'data:image/png;base64,x' } }), 0) } readAsText() {} },
    Image: class { set src(v) { setTimeout(() => this.onload && this.onload(), 0) } },
    URL, URLSearchParams, Date, JSON, Math, Promise, Set, Map, WeakMap, Array, Object, String,
    Number, Boolean, RegExp, Error, TypeError, RangeError, isNaN, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent, structuredClone,
    crypto: globalThis.crypto,
    Event: class Event { constructor(type, init) { this.type = type; Object.assign(this, init || {}) } },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; Object.assign(this, init || {}) } },
    indexedDB: {
      open: () => ({ addEventListener() {}, removeEventListener() {}, set onerror(v) {}, set onsuccess(v) {}, set onupgradeneeded(v) {}, result: {}, error: null }),
      deleteDatabase: () => ({ addEventListener() {} })
    },
    IDBKeyRange: { only: v => v, bound: (a, b) => ({ lower: a, upper: b }), lowerBound: v => v, upperBound: v => v },
    supabase: { createClient: () => makeSupabaseStub() }
  }

  win.window = win; win.globalThis = win; win.self = win
  vm.createContext(win)

  const evalErrors = []
  for (const rel of scripts) {
    let src
    try { src = readFileSync(join(APP, rel), 'utf8') } catch (e) { evalErrors.push(`${rel}: READ FAILED ${e.message}`); continue }
    try { vm.runInContext(src, win, { filename: rel }) }
    catch (e) { evalErrors.push(`${rel}: ${e.message}`) }
  }

  // fire DOMContentLoaded exactly as a browser would after the deferred scripts
  for (const fn of (docListeners.DOMContentLoaded || []).slice()) {
    try { fn({ type: 'DOMContentLoaded', target: document }) } catch (e) { evalErrors.push('DOMContentLoaded handler: ' + e.message) }
  }

  const scrollListeners = (winListeners.scroll || [])
  const header = document.querySelector('.report-header')
  function fireScroll(y) {
    win.scrollY = y
    scrollListeners.slice().forEach(fn => { try { fn({ type: 'scroll', target: win }) } catch (e) { evalErrors.push('scroll handler: ' + e.message) } })
  }

  return { win, document, byId, elements, evalErrors, header, fireScroll, scrollCount: scrollListeners.length }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function reportPage(title, htmlFile, scripts, expectations) {
  console.log('\n==== ' + title + ' ====')
  const page = boot(htmlFile, scripts)
  // index.js/cf4.js wrap everything in an ASYNC DOMContentLoaded body, so the
  // wiring lands a few ticks later - wait for it before asserting.
  await sleep(200)
  const errs = page.evalErrors.concat(bootRejections.splice(0))
  if (errs.length) console.log('  !! boot errors:\n     ' + errs.join('\n     '))
  ok('E0', 'no script threw while booting', errs.length === 0, errs[0] || '')
  for (const [id, what, fn] of expectations(page)) ok(id, what, fn.v, fn.d || '')
  return page
}

const coreScripts = [
  'function/paths.js', 'function/supabaseClient.js', 'function/photoStore.js', 'function/auth.js',
  'function/syncEngine.js', 'function/offlineStore.js', 'function/patientRecords.js',
  'function/dbRecords.js', 'function/draftsBrowser.js'
]

// which header buttons this page is supposed to have (cf4 has no Open Draft File)
const HEADER_BUTTONS = ['saveDataBtn', 'localDraftsBtn', 'openDataBtn', 'saveToDbBtn',
  'dbRecordsBtn', 'savePdfBtn', 'printBtn', 'newFormBtn']

function headerChecks(page, buttons) {
  const checks = []
  for (const id of buttons) {
    if (!page.byId[id]) { checks.push(['x' + id, id + ' exists in the HTML', { v: false, d: 'MISSING FROM PAGE' }]); continue }
    const n = page.byId[id].clickCount()
    checks.push(['B', id + ' has a click handler', { v: n > 0, d: 'n=' + n }])
  }
  const ft = page.win.EntFormBridge
  checks.push(['W1', 'window.EntFormBridge exposed (dbRecords/drafts need it)',
    { v: !!ft && typeof ft.getData === 'function', d: 'reportType=' + ((ft || {}).reportType || '?') }])
  checks.push(['W2', 'window.EntDbRecords (Save to DB / DB Records)', { v: !!page.win.EntDbRecords }])
  checks.push(['W3', 'window.EntDrafts (draft shelf)', { v: !!page.win.EntDrafts }])
  checks.push(['S0', 'a window scroll listener is registered', { v: page.scrollCount > 0, d: 'n=' + page.scrollCount }])
  checks.push(['S1', 'scroll down adds .header-scrolled (header minimizes)',
    { v: (() => { page.fireScroll(120); return !!page.header && page.header.classList.contains('header-scrolled') })(), d: 'header=' + !!page.header }])
  checks.push(['S2', 'scroll back to top removes .header-scrolled',
    { v: (() => { page.fireScroll(0); return !!page.header && !page.header.classList.contains('header-scrolled') })(), d: '' }])
  return checks
}

await reportPage('NASAL ENDOSCOPY', 'nasalEndoscopy.html', coreScripts.concat('function/index.js'), (page) =>
  headerChecks(page, HEADER_BUTTONS).concat([
    ['O1', 'window.EntOfflineViewer (offline records modal)',
      { v: !!page.win.EntOfflineViewer && typeof page.win.EntOfflineViewer.open === 'function' }],
    ['O2', 'Offline Records button: at most 2 owners (drafts + offline viewer)',
      { v: page.byId.localDraftsBtn.clickCount() <= 2, d: 'n=' + page.byId.localDraftsBtn.clickCount() }],
    ['O3', 'offline viewer claimed the button (drafts shelf steps aside)',
      { v: page.byId.localDraftsBtn.dataset.offlineBound === 'true', d: 'offlineBound=' + page.byId.localDraftsBtn.dataset.offlineBound }]
  ]))

await reportPage('LARYNGEAL ENDOSCOPY', 'laryngealEndoscopy.html', coreScripts.concat('function/index.js'),
  (page) => headerChecks(page, HEADER_BUTTONS))

await reportPage('CF4 FORM', 'cf4Form.html', coreScripts.concat('function/cf4.js'),
  (page) => headerChecks(page, HEADER_BUTTONS.filter(b => b !== 'openDataBtn')))

console.log('\n  ' + passed + ' passed, ' + failed + ' failed\n')
process.exit(failed ? 1 : 0)

