// =====================================================================
//  test_cf4_restore.mjs
//  Does a saved CF4 keep its Sex (and its radios) from save to reopen?
//  ---------------------------------------------------------------------
//  The bug this locks down: a saved record came back with a BLANK Sex, and
//  the next "Save to Database" wrote that blank over the real value. Three
//  defects in function/cf4.js, all on the restore side (the SAVE always
//  carried patientSex - FormData includes checked radios):
//
//    1. restoreFormDataFromJSON looked the group up with getElementById,
//       but the radios in cf4Form.html carry only a NAME - no id - so the
//       lookup returned null and the function returned early: Sex stayed
//       exactly as the last patient left it (or blank on a fresh page).
//    2. loadFormData (the local-device restore) compared the saved value
//       against the FIRST radio of the group only - querySelector returns
//       it - so a saved "Female" could never come back ("Male" is first).
//    3. resetCf4FormToBlank cleared checkboxes and the three default radio
//       groups, but NOT patientSex: the previous patient's sex survived
//       the reset and was offered as this patient's.
//
//  No network. cf4.js is booted in a VM against a small DOM built from the
//  REAL pages/cf4Form.html (ids, radios and names are parsed from the file,
//  so the harness fails loudly if the form's shape ever changes).
//
//  Run: node supabase-v2/scripts/test_cf4_restore.mjs
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

// ---------------------------------------------------------------- DOM ----
const html = readFileSync(join(APP, 'pages', 'cf4Form.html'), 'utf8')
const elements = []
const byId = {}

function attrsOf(tag) {
  const a = {}
  const re = /([a-zA-Z-]+)="([^"]*)"/g
  let m
  while ((m = re.exec(tag))) a[m[1]] = m[2]
  return a
}
function makeEl(tagName, attrs) {
  const el = {
    tag: tagName,
    id: attrs.id,
    name: attrs.name,
    value: attrs.value !== undefined ? attrs.value : '',
    type: attrs.type || (tagName === 'textarea' ? 'textarea' : tagName === 'select' ? 'select' : 'text'),
    checked: /(?:\s|^)checked(?:\s|>|\/|=)/.test(attrs._raw || ''),
    style: {}, dataset: {}, children: [], hidden: false,
    innerHTML: '', textContent: '', files: [],
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

// The selectors the CF4 code actually uses. Anything else (class lookups,
// header slots) simply matches nothing - the real page's ids carry it.
function matchAll(sel) {
  sel = String(sel).trim()
  let m
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
  // "input[type="text"], input[type=...], textarea, select" - the reset
  // selector. Split it and union the simple parts.
  if (sel.includes(',')) {
    const out = []
    sel.split(',').forEach(part => { for (const e of matchAll(part)) if (!out.includes(e)) out.push(e) })
    return out
  }
  if (sel === 'textarea' || sel === 'select') {
    return elements.filter(e => e.tag === sel)
  }
  return []                       // classes, slots, templates: not present
}

// Parse the REAL form: every element with an id, plus the radio groups
// (which deliberately have no id - that is the bug).
const tagRe = /<(input|textarea|select|form|button|div|span|a|label)\b[^>]*>/g
let t
while ((t = tagRe.exec(html))) {
  const attrs = attrsOf(t[0])
  if (!attrs.id && !/^input$/i.test(t[1])) continue
  if (!attrs.id && t[1] === 'input' && attrs.type !== 'radio' && attrs.type !== 'checkbox') continue
  attrs._raw = t[0]
  makeEl(t[1].toLowerCase(), attrs)
}
if (!byId['cf4-form']) {
  makeEl('form', { id: 'cf4-form' })
}

// ------------------------------------------------------------- window ----
const store = new Map()
const localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)) },
  removeItem: k => { store.delete(k) },
  clear: () => store.clear()
}
// A previously saved draft on this device: a female patient. This is the
// loadFormData path (defect 2) - it must come back checked.
localStorage.setItem('cf4FormData', JSON.stringify({
  patientLastName: 'LOCALDRAFT',
  patientSex: 'Female'
}))

const docListeners = {}
const document = {
  readyState: 'complete', hidden: false,
  body: { classList: { contains: () => false }, appendChild() {}, insertAdjacentHTML() {} },
  getElementById: id => byId[id] || null,
  createElement: tag => makeEl(String(tag).toLowerCase(), {}),
  createTextNode: () => ({}),
  addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn) },
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
  setTimeout: () => 0, clearTimeout: () => {},      // auto-fill timers: not run
  setInterval: () => 0, clearInterval: () => {},
  addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
  alert() {}, confirm: () => true, prompt: () => '',
  URL, URLSearchParams, Date, JSON, Math, Promise, Set, Map, Array, Object, String, Number, Boolean, RegExp, Error, isNaN, parseInt, parseFloat,
  Event: class Event {}, CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; Object.assign(this, init || {}) } }
}
win.window = win
win.globalThis = win
win.self = win

const src = readFileSync(join(APP, 'function', 'cf4.js'), 'utf8')
vm.createContext(win)
vm.runInContext(src, win, { filename: 'cf4.js' })
// cf4.js wraps its whole body in a DOMContentLoaded listener (line 1).
// The page is already "complete" here, so fire it exactly as a browser
// would when the script lands after parsing.
;(docListeners.DOMContentLoaded || []).forEach(fn => fn({}))

const sexOf = v => {
  const r = matchAll(`input[name="patientSex"][value="${v}"]`)[0]
  return r ? !!r.checked : false
}
const anySex = () => sexOf('Male') || sexOf('Female')

console.log('')
console.log('==== CF4 RESTORE — does the Sex survive save → reopen? ====')
console.log('')

/* ---- 1 · the local-device restore (loadFormData) --------------------- */
{
  ok('R1', 'a locally saved "Female" comes back checked',
     sexOf('Female') && !sexOf('Male'),
     'Female=' + sexOf('Female') + ' Male=' + sexOf('Male'))
  ok('R2', 'the other fields of that draft load too',
     byId.patientLastName && byId.patientLastName.value === 'LOCALDRAFT',
     'patientLastName=' + (byId.patientLastName && byId.patientLastName.value))
}

/* ---- 2 · reopening a record from the database ------------------------ */
const bridge = win.EntFormBridge
ok('R3', 'the form bridge exists so a record can be opened at all',
   bridge && typeof bridge.restore === 'function')

if (bridge) {
  // A saved DB record with the sex recorded.
  bridge.restore({ patientLastName: 'CLOUDPATIENT', patientSex: 'Female' })
  ok('R4', 'reopening a saved record restores its Sex (no id on the radio)',
     sexOf('Female') && !sexOf('Male'),
     'Female=' + sexOf('Female') + ' Male=' + sexOf('Male'))
  ok('R5', 'and the rest of that record comes back with it',
     byId.patientLastName.value === 'CLOUDPATIENT',
     'patientLastName=' + byId.patientLastName.value)

  // A record whose payload has NO patientSex at all: the previous patient's
  // selection must not survive the reset (defect 3).
  bridge.restore({ patientLastName: 'NOSEXRECORD' })
  ok('R6', "a record without a Sex clears the previous patient's selection",
     !anySex(),
     'Male=' + sexOf('Male') + ' Female=' + sexOf('Female'))

  // An explicit blank (payload wrote '' because nothing was checked).
  bridge.restore({ patientLastName: 'BLANKSEX', patientSex: '' })
  ok('R7', 'an explicitly blank Sex clears the group instead of keeping it',
     !anySex())

  // Male comes back too - not only the value that happens to be first.
  bridge.restore({ patientLastName: 'MALERECORD', patientSex: 'Male' })
  ok('R8', 'a saved "Male" comes back checked as well',
     sexOf('Male') && !sexOf('Female'))

  // The default radios are still defaulted after a reset that cleared all
  // radios - referredFromHci has an HTML default of "No".
  const refNo = matchAll('input[name="referredFromHci"][value="No"]')[0]
  ok('R9', 'the default radios (Referred = No) survive the radio clear',
     refNo && refNo.checked, 'referredFromHci/No=' + (refNo && refNo.checked))
}

console.log('')
console.log(`  ${passed} passed, ${failed} failed`)
console.log('')
process.exitCode = failed ? 1 : 0

