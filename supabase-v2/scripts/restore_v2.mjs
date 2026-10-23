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
        node supabase-v2/scripts/restore_v2.mjs supabase-v2/backup/v2-<stamp> --data
        Restores clinics -> staff_profiles -> reports -> report_photos in
        FK order, by uuid, idempotently (safe to re-run).

   CONFIG — for PHASE 2, scripts/.env.local must point at the NEW project:
        SUPABASE_URL=https://NEW-PROJECT-REF.supabase.co
        SUPABASE_SERVICE_ROLE_KEY=<new project service key>
   ===================================================================== */
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
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
const phase = process.argv.find(a => a === '--auth' || a === '--data') || ''
if (!arg || !phase) {
  console.error('usage: node restore_v2.mjs <backupDir> --auth   (phase 1: recreate logins)')
  console.error('       node restore_v2.mjs <backupDir> --data   (phase 2: restore records)')
  process.exit(1)
}

// Only PHASE 2 talks to a project, so only it needs the target credentials.
const BASE = (env.SUPABASE_URL || '').replace(/\/+$/, '')
const SVC = env.SUPABASE_SERVICE_ROLE_KEY || ''
if (phase === '--data' && (!BASE || !SVC)) {
  console.error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required in scripts/.env.local (point them at the NEW project).')
  process.exit(1)
}

const SRC = resolve(arg)
if (!existsSync(SRC)) { console.error('backup folder not found: ' + SRC); process.exit(1) }

const readJson = name => {
  const p = join(SRC, name)
  if (!existsSync(p)) return []
  try { const j = JSON.parse(readFileSync(p, 'utf8')); return Array.isArray(j) ? j : [] } catch { return [] }
}
const sqlStr = v => (v === null || v === undefined) ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`
const sqlJsonb = v => (v === null || v === undefined) ? 'NULL' : `${sqlStr(JSON.stringify(v))}::jsonb`

/* ================= PHASE 1 · --auth : recreate the logins ========== */
if (phase === '--auth') {
  const users = readJson('auth_users.json')
  if (!users.length) { console.error('no auth_users.json in ' + SRC + ' — re-run backup_v2.mjs first.'); process.exit(1) }

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
  console.log('  3. Then run PHASE 2:  node restore_v2.mjs "' + SRC + '" --data')
  console.log('')
  process.exit(0)
}

/* ================= PHASE 2 · --data : restore the records ========== */
async function upsert(table, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500)
    const r = await fetch(`${BASE}/rest/v1/${table}?on_conflict=id`, {
      method: 'POST',
      headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(batch)
    })
    if (!r.ok) throw new Error(`${table}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
    console.log(`  ok    ${table.padEnd(16)} ${batch.length} row(s)`)
  }
}

console.log('')
console.log('==== PHASE 2 (data) RESTORE ====')
console.log('project : ' + BASE)
console.log('from    : ' + SRC)
console.log('')
console.log('PRECONDITION: you already ran the auth SQL (PHASE 1) in this project.')
console.log('')

// FK order: clinics -> staff_profiles -> reports -> report_photos.
const clinics = readJson('clinics.json')
const staff = readJson('staff_profiles.json')
const reports = readJson('reports.json')
const photos = readJson('report_photos.json')

try {
  if (clinics.length) await upsert('clinics', clinics)
  if (staff.length) await upsert('staff_profiles', staff)
  if (reports.length) await upsert('reports', reports)
  if (photos.length) await upsert('report_photos', photos)
} catch (e) {
  console.error('')
  console.error('RESTORE FAILED: ' + e.message)
  console.error('If this is a foreign-key error, the auth accounts (PHASE 1) are missing')
  console.error('or were created with different uuids. Re-run PHASE 1, then PHASE 2 again.')
  process.exit(1)
}

console.log('')
console.log(`done. ${reports.length} report(s), ${staff.length} staff, ${clinics.length} clinic(s), ${photos.length} photo row(s).`)
console.log('Next: point the app at the NEW project (function/supabaseClient.js -> URL + anon key),')
console.log('rebuild (node build-pages.mjs) and redeploy. Photos live inline in payload (base64).')
console.log('')

