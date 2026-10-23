// temp/test_offline_auth.mjs
// ---------------------------------------------------------------------------
// OFFLINE ACCESS CONTRACT (v36a). Loads the REAL function/paths.js,
// function/supabaseClient.js and function/auth.js into a stubbed browser
// (node:vm + node:webcrypto) and proves the security + usability rules the
// offline login redesign must keep:
//   S  static: the plaintext era is really gone from the shipped files
//   A1 the legacy entSavedLoginV1 plaintext key is deleted on load
//   A2 a successful ONLINE sign-in writes an offline GRANT (salt + PBKDF2
//      verifier + profile snapshot) and never a password
//   A3 getOfflineGrant() hands out only the username - never the verifier
//   A4 offline sign-in with the RIGHT password works and carries the REAL
//      role/identity (doctor), marked offline:true
//   A5 offline sign-in with a WRONG password is refused
//   A6 offline sign-in for an account this device has NO grant for is
//      refused with the same wording (no account enumeration)
//   A7 a fresh tab offline (no verified session) NEVER gets a fabricated
//      user: ready() is null and the page is redirected to login
//   A8 after offline verification, a RELOAD offline keeps the session:
//      guard() passes, scope() is the doctor's real shelf
//   A9 ONLINE with only the offline mark: ready() refuses - a real
//      Supabase sign-in is required again
//   A10 logout() clears grant + mark + legacy key
//   A11 auth.js registers the service worker on every page
//   A12 readSession().offline marks the session as offline access
//
// Run: node temp/test_offline_auth.mjs
// ---------------------------------------------------------------------------
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function ok(id, label, cond, extra) {
  if (cond) { passed++; console.log(`  \u2713 ${id}  ${label}`); }
  else { failed++; console.log(`  \u2717 ${id}  ${label}${extra ? ' -- ' + extra : ''}`); }
}

/* ------------------------------ static checks ---------------------------- */
console.log('\n==== OFFLINE ACCESS (v36a) TESTS ====\n');
const loginSrc = fs.readFileSync(path.join(ROOT, 'pages', 'login.html'), 'utf8');
const authSrc = fs.readFileSync(path.join(ROOT, 'function', 'auth.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const readySrc = fs.readFileSync(path.join(ROOT, 'function', 'offlineReady.js'), 'utf8');

ok('S1', 'login.html no longer DECLARES or WRITES the plaintext login key',
   !/const SAVED_LOGIN_KEY/.test(loginSrc) && !/password:\s*pass/.test(loginSrc),
   'plaintext storage still present');
ok('S2', 'auth.js never READS the old plaintext key',
   !/getItem\(SAVED_LOGIN_KEY\)/.test(authSrc),
   'SAVED_LOGIN_KEY read still present');
ok('S3', 'login.html never auto-enters the dashboard unverified',
   !/btn\.textContent\s*=\s*['"]Sign in \(Offline\)['"]/.test(loginSrc)
   && !/landingPage\(\{\s*role:\s*['"]offline['"]/.test(loginSrc)
   && !/SAVED_LOGIN_KEY/.test(loginSrc),
   'old one-click bypass still present');
ok('S4', 'sw.js can VERIFY its cache on request (offline-ready proof)',
   /ent-verify-offline/.test(swSrc) && /ent-offline-report/.test(swSrc));
ok('S5', 'offlineReady.js exists and reports honestly',
   /Offline-ready/.test(readySrc) && /not prepared for offline use yet/.test(readySrc));

/* ------------------------------ browser stub ----------------------------- */
function makeWindow(opts) {
  const o = opts || {};
  const ls = o.ls || new Map();
  const ss = o.ss || new Map();
  const state = { rows: o.rows || [] };
  const store = (m) => ({
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    clear: () => m.clear(),
    key: i => [...m.keys()][i] ?? null,
    get length() { return m.size }
  });
  const win = {
    localStorage: store(ls),
    sessionStorage: store(ss),
    document: {
      readyState: 'complete',
      hidden: false,
      body: { classList: { contains: () => false }, appendChild(c) { return c; } },
      addEventListener: () => {},
      getElementById: () => null,
      querySelector: () => null,
      createElement: (t) => ({
        tagName: String(t).toUpperCase(), style: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        setAttribute() {}, appendChild() {}, addEventListener() {},
        querySelector: () => ({ addEventListener() {} })
      })
    },
    addEventListener: () => {}, dispatchEvent: () => {},
    location: {
      pathname: o.pathname || '/pages/login.html', search: '', href: '', protocol: 'https:',
      replace(v) { win.__replaced.push(String(v)); }
    },
    navigator: {
      userAgent: 'node-test',
      onLine: o.onLine !== false,
      serviceWorker: {
        register(url) { win.__swRegistered.push(String(url)); return Promise.resolve({}); },
        addEventListener: () => {}
      }
    },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    TextEncoder, TextDecoder, crypto: webcrypto, btoa, atob,
    CustomEvent: class { constructor(t, d) { this.detail = d && d.detail; } },
    fetch: async (url) => {
      win.__fetched.push(String(url));
      return { ok: true, status: 200, text: async () => JSON.stringify(state.rows), json: async () => state.rows };
    },
    supabase: {
      createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: win.__session }, error: null }),
          signInWithPassword: async (c) => { win.__signInCreds = c; return win.__signInResult; },
          updateUser: async () => ({ data: {}, error: null }),
          signOut: async () => { win.__signedOut = (win.__signedOut || 0) + 1; win.__session = null; return { error: null }; },
          onAuthStateChange: (cb) => { win.__notify = cb; return { data: { subscription: { unsubscribe() {} } } } }
        }
      })
    }
  };
  win.__session = null;
  win.__signInResult = { data: { user: null }, error: { message: 'not signed in' } };
  win.__replaced = [];
  win.__swRegistered = [];
  win.__fetched = [];
  win.__setRows = (r) => { state.rows = r; };
  win.window = win;
  win.globalThis = win;
  return win;
}

function loadScripts(win, files) {
  for (const f of files) {
    const code = fs.readFileSync(path.join(ROOT, 'function', f), 'utf8');
    vm.createContext(win);
    vm.runInContext(code, win, { filename: f });
  }
}
const PROFILE = {
  id: 'u-doc', username: 'testdoc1', full_name: 'Dr Test', role: 'doctor',
  clinic_id: 'c1', assigned_doctor_id: null, is_active: true, must_change_password: false
};
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

;(async () => {
  /* ===== w1: first visit, ONLINE, legacy plaintext key present ===== */
  const sharedLS = new Map();
  const sharedSS = new Map();
  const w1 = makeWindow({ ls: sharedLS, ss: sharedSS, onLine: true, pathname: '/pages/login.html' });
  w1.localStorage.setItem('entSavedLoginV1', JSON.stringify({ username: 'testdoc1', password: 'PlainText1!', at: Date.now() }));
  w1.__setRows([PROFILE]);
  w1.__session = { access_token: 'JWT', user: { id: 'u-doc' } };
  w1.__signInResult = { data: { user: { id: 'u-doc', email: 'testdoc1@zztest.invalid' } }, error: null };
  let loadErr = '';
  try { loadScripts(w1, ['paths.js', 'supabaseClient.js', 'auth.js']); }
  catch (e) { loadErr = String((e && e.stack) || e); }
  ok('L1', 'paths + supabaseClient + auth load as a module graph', loadErr === '', loadErr.slice(0, 300));

  ok('A11', 'auth.js registers the service worker on every page',
     w1.__swRegistered.some(u => /sw\.js$/.test(u)), JSON.stringify(w1.__swRegistered));
  ok('A1', 'the legacy plaintext login key is deleted on load',
     w1.localStorage.getItem('entSavedLoginV1') === null);

  /* ===== A2/A3: a successful ONLINE sign-in writes the grant ===== */
  const A = w1.EntAuth;
  const loginRes = await A.login('testdoc1', 'Correct-Horse-1');
  ok('A2a', 'online sign-in succeeds against the stubbed server',
     loginRes.success === true, JSON.stringify(loginRes));
  const rawGrant = w1.localStorage.getItem('entOfflineGrantV2');
  let grant = null;
  try { grant = JSON.parse(rawGrant || 'null'); } catch (e) { grant = null; }
  ok('A2b', 'the sign-in wrote an offline grant (v2 + salt + verifier + profile)',
     !!grant && grant.v === 2 && !!grant.salt && !!grant.verifier &&
     !!grant.profile && grant.profile.id === 'u-doc',
     rawGrant ? 'grant shape wrong' : 'no grant written');
  ok('A2c', 'the grant stores NO password anywhere',
     !!grant && !('password' in grant) && !/Correct-Horse-1/.test(rawGrant || ''),
     'password leaked into the grant');
  ok('A2d', 'the grant keeps the SERVER profile (role + clinic) for identity',
     !!grant && grant.profile.role === 'doctor' && grant.profile.clinic_id === 'c1');
  const pub = A.getOfflineGrant();
  ok('A3', 'getOfflineGrant() exposes only username + grantedAt',
     !!pub && pub.username === 'testdoc1' && !pub.verifier && !pub.salt && !pub.profile,
     JSON.stringify(pub));

  /* ===== A4-A6 + A12: OFFLINE sign-in against the grant ===== */
  w1.navigator.onLine = false;
  const good = await A.loginOffline('testdoc1', 'Correct-Horse-1');
  ok('A4a', 'offline sign-in with the RIGHT password succeeds (offline:true)',
     good.success === true && good.offline === true, JSON.stringify(good && good.error));
  ok('A4b', 'the offline session carries the REAL identity and role',
     !!good.user && good.user.id === 'u-doc' && good.user.role === 'doctor',
     JSON.stringify(good.user && { id: good.user.id, role: good.user.role }));
  ok('A4c', 'scope() offline is the doctor\'s own shelf (never "offline")',
     A.scope().doctorId === 'u-doc' && A.scope().seeAll === false,
     JSON.stringify(A.scope()));
  const sess = A.readSession();
  ok('A12', 'readSession() marks this as an OFFLINE ACCESS session',
     !!sess && sess.offline === true, JSON.stringify(sess && sess.offline));

  const bad = await A.loginOffline('testdoc1', 'wrong-password');
  ok('A5', 'offline sign-in with the WRONG password is refused',
     bad.success === false && /Wrong username or password/.test(bad.error || ''),
     JSON.stringify(bad.error));
  const stranger = await A.loginOffline('someone-else', 'Correct-Horse-1');
  ok('A6', 'an account with no grant here is refused with the same wording',
     stranger.success === false && /Wrong username or password/.test(stranger.error || ''),
     JSON.stringify(stranger.error));
  ok('A5b', 'failed offline attempts do NOT destroy the active session',
     !!A.currentUser() && A.currentUser().id === 'u-doc',
     JSON.stringify(A.currentUser() && A.currentUser().id));

  /* ===== A8: reload the app OFFLINE (same storage, fresh window) ===== */
  const w2 = makeWindow({ ls: sharedLS, ss: sharedSS, onLine: false, pathname: '/pages/login.html' });
  w2.__setRows([PROFILE]);
  let loadErr2 = '';
  try { loadScripts(w2, ['paths.js', 'supabaseClient.js', 'auth.js']); }
  catch (e) { loadErr2 = String((e && e.stack) || e); }
  ok('L2', 'the offline reload loads the module graph too', loadErr2 === '', loadErr2.slice(0, 300));
  w2.location.pathname = '/pages/nasalEndoscopy.html';
  const guardSession = await w2.EntAuth.guard();
  ok('A8a', 'reload offline: guard() passes with the verified offline session',
     !!guardSession && !!guardSession.user && guardSession.user.id === 'u-doc',
     JSON.stringify(guardSession));
  ok('A8b', 'reload offline: scope() still names the doctor\'s real shelf',
     w2.EntAuth.scope().doctorId === 'u-doc' && w2.EntAuth.scope().role === 'doctor',
     JSON.stringify(w2.EntAuth.scope()));
  ok('A8c', 'reload offline: no redirect loop back to login',
     w2.__replaced.length === 0, JSON.stringify(w2.__replaced));
  ok('A12b', 'reload offline: the session is still flagged as offline access',
     !!(w2.EntAuth.readSession() || {}).offline);

  /* ===== A7: a FRESH TAB offline (empty sessionStorage) ===== */
  const w3 = makeWindow({ ls: sharedLS, ss: new Map(), onLine: false, pathname: '/pages/nasalEndoscopy.html' });
  w3.__setRows([PROFILE]);
  try { loadScripts(w3, ['paths.js', 'supabaseClient.js', 'auth.js']); }
  catch (e) { console.log('  (w3 load error) ' + e); }
  await tick(40);
  const u3 = await w3.EntAuth.ready();
  ok('A7a', 'fresh tab offline with NO verified session gets NO user',
     u3 === null, JSON.stringify(u3));
  ok('A7b', 'fresh tab offline is sent to the login screen (no fabricated role)',
     w3.__replaced.some(u => /login\.html/.test(u)), JSON.stringify(w3.__replaced));

  /* ===== A9: ONLINE with only the offline mark: real sign-in required ===== */
  const w4 = makeWindow({ ls: sharedLS, ss: sharedSS, onLine: true, pathname: '/pages/login.html' });
  w4.__setRows([PROFILE]);
  try { loadScripts(w4, ['paths.js', 'supabaseClient.js', 'auth.js']); }
  catch (e) { console.log('  (w4 load error) ' + e); }
  const u4 = await w4.EntAuth.ready();
  ok('A9', 'ONLINE: the offline session is refused until Supabase signs in again',
     u4 === null, JSON.stringify(u4));

  /* ===== A10: logout kills offline access entirely ===== */
  await w1.EntAuth.logout();
  ok('A10a', 'logout clears the device offline grant',
     w1.localStorage.getItem('entOfflineGrantV2') === null);
  ok('A10b', 'logout clears any legacy plaintext key',
     w1.localStorage.getItem('entSavedLoginV1') === null);
  ok('A10c', 'logout clears this tab\'s offline session mark',
     w1.sessionStorage.getItem('entOfflineSessionV1') === null);

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('UNCAUGHT:', e);
  process.exit(1);
});
