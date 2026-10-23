#!/usr/bin/env node
/* =====================================================================
 *  test_presence_polling.mjs — the Tier 1 presence cut, measured.
 * ---------------------------------------------------------------------
 *  Two production changes on 2026-10-03 to cut Supabase log ingestion:
 *
 *    1. admin.js  REFRESH_MS  15000 -> 30000   ("ACTIVE NOW" poll)
 *    2. auth.js   beat()      + `if (document.hidden) return false`
 *
 *  Neither is asserted from source text here. This loads the REAL auth.js
 *  into a stubbed browser, drives the real visibilitychange and interval
 *  paths, and COUNTS the requests that actually go out. A regex would pass
 *  on a change that never runs.
 *
 *    H1  a visible tab still heartbeats          (no regression)
 *    H2  a hidden tab sends NOTHING              (the change works)
 *    H3  returning to the tab beats immediately  (resume, not restart)
 *    H4  the interval keeps ticking afterwards
 *    H5  the session guard still precedes it     (fail-closed intact)
 *    H6  authentication is unchanged
 *    H7  the heartbeat UP-SERTS — no 409 after the first beat
 *    P1  the 5-minute presence window is intact
 *    P2  admin.js polls at 30s, and only liveTick uses it
 *
 *  No network. Run: node supabase-v2/scripts/test_presence_polling.mjs
 * ===================================================================== */
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

/* ---- the browser ---------------------------------------------------- */
// A DOM element good enough for renderChrome() and friends: querySelector,
// classList, dataset, style, appendChild and the text/HTML setters.
function makeEl(id = '') {
  const el = {
    id,
    innerHTML: '', textContent: '', value: '', hidden: false, disabled: false,
    dataset: {}, style: {}, className: '',
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    querySelector: () => makeEl('child'),
    querySelectorAll: () => [],
    getAttribute: () => null,
    setAttribute() {}, removeAttribute() {},
    appendChild(c) { return c }, removeChild() {}, replaceChildren() {},
    addEventListener() {}, removeEventListener() {},
    closest: () => null, focus() {}, blur() {}, click() {},
    getContext: () => null,
  }
  return el
}

function makeWin() {
  const sent = []
  const timers = []          // every setInterval the app registers
  const visListeners = []
  const store = new Map()

  const win = {
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    document: {
      readyState: 'complete',
      hidden: false,                     // <-- the knob under test
      body: { classList: { contains: () => false } },
      addEventListener: (t, fn) => { if (t === 'visibilitychange') visListeners.push(fn) },
      // auth.js boots itself on load and renders the header chip, so the
      // elements it reaches for must look like elements - not bare {}.
      // A stub that returns null (or an object without querySelector) makes
      // renderChrome() throw, and the test then dies inside app code
      // instead of reporting on the heartbeat.
      getElementById: (id) => makeEl(id),
      querySelector: () => makeEl('q'),
      createElement: () => makeEl('created'),
    },
    addEventListener: () => {},
    dispatchEvent: () => {},
    location: { pathname: '/index.html', search: '', href: '' },
    navigator: { userAgent: 'node-test', onLine: true },
    console, clearInterval: () => {},
    // setInterval is CAPTURED, never scheduled: the test drives it by hand
    // so every assertion is deterministic rather than time-dependent.
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    // setTimeout must be the REAL one, and must NOT run its callback
    // synchronously. login() races signInWithPassword() against a
    // 15-second ceiling built from setTimeout; a stub that invokes the
    // callback immediately rejects that race instantly and every sign-in
    // fails with "The server did not answer in time" - so no heartbeat is
    // ever started and the test measures a broken harness rather than the
    // app. test_admin_console.mjs carries the same warning.
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms)
      // Do not let a pending timer hold the process open at exit.
      if (t && typeof t.unref === 'function') t.unref()
      return t
    },
    clearTimeout: (t) => clearTimeout(t),
  }
  win.window = win
  win.globalThis = win
  win.__sent = sent
  win.__timers = timers
  win.__vis = visListeners
  win.__setHidden = (v) => { win.document.hidden = v }
  return win
}

const sessionRow = [{ id: 'u1', username: 'testdoc1', role: 'doctor', is_active: true, must_change_password: false }]
const win = makeWin()

