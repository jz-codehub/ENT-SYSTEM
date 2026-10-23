#!/usr/bin/env node
/* test_cross_clinic_secretary.mjs — 0037 frontend behaviour, offline.
   Proves the CLIENT half of the cross-clinic secretary without a backend:
   a single-doctor secretary is unchanged; a secretary who picked a
   different doctor is shelved under her and a save names that doctor_id;
   a doctor sends no override. The database is the real gate
   (ent_is_my_doctor re-runs on every write); this only proves the browser
   ASKS for the right shelf - the contract auth.js and dbRecords.js keep.
   Run: node supabase-v2/scripts/test_cross_clinic_secretary.mjs */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..', '..')
let passed = 0, failed = 0
const ok = (id, what, d = '') => { passed++; console.log(`  PASS  ${id.padEnd(4)} ${what}${d ? ' — ' + d : ''}`) }
const bad = (id, what, d = '') => { failed++; console.log(`  FAIL  ${id.padEnd(4)} ${what}${d ? ' — ' + d : ''}`) }
const is = (id, what, cond, d = '') => cond ? ok(id, what, d) : bad(id, what, d)

const PRIMARY = 'doc-primary-uuid'
const OTHER = 'doc-other-uuid'

function makeWin({ profile, doctors, storedChoice } = {}) {
  const store = new Map()
  if (storedChoice) store.set('ent_working_doctor_v1', JSON.stringify(storedChoice))
  const el = () => ({
    innerHTML: '', textContent: '', className: '', id: '', style: {}, value: '',
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    querySelector: () => el(), querySelectorAll: () => [], appendChild(c) { return c },
    removeChild() {}, replaceChildren() {}, addEventListener() {}, removeEventListener() {},
    closest: () => null, focus() {}, click() {}, getAttribute: () => null, setAttribute() {},
  })
  const win = {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    document: {
      readyState: 'loading',
      body: { classList: { contains: () => false }, appendChild() {} },
      addEventListener: () => {}, getElementById: () => null,
      querySelector: () => null, createElement: () => el(),
    },
    addEventListener: () => {}, dispatchEvent: () => {},
    location: { pathname: '/index.html', search: '', href: '', replace: () => {}, reload: () => {} },
    navigator: { userAgent: 'node-test', onLine: true },
    console, setInterval: () => 0, clearInterval: () => {}, setTimeout: (f) => { try { f() } catch (e) {} return 0 }, clearTimeout: () => {},
    supabase: { createClient: () => ({ auth: {
      getSession: async () => ({ data: { session: { access_token: 'JWT', user: { id: (profile || {}).id } } }, error: null }),
      signInWithPassword: async () => ({ data: { user: { id: (profile || {}).id } }, error: null }),
      updateUser: async () => ({ data: {}, error: null }), signOut: async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    } }) },
  }
  win.window = win
  win.globalThis = win
  win.fetch = async (url) => {
    const u = String(url)
    if (u.includes('rpc/my_assigned_doctor_name')) {
      return { ok: true, status: 200, text: async () => JSON.stringify('Dr. Primary'), json: async () => 'Dr. Primary' }
    }
    if (u.includes('rpc/my_assigned_doctors')) {
      const rows = doctors === undefined
        ? [{ doctor_id: PRIMARY, doctor_name: 'Dr. Primary', clinic_id: 'c-home', clinic_name: 'ENT Home', is_primary: true }]
        : doctors
      return { ok: true, status: 200, text: async () => JSON.stringify(rows), json: async () => rows }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify([profile]), json: async () => [profile] }
  }
  return win
}

const SEC = { id: 'sec-1', username: 'tara', full_name: 'Tara Bautista', role: 'secretary',
  clinic_id: 'c-home', assigned_doctor_id: PRIMARY, is_active: true, must_change_password: false }
const DOC = { id: 'doc-1', username: 'jess', full_name: 'Jesus Jardin', role: 'doctor',
  clinic_id: 'c-home', assigned_doctor_id: null, is_active: true, must_change_password: false }

async function bootWith(win) {
  for (const f of ['supabaseClient.js', 'photoStore.js', 'auth.js']) {
    vm.createContext(win)
    vm.runInContext(readFileSync(join(APP, 'function', f), 'utf8'), win, { filename: f })
  }
  await win.EntAuth.ready()
  return win.EntAuth
}
// Reproduce exactly what dbRecords' baseRow adds for doctor_id.
function baseRowDoctorIdFor(A) {
  const scoped = A.scope()
  const user = A.currentUser() || {}
  const owner = { doctorId: scoped.doctorId || '', role: user.role || '' }
  return (owner.role === 'secretary' && owner.doctorId) ? { doctor_id: owner.doctorId } : {}
}

console.log('')
console.log('==== CROSS-CLINIC SECRETARY (0037) FRONTEND TESTS ====')

{ // 1. a single-doctor secretary is UNCHANGED
  const A = await bootWith(makeWin({ profile: SEC }))
  const s = A.scope()
  is('X1', 'a single-doctor secretary is shelved under her primary', s.doctorId === PRIMARY, s.doctorId)
  is('X2', 'no cross-clinic override is reported', s.workingDoctorId === '', s.workingDoctorId)
  is('X3', 'assignedDoctorId still names the primary', s.assignedDoctorId === PRIMARY)
  is('X4', 'a save names her primary (same shelf as before)',
     baseRowDoctorIdFor(A).doctor_id === PRIMARY, JSON.stringify(baseRowDoctorIdFor(A)))
}

{ // 2. picking a DIFFERENT doctor shelves her there, and a save names it
  const doctors = [
    { doctor_id: PRIMARY, doctor_name: 'Dr. Primary', clinic_id: 'c-home', clinic_name: 'ENT Home', is_primary: true },
    { doctor_id: OTHER, doctor_name: 'Dr. Other', clinic_id: 'c-away', clinic_name: 'ENT Away', is_primary: false },
  ]
  const A = await bootWith(makeWin({ profile: SEC, doctors, storedChoice: { id: OTHER, name: 'Dr. Other', clinic: 'ENT Away' } }))
  const s = A.scope()
  is('X5', 'a chosen doctor overrides the shelf', s.doctorId === OTHER, s.doctorId)
  is('X6', 'the override is reported as cross-clinic', s.workingDoctorId === OTHER, s.workingDoctorId)
  is('X7', 'the clinic name rides along for the chip', s.workingClinicName === 'ENT Away', s.workingClinicName)
  is('X8', 'assignedDoctorId is still her PRIMARY', s.assignedDoctorId === PRIMARY, s.assignedDoctorId)
  is('X9', 'a save under a chosen doctor names that doctor_id',
     baseRowDoctorIdFor(A).doctor_id === OTHER, JSON.stringify(baseRowDoctorIdFor(A)))
}

{ // 3. a DOCTOR never sends a doctor_id override
  const A = await bootWith(makeWin({ profile: DOC }))
  const s = A.scope()
  is('X10', 'a doctor is shelved under himself', s.doctorId === DOC.id, s.doctorId)
  is('X11', 'a doctor sends NO doctor_id override',
     !('doctor_id' in baseRowDoctorIdFor(A)), JSON.stringify(baseRowDoctorIdFor(A)))
}

console.log('')
console.log(`==== CROSS-CLINIC SECRETARY OK · ${passed} passed, ${failed} failed ====`)
process.exit(failed ? 1 : 0)
