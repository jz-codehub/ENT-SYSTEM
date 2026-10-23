#!/usr/bin/env node
/* =====================================================================
   test_draft_photo_invariants.mjs — Phase A regression guard
   ---------------------------------------------------------------------
   WHY
   `is_draft` and `photo_count` are written by THREE separate client
   writers (syncEngine.js, draftsBrowser.js x2, dbRecords.js). Both columns
   used to be omitted by some of them, which produced rows observed live as:

       is_draft = false, saved_at = STAMPED, photo_count = 0

   on records that were only ever an automatic background sync. Because a
   Postgres DEFAULT silently fills an absent column, and because absent
   columns are never updated on conflict, nothing repaired them afterwards.

   These tests load the REAL modules into a stubbed browser and inspect the
   actual request bodies, so a writer that stops sending either column fails
   here rather than in a clinic. No network, no database, no patient data.

   Also asserts the 0017 migration still carries the two guarantees it
   exists for, so the SQL and the JS cannot drift apart silently.

   Run: node supabase-v2/scripts/test_draft_photo_invariants.mjs
   ===================================================================== */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..', '..')

let passed = 0, failed = 0
const ok = (id, what, d = '') => { passed++; console.log('  PASS  ' + id.padEnd(6) + ' ' + what + (d ? ' — ' + d : '')) }
const bad = (id, what, d = '') => { failed++; console.log('  FAIL  ' + id.padEnd(6) + ' ' + what + (d ? ' — ' + d : '')) }
const is = (id, what, cond, d = '') => (cond ? ok(id, what, d) : bad(id, what, d))

console.log('')
console.log('==== DRAFT / PHOTO-COUNT INVARIANTS ====')
console.log('')

/* ---------------- a small browser, and a recording apiRequest -------- */
function makeWindow(sink) {
  const store = new Map()
  const win = {
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k), key: i => [...store.keys()][i] ?? null,
      get length() { return store.size }
    },
    document: {
      readyState: 'complete', body: { classList: { contains: () => false } },
      addEventListener: () => {}, removeEventListener: () => {},
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false },
        appendChild() {}, setAttribute() {}, addEventListener() {}, querySelector: () => null })
    },
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {},
    location: { pathname: '/nasalEndoscopy.html', search: '', href: '', replace: () => {} },
    navigator: { userAgent: 'node-test', onLine: true },
    console, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    CustomEvent: class { constructor(t, o) { this.detail = o && o.detail } },
    alert: () => {},
    fetch: async (url) => {
      // photo_storage is OFF on the live project; this is the real answer.
      const body = { ok: false, code: 'PHOTO_STORAGE_DISABLED', error: 'Cloud photo storage is not enabled for this system yet.' }
      return { ok: false, status: 503, text: async () => JSON.stringify(body), json: async () => body }
    }
  }
  win.window = win; win.globalThis = win
  win.EntSupabase = {
    isConfigured: () => true,
    getConfig: () => ({ supabaseUrl: 'https://probe.supabase.co', supabaseAnonKey: 'anon' }),
    getAccessToken: async () => 'JWT',
    apiRequest: async (path, opts = {}) => {
      if (opts.method === 'POST') {
        let b = null; try { b = JSON.parse(opts.body) } catch { b = null }
        if (b) sink.push({ path, rows: Array.isArray(b) ? b : [b] })
      }
      return []
    }
  }
  // logActivity is called as `...logActivity(...).catch(...)` in dbRecords.js,
  // so the stub must return a thenable. Returning undefined here produced a
  // "Cannot read properties of undefined (reading 'catch')" AFTER the save had
  // already succeeded — noise from the harness, not a defect in the app.
  win.EntAuth = {
    scope: () => ({ doctorId: 'doc', seeAll: true }),
    currentUser: () => ({ username: 'probe', role: 'doctor' }),
    logActivity: () => Promise.resolve()
  }
  return win
}

function load(win, files) {
  vm.createContext(win)
  for (const f of files) vm.runInContext(readFileSync(join(APP, 'function', f), 'utf8'), win, { filename: f })
}

const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='
const has = (r, k) => Object.prototype.hasOwnProperty.call(r, k)

/* ================= WRITER 1: the background sync ==================== */
console.log('---- syncEngine.js (background sync) ----')
{
  const posts = []
  const win = makeWindow(posts)
  load(win, ['patientRecords.js', 'syncEngine.js'])
  win.localStorage.setItem('entPatientRecordHistoryV1', JSON.stringify([
    { key: 'nasal|id:p1|2026-10-02', reportType: 'nasal', patientName: 'SyncProbe',
      patientId: 'p1', caseNumber: '', procedureDate: '2026-10-02',
      lastActivityAt: new Date().toISOString() }
  ]))
  await win.EntSync.syncPatientRecords()
  const rows = posts.filter(p => p.path.startsWith('reports?')).flatMap(p => p.rows)

  is('DP-01', 'the sync writer sends at least one reports row', rows.length > 0, rows.length + ' row(s)')
  is('DP-02', 'every synced row states is_draft explicitly',
     rows.length > 0 && rows.every(r => has(r, 'is_draft')))
  is('DP-03', 'a background sync never marks a report FINAL',
     rows.length > 0 && rows.every(r => r.is_draft === true),
     'is_draft=' + (rows[0] ? rows[0].is_draft : '?'))
  is('DP-04', 'every synced row states photo_count explicitly',
     rows.length > 0 && rows.every(r => has(r, 'photo_count')))
  is('DP-05', 'photo_count is a number, never undefined',
     rows.length > 0 && rows.every(r => Number.isInteger(r.photo_count)),
     'photo_count=' + (rows[0] ? rows[0].photo_count : '?'))
}