win.supabase = {
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: win.__session }, error: null }),
      signInWithPassword: async () => ({ data: { user: { id: 'u1', email: 'testdoc1@zztest.invalid' } }, error: null }),
      updateUser: async () => ({ data: {}, error: null }),
      signOut: async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  }),
}

win.fetch = async (url, opts = {}) => {
  win.__sent.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {} })
  return { ok: true, status: 200, text: async () => JSON.stringify(sessionRow), json: async () => sessionRow }
}

win.__session = { access_token: 'SESSION-JWT-abc', user: { id: 'u1' } }

/* ---- load the real modules ------------------------------------------ */
let loadError = ''
try {
  for (const f of ['supabaseClient.js', 'photoStore.js', 'auth.js']) {
    const code = readFileSync(join(APP, 'function', f), 'utf8')
    vm.createContext(win)
    vm.runInContext(code, win, { filename: f })
  }
} catch (e) { loadError = String(e && e.message || e) }

console.log('')
console.log('==== PRESENCE POLLING — Tier 1, measured against the real auth.js ====')
console.log('')
ok('L0', 'the app loads', loadError === '', loadError || 'clean')

const A = win.EntAuth
if (!A) { console.log('\nFATAL: auth.js did not export EntAuth'); process.exit(1) }

// Sign in through the real path, so the heartbeat starts on real code.
;(async () => {
  await A.login('testdoc1', 'pw')

  const beats = () => win.__sent.filter(r => r.url.includes('user_presence')).length
  const hb = () => win.__timers.find(t => t.ms === 30000)

  // ---- H1 · a visible tab still heartbeats ---------------------------
  // startHeartbeat() fires beat() immediately, so a signed-in VISIBLE tab
  // has already sent one by the time we get here.
  const afterLogin = beats()
  ok('H1', 'a VISIBLE tab heartbeats on sign-in', afterLogin > 0,
     `${afterLogin} user_presence POST(s) at sign-in`)
  ok('H1b', 'the heartbeat interval is still 30s (unchanged)', !!hb(),
     hb() ? `setInterval(beat, ${hb().ms})` : 'no 30s timer registered')

  win.__setHidden(false)
  win.__sent.length = 0
  await hb().fn(); await hb().fn()
  ok('H1c', 'each visible interval tick sends exactly one heartbeat',
     beats() === 2, `${beats()} after 2 ticks`)

  // ---- H2 · a hidden tab sends NOTHING -------------------------------
  win.__setHidden(true)
  win.__sent.length = 0
  await hb().fn(); await hb().fn(); await hb().fn()
  ok('H2', 'a HIDDEN tab sends NO heartbeat', beats() === 0,
     `${beats()} after 3 ticks while hidden`)

  // ---- H3 · returning beats IMMEDIATELY, not in 30s ------------------
  win.__setHidden(false)
  win.__sent.length = 0
  win.__vis.forEach(fn => fn())                 // the real visibilitychange path
  await new Promise(r => setTimeout(r, 20))
  ok('H3', 'returning to the tab beats IMMEDIATELY', beats() > 0,
     `${beats()} on visibilitychange, no interval wait`)

  // ---- H4 · the interval keeps working afterwards --------------------
  win.__setHidden(false)
  win.__sent.length = 0
  await hb().fn()
  ok('H4', 'the interval keeps beating after the tab returns', beats() === 1,
     `${beats()} on the next tick`)

  win.__setHidden(true);  win.__sent.length = 0
  await hb().fn()
  const quiet = beats()
  win.__setHidden(false); await hb().fn()
  const loud = beats()
  ok('H4b', 'a hide/show cycle toggles cleanly, and only ONE heartbeat timer exists',
     quiet === 0 && loud === 1 && win.__timers.filter(t => t.ms === 30000).length === 1,
     `hidden=${quiet} visible=${loud} 30s-timers=${win.__timers.filter(t => t.ms === 30000).length}`)

  // ---- H7 · the heartbeat is an UPSERT, not a bare INSERT ------------
  // user_presence is keyed (user_id, device_label): the row from the
  // previous beat still exists, so a bare INSERT answered 409 (23505)
  // on every tick after the first and seen_at froze — "ACTIVE NOW" went
  // stale while the console merely looked noisy. Both halves are
  // load-bearing: the conflict target names the key, and Prefer tells
  // PostgREST to merge instead of reject.
  win.__setHidden(false)
  win.__sent.length = 0
  await hb().fn()
  const upsert = win.__sent.find(r => r.url.includes('user_presence'))
  ok('H7', 'the heartbeat names the conflict target',
     !!upsert && /on_conflict=user_id,device_label/.test(upsert.url),
     upsert ? upsert.url.split('/rest/v1')[1] : 'no heartbeat sent')
  ok('H7b', 'and carries Prefer: resolution=merge-duplicates',
     !!upsert && /resolution=merge-duplicates/.test(String((upsert.headers || {}).Prefer || '')),
     upsert ? String((upsert.headers || {}).Prefer || '(no Prefer header)') : 'no heartbeat')

  // ---- H5 · the session guard still comes FIRST ----------------------
  // Order is asserted by POSITION, not by a character distance. A fixed
  // window silently breaks the moment someone adds a comment explaining
  // the guard - which is exactly what happened on the first run of this
  // test, and it failed for a reason that had nothing to do with order.
  const authSrc = readFileSync(join(APP, 'function', 'auth.js'), 'utf8')
  const iSession = authSrc.indexOf('if (!signedInUser) return false;')
  const iHidden = authSrc.indexOf('if (document.hidden) return false;')
  ok('H5', 'the session guard PRECEDES the hidden guard (fail-closed intact)',
     iSession >= 0 && iHidden > iSession,
     `session@${iSession} hidden@${iHidden}`)
  ok('H5b', 'both guards are inside beat(), not somewhere else',
     iSession < authSrc.indexOf('function startHeartbeat') &&
     iHidden < authSrc.indexOf('function startHeartbeat'),
     'both sit above startHeartbeat(), which is beat()\'s only caller')

  // ---- H6 · authentication is untouched ------------------------------
  const me = A.currentUser()
  ok('H6', 'the session user is intact after all of that',
     !!me && me.username === 'testdoc1', me ? `${me.username}/${me.role}` : 'no user')
  ok('H6b', 'sign-in still succeeds (nothing above broke login)',
     !!me && me.is_active !== false && me.role === 'doctor')

  // ---- P1 · the 5-minute window is untouched -------------------------
  ok('P1', 'the ACTIVE_WINDOW is still 5 minutes',
     A.ACTIVE_WINDOW_MS === 5 * 60 * 1000, `${A.ACTIVE_WINDOW_MS}ms`)

  // ---- P2 · admin.js ---------------------------------------------------
  // Comments are stripped first, and the match is word-bounded. A bare
  // /REFRESH_MS/ also matches ANALYTICS_REFRESH_MS, and a comment that
  // merely MENTIONS the constant inflates the count - both of which
  // happened on the first run of this test.
  const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const adminSrc = readFileSync(join(APP, 'function', 'admin.js'), 'utf8')
  const adminCode = strip(adminSrc)
  const c = /const REFRESH_MS = (\d+);/.exec(adminCode)
  ok('P2', 'admin.js REFRESH_MS is now 30000', !!c && c[1] === '30000',
     c ? c[0] : 'not found')

  const uses = [...adminCode.matchAll(/(?<![\w.])REFRESH_MS/g)].length
  ok('P2b', 'REFRESH_MS still drives liveTick and NOTHING else',
     /setInterval\(liveTick, REFRESH_MS\)/.test(adminCode) && uses === 2,
     `${uses} live occurrences after stripping comments and excluding ANALYTICS_REFRESH_MS`)

  ok('P2c', 'a 30s poll is still well inside the 5-minute window',
     !!c && Number(c[1]) * 10 <= 5 * 60 * 1000,
     `${c ? c[1] : '?'}s x 10 = 300s <= 300s window`)
  ok('P2d', 'ANALYTICS_REFRESH_MS still the free-plan value (120s)',
     /const ANALYTICS_REFRESH_MS = 120000/.test(adminCode),
     'out of scope for the presence fix; stays doubled for egress')

  console.log('')
  console.log(failed === 0
    ? `==== ALL PASSED — ${passed} passed, 0 failed ====`
    : `==== ${failed} FAILED — ${passed} passed ====`)
  console.log('')
  process.exit(failed === 0 ? 0 : 1)
})()
