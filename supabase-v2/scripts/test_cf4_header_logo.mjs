// =====================================================================
//  test_cf4_header_logo.mjs
//  Does the CF4 header LOGO follow the REVER <-> CUMC selection?
//  ---------------------------------------------------------------------
//  The bug this locks down: switching the CF4 "Default Hospital Header"
//  dropdown to REVER MEDICAL CENTER INC. moved the hospital line and the
//  HCI fields, but the left logo stayed the CUMC one - on screen AND in
//  print - because three places resolved the logo on their own instead of
//  through one hospital choice:
//
//    1. the on-screen header used savedCf4Settings.cf4LeftLogo || a
//       hardcoded CUMC default (cf4.js);
//    2. the printed report did the same in getCf4PrintLogoSources;
//    3. buildPrintContent repeated it a third time.
//
//  All three now go through cf4LeftLogoSrc(): custom upload wins, then the
//  hospital selection (cf4Settings.cf4Hospital, falling back to the
//  endoscopy clinicSettings.hospitalHeader), defaulting to CUMC.
//
//  No network. cf4.js is booted in a VM against a DOM parsed from the REAL
//  pages/cf4Form.html - ids and classes come from the file, so a change to
//  the form's shape fails this test loudly.
//
//  Run: node supabase-v2/scripts/test_cf4_header_logo.mjs
// =====================================================================
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..', '..')
const HTML = readFileSync(join(APP, 'pages', 'cf4Form.html'), 'utf8')
const SRC = readFileSync(join(APP, 'function', 'cf4.js'), 'utf8')

let passed = 0, failed = 0
const ok = (id, what, cond, d = '') => {
  if (cond) { passed++; console.log(`  PASS  ${id.padEnd(4)} ${what}${d ? ' — ' + d : ''}`) }
  else { failed++; console.log(`  FAIL  ${id.padEnd(4)} ${what}${d ? ' — ' + d : ''}`) }
}

// ---------------------------------------------------------------- boot ---
function attrsOf(tag) {
  const a = {}
  const re = /([a-zA-Z-]+)="([^"]*)"/g
  let m
  while ((m = re.exec(tag))) a[m[1]] = m[2]
  return a
}

