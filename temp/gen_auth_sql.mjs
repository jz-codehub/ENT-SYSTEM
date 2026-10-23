import { readFileSync, writeFileSync } from 'node:fs'
const SRC = 'supabase-v2/backup/v2-2026-10-11T23-44-19-717Z'
// test/placeholder accounts to SKIP
const SKIP_EMAILS = new Set(['testdoc1@zztest.invalid', '532@zztest.invalid', 'testadmin@zztest.invalid'])
const SKIP_USERNAMES = new Set(['testdoc1', 'testadmin'])
const SKIP_CLINICS = new Set([
  'f07b0583-edf0-4622-ba79-71b8d877c96b', // testdoc1
  '04bbded8-d7dc-43a7-af0f-8779d69940aa', // zcbdoc1
  'e733777d-50da-479f-8fd2-71d01dbd5eaa', // testdoc2
])
const auth = JSON.parse(readFileSync(SRC + '/auth_users.json', 'utf8'))
const staff = JSON.parse(readFileSync(SRC + '/staff_profiles.json', 'utf8'))
const keepAuth = auth.filter(u => !SKIP_EMAILS.has(u.email))
const keepStaff = staff.filter(s => !SKIP_USERNAMES.has(s.username))
const skipStaffIds = new Set(staff.filter(s => SKIP_USERNAMES.has(s.username)).map(s => s.id))
// also gina (secretary of testdoc1 clinic) — keep? she has no reports. Keep her, reassign later.
console.log('auth: ' + auth.length + ' -> ' + keepAuth.length)
console.log('staff: ' + staff.length + ' -> ' + keepStaff.length)
console.log('skipped staff ids: ' + [...skipStaffIds].join(', '))
for (const u of auth.filter(u => SKIP_EMAILS.has(u.email))) console.log('SKIP auth: ' + u.email)
// OLD bokskie (admin, c12b00e2) vs NEW bokskie (629596a4): exclude OLD bokskie auth+staff
// — the NEW bokskie stays the admin. Exclude old bokskie staff row so no dup admin.
const OLD_BOKSKIE = 'c12b00e2-f4ec-4731-9f8a-7847290c624c'
const finalAuth = keepAuth.filter(u => u.id !== OLD_BOKSKIE)
const finalStaff = keepStaff.filter(s => s.id !== OLD_BOKSKIE)
console.log('final auth (excl old bokskie): ' + finalAuth.length)
console.log('final staff (excl old bokskie): ' + finalStaff.length)
const lit = v => v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`
const userRows = finalAuth.map(u => `  ('00000000-0000-0000-0000-000000000000', ${lit(u.id)}, 'authenticated', 'authenticated', ${lit(u.email)}, ${lit(u.encrypted_password)}, ${lit(u.email_confirmed_at)}, ${lit(u.created_at)}, ${lit(u.updated_at)}, ${lit(JSON.stringify(u.raw_app_meta_data || {}))}::jsonb, ${lit(JSON.stringify(u.raw_user_meta_data || {}))}::jsonb)`)
const identRows = finalAuth.map(u => `  SELECT ${lit(u.id)}::uuid, 'email', ${lit(u.id)}::text, ${lit(JSON.stringify({ sub: u.id, email: u.email }))}::jsonb, ${lit(u.created_at)}::timestamptz, ${lit(u.updated_at)}::timestamptz`)
const sql = [
  '-- RESTORE PHASE 1: recreate OLD logins (excl test accounts + old bokskie) with ORIGINAL uuids.',
  '-- Run in NEW project SQL Editor. SENSITIVE: password hashes. Do not commit.',
  'BEGIN;', '', 'INSERT INTO auth.users',
  '  (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,',
  '   created_at, updated_at, raw_app_meta_data, raw_user_meta_data)', 'VALUES',
  userRows.join(',\n'), 'ON CONFLICT (id) DO NOTHING;', '',
  'INSERT INTO auth.identities (user_id, provider, provider_id, identity_data, created_at, updated_at)',
  identRows.join('\nUNION ALL\n') + ';', '', 'COMMIT;', '',
  `-- ${finalAuth.length} account(s). Same passwords keep working.`,
].join('\n')
writeFileSync(SRC + '/auth_users_restore.sql', sql, 'utf8')
console.log('wrote auth_users_restore.sql (' + finalAuth.length + ' users)')
// placeholder clinics: report which ones are referenced
const clinics = JSON.parse(readFileSync(SRC + '/clinics.json', 'utf8'))
for (const c of clinics) {
  if (c.id.startsWith('00000000')) console.log('PLACEHOLDER ' + c.id.slice(0, 13) + ' ' + c.name + ' code=' + c.code + ' managed_by=' + (c.managed_by || '').slice(0, 8))
}
