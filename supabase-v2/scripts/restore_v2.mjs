#!/usr/bin/env node
/* =====================================================================
   restore_v2.mjs — put a backup_v2.mjs dump back into a (new) project
   ---------------------------------------------------------------------
   WHY THIS EXISTS
   You are moving to a fresh Supabase project but must keep every CF4 /
   nasal / laryngeal patient record. The data lives in `reports` (the
   whole editable form, with photos inline as base64 because photo
   storage is off). But reports has NOT NULL foreign keys:

        reports.clinic_id   -> clinics(id)
        reports.doctor_id   -> staff_profiles(id)
        reports.created_by  -> staff_profiles(id)
        staff_profiles.id   -> auth.users(id)

   So the accounts and clinics must exist in the NEW project with the
   SAME uuids BEFORE the reports can land. This script does an EXACT
   MOVE — every uuid is preserved — so authorship ("saved by Lilian"),
   the doctor shelves and every report line up 1:1 and nothing is lost.

   TWO PHASES (run in this order):

     PHASE 1 — auth (recreate the logins)
        node supabase-v2/scripts/restore_v2.mjs supabase-v2/backup/v2-<stamp> --auth
        Writes <backup>/auth_users_restore.sql and prints instructions.
        Open the NEW project -> SQL Editor, paste that file, Run.
        (The SQL editor runs as an owner, so it can insert into auth.users
         with the original uuids + password hashes; the same passwords keep
         working. If a login ever fails, use "Forgot password" — the emails
         are preserved. PHASE 1 needs NO credentials: it only writes SQL.)

     PHASE 2 — data (recreate clinics, staff, reports, photos)
        node supabase-v2/scripts/restore_v2.mjs supabase-v2/backup/v2-<stamp> --data --confirm-write --target-project=<new-project-ref>
        Restores clinics -> staff_profiles -> reports -> report_photos in
        FK order, by uuid, idempotently (safe to re-run).

     VALIDATE — verify files and hashes without contacting Supabase
        node supabase-v2/scripts/restore_v2.mjs supabase-v2/backup/v2-<stamp> --check

   CONFIG — for PHASE 2, scripts/.env.local must point at the NEW project:
        SUPABASE_URL=https://NEW-PROJECT-REF.supabase.co
        SUPABASE_SERVICE_ROLE_KEY=<new project service key>
   ===================================================================== */
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const env = {}
if (existsSync(join(HERE, '.env.local'))) {
  for (const line of readFileSync(join(HERE, '.env.local'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

const arg = process.argv[2] || ''
const phase = process.argv.find(a => a === '--auth' || a === '--data' || a === '--check') || ''
const targetProjectArg = process.argv.find(a => a.startsWith('--target-project='))
const targetProjectRef = targetProjectArg ? targetProjectArg.slice('--target-project='.length) : ''
const confirmWrite = process.argv.includes('--confirm-write')
if (!arg || !phase) {
  console.error('usage: node restore_v2.mjs <backupDir> --auth   (phase 1: recreate logins)')
  console.error('       node restore_v2.mjs <backupDir> --data --confirm-write --target-project=<ref>   (phase 2)')
  console.error('       node restore_v2.mjs <backupDir> --check  (verify backup files without network access)')
  process.exit(1)
}

// Only PHASE 2 talks to a project, so only it needs the target credentials.
const SRC = resolve(arg)
if (!existsSync(SRC)) { console.error('backup folder not found: ' + SRC); process.exit(1) }

const manifestPath = join(SRC, 'MANIFEST.json')
if (!existsSync(manifestPath)) {
  console.error('backup manifest missing; refusing an unverified restore.')
  process.exit(1)
}
let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (error) {
  console.error('backup manifest is invalid: ' + error.message)
  process.exit(1)
}
if (manifest.format_version !== 2 || manifest.complete !== true || manifest.mode !== 'full') {
  console.error('restore requires a complete format-v2 --full backup.')
  process.exit(1)
}
if (!manifest.storage || manifest.storage.bucket !== 'patient-photos'
  || manifest.storage.included !== true
  || manifest.storage.complete !== true) {
  console.error('full backup does not contain a verified patient-photos archive.')
  process.exit(1)
}

const TABLES = [
  ['clinics', 'id'],
  ['staff_profiles', 'id'],
  ['reports', 'id'],
  ['report_photos', 'id'],
  ['activity_logs', 'id'],
  ['user_presence', 'user_id,device_label'],
  ['system_flags', 'flag_key'],
  ['clinic_settings', 'clinic_id,setting_key'],
  ['tickets', 'id'],
  ['ticket_messages', 'id'],
  ['report_access_grants', 'report_id,grantee_id'],
  ['report_access_requests', 'id'],
  ['secretary_assignments', 'secretary_id,doctor_id']
]
for (const [table] of TABLES) {
  if (!manifest.tables || !manifest.tables[table]
    || !Number.isInteger(manifest.tables[table].rows)
    || !/^[a-f0-9]{64}$/.test(manifest.tables[table].sha256 || '')) {
    console.error(`backup manifest is missing a complete row count for ${table}.`)
    process.exit(1)
  }
}
if (!manifest.tables['auth.users']
  || !Number.isInteger(manifest.tables['auth.users'].rows)
  || !/^[a-f0-9]{64}$/.test(manifest.tables['auth.users'].sha256 || '')) {
  console.error('backup manifest is missing a complete auth.users count.')
  process.exit(1)
}
if (!manifest.storage.sha256 || typeof manifest.storage.sha256 !== 'object') {
  console.error('backup manifest is missing storage integrity hashes.')
  process.exit(1)
}

const BASE = (env.SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/+$/, '')
const SVC = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (phase === '--data' && (!BASE || !SVC)) {
  console.error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required in scripts/.env.local (point them at the NEW project).')
  process.exit(1)
}
if (phase === '--data') {
  let actualProjectRef = ''
  try {
    actualProjectRef = new URL(BASE).hostname.split('.')[0]
  } catch (error) {
    console.error('SUPABASE_URL is invalid: ' + error.message)
    process.exit(1)
  }
  if (!confirmWrite || !targetProjectRef || targetProjectRef !== actualProjectRef) {
    console.error('data restore requires --confirm-write and --target-project=<ref> matching SUPABASE_URL.')
    process.exit(1)
  }
}

const sha256 = value => createHash('sha256').update(value).digest('hex')
const storagePathIsSafe = path => typeof path === 'string' && path.length > 0
  && !path.startsWith('/') && !path.includes('\\') && !path.includes(':')
  && path.split('/').every(part => part && part !== '.' && part !== '..')
const readJson = (name, expectedHash) => {
  const p = join(SRC, name)
  if (!existsSync(p)) throw new Error('required backup file missing: ' + name)
  const content = readFileSync(p, 'utf8')
  if (sha256(content) !== expectedHash) throw new Error('backup integrity check failed: ' + name)
  const j = JSON.parse(content)
  if (!Array.isArray(j)) throw new Error('backup file is not a row array: ' + name)
  return j
}
const checkPhotoArchive = photoRows => {
  const activeRows = photoRows.filter(row => row.deleted_at == null)
  const paths = [...new Set(activeRows.map(row => row.object_path))]
  if (paths.some(path => !storagePathIsSafe(path))) {
    throw new Error('Unsafe or missing object path in active report photo metadata.')
  }
  if (paths.length !== manifest.storage.objects
    || Object.keys(manifest.storage.sha256).length !== manifest.storage.objects) {
    throw new Error(`patient-photos: manifest expected ${manifest.storage.objects} objects, active metadata lists ${paths.length}.`)
  }
  for (const objectPath of paths) {
    const source = join(SRC, 'storage', 'patient-photos', ...objectPath.split('/'))
    if (!existsSync(source)) throw new Error('Photo object missing from backup archive.')
    if (sha256(readFileSync(source)) !== manifest.storage.sha256[objectPath]) {
      throw new Error('Photo object integrity check failed.')
    }
  }
}

if (phase === '--check') {
  try {
    for (const [table] of TABLES) {
      const rows = readJson(`${table}.json`, manifest.tables[table].sha256)
      if (rows.length !== manifest.tables[table].rows) {
        throw new Error(`${table}: manifest expected ${manifest.tables[table].rows} rows, file contains ${rows.length}.`)
      }
    }
    const users = readJson('auth_users.json', manifest.tables['auth.users'].sha256)
    if (users.length !== manifest.tables['auth.users'].rows || users.some(user => !user.id)) {
      throw new Error('auth.users count or row identity does not match the manifest.')
    }
    checkPhotoArchive(readJson('report_photos.json', manifest.tables.report_photos.sha256))
  } catch (error) {
    console.error('BACKUP VALIDATION FAILED: ' + error.message)
    process.exit(1)
  }
  console.log('Backup validation passed. No Supabase connection was made.')
  process.exit(0)
}
const sqlStr = v => (v === null || v === undefined) ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`
const sqlJsonb = v => (v === null || v === undefined) ? 'NULL' : `${sqlStr(JSON.stringify(v))}::jsonb`

/* ================= PHASE 1 · --auth : recreate the logins ========== */
if (phase === '--auth') {
  const users = readJson('auth_users.json', manifest.tables['auth.users'].sha256)
  if (users.length !== manifest.tables['auth.users'].rows) {
    console.error(`auth.users count mismatch: manifest says ${manifest.tables['auth.users'].rows}, file contains ${users.length}.`)
    process.exit(1)
  }
  if (users.some(user => !user.id)) {
    console.error('auth.users backup contains a row without an id.')
    process.exit(1)
  }

  const INSTANCE = '00000000-0000-0000-0000-000000000000'
  const userRows = []
  const identRows = []
  for (const u of users) {
    if (!u.id) continue
    userRows.push(
      `  (${sqlStr(INSTANCE)}, ${sqlStr(u.id)}, ${sqlStr(u.aud || 'authenticated')}, ${sqlStr(u.role || 'authenticated')}, ` +
      `${sqlStr(u.email)}, ${sqlStr(u.encrypted_password)}, ${sqlStr(u.email_confirmed_at)}, ` +
      `${sqlStr(u.created_at || new Date().toISOString())}, ${sqlStr(u.updated_at || new Date().toISOString())}, ` +
      `${sqlJsonb(u.raw_app_meta_data || { provider: 'email', providers: ['email'] })}, ${sqlJsonb(u.raw_user_meta_data || {})})`
    )
    identRows.push(
      `  SELECT ${sqlStr(u.id)}::uuid, 'email', ${sqlJsonb({ sub: u.id, email: u.email })}, ` +
      `${sqlStr(u.created_at || new Date().toISOString())}::timestamptz ` +
      `WHERE NOT EXISTS (SELECT 1 FROM auth.identities i WHERE i.provider_id='email' AND i.identity_data->>'sub' = ${sqlStr(u.id)})`
    )
  }

  const sql = [
    '-- =====================================================================',
    '-- auth_users_restore.sql  ·  GENERATED by restore_v2.mjs --auth',
    '-- Recreate the login accounts in the NEW project with their ORIGINAL',
    '-- uuids and password hashes, so staff_profiles / reports FKs line up',
    '-- and the same passwords keep working. Run in: NEW project -> SQL Editor.',
    '-- SENSITIVE: contains password hashes. Do not commit.',
    '-- =====================================================================',
    'BEGIN;',
    '',
    'INSERT INTO auth.users',
    '  (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,',
    '   created_at, updated_at, raw_app_meta_data, raw_user_meta_data)',
    'VALUES',
    userRows.join(',\n'),
    'ON CONFLICT (id) DO NOTHING;',
    '',
    'INSERT INTO auth.identities (user_id, provider_id, identity_data, created_at)',
    identRows.join('\nUNION ALL\n') + ';',
    '',
    'COMMIT;',
    '',
    `-- ${users.length} account(s). If any login later fails, use "Forgot password"`,
    '-- (the email addresses are preserved, so a reset reaches the right person).',
    ''
  ].join('\n')

  const out = join(SRC, 'auth_users_restore.sql')
  writeFileSync(out, sql, 'utf8')
  console.log('')
  console.log('==== PHASE 1 (auth) READY ====')
  console.log('wrote: ' + out)
  console.log('')
  console.log('NEXT:')
  console.log('  1. Open the NEW Supabase project -> SQL Editor -> New query.')
  console.log('  2. Paste the WHOLE file above and Run it.')
  console.log('  3. Then run PHASE 2 with explicit target confirmation:')
  console.log('     node restore_v2.mjs "' + SRC + '" --data --confirm-write --target-project=<new-project-ref>')
  console.log('')
  process.exit(0)
}

/* ================= PHASE 2 · --data : restore the records ========== */
async function upsert(table, conflictColumns, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500)
    const r = await fetch(`${BASE}/rest/v1/${table}?on_conflict=${encodeURIComponent(conflictColumns)}`, {
      method: 'POST',
      headers: {
        apikey: SVC,
        Authorization: `Bearer ${SVC}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify(batch)
    })
    if (!r.ok) throw new Error(`${table}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
    const restored = await r.json()
    if (!Array.isArray(restored) || restored.length !== batch.length) {
      throw new Error(`${table}: expected ${batch.length} restored rows, confirmed ${Array.isArray(restored) ? restored.length : 0}.`)
    }
    console.log(`  ok    ${table.padEnd(16)} ${batch.length} row(s)`)
  }
}

console.log('')
console.log('==== PHASE 2 (data) RESTORE ====')
console.log('project : ' + BASE)
console.log('from    : ' + SRC)
console.log('')
console.log('PRECONDITION: PHASE 1 auth SQL was run in the target project.')
console.log('')

async function restorePhotoObjects(photoRows) {
  for (const row of photoRows) {
    const objectPath = row.object_path
    if (!storagePathIsSafe(objectPath)) {
      throw new Error('Unsafe object path in report_photos backup.')
    }
    const source = join(SRC, 'storage', 'patient-photos', ...objectPath.split('/'))
    if (!existsSync(source)) throw new Error('Photo object missing from backup archive.')
    const bytes = readFileSync(source)
    if (sha256(bytes) !== manifest.storage.sha256[objectPath]) {
      throw new Error('Photo object integrity check failed.')
    }
    const encoded = objectPath.split('/').map(encodeURIComponent).join('/')
    const mimeType = ['image/jpeg', 'image/png', 'image/webp'].includes(row.mime_type)
      ? row.mime_type
      : 'application/octet-stream'
    const response = await fetch(`${BASE}/storage/v1/object/patient-photos/${encoded}`, {
      method: 'POST',
      headers: {
        apikey: SVC,
        Authorization: `Bearer ${SVC}`,
        'Content-Type': mimeType,
        'x-upsert': 'true'
      },
      body: bytes
    })
    if (!response.ok) {
      throw new Error(`Photo restore failed (${response.status}) for an object path.`)
    }
  }
}

const restoredCounts = {}
try {
  for (const [table, conflictColumns] of TABLES) {
    const rows = readJson(`${table}.json`, manifest.tables[table].sha256)
    const expected = manifest.tables[table].rows
    if (rows.length !== expected) {
      throw new Error(`${table}: manifest expected ${expected} rows, file contains ${rows.length}.`)
    }
    if (rows.length) await upsert(table, conflictColumns, rows)
    restoredCounts[table] = rows.length
  }
  const photoRows = readJson('report_photos.json', manifest.tables.report_photos.sha256)
  checkPhotoArchive(photoRows)
  const uniquePhotoRows = [...new Map(photoRows
    .filter(row => row.deleted_at == null)
    .map(row => [row.object_path, row])).values()]
  await restorePhotoObjects(uniquePhotoRows)
} catch (error) {
  console.error('')
  console.error('RESTORE INCOMPLETE: ' + error.message)
  console.error('Do not point the clinic app at this target until counts and photos are verified.')
  process.exit(1)
}

console.log('')
console.log('Restore requests completed. Independently verify the target row counts, login, report access, and photo retrieval before cutover.')
console.log(JSON.stringify(restoredCounts))
console.log('Next: point the app at the NEW project (function/supabaseClient.js -> URL + anon key),')
console.log('rebuild (node build-pages.mjs) and redeploy. The backup includes photo bucket objects; verify photo access before cutover.')
console.log('')