/* ================= WRITER 2: Save to Database ====================== */
console.log('')
console.log('---- dbRecords.js ("Save to Database") ----')
{
  const posts = []
  const win = makeWindow(posts)
  load(win, ['photoStore.js', 'patientRecords.js', 'syncEngine.js', 'dbRecords.js'])
  win.EntFormBridge = {
    reportType: 'nasal',
    getData: () => ({ patientLastName: 'ZZINV', patientFirstName: 'Probe', procedureDate: '2026-10-02', images: [JPEG, JPEG] }),
    restore: () => {}, alert: () => {}
  }
  await win.EntDbRecords.saveToDatabase()
  await new Promise(r => setTimeout(r, 300))
  const rows = posts.filter(p => p.path.startsWith('reports?')).flatMap(p => p.rows)
  const final = rows.filter(r => r.is_draft === false)

  is('DP-06', 'the save writer sends at least one reports row', rows.length > 0, rows.length + ' row(s)')
  is('DP-07', 'the finalizing write exists and sets is_draft = false',
     final.length > 0, final.length + ' finalizing row(s)')
  is('DP-08', 'the finalizing write states photo_count explicitly',
     final.length > 0 && final.every(r => has(r, 'photo_count')))
  is('DP-09', 'photo_count matches the images actually stored in the payload',
     final.length > 0 && final.every(r => {
       const imgs = r.payload && r.payload.formData && Array.isArray(r.payload.formData.images)
         ? r.payload.formData.images.filter(Boolean).length : 0
       return r.photo_count === imgs
     }),
     final[0] ? 'photo_count=' + final[0].photo_count + ', images in payload=' +
       ((final[0].payload.formData.images || []).filter(Boolean).length) : 'no row')

  const allStateIt = rows.every(r => has(r, 'is_draft') && has(r, 'photo_count'))
  is('DP-10', 'NO writer on the save path omits either column', allStateIt)
}

/* ================= WRITER 3: the two drafts paths =================== */
console.log('')
console.log('---- draftsBrowser.js (both share paths) ----')
{
  const src = readFileSync(join(APP, 'function', 'draftsBrowser.js'), 'utf8')
  // Both share writers build a `row` literal that is POSTed to reports.
  const rowBlocks = src.split(/\n\s{8}const row = \{/).slice(1)
  is('DP-11', 'found both draftsBrowser row writers', rowBlocks.length === 2, rowBlocks.length + ' found')
  const every = rowBlocks.every(b => /is_draft:\s*true/.test(b))
  const everyCount = rowBlocks.every(b => /photo_count:\s*0/.test(b))
  is('DP-12', 'every drafts writer states is_draft = true', every)
  is('DP-13', 'every drafts writer states photo_count explicitly', everyCount)
}

/* ================= the migration itself ============================= */
console.log('')
console.log('---- 0017 migration ----')
{
  const sql = readFileSync(join(APP, 'supabase-v2', 'migrations', '0017_draft_and_photo_integrity.sql'), 'utf8')
  is('DP-14', '0017 flips is_draft DEFAULT to TRUE',
     /ALTER COLUMN is_draft SET DEFAULT TRUE/i.test(sql))
  is('DP-15', '0017 creates the partial unique index on live photo slots',
     /UNIQUE INDEX IF NOT EXISTS uq_report_photos_live_slot/i.test(sql) &&
     /\(report_id,\s*index_no\)\s*WHERE deleted_at IS NULL/i.test(sql))
  is('DP-16', 'the index is PARTIAL on deleted_at so a soft delete frees the slot',
     /WHERE deleted_at IS NULL/i.test(sql))
  is('DP-17', '0017 touches no row (no backfill / no UPDATE of data)',
     !/\bUPDATE\s+public\./i.test(sql) && !/\bDELETE\s+FROM\b/i.test(sql) &&
     !/\bINSERT\s+INTO\b/i.test(sql.replace(/INSERT INTO public\.staff_profiles[\s\S]*?;/, '')))
  // The word "photo_storage" appears in 0017 only inside a comment saying the
  // flag is NOT touched. The first version of this assertion grepped for the
  // bare word and failed on that comment. What actually matters is that no
  // statement WRITES the flag table.
  const flagWrites = /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(public\.)?system_flags/i.test(sql)
  is('DP-18', '0017 never writes the system_flags table (flag untouched)',
     !flagWrites)
  is('DP-19', '0017 never makes the bucket public',
     !/public\s*=\s*TRUE/i.test(sql))
}

console.log('')
const parts = []
if (failed) parts.push(failed + ' FAILED')
console.log('==== ' + (parts.length ? parts.join(' / ') : 'DRAFT/PHOTO INVARIANTS OK') +
  ' — ' + passed + ' passed, ' + failed + ' failed (' + (passed + failed) + ' checks) ====')
console.log('')
process.exit(failed ? 1 : 0)