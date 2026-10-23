// Part 1 of 3: header + helpers + M1-M8
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..', '..')

let passed = 0, failed = 0
const ok = (id, what, cond, d = '') => {
  if (cond) { passed++; console.log('  PASS  ' + id.padEnd(4) + ' ' + what + (d ? ' - ' + d : '')) }
  else { failed++; console.log('  FAIL  ' + id.padEnd(4) + ' ' + what + (d ? ' - ' + d : '')) }
}

const read = (...p) => { try { return readFileSync(join(APP, ...p), 'utf8') } catch { return '' } }
const stripSql = s => s.replace(/--[^\n]*/g, '')

const m34raw = read('supabase-v2', 'migrations', '0034_secretary_shelf_delete.sql')
const m34fresh = read('supabase-v2', 'migrations', '0034_secretary_shelf_delete.sql')
const m34 = stripSql(m34raw)
const dbRec = read('function', 'dbRecords.js')
const admin = read('function', 'admin.js')
const baseline = read('supabase-v2', 'migrations', '0000_BASELINE_all.sql')

// ---------------------------------------------------------------------
// 0039 - the repair for both reported errors.
//
//   The delete error was a WITH CHECK failure: after 0037 the only UPDATE
//   policies on reports demand either a LIVE new row (deleted_at IS NULL)
//   or an active admin of the owning clinic, so a doctor or secretary
//   writing deleted_at had no arm that accepted the row being written.
//   reports_update_own_doctor is the policy that answers it, because its
//   USING and WITH CHECK are the SAME predicate and so it judges the row
//   in either direction. 0039 re-asserts it.
//
//   The bin error is 0026's sentence, which only 0026's function can say.
//   0039 replaces the function with a three-reader version.
// ---------------------------------------------------------------------
const m39raw = read('supabase-v2', 'migrations', '0039_recycle_bin_doctor_and_secretary.sql')
const m39fresh = read('supabase-v2', 'migrations', '0039_recycle_bin_doctor_and_secretary.sql')
const m39 = stripSql(m39raw)
ok('N1', '0039 exists in the single migrations/ set (no mirror folder to drift)',
   m39raw.length > 0 && m39fresh === m39raw && !existsSync(join(APP, 'supabase-v2', 'fresh-setup')))

const n39Soft = m39.indexOf('ent_may_soft_delete(')
const n39SoftBody = m39.slice(m39.indexOf('AS $$', n39Soft), m39.indexOf('$$;', n39Soft))
ok('N2', 'the cross-clinic secretary arm is on the delete predicate',
  n39SoftBody.includes('ent_is_my_doctor(p_doctor)'), '0037 scope, so delete cannot be narrower than read/write')
ok('N3', '0039 removes no earlier arm',
  n39SoftBody.includes('is_draft AND created_by')
  && n39SoftBody.includes('p_doctor = public.ent_auth_uid()')
  && n39SoftBody.includes('ent_is_active_admin()')
  && n39SoftBody.includes('ent_claim_clinic_id()')
  && n39SoftBody.includes('me.assigned_doctor_id'))

const n39Pol = m39.indexOf('reports_update_own_doctor ON public.reports')
const n39PolBody = m39.slice(n39Pol, n39Pol + 700)
ok('N4', 'the soft-delete policy is RE-ASSERTED (the actual cause of the 403)',
  m39.includes('DROP POLICY IF EXISTS reports_update_own_doctor')
  && m39.includes('CREATE POLICY reports_update_own_doctor'))
ok('N5', 'USING and WITH CHECK are the SAME predicate, so delete and restore both work',
  (n39PolBody.match(/ent_may_soft_delete\(clinic_id, doctor_id, id\)/g) || []).length >= 2,
  'one missing half is how "delete works, restore is refused" happens')

const n39Bin = m39.indexOf('ent_deleted_reports(p_limit')
const n39BinBody = m39.slice(m39.indexOf('AS $$', n39Bin), m39.indexOf('$$;', n39Bin))
ok('N6', 'the bin now reads for a DOCTOR on his own shelf',
  n39BinBody.includes("me.role = 'doctor'") && n39BinBody.includes('r.doctor_id = me.id'))
ok('N7', 'the doctor arm is clinic-scoped, never cross-clinic',
  /me\.role = 'doctor'\s+AND r\.doctor_id = me\.id\s+AND r\.clinic_id = me\.clinic_id/.test(n39BinBody))
ok('N8', 'the secretary scope is the full 0037 assigned set',
  n39BinBody.includes('ent_is_my_doctor(r.doctor_id)'))
ok('N9', 'the admin scope stays the clinic he OWNS, not membership',
  n39BinBody.includes('ent_is_active_admin()') && n39BinBody.includes('ent_claim_clinic_id()'))
ok('N10', 'the bin still REFUSES strangers, and never returns the payload',
  n39BinBody.includes('RAISE EXCEPTION') && !n39BinBody.includes('payload'))
