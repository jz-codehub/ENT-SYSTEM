import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESTORE = join(HERE, 'restore_v2.mjs')
const ROOT = mkdtempSync(join(tmpdir(), 'ent-backup-restore-test-'))
const FIXTURE = join(ROOT, 'backup')
const sha256 = value => createHash('sha256').update(value).digest('hex')
const tables = [
  'clinics', 'staff_profiles', 'reports', 'report_photos', 'activity_logs',
  'user_presence', 'system_flags', 'clinic_settings', 'tickets',
  'ticket_messages', 'report_access_grants', 'report_access_requests',
  'secretary_assignments'
]

function writeJson(file, value) {
  const content = JSON.stringify(value)
  writeFileSync(join(FIXTURE, file), content)
  return { rows: value.length, sha256: sha256(content) }
}

function runRestore(...args) {
  return spawnSync(process.execPath, [RESTORE, FIXTURE, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SUPABASE_URL: 'https://test-project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-only-not-a-real-key'
    }
  })
}

try {
  mkdirSync(FIXTURE, { recursive: true })
  const manifest = {
    format_version: 2,
    mode: 'full',
    complete: true,
    tables: {},
    storage: {
      bucket: 'patient-photos',
      included: true,
      complete: true,
      objects: 1,
      sha256: {}
    }
  }
  for (const table of tables) {
    const data = table === 'report_photos'
      ? [{ object_path: 'clinic-a/photo.jpg', deleted_at: null }]
      : []
    manifest.tables[table] = writeJson(`${table}.json`, data)
  }
  const users = [{ id: '00000000-0000-0000-0000-000000000001', email: 'test@example.invalid' }]
  manifest.tables['auth.users'] = writeJson('auth_users.json', users)
  const objectPath = join(FIXTURE, 'storage', 'patient-photos', 'clinic-a', 'photo.jpg')
  mkdirSync(dirname(objectPath), { recursive: true })
  const photo = Buffer.from('local test photo bytes')
  writeFileSync(objectPath, photo)
  manifest.storage.sha256['clinic-a/photo.jpg'] = sha256(photo)
  writeFileSync(join(FIXTURE, 'MANIFEST.json'), JSON.stringify(manifest, null, 2))

  let result = runRestore('--check')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /No Supabase connection was made/)

  manifest.complete = false
  writeFileSync(join(FIXTURE, 'MANIFEST.json'), JSON.stringify(manifest, null, 2))
  result = runRestore('--check')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /requires a complete format-v2 --full backup/)
  manifest.complete = true
  writeFileSync(join(FIXTURE, 'MANIFEST.json'), JSON.stringify(manifest, null, 2))

  result = runRestore('--data')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /requires --confirm-write and --target-project/)

  result = runRestore('--data', '--confirm-write', '--target-project=other-project')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /requires --confirm-write and --target-project/)

  result = runRestore('--auth')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(join(FIXTURE, 'auth_users_restore.sql')), true)

  writeFileSync(objectPath, Buffer.from('tampered photo bytes'))
  result = runRestore('--check')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /integrity check failed/)

  writeFileSync(objectPath, photo)
  const reportPath = join(FIXTURE, 'reports.json')
  writeFileSync(reportPath, readFileSync(reportPath, 'utf8') + ' ')
  result = runRestore('--check')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /integrity check failed/)

  manifest.tables.reports = writeJson('reports.json', [])
  manifest.tables.report_photos = writeJson('report_photos.json', [
    { object_path: '../escape.jpg', deleted_at: null }
  ])
  manifest.storage.sha256 = { '../escape.jpg': sha256(photo) }
  writeFileSync(join(FIXTURE, 'MANIFEST.json'), JSON.stringify(manifest, null, 2))
  result = runRestore('--check')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Unsafe or missing object path/)

  console.log('Backup/restore safety checks passed (offline fixtures only).')
} finally {
  rmSync(resolve(ROOT), { recursive: true, force: true })
}