function boot(cf4Settings, clinicSettings) {
  const elements = []
  const byId = {}
  const docListeners = {}

  function makeEl(tagName, attrs) {
    const el = {
      tag: tagName, id: attrs.id, name: attrs.name,
      className: attrs.class || '',
      value: attrs.value !== undefined ? attrs.value : '',
      type: attrs.type || (tagName === 'textarea' ? 'textarea' : tagName === 'select' ? 'select' : 'text'),
      checked: /(?:\s|^)checked(?:\s|>|\/|=)/.test(attrs._raw || ''),
      src: '', textContent: '',
      style: {}, dataset: {}, children: [], hidden: false,
      innerHTML: '', files: [],
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true },
      setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
      appendChild(c) { this.children.push(c); return c },
      replaceChildren() { this.children = [] },
      remove() {}, focus() {}, click() {}, blur() {},
      closest: () => null, matches: () => false,
      querySelector: s => matchAll(s)[0] || null,
      querySelectorAll: s => matchAll(s),
      getContext: () => null, scrollIntoView() {},
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 })
    }
    elements.push(el)
    if (el.id) byId[el.id] = el
    return el
  }

  function matchAll(sel) {
    sel = String(sel).trim()
    let m
    if (sel.startsWith('.')) {
      const cls = sel.slice(1)
      return elements.filter(e => String(e.className || '').split(/\s+/).includes(cls))
    }
    if ((m = /^input\[name="([^"]+)"\]\[value="([^"]+)"\]$/.exec(sel))) {
      return elements.filter(e => e.type === 'radio' && e.name === m[1] && e.value === m[2])
    }
    if ((m = /^input\[name="([^"]+)"\]:checked$/.exec(sel))) {
      return elements.filter(e => e.name === m[1] && e.checked)
    }
    if ((m = /^input\[name="([^"]+)"\]$/.exec(sel))) {
      return elements.filter(e => e.tag === 'input' && e.name === m[1])
    }
    if ((m = /^\[name="([^"]+)"\]$/.exec(sel))) {
      return elements.filter(e => e.name === m[1])
    }
    if ((m = /^input\[type="([^"]+)"\]$/.exec(sel))) {
      return elements.filter(e => e.tag === 'input' && e.type === m[1])
    }
    if (sel.includes(',')) {
      const out = []
      sel.split(',').forEach(part => { for (const e of matchAll(part)) if (!out.includes(e)) out.push(e) })
      return out
    }
    if (sel === 'textarea' || sel === 'select') return elements.filter(e => e.tag === sel)
    return []
  }

  // Everything with an id or a class, plus every radio/checkbox group.
  const tagRe = /<(input|textarea|select|form|button|div|span|a|label|img)\b[^>]*>/g
  let t
  while ((t = tagRe.exec(HTML))) {
    const attrs = attrsOf(t[0])
    const isFormControl = /^input$/i.test(t[1]) &&
      (attrs.type === 'radio' || attrs.type === 'checkbox' || attrs.id)
    if (!attrs.id && !attrs.class && !isFormControl) continue
    attrs._raw = t[0]
    makeEl(t[1].toLowerCase(), attrs)
  }
  if (!byId['cf4-form']) makeEl('form', { id: 'cf4-form' })

  const store = new Map()
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: k => { store.delete(k) },
    clear: () => store.clear()
  }
  if (cf4Settings) localStorage.setItem('cf4Settings', JSON.stringify(cf4Settings))
  if (clinicSettings) localStorage.setItem('clinicSettings', JSON.stringify(clinicSettings))

  const document = {
    readyState: 'complete', hidden: false,
    body: { classList: { contains: () => false }, appendChild() {}, insertAdjacentHTML() {} },
    getElementById: id => byId[id] || null,
    createElement: tag => makeEl(String(tag).toLowerCase(), {}),
    createTextNode: () => ({}),
    addEventListener: (ev, fn) => { (docListeners[ev] = docListeners[ev] || []).push(fn) },
    removeEventListener() {},
    querySelector: s => matchAll(s)[0] || null,
    querySelectorAll: s => matchAll(s),
    getElementsByClassName: () => []
  }

  const win = {
    document, localStorage, sessionStorage: localStorage,
    location: { pathname: '/pages/cf4Form.html', search: '', hash: '', href: '', replace() {}, assign() {} },
    navigator: { onLine: true, userAgent: 'node-test' },
    console,
    setTimeout: () => 0, clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    alert() {}, confirm: () => true, prompt: () => '',
    URL, URLSearchParams, Date, JSON, Math, Promise, Set, Map, Array, Object, String, Number, Boolean, RegExp, Error, isNaN, parseInt, parseFloat,
    Event: class Event {}, CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; Object.assign(this, init || {}) } }
  }
  win.window = win
  win.globalThis = win
  win.self = win

  vm.createContext(win)
  vm.runInContext(SRC, win, { filename: 'cf4.js' })
  // cf4.js wraps its whole body in DOMContentLoaded (line 1); the page is
  // already "complete" here, so fire it exactly as a browser would.
  ;(docListeners.DOMContentLoaded || []).forEach(fn => fn({}))

  return {
    logo: () => (byId.headerLeftLogo ? byId.headerLeftLogo.src : '(no element)'),
    line: () => matchAll('.header-hospital').map(e => e.textContent).join(' | ')
  }
}

console.log('')
console.log('==== CF4 HEADER — does the logo follow REVER <-> CUMC? ====')
console.log('')

/* ---- 1 · the CF4 dropdown set to REVER (the reported bug) ------------ */
{
  const page = boot({ cf4Hospital: 'rever' })
  ok('H1', 'the dropdown set to REVER swaps the logo to RMCI',
     page.logo().includes('rmci-logo.png'), 'src=' + page.logo())
  ok('H2', 'and the hospital line reads REVER MEDICAL CENTER INC.',
     page.line().includes('REVER MEDICAL CENTER INC.'), 'line="' + page.line() + '"')
}

/* ---- 2 · nothing saved: the default stays CUMC ----------------------- */
{
  const page = boot({})
  ok('H3', 'with no settings the default logo is the CUMC one',
     page.logo().includes('cumc-logo.png'), 'src=' + page.logo())
  ok('H4', 'and the default line reads CAPITOL UNIVERSITY MEDICAL CENTER',
     page.line().includes('CAPITOL UNIVERSITY MEDICAL CENTER'), 'line="' + page.line() + '"')
}

/* ---- 3 · a custom upload still beats the hospital preset ------------- */
{
  const page = boot({ cf4Hospital: 'rever', cf4LeftLogo: 'data:image/png;base64,CUSTOM' })
  ok('H5', 'a custom-uploaded left logo wins over the REVER preset',
     page.logo() === 'data:image/png;base64,CUSTOM', 'src=' + page.logo())
}

/* ---- 4 · the endoscopy select is the fallback, not ignored ------------ */
{
  const page = boot({}, { hospitalHeader: 'rever' })
  ok('H6', 'with no CF4 key the endoscopy REVER selection drives the logo',
     page.logo().includes('rmci-logo.png'), 'src=' + page.logo())
  ok('H7', 'and the hospital line follows it too',
     page.line().includes('REVER MEDICAL CENTER INC.'), 'line="' + page.line() + '"')
}

console.log('')
console.log(`  ${passed} passed, ${failed} failed`)
console.log('')
process.exitCode = failed ? 1 : 0