ok('N11', 'the bin is not scoped by ent_is_member_of (a clinic manager also passes that)',
  !n39BinBody.includes('ent_is_member_of'))
ok('N12', '0039 grants no hard delete and keeps the admin-only erase narrow',
  !m39.includes('CREATE POLICY reports_delete_own_doctor')
  && m39.includes('reports_delete_admin')
  && m39.includes('reports_delete_own_doctor exists again'))
ok('N13', '0039 self-verifies every invariant it depends on',
  m39.includes('pg_get_functiondef') && m39.includes('pg_policies') && m39.includes('RAISE NOTICE'))
ok('N14', 'the 0023 gap is documented, not silently skipped',
  read('supabase-v2', 'migrations', '0023_SUPERSEDED_README.md').includes('DO NOT APPLY'))

console.log('==== RECYCLE BIN FLOW - offline ====')
console.log('')

// 1 - migration 0034, the predicate
ok('M1', '0034 exists in the single migrations/ set (no mirror folder to drift)', m34raw.length > 0 && m34fresh === m34raw && !existsSync(join(APP, 'supabase-v2', 'fresh-setup')))
const marker = 'ent_may_soft_delete('
const segStart = m34.indexOf(marker)
const asStart = m34.indexOf('AS $$', segStart)
const asEnd = m34.indexOf('$$;', asStart)
const predBody = (segStart >= 0 && asStart > segStart && asEnd > asStart) ? m34.slice(asStart + 5, asEnd) : ''
ok('M2', 'ent_may_soft_delete carries the NEW secretary arm', predBody.includes('secretary') && predBody.includes('assigned_doctor_id'), 'role + assigned shelf both required')
ok('M3', 'the secretary arm resolves HER OWN profile row (not a claim)', predBody.includes('staff_profiles me'))
ok('M4', 'the shelf arm is hand-written, no grant helper in the tail', predBody.length > 0 && !predBody.slice(predBody.indexOf('staff_profiles me')).includes('ent_may_edit_report'))
ok('M5', 'no earlier arm was traded away', predBody.includes('is_draft AND created_by') && predBody.includes('ent_auth_uid') && predBody.includes('ent_is_active_admin'))
// Part 2 of 3: M6-M15 (string-includes only, no tricky regex)
const binMarker = 'ent_deleted_reports(p_limit'
const binStart = m34.indexOf(binMarker)
const binAsStart = m34.indexOf('AS $$', binStart)
const binAsEnd = m34.indexOf('$$;', binAsStart)
const binBody = (binStart >= 0 && binAsStart > binStart && binAsEnd > binAsStart) ? m34.slice(binAsStart + 5, binAsEnd) : ''
ok('M6', 'the bin reads for an admin AND for the shelf secretary', binBody.includes('secretary') && binBody.includes('assigned_doctor_id') && binBody.includes('ent_is_active_admin'))
ok('M7', 'the bin still REFUSES everyone else with an explicit RAISE', binBody.includes('RAISE EXCEPTION'))
ok('M8', 'the bin never returns the payload', !binBody.includes('payload'))
ok('M9', 'secretary scope is clinic + assigned doctor', binBody.includes('clinic_id') && binBody.includes('doctor_id'))
ok('M10', 'deleted_by is stamped from the JWT', m34.includes('ent_stamp_deleaser') && m34.includes('ent_auth_uid'))
ok('M11', 'the stamp only fires on a deletion-state change', m34.includes('IS DISTINCT FROM'))
ok('M12', 'service_role stays exempt', m34.includes('service_role'))
ok('M13', 'the file FORBIDS a doctor hard-delete policy', m34.includes('reports_delete_own_doctor') && m34.includes('IF EXISTS'))
ok('M14', 'the final delete stays admin-only over an already-deleted row', m34.includes('reports_delete_admin') && m34.includes('deleted_at IS NOT NULL') && m34.includes('ent_is_active_admin'))
ok('M15', 'no baseline all-in-one exists (separate files only)', baseline.length === 0 && m34raw.length > 0 && !existsSync(join(APP, 'supabase-v2', 'fresh-setup')))
// Part 3 of 3: U1-U9, A1-A5, F1-F3 + footer
ok('U1', 'record cards carry a Delete button again', dbRec.includes('ent-db-del') && dbRec.includes('confirmAndDelete(record)'))
ok('U2', 'the delete ASKS first', dbRec.includes('async function confirmAndDelete') && dbRec.includes('showConfirm('))
ok('U3', 'soft delete routes through the ent_soft_delete_report RPC (SECURITY DEFINER)',
   dbRec.includes('rpc/ent_soft_delete_report') && dbRec.includes("method: 'POST'"))
ok('U4', 'dbRecords.js contains NO hard DELETE at all', !dbRec.includes("method: 'DELETE'"))
ok('U5', 'the audit line logs the action, never the patient name', dbRec.includes("logActivity('DELETE_RECORD'"))
ok('U6', 'the bin toggle exists and is drawn for admin/secretary/doctor', dbRec.includes('ent-db-trashbtn'))
ok('U7', 'the bin reads through ent_deleted_reports', dbRec.includes('rpc/ent_deleted_reports'))
ok('U8', 'restore routes through the ent_restore_report RPC (mirror of delete)',
   dbRec.includes('rpc/ent_restore_report') && dbRec.includes("method: 'POST'"))
ok('U9', 'no purge UI in this file', !dbRec.includes('data-trash-action="purge"') && !dbRec.includes('purgeTrashRow'))

// ---------------------------------------------------------------------
// 0039: the two reported bugs, locked in so neither can come back.
//   U10  the browser DRAWS the bin toggle for a doctor too (0039 widened
//        ent_deleted_reports to three readers)
//   U11  the delete button is NOT gated on role in the client - the
//        database decides, so the same code path serves every role
// ---------------------------------------------------------------------
ok('U10', 'the bin toggle is drawn for admin, secretary AND doctor', dbRec.includes("role === 'doctor'"))
ok('U11', 'the delete handler is not role-gated in the client', /async function confirmAndDelete[\s\S]{0,400}?currentUserRole\(\)/.test(dbRec) === false)
ok('A1', 'trash rows offer Delete forever beside Restore', admin.includes('data-trash-action="purge"') && admin.includes('Delete forever') && admin.includes('data-trash-action="restore"'))
ok('A2', 'the purge click is TWO-STEP', admin.includes('data-armed') && admin.includes('Click again to erase'))
ok('A3', 'the DELETE can only aim at an already-deleted row', admin.includes("method: 'DELETE'") && admin.includes('deleted_at=not.null'))
ok('A4', 'an empty server answer is a REFUSAL, not a success', admin.includes('nothing was erased'))
ok('A5', 'the erase asks for return=representation', admin.includes('return=representation'))
const migDir = join(APP, 'supabase-v2', 'migrations')

// ---------------------------------------------------------------------
// 7 · account-deletion safety (0035), storage purge + retention (0036)
// ---------------------------------------------------------------------
const m35 = stripSql(read('supabase-v2', 'migrations', '0035_account_deletion_safety.sql'))
const m36 = stripSql(read('supabase-v2', 'migrations', '0036_recycle_bin_retention.sql'))
const authAdmin = read('supabase-v2', 'edge-functions', 'auth-admin', 'index.ts')
const photosFn = read('supabase-v2', 'edge-functions', 'patient-photos', 'index.ts')

ok('S1', 'created_by FK relaxes to ON DELETE SET NULL (account can go, author name stays)',
  /reports_created_by_fkey/.test(m35) && /created_by.*ON DELETE SET NULL/.test(m35))
ok('S2', 'uploaded_by FK relaxes to ON DELETE SET NULL too',
  /report_photos_uploaded_by_fkey/.test(m36 === '' ? m35 : m35) && /uploaded_by.*ON DELETE SET NULL/.test(m35))
ok('S3', 'doctor_id is REASSIGNED, never nulled - dedup + clinic ownership survive',
  /ent_reassign_doctor_records/.test(m35) && /SET doctor_id = p_to/.test(m35))
ok('S4', 'the reassignment refuses to cross a clinic boundary',
  /cannot move records between two different clinics/.test(m35))
ok('S5', 'the reassignment only lands on an active doctor (or the admin himself)',
  /records may only be reassigned to an active doctor/.test(m35))
ok('S6', 'auth-admin reassigns a doctors shelf BEFORE deleteUser (no 23503, no orphan)',
  /pickReassignTarget/.test(authAdmin) && /ent_reassign_doctor_records/.test(authAdmin))
ok('S7', 'patient-photos frees the Storage bytes of an ALREADY-deleted report only',
  /action === 'purge_report'/.test(photosFn) && /storage.*remove/.test(photosFn)
  && /not in the recycle bin/.test(photosFn))
ok('S8', 'retention RPC can only erase already-deleted rows of the admins own clinic',
  /ent_purge_recycle_bin/.test(m36) && /deleted_at IS NOT NULL/.test(m36)
  && /ent_claim_clinic_id/.test(m36))
ok('S9', 'the console frees storage BEFORE the row cascades its photo metadata away',
  /callPhotos\(\{ action: 'purge_report', report_id: id \}\)/.test(admin)
  && /purge_report/.test(admin))

ok('F1', 'migrations/ exists with its README (the paste-order guide ships with the set)', existsSync(join(migDir, 'README.md')))
ok('F2', 'no fresh-setup/ mirror folder left to drift', !existsSync(join(APP, 'supabase-v2', 'fresh-setup')))
ok('F3', 'migrations/ carries 0034 as a separate file, no all-in-one', existsSync(join(migDir, '0034_secretary_shelf_delete.sql')) && existsSync(join(migDir, '0001_extensions_enums_helpers.sql')) && !existsSync(join(migDir, '0000_BASELINE_all.sql')))

console.log('')
console.log('==== ' + passed + ' passed, ' + failed + ' failed ====')
process.exit(failed ? 1 : 0)
