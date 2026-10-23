#!/usr/bin/env node
/* Regression checks for offline report queueing, conflict protection, and photo retry mode. */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..', '..')
let failed = 0

function assert(id, condition, message) {
  if (condition) console.log(`PASS ${id} ${message}`)
  else {
    failed++
    console.error(`FAIL ${id} ${message}`)
  }
}

function makeWindow({ remoteRows = [], offlineSession = false } = {}) {
  const values = new Map()
  const posts = []
  const apiCalls = []
  const notices = []
  const win = {
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
      key: index => [...values.keys()][index] ?? null,
      get length() { return values.size }
    },
    navigator: { onLine: true },
    location: { pathname: '/pages/index.html' },
    document: {
      readyState: 'complete',
      body: {
        contains: () => false,
        appendChild: element => notices.push(element)
      },
      createElement: () => ({
        style: {},
        setAttribute() {},
        addEventListener() {},
        append() {},
        remove() {}
      })
    },
    crypto: { getRandomValues(bytes) { bytes.forEach((_, index) => { bytes[index] = index + 1 }); return bytes } },
    addEventListener() {},
    dispatchEvent() {},
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail } },
    setTimeout() { return 0 },
    clearTimeout() {},
    setInterval() { return 0 },
    console,
    EntAuth: {
      ready: async () => {},
      isOfflineSession: () => offlineSession,
      scope: () => ({ doctorId: 'doctor-1', seeAll: false }),
      currentUser: () => ({ id: 'user-1', username: 'doctor', role: 'doctor' })
    },
    EntSupabase: {
      isConfigured: () => true,
      onAuthChange() {},
      apiRequest: async (path, options = {}) => {
        apiCalls.push(path)
        if (options.method === 'POST') {
          const rows = JSON.parse(options.body)
          posts.push(...rows)
          return rows.map(row => ({
            id: 'report-uuid',
            updated_at: row.updated_at,
            payload: row.payload
          }))
        }
        if (path.startsWith('reports?record_key=')) return remoteRows
        return []
      }
    },
    EntPhotoStore: {
      retrySafeCalls: [],
      async uploadAll(images, reportId, progress, options) {
        this.retrySafeCalls.push({ images, reportId, retrySafe: options?.retrySafe === true })
        return { ok: true, count: images.length, paths: images.map((_, index) => `photo-${index + 1}`) }
      }
    }
  }
  win.window = win
  win.globalThis = win
  vm.createContext(win)
  for (const file of ['offlineStore.js', 'syncEngine.js']) {
    vm.runInContext(readFileSync(join(APP, 'function', file), 'utf8'), win, { filename: file })
  }
  return { win, posts, apiCalls, notices }
}

const image = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBw'

{
  const { win, apiCalls, notices } = makeWindow({ offlineSession: true })
  const reportSync = await win.EntSync.syncPatientRecords()
  const queueSync = await win.EntSync.flushOfflineQueue()
  assert('OQ-00', reportSync.reason === 'offline-session' &&
    queueSync.skipped === 'offline-session' && apiCalls.length === 0 && notices.length === 1,
    'offline authentication makes no cloud requests and prompts for online sign-in to sync queued reports')
}

{
  const { win, apiCalls } = makeWindow()
  win.navigator.onLine = false
  const result = await win.EntSync.syncPatientRecords()
  assert('OQ-00a', result.reason === 'offline' && apiCalls.length === 0,
    'report history sync does not make network requests while offline')
}

{
  const { win, posts } = makeWindow()
  const saved = await win.EntOfflineStore.recordSaved({
    key: 'nasal|stable-report',
    reportType: 'nasal',
    patientName: 'Offline Test',
    formData: { images: [image] }
  })
  const record = await win.EntOfflineStore.getRecord('nasal|stable-report')
  const job = (await win.EntOfflineStore.dueJobs())[0]
  assert('OQ-01', saved.saved && saved.queued, 'a local report persists and enters the queue')
  assert('OQ-02', record.formData.images.length === 1 && !!job.syncId, 'photo data and stable retry token persist locally')

  const flushed = await win.EntSync.flushOfflineQueue()
  const synced = await win.EntOfflineStore.getRecord(record.key)
  assert('OQ-03', flushed.success && flushed.pushed === 1, 'the confirmed report sync completes')
  assert('OQ-04', posts[0]?.payload?.offlineSyncId === job.syncId, 'the server row carries the queue idempotency token')
  assert('OQ-05', win.EntPhotoStore.retrySafeCalls.length === 0, 'photo upload is not required for report synchronization')
  assert('OQ-06', synced.synced && (await win.EntOfflineStore.jobCount()) === 0, 'the report is marked synced after Supabase confirms the report')
  assert('OQ-06a', synced.photosLocalOnly && synced.localPhotoCount === 1, 'local photos are explicitly retained as not synced')
}

{
  const { win, posts } = makeWindow({
    remoteRows: [{
      id: 'remote-report',
      updated_at: '2026-01-02T00:00:00.000Z',
      is_draft: true,
      payload: { sharedAt: '2026-01-02T00:00:00.000Z', offlineSyncId: 'another-device' }
    }]
  })
  await win.EntOfflineStore.recordSaved({
    key: 'cf4|changed-report',
    reportType: 'cf4',
    patientName: 'Conflict Test',
    formData: { images: [] }
  })
  const result = await win.EntSync.flushOfflineQueue()
  const record = await win.EntOfflineStore.getRecord('cf4|changed-report')
  const jobs = await win.EntOfflineStore.dueJobs()
  assert('OQ-07', posts.length === 0, 'a conflicting remote edit is never overwritten')
  assert('OQ-08', result.success && record.syncStatus === 'failed', 'a conflict is surfaced as Sync Failed')
  assert('OQ-09', jobs.length === 0 && (await win.EntOfflineStore.jobCount()) === 1, 'conflicting work remains stored but is not retried blindly')
}

const edge = readFileSync(join(APP, 'supabase-v2', 'edge-functions', 'patient-photos', 'index.ts'), 'utf8')
assert('OQ-10', !edge.includes('retry_safe') && edge.includes('buildObjectPath(report.clinic_id, report.id, ext)'), 'the existing online photo upload contract is unchanged')
const workspace = readFileSync(join(APP, 'pages', 'offlineWorkspace.html'), 'utf8')
assert('OQ-11', (workspace.match(/<button\b/g) || []).length === 3 &&
  ['Nasal Endoscopy', 'Laryngeal Endoscopy', 'CF4 Form'].every(label => workspace.includes(label)),
  'the offline workspace contains exactly the three report actions')
assert('OQ-12', ['function/photoStore.js', 'function/offlineStore.js', 'function/syncEngine.js',
  'pages/offlineWorkspace.html', 'style/offlineWorkspace.css', 'function/offlineWorkspace.js']
  .every(file => readFileSync(join(APP, 'sw.js'), 'utf8').includes(`'${file}'`)),
  'the worker precaches workspace and sync dependencies')
const build = readFileSync(join(APP, 'build-pages.mjs'), 'utf8')
assert('OQ-13', /const PAGES = \[[\s\S]*?'pages\/offlineWorkspace\.html'/.test(build),
  'the deployment allowlist publishes the page required by the worker')

console.log(failed ? `\n${failed} offline queue check(s) failed.` : '\nAll offline queue checks passed.')
process.exitCode = failed ? 1 : 0
