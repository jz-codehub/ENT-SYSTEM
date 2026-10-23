// temp/test_offline_ux.mjs
// ---------------------------------------------------------------------------
// OFFLINE SAVE UX runtime test. Loads the REAL function/syncEngine.js and
// function/draftsBrowser.js in a VM with a minimal DOM and asserts:
//   S1  a flush that uploads the last queued record fires
//       'ent-offline:all-synced' and shows the confirmation card
//       "All offline records already saved to database"
//   S2  a flush with nothing to push shows NO card
//   S3  a flush that leaves jobs behind (partial upload) shows NO card
//   D1  "Save to Offline Mode" with no signal -> amber toast
//       "Saved to Offline Mode ... will be saved to the database
//       automatically when you have signal"
//   D2  the same save WITH signal keeps the old wording
// ---------------------------------------------------------------------------
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function ok(id, label, cond, extra) {
  if (cond) { passed++; console.log(`  \u2713 ${id}  ${label}`); }
  else { failed++; console.log(`  \u2717 ${id}  ${label}${extra ? ' -- ' + extra : ''}`); }
}

/* ------------------------------ mini-DOM -------------------------------- */
function makeClassList() {
  const s = new Set();
  return {
    add: (...c) => c.forEach(x => s.add(x)),
    remove: (...c) => c.forEach(x => s.delete(x)),
    toggle(c, force) {
      if (force === undefined) { s.has(c) ? s.delete(c) : s.add(c); }
      else if (force) s.add(c); else s.delete(c);
    },
    contains: (c) => s.has(c),
    toString: () => [...s].join(' ')
  };
}
function makeEl(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    _listeners: {},
    className: '', id: '', textContent: '', innerHTML: '',
    offsetWidth: 1, hidden: false, style: {}, dataset: {},
    classList: makeClassList(),
    setAttribute(k, v) { this['attr_' + k] = String(v); },
    getAttribute(k) { return this['attr_' + k] ?? null; },
    addEventListener(t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); },
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; },
    contains(c) { return this === c || this.children.includes(c); },
    querySelector(sel) { (this._q = this._q || {})[sel] = this._q[sel] || makeEl('span'); return this._q[sel]; },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {}, click() { (this._listeners.click || []).forEach(f => f({ target: this })); }
  };
}
function makeDocument() {
  const body = makeEl('body');
  return {
    readyState: 'complete', body,
    createElement: (t) => makeEl(t),
    createTextNode: (t) => { const n = makeEl('#text'); n.textContent = t; return n; },
    getElementById: () => null,
    getElementsByTagName: () => [], getElementsByClassName: () => [],
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => []
  };
}
function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; }
  };
}
function makeWindow(opts = {}) {
  const listeners = new Map();
  const win = {
    document: makeDocument(),
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    navigator: { onLine: opts.onLine !== false },
    location: { pathname: '/pages/nasalEndoscopy.html', search: '', href: 'https://x.test/pages/nasalEndoscopy.html', origin: 'https://x.test' },
    console,
    alert() {}, confirm() { return true; }, prompt() { return null; },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    addEventListener(t, f) { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(f); },
    removeEventListener() {},
    dispatchEvent(ev) { (listeners.get(ev && ev.type) || []).slice().forEach(f => f(ev)); return true; },
    CustomEvent: class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    Event: class Event { constructor(type) { this.type = type; } },
    requestAnimationFrame: () => 1,
    matchMedia: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    EntFormBridge: undefined,
    EntAuth: undefined,
    EntSupabase: undefined,
    EntOfflineStore: undefined
  };
  win.window = win;
  return win;
}
function loadScript(win, file) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  vm.createContext(win);
  vm.runInContext(code, win, { filename: file });
  return win;
}

/* ---------------- S1: flush drains queue -> confirmation card ------------ */
{
  const win = makeWindow({ onLine: true });
  let pending = 1;
  const pushes = [];
  let eventFired = null;
  win.EntOfflineStore = {
    dueJobs: async () => (pending > 0 ? [{ id: 'q|k1', recordKey: 'k1', attempts: 0 }] : []),
    getRecord: async (k) => ({ key: k, ownerId: '', reportType: 'cf4', patientName: 'DELA CRUZ, BEN' }),
    markJobDone: async () => { pending = 0; return true; },
    markSynced: async () => true,
    markJobFailed: async () => true,
    jobCount: async () => pending
  };
  win.EntSupabase = { isConfigured: () => true, apiRequest: async (p) => { pushes.push(p); return {}; }, getConfig: () => ({}) };
  loadScript(win, 'function/syncEngine.js');
  win.addEventListener('ent-offline:all-synced', (e) => { eventFired = e; });
  const res = await win.EntSync.flushOfflineQueue();
  ok('S1a', 'flush uploads the queued record', pushes.length === 1 && res && res.success === true && res.pushed === 1,
     JSON.stringify({ pushes: pushes.length, res }));
  ok('S1b', "'ent-offline:all-synced' event fired with pushed=1",
     !!eventFired && eventFired.detail && eventFired.detail.pushed === 1);
  const toast = win.document.body.children.find(c => c.id === 'entSyncDoneToast');
  ok('S1c', 'confirmation card was created', !!toast);
  if (toast) {
    ok('S1d', 'card is visible', toast.classList.contains('is-visible'));
    ok('S1e', 'card title says all offline records saved to database',
       String(toast.innerHTML).includes('All offline records already saved to database'));
    const detail = toast.querySelector('.ent-sync-done-detail');
    ok('S1f', 'card detail mentions signal + upload count',
       /signal right now/.test(detail.textContent) && /1 offline save uploaded/.test(detail.textContent),
       detail.textContent);
  }
}

/* ---------------- S2: nothing pushed -> NO card -------------------------- */
{
  const win = makeWindow({ onLine: true });
  win.EntOfflineStore = {
    dueJobs: async () => [],
    getRecord: async () => null,
    markJobDone: async () => true, markSynced: async () => true, markJobFailed: async () => true,
    jobCount: async () => 0
  };
  win.EntSupabase = { isConfigured: () => true, apiRequest: async () => ({}), getConfig: () => ({}) };
  loadScript(win, 'function/syncEngine.js');
  const res = await win.EntSync.flushOfflineQueue();
  const toast = win.document.body.children.find(c => c.id === 'entSyncDoneToast');
  ok('S2', 'a flush with an empty queue shows no confirmation card',
     res && res.pushed === 0 && !toast);
}

/* ---------------- S3: partial upload (queue not empty) -> NO card -------- */
{
  const win = makeWindow({ onLine: true });
  let pending = 2; // two jobs, but the second is owned by another account
  win.EntOfflineStore = {
    dueJobs: async () => (pending > 0 ? [{ id: 'q|k1', recordKey: 'k1', attempts: 0 }] : []),
    getRecord: async (k) => ({ key: k, ownerId: pending > 1 ? 'someone-else' : '', reportType: 'cf4', patientName: 'A' }),
    markJobDone: async () => { pending -= 1; return true; },
    markSynced: async () => true, markJobFailed: async () => true,
    jobCount: async () => pending
  };
  win.EntSupabase = { isConfigured: () => true, apiRequest: async () => ({}), getConfig: () => ({}) };
  loadScript(win, 'function/syncEngine.js');
  const res = await win.EntSync.flushOfflineQueue();
  const toast = win.document.body.children.find(c => c.id === 'entSyncDoneToast');
  ok('S3', 'a partial upload (jobs still waiting) shows no "all caught up" card',
     res && res.pushed === 1 && !toast);
}

/* ---------------- D1: offline save -> amber "Saved to Offline Mode" ------ */
{
  const win = makeWindow({ onLine: false });
  loadScript(win, 'function/draftsBrowser.js');
  const draft = await win.EntDrafts.saveAndOpen('cf4',
     { patientLastName: 'DELA CRUZ', patientFirstName: 'BEN', procedureDate: '2026-10-05' }, 'ben.json');
  ok('D1a', 'offline save still saves', !!draft && /DELA CRUZ/.test(String(draft.patientName)));
  const toast = win.document.body.children.find(c => c.id === 'entDraftsToast');
  ok('D1b', 'saved toast was created', !!toast);
  if (toast) {
    const title = toast.querySelector('.ent-saved-toast-title');
    const detail = toast.querySelector('.ent-saved-toast-detail');
    ok('D1c', 'toast title is "Saved to Offline Mode"', title.textContent === '\uD83D\uDCE5 Saved to Offline Mode', title.textContent);
    ok('D1d', 'toast promises automatic upload when signal returns',
       /will be saved to the database automatically when you have signal/.test(detail.textContent), detail.textContent);
    ok('D1e', 'toast wears the amber is-offline variant', toast.classList.contains('is-offline'));
  }
}

/* ---------------- D2: online save -> old wording ------------------------ */
{
  const win = makeWindow({ onLine: true });
  loadScript(win, 'function/draftsBrowser.js');
  win.EntDrafts.saveAndOpen('cf4',
     { patientLastName: 'DELA CRUZ', patientFirstName: 'BEN', procedureDate: '2026-10-05' }, 'ben.json');
  const toast = win.document.body.children.find(c => c.id === 'entDraftsToast');
  ok('D2', 'an online save keeps the original toast wording',
     !!toast && toast.querySelector('.ent-saved-toast-title').textContent === 'Draft saved on this device'
     && !toast.classList.contains('is-offline'));
}

console.log('');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('');
process.exitCode = failed ? 1 : 0;

