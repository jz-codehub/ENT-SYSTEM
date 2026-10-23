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

   Usage: node supabase-v2/scripts/backup_v2.mjs
   Writes: supabase-v2/backup/v2-<timestamp>/  (git-ignored? NO - review
           before committing; it contains real rows, albeit synthetic)
   ===================================================================== */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
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

// Every table 0001-0006 creates, in dependency order.
const TABLES = ['clinics', 'staff_profiles', 'reports', 'report_photos',
                'activity_logs', 'user_presence', 'system_flags', 'clinic_settings']

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const OUT = join(HERE, '..', 'backup', `v2-${stamp}`)
mkdirSync(OUT, { recursive: true })

async function rows(table) {
  // Range header pages through the table; PostgREST caps a single page.
  // Not every table has an `id`: user_presence is keyed by
  // (user_id, device_label), system_flags by flag_key and clinic_settings
  // by (clinic_id, setting_key). So order by `id` only if the table has
  // one, and fall back to unordered paging when PostgREST rejects it.
  //
  // FREE-PLAN EGRESS. `select=*` on `reports` drags the ENTIRE payload, and
  // while photo storage is OFF that payload holds every endoscopy photo as
  // base64 - hundreds of KB to MB per row. A routine backup of a photo-heavy
  // shelf can pull more egress in one run than the whole app uses in a week,
  // against a 5 GB/month cap. So the DEFAULT backup reads reports WITHOUT the
  // payload column: the identity/metadata columns are the part that matters
  // for a "move to a new project" restore, and the photos are re-uploadable
  // from the source device (they are not gone - draftsBrowser/photoStore keep
  // the device copy). Pass --with-payload only when you deliberately need the
  // full base64 archive and accept the one-off egress hit.
  const slimReports = table === 'reports' && !process.argv.includes('--with-payload')
  const cols = slimReports
    ? 'id,clinic_id,doctor_id,created_by,record_key,report_type,is_draft,'
      + 'patient_name,patient_id,case_number,procedure_date,file_name,'
      + 'photo_count,created_at,updated_at,saved_at'
    : '*'
  const all = []
  for (let from = 0; from < 20000; from += 1000) {
    const base = `${BASE}/rest/v1/${table}?select=${cols}&limit=1000&offset=${from}`
    let r = await fetch(`${base}&order=id.asc`,
      { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } })
    if (!r.ok) r = await fetch(base, { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } })
    if (!r.ok) return { error: `HTTP ${r.status} ${(await r.text()).slice(0, 80)}`, rows: all }
    const j = await r.json()
    if (!Array.isArray(j) || j.length === 0) break
    all.push(...j)
    if (j.length < 1000) break
  }
  return { rows: all }
}

console.log('')
console.log('==== V2 DATA BACKUP ====')
console.log(`project : ${BASE}`)
console.log(`to      : ${OUT}`)
console.log('')

const manifest = { taken_at: new Date().toISOString(), project: BASE, tables: {} }
for (const t of TABLES) {
  const { rows: data, error } = await rows(t)
  if (error) { console.log(`  SKIP  ${t.padEnd(18)} ${error}`); manifest.tables[t] = { error }; continue }
  writeFileSync(join(OUT, `${t}.json`), JSON.stringify(data, null, 2))
  manifest.tables[t] = { rows: data.length }
  console.log(`  ok    ${t.padEnd(18)} ${String(data.length).padStart(5)} row(s) -> ${t}.json`)
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
  for (let page = 1; page < 200; page++) {
    const r = await fetch(`${BASE}/auth/v1/admin/users?page=${page}&per_page=1000`,
      { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } })
    if (!r.ok) { console.log(`  WARN  auth.users          HTTP ${r.status} ${(await r.text()).slice(0, 60)}`); break }
    const j = await r.json()
    const users = Array.isArray(j.users) ? j.users : []
    authUsers.push(...users)
    if (users.length < 1000) break
  }
  writeFileSync(join(OUT, 'auth_users.json'), JSON.stringify(authUsers, null, 2))
  manifest.tables['auth.users'] = { rows: authUsers.length }
  console.log(`  ok    ${'auth.users'.padEnd(18)} ${String(authUsers.length).padStart(5)} row(s) -> auth_users.json  (SENSITIVE: password hashes)`)
} catch (e) {
  console.log(`  WARN  auth.users          ${e.message}`)
}

writeFileSync(join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2))
console.log('')
console.log('restore: for each table, POST the array back to /rest/v1/<table>')
console.log('        with the service key and Prefer: resolution=merge-duplicates')
console.log('')
console.log('NOTE: this is DATA only. The schema lives in supabase-v2/migrations.')
console.log('')