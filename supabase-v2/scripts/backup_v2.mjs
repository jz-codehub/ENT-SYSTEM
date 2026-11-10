#!/usr/bin/env node
/* =====================================================================
   backup_v2.mjs — export the live V2 project BEFORE re-running anything.
   ---------------------------------------------------------------------
   The re-run of 0003-0006 is expected to be safe (every statement is
   idempotent), but "expected" is not a reason to skip the backup. This
   dumps the DATA of every v2 table through PostgREST using the service
   key, which is enough to put the rows back if the change turns out to
   be wrong.

   It does NOT dump the schema DDL: the canonical schema is the set of
   migrations in supabase-v2/migrations, which is what gets applied. For
   a true DDL dump, run this in the SQL Editor:
       \i supabase-v2/migrations/...   (or paste each file)
   or use `supabase db dump` with the CLI.

   Usage:
     node supabase-v2/scripts/backup_v2.mjs             (metadata-only reports)
     node supabase-v2/scripts/backup_v2.mjs --full      (payloads + stored photos)
   Writes sensitive output to supabase-v2/backup/v2-<timestamp>/.
   ===================================================================== */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const env = {}
if (existsSync(join(HERE, '.env.local'))) {
  for (const line of readFileSync(join(HERE, '.env.local'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
const BASE = (env.SUPABASE_URL || '').replace(/\/+$/, '')
const SVC = env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!BASE || !SVC) { console.error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required.'); process.exit(1) }

// All application tables in the checked-in migrations. Sort columns give
// stable pages even for tables whose primary key is composite.
const TABLES = [
  { name: 'clinics', order: 'id' },
  { name: 'staff_profiles', order: 'id' },
  { name: 'reports', order: 'id' },
  { name: 'report_photos', order: 'id' },
  { name: 'activity_logs', order: 'id' },
  { name: 'user_presence', order: 'user_id,device_label' },
  { name: 'system_flags', order: 'flag_key' },
  { name: 'clinic_settings', order: 'clinic_id,setting_key' },
  { name: 'tickets', order: 'id' },
  { name: 'ticket_messages', order: 'id' },
  { name: 'report_access_grants', order: 'report_id,grantee_id' },
  { name: 'report_access_requests', order: 'id' },
  { name: 'secretary_assignments', order: 'secretary_id,doctor_id' }
]
const PAGE_SIZE = 1000
const MAX_ROWS_PER_TABLE = 1000000
const FULL = process.argv.includes('--full')
const sha256 = value => createHash('sha256').update(value).digest('hex')

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const OUT = join(HERE, '..', 'backup', `v2-${stamp}`)
mkdirSync(OUT, { recursive: true })

async function rows(table) {
  // Full mode includes editable report payloads. This can be large because
  // older deployments may store base64 images inside reports.payload.
  const slimReports = table.name === 'reports' && !FULL
  const cols = slimReports
    ? 'id,clinic_id,doctor_id,created_by,record_key,report_type,is_draft,'
      + 'patient_name,patient_id,case_number,procedure_date,file_name,'
      + 'photo_count,created_at,updated_at,saved_at'
    : '*'
  const pageSize = table.name === 'reports' && FULL ? 25 : PAGE_SIZE
  const all = []
  for (let offset = 0; offset <= MAX_ROWS_PER_TABLE; offset += pageSize) {
    const order = table.order.split(',').map(column => `${column}.asc`).join(',')
    const url = `${BASE}/rest/v1/${table.name}?select=${cols}`
      + `&order=${order}&limit=${pageSize}&offset=${offset}`
    const r = await fetch(url,
      { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } })
    if (!r.ok) return { error: `HTTP ${r.status} ${(await r.text()).slice(0, 120)}`, rows: all }
    const j = await r.json()
    if (!Array.isArray(j)) return { error: 'Response was not a row array.', rows: all }
    if (j.length === 0) break
    if (offset >= MAX_ROWS_PER_TABLE) {
      return { error: `Exceeded the ${MAX_ROWS_PER_TABLE} row safety ceiling.`, rows: all }
    }
    all.push(...j)
    if (j.length < pageSize) break
  }
  return { rows: all }
}

function storagePathIsSafe(path) {
  return typeof path === 'string' && path.length > 0
    && !path.startsWith('/') && !path.includes('\\') && !path.includes(':')
    && path.split('/').every(part => part && part !== '.' && part !== '..')
}

async function backupPhotoObjects(photoRows) {
  const activePhotos = photoRows.filter(row => row.deleted_at == null)
  if (activePhotos.some(row => !storagePathIsSafe(row.object_path))) {
    return { error: 'An active report photo has a missing or unsafe object path.' }
  }
  const paths = [...new Set(activePhotos.map(row => row.object_path))]
  const output = join(OUT, 'storage', 'patient-photos')
  let completed = 0
  const hashes = {}
  for (const path of paths) {
    if (!storagePathIsSafe(path)) return { error: 'Unsafe photo object path in report_photos.' }
    const encoded = path.split('/').map(encodeURIComponent).join('/')
    const response = await fetch(`${BASE}/storage/v1/object/patient-photos/${encoded}`, {
      headers: { apikey: SVC, Authorization: `Bearer ${SVC}` }
    })
    if (!response.ok) {
      return { error: `Photo download failed (${response.status}) for an object path.` }
    }
    const destination = join(output, ...path.split('/'))
    mkdirSync(dirname(destination), { recursive: true })
    const bytes = Buffer.from(await response.arrayBuffer())
    writeFileSync(destination, bytes)
    hashes[path] = sha256(bytes)
    completed++
  }
  return { count: completed, hashes }
}

console.log('')
console.log(`==== V2 ${FULL ? 'FULL' : 'METADATA-ONLY'} BACKUP ====`)
console.log(`project : ${BASE}`)
console.log(`to      : ${OUT}`)
console.log('')

const manifest = {
  format_version: 2,
  mode: FULL ? 'full' : 'metadata-only',
  complete: false,
  taken_at: new Date().toISOString(),
  project: BASE,
  tables: {},
  storage: { bucket: 'patient-photos', included: FULL, complete: false, objects: 0, sha256: {} }
}
let failed = false
for (const table of TABLES) {
  const { rows: data, error } = await rows(table)
  if (error) {
    failed = true
    console.error(`  FAIL  ${table.name.padEnd(24)} ${error}`)
    manifest.tables[table.name] = { error, rows_read: data.length }
    continue
  }
  const content = JSON.stringify(data)
  writeFileSync(join(OUT, `${table.name}.json`), content)
  manifest.tables[table.name] = { rows: data.length, sha256: sha256(content) }
  console.log(`  ok    ${table.name.padEnd(24)} ${String(data.length).padStart(7)} row(s)`)
}

// ------------------------------------------------------------------
// auth.users — the accounts staff log in with.
//
// staff_profiles.id is a FOREIGN KEY to auth.users(id), and reports
// .doctor_id / .created_by point at staff_profiles. So a "move to a
// NEW project" that preserves the SAME uuids (the exact move) must
// recreate these auth rows first, with the same id and password hash,
// or every staff_profiles / reports FK breaks on restore.
//
// PostgREST cannot read the auth schema; this uses the admin API with
// the service key. The password hashes are copied verbatim, so the
// SAME password keeps working after the move. This file is SENSITIVE
// (it holds credential hashes) — keep the backup folder private.
// ------------------------------------------------------------------
let authUsers = []
try {
  for (let page = 1; page <= 1000; page++) {
    const r = await fetch(`${BASE}/auth/v1/admin/users?page=${page}&per_page=1000`,
      { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } })
    if (!r.ok) {
      failed = true
      manifest.tables['auth.users'] = { error: `HTTP ${r.status}` }
      console.error(`  FAIL  auth.users                HTTP ${r.status}`)
      break
    }
    const j = await r.json()
    const users = Array.isArray(j.users) ? j.users : []
    authUsers.push(...users)
    if (users.length < 1000) break
    if (page === 1000) {
      failed = true
      manifest.tables['auth.users'] = { error: 'Exceeded the 1,000,000 user safety ceiling.' }
    }
  }
  if (!manifest.tables['auth.users']?.error) {
    const content = JSON.stringify(authUsers)
    writeFileSync(join(OUT, 'auth_users.json'), content)
    manifest.tables['auth.users'] = { rows: authUsers.length, sha256: sha256(content) }
    console.log(`  ok    ${'auth.users'.padEnd(24)} ${String(authUsers.length).padStart(7)} user(s) (sensitive hashes)`)
  }
} catch (e) {
  failed = true
  manifest.tables['auth.users'] = { error: e.message }
  console.error(`  FAIL  auth.users                ${e.message}`)
}

if (FULL && manifest.tables.report_photos && !manifest.tables.report_photos.error) {
  try {
    const photoRows = JSON.parse(readFileSync(join(OUT, 'report_photos.json'), 'utf8'))
    const result = await backupPhotoObjects(photoRows)
    if (result.error) {
      failed = true
      manifest.storage.error = result.error
      manifest.storage.complete = false
      console.error(`  FAIL  patient-photos           ${result.error}`)
    } else {
      manifest.storage.objects = result.count
      manifest.storage.sha256 = result.hashes
      manifest.storage.complete = true
      console.log(`  ok    patient-photos           ${String(result.count).padStart(7)} object(s)`)
    }
  } catch (error) {
    failed = true
    manifest.storage.error = error.message
    manifest.storage.complete = false
    console.error(`  FAIL  patient-photos           ${error.message}`)
  }
} else if (FULL) {
  failed = true
  manifest.storage.complete = false
  manifest.storage.error = 'report_photos metadata was not fully backed up.'
}

manifest.complete = !failed
writeFileSync(join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2))
console.log('')
console.log(manifest.complete
  ? 'Backup completed. Protect this directory; it contains sensitive clinical data and password hashes.'
  : 'BACKUP INCOMPLETE. Do not use it for restore; fix the listed errors and run again.')
console.log('Schema DDL is not included; use checked-in migrations or the Supabase CLI separately.')
if (!manifest.complete) process.exitCode = 1