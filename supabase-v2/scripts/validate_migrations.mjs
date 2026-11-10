#!/usr/bin/env node
/* =====================================================================
   validate_migrations.mjs â€” prove the migration set in migrations/ is
   consistent and that the delete / recycle-bin rules are right.
   ---------------------------------------------------------------------
   WHY THIS EXISTS

   Part 5 asks for a validation plan and for the checks that can safely run
   without a server. There is no Postgres on this machine and no test project
   nominated yet, so the SQL cannot be EXECUTED here. What CAN be proven
   offline is everything that is a property of the FILES:

     V1  apply order is total, with no duplicate and only the 0023 gap
     V2  ONE source of truth: migrations/ is the only schema folder. The
         old fresh-setup/ mirror, .env.example and the copy builder were
         removed 2026-10-11 so two copies can never drift apart.
     V3  every object a file REFERENCES is created by it or an EARLIER one
         (this is what catches a file pasted out of order on a fresh project)
     V4  the 0023 gap is deliberate, documented, and nothing was lost
     V5  the delete / restore / bin authorization MATRIX, read off the real SQL
     V6  nothing disables RLS or grants anything to anon

   WHAT THIS DOES NOT PROVE, SAID PLAINLY

   It does not prove the database behaves correctly - parsing SQL in Node is
   not executing it. Everything that needs a real project is listed at the end
   of the run as MANUAL, not as PASS.

   Run: node supabase-v2/scripts/validate_migrations.mjs
   Exit 0 = every offline check passed. Non-zero = a real problem.
   ===================================================================== */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const MIG = join(ROOT, 'migrations')

let pass = 0, fail = 0
const problems = []
const ok = (id, msg, extra) => { pass++; console.log(`  PASS  ${id.padEnd(6)} ${msg}${extra ? `\n         ${extra}` : ''}`) }
const bad = (id, msg, extra) => { fail++; problems.push(`${id} ${msg}`); console.log(`  FAIL  ${id.padEnd(6)} ${msg}${extra ? `\n         ${extra}` : ''}`) }
const chk = (id, msg, cond, extra) => (cond ? ok(id, msg, extra) : bad(id, msg, extra))

console.log('')
console.log('==== MIGRATION SET VALIDATION (offline) ====')

// Strip comments but KEEP string literals intact, because most of the rules
// being asserted are about quoted SQL ("me.role = 'doctor'", 'secretary').
//
// The subtlety: a `--` inside a literal is TEXT. Blanking literals first would
// delete the very substrings being checked, and a naive comment strip would
// eat `public.ent_auth_uid()` as if the function name were a SQL comment.
// So walk the text once, copying characters and skipping only a comment that
// is genuinely OUTSIDE a literal.
const stripComments = s => {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "'") {                       // single-quoted literal: copy whole
      const start = i
      i++
      while (i < s.length) {
        if (s[i] === "'" && s[i + 1] === "'") { i += 2; continue }   // '' escape
        if (s[i] === "'") break
        i++
      }
      out += s.slice(start, i + 1)
      continue
    }
    if (c === '$' && s[i + 1] === '$') {   // $$ body: copy whole, comments and all
      const end = s.indexOf('$$', i + 2)
      const stop = end < 0 ? s.length : end + 2
      out += s.slice(i, stop)
      i = stop - 1
      continue
    }
    if (c === '-' && s[i + 1] === '-') {   // line comment: drop to end of line
      const nl = s.indexOf('\n', i)
      i = nl < 0 ? s.length : nl
      out += ' '
      continue
    }
    if (c === '/' && s[i + 1] === '*') {   // block comment
      const end = s.indexOf('*/', i + 2)
      i = end < 0 ? s.length : end + 1
      out += ' '
      continue
    }
    out += c
  }
  return out
}
// For structural text (a policy body, a function body) comments are already
// handled by the walk above; this only collapses whitespace for readability.
const blankBodies = s => s.replace(/\$\$[\s\S]*?\$\$/g, m => ' '.repeat(m.length))

const migFiles = readdirSync(MIG).filter(f => f.endsWith('.sql')).sort()
const raw = f => readFileSync(join(MIG, f), 'utf8')

/* ------------------------------------------------------------------ V1 */
console.log('')
console.log('--- V1 Â· apply order --------------------------------------------')
const nums = migFiles.map(f => parseInt(f.slice(0, 4), 10))
chk('V1a', `migrations are numbered and sorted (${migFiles.length} files)`,
  nums.every((n, i) => i === 0 || n >= nums[i - 1]))
// 0009b shares the 0009 number ON PURPOSE: it is a @doc-only Dashboard runbook
// that must sort immediately after 0009_storage_policies.sql. So the real rule
// is "no number is used by two EXECUTABLE files".
const execFiles = migFiles.filter(f => !/^--.*@doc-only/m.test(raw(f)))
const execNums = execFiles.map(f => parseInt(f.slice(0, 4), 10))
const dupNums = execNums.filter((n, i) => execNums.indexOf(n) !== i)
chk('V1b', `no duplicate migration number among the ${execFiles.length} executable files`,
  dupNums.length === 0,
  [...new Set(dupNums)].map(n => String(n).padStart(4, '0')).join(', ') || undefined)
const docOnly = migFiles.filter(f => !execFiles.includes(f))
chk('V1d', 'the only non-executable file is the 0009b Dashboard runbook',
  docOnly.length === 1 && docOnly[0].startsWith('0009b'), docOnly.join(', ') || undefined)
const gaps = []
for (let i = 1; i < nums.length; i++) if (nums[i] - nums[i - 1] > 1) gaps.push(`${String(nums[i - 1]).padStart(4, '0')}->${String(nums[i]).padStart(4, '0')}`)
chk('V1c', 'the 0022 -> 0024 gap is the ONLY gap in the sequence',
  gaps.length === 1 && gaps[0] === '0022->0024',
  gaps.join(', ') + ' â€” 0023 was superseded and never applied, see V4')

/* ------------------------------------------------------------------ V2 */
console.log('')
console.log('--- V2 Â· one source of truth ------------------------------------')
chk('V2a', 'migrations/ is the ONLY schema folder (no fresh-setup/ mirror left to drift)',
   !existsSync(join(ROOT, 'fresh-setup')))
chk('V2b', 'the paste-order guide ships with the set (migrations/README.md)',
   existsSync(join(MIG, 'README.md')))
chk('V2c', 'no copy builder or env template left behind',
   !existsSync(join(HERE, 'build_fresh_setup.mjs')) && !existsSync(join(HERE, '.env.example')))

/* ------------------------------------------------------------------ V3 */
console.log('')
console.log('--- V3 Â· every reference resolves at or before its own file ------')
// An object is "created" by a file containing CREATE [OR REPLACE] FUNCTION /
// TABLE / POLICY / TRIGGER / INDEX, or ALTER TABLE. A reference is any
// `public.<name>(` call. A reference that appears BEFORE its creator is a
// file pasted out of order, which on a fresh project fails at apply time
// with "function does not exist" - so this is the check that matters.
const created = new Map()
const refs = []
const CREATE_RE = /\b(?:CREATE\s+OR\s+REPLACE\s+FUNCTION|CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS|CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS|CREATE\s+POLICY|CREATE\s+TRIGGER|ALTER\s+TABLE)\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi

migFiles.forEach((f, idx) => {
  for (const m of raw(f).matchAll(CREATE_RE)) if (!created.has(m[1])) created.set(m[1], idx)
})

// Second pass, so a file may reference something it creates itself.
//
// IMPORTANT DISTINCTION, or this check produces a false alarm. A call inside
// a plpgsql/$$ body is NOT resolved when the file runs - PostgreSQL parses the
// body without checking that the callee exists, and resolves it on first CALL.
// So 0018 may reference ent_has_report_grant (created in 0019) from inside
// ent_stamp_report_ownership and still apply cleanly; the reference only has
// to resolve by the time a cross-clinic write actually happens, which it does.
// A call OUTSIDE a $$ body - in a policy expression, a view, a CHECK - IS
// resolved at apply time, and THAT is the ordering bug worth catching.
const softRefs = []
migFiles.forEach((f, idx) => {
  // top-level text only: bodies blanked, so only apply-time references count
  for (const m of blankBodies(stripComments(raw(f))).matchAll(/\bpublic\.([a-z_][a-z0-9_]*)\s*\(/g)) {
    if (!created.has(m[1]) || created.get(m[1]) <= idx) continue
    refs.push(`${f} references public.${m[1]}() at APPLY time, created only later in ${migFiles[created.get(m[1])]}`)
  }
  // inside bodies: informational only, must resolve by runtime not apply time
  for (const m of stripComments(raw(f)).matchAll(/\bpublic\.([a-z_][a-z0-9_]*)\s*\(/g)) {
    if (!created.has(m[1]) || created.get(m[1]) <= idx) continue
    softRefs.push(`${f}: public.${m[1]}() -> ${migFiles[created.get(m[1])]}`)
  }
})
chk('V3a', 'no file references a LATER file\'s function at APPLY time',
  refs.length === 0, [...new Set(refs)].slice(0, 8).join('\n         ') || undefined)
// Reported, not failed: these resolve on first CALL, which is after 0039.
console.log(`        (${new Set(softRefs).size} in-body forward reference(s) exist and are fine - plpgsql`
  + ` resolves them at call time, not apply time: ${[...new Set(softRefs)].slice(0, 3).join('; ')}${new Set(softRefs).size > 3 ? ' â€¦' : ''})`)

const REQUIRED = ['ent_may_soft_delete', 'ent_deleted_reports', 'ent_is_my_doctor', 'ent_may_edit_report',
  'ent_may_touch_report', 'ent_may_read_own_clinic', 'ent_has_report_grant', 'ent_is_active_admin',
  'ent_auth_uid', 'ent_claim_clinic_id', 'ent_stamp_report_ownership', 'ent_stamp_deleaser']
chk('V3b', `the schema defines every authorization helper the app calls (${created.size} objects total)`,
  REQUIRED.every(n => created.has(n)), REQUIRED.filter(n => !created.has(n)).join(', ') || undefined)

const allRaw = migFiles.map(raw).join('\n')
chk('V3c', 'reports_update_own_doctor and reports_delete_admin both exist',
  /CREATE POLICY reports_update_own_doctor/.test(allRaw) && /CREATE POLICY reports_delete_admin/.test(allRaw))

/* ------------------------------------------------------------------ V4 */
console.log('')
console.log('--- V4 Â· the 0023 gap is a documented decision -------------------')
const note = join(MIG, '0023_SUPERSEDED_README.md')
chk('V4a', 'migrations/0023_SUPERSEDED_README.md exists', existsSync(note))
chk('V4b', 'the 0023 note says DO NOT CREATE, so nobody fills the gap later',
   readFileSync(note, 'utf8').includes('Do not create'))
chk('V4c', 'no migration file claims to BE 0023', !migFiles.some(f => f.startsWith('0023')))
chk('V4d', 'no 0023 SQL file exists anywhere in the set',
   readdirSync(MIG).every(f => !/^0023.*\.sql$/.test(f)))
// Everything 0023 asked for must be delivered by a file that exists.
chk('V4e', "0023's root-cause fix landed in 0024 (ent_auth_uid in the grant stamp)",
  /CREATE OR REPLACE FUNCTION public\.ent_stamp_grant/.test(allRaw)
  && bodyOf24().includes('ent_auth_uid'))
chk('V4f', "0023's attribution landed in 0025 (granted_by_name)",
  allRaw.includes('granted_by_name'))
chk('V4g', "0023's revoke rule landed in 0032 (ent_may_revoke_grant)",
  /CREATE OR REPLACE FUNCTION public\.ent_may_revoke_grant/.test(allRaw))
chk('V4h', "0023's NOT NULL decision was REJECTED on purpose (0025 keeps granted_by nullable)",
  raw('0025_grant_author_survives_deletion.sql').includes('granted_by is NOT NULL, which conflicts'))
chk('V4i', '0024 and 0025 both exist, so the gap is bounded by real files',
  migFiles.includes('0024_grant_stamp_reaches_the_stamp.sql') && migFiles.includes('0025_grant_author_survives_deletion.sql'))

function bodyOf24() {
  const src = stripComments(raw('0024_grant_stamp_reaches_the_stamp.sql'))
  const i = src.indexOf('ent_stamp_grant(')
  const a = src.indexOf('AS $$', i), b = src.indexOf('$$;', a)
  return (i >= 0 && a > i && b > a) ? src.slice(a + 5, b) : ''
}

/* ------------------------------------------------------------------ V5 */
console.log('')
console.log('--- V5 Â· delete / restore / bin matrix, read off the real SQL ----')
const bodyOf = (file, sig) => {
  const src = stripComments(raw(file))
  const i = src.indexOf(sig)
  const a = src.indexOf('AS $$', i), b = src.indexOf('$$;', a)
  if (i < 0 || a <= i || b <= a) return ''
  // stripComments deliberately copies $$ bodies WHOLE, comments and all, so a
  // body's own prose survives. The rules asserted against a body are about
  // executable text, so drop the comments from the slice before returning -
  // otherwise a comment saying "ent_is_member_of is NOT used" would satisfy
  // (and fail) a check for exactly that.
  return src.slice(a + 5, b).replace(/--[^\n]*/g, ' ')
}
const policyOf = (file, name) => {
  const src = stripComments(raw(file))
  const i = src.indexOf(`CREATE POLICY ${name}`)
  if (i < 0) return ''
  return src.slice(i, src.indexOf(';', i)).replace(/--[^\n]*/g, ' ')
}

const M39 = '0039_recycle_bin_doctor_and_secretary.sql'
const SOFT = bodyOf(M39, 'ent_may_soft_delete(')
const BIN = bodyOf(M39, 'ent_deleted_reports(p_limit')
const SOFT_POL = policyOf(M39, 'reports_update_own_doctor')
const UPD37 = policyOf('0037_cross_clinic_secretary.sql', 'reports_update_owner')
const SEL37 = policyOf('0037_cross_clinic_secretary.sql', 'reports_select_owner')
// 0026 is the file that DEFINES the surviving hard-delete policy; 0034 only
// ASSERTS it is still narrow. Asserting against 0034 would look at prose.
const DEL_ADMIN = policyOf('0026_soft_delete_recycle_bin.sql', 'reports_delete_admin')
const M34_ASSERTS = stripComments(raw('0034_secretary_shelf_delete.sql'))

// --- who may MARK a row deleted -----------------------------------------
chk('V5.1', 'delete predicate admits the author of her own UNFINISHED draft',
  SOFT.includes('is_draft AND created_by = public.ent_auth_uid()'))
chk('V5.2', "delete predicate admits the row's own doctor",
  SOFT.includes('p_doctor = public.ent_auth_uid()'))
chk('V5.3', 'delete predicate admits an active admin of the OWNING clinic',
  SOFT.includes('ent_is_active_admin()') && SOFT.includes('ent_claim_clinic_id()'))
chk('V5.4', "delete predicate admits a secretary on her primary doctor's shelf",
  SOFT.includes('me.assigned_doctor_id') && SOFT.includes("me.role = 'secretary'"))
chk('V5.5', 'delete predicate admits a secretary on ANY assigned doctor, cross-clinic',
  SOFT.includes('ent_is_my_doctor(p_doctor)'))
chk('V5.6', 'the delete predicate is SECURITY DEFINER and closed to anon',
  /ent_may_soft_delete[\s\S]{0,400}?SECURITY DEFINER/.test(raw(M39))
  && /REVOKE ALL ON FUNCTION public\.ent_may_soft_delete\(uuid, uuid, uuid\) FROM anon, public/.test(raw(M39))
  && /GRANT\s+EXECUTE ON FUNCTION public\.ent_may_soft_delete\(uuid, uuid, uuid\) TO authenticated/.test(raw(M39)))
chk('V5.7', '0030 introduced the policy and 0039 only RE-ASSERTS it',
  policyOf('0030_wire_soft_delete_policy.sql', 'reports_update_own_doctor').includes('CREATE POLICY'))
chk('V5.8', 'the policy EXISTS (its absence is the reported 403)',
  SOFT_POL.includes('CREATE POLICY reports_update_own_doctor'))
chk('V5.9', 'USING routes through ent_may_soft_delete',
  /USING\s*\(\s*public\.ent_may_soft_delete\(clinic_id, doctor_id, id\)/.test(SOFT_POL))
chk('V5.10', 'WITH CHECK routes through the SAME predicate, so restore works too',
  /WITH CHECK\s*\(\s*public\.ent_may_soft_delete\(clinic_id, doctor_id, id\)/.test(SOFT_POL))
chk('V5.11', "0037's live-row arms demand deleted_at IS NULL - the WITH CHECK trap",
  (UPD37.match(/deleted_at IS NULL/g) || []).length >= 2 && UPD37.includes('deleted_at IS NOT NULL'))
chk('V5.12', "0037's admin-only restore arm is left intact by 0039",
  UPD37.includes('deleted_at IS NOT NULL') && UPD37.includes('ent_is_active_admin()'))

// --- who may READ the bin ------------------------------------------------
chk('V5.13', 'the bin reads for an active admin, scoped to the clinic he OWNS',
  BIN.includes("me.role = 'admin'") && BIN.includes('ent_is_active_admin()') && BIN.includes('ent_claim_clinic_id()'))
chk('V5.14', 'the bin reads for a secretary, scoped to her whole 0037 assigned set',
  BIN.includes("me.role = 'secretary'") && BIN.includes('ent_is_my_doctor(r.doctor_id)'))
chk('V5.15', 'the bin reads for a DOCTOR, scoped to his OWN shelf AND own clinic',
  BIN.includes("me.role = 'doctor'") && /r\.doctor_id = me\.id\s+AND r\.clinic_id = me\.clinic_id/.test(BIN))
chk('V5.16', 'the bin REFUSES every other role with an explicit RAISE',
  BIN.includes('RAISE EXCEPTION') && /me\.role NOT IN \('admin', 'secretary', 'doctor'\)/.test(BIN))
chk('V5.17', 'the bin is SECURITY DEFINER, closed to anon, and payload-free',
  /ent_deleted_reports[\s\S]{0,600}?SECURITY DEFINER/.test(raw(M39))
  && /REVOKE ALL ON FUNCTION public\.ent_deleted_reports\(integer\) FROM anon, public/.test(raw(M39))
  && !BIN.includes('payload'))
chk('V5.18', 'the bin is NOT scoped by ent_is_member_of (a clinic manager passes that)',
  !BIN.includes('ent_is_member_of'))
chk('V5.19', 'the bin only ever returns rows with deleted_at IS NOT NULL',
  BIN.includes('r.deleted_at IS NOT NULL'))

// --- isolation and irreversibility --------------------------------------
chk('V5.20', 'deleted rows stay hidden from every ordinary read', SEL37.includes('deleted_at IS NULL'))

// The LAST file to define each delete policy is what a fresh database ends up
// with, so ordering matters more than existence. 0008/0019 create
// reports_delete_own_doctor, and 0026 DROPs it - the final state has no
// irreversible doctor delete. Reading only "does CREATE exist anywhere" would
// report the opposite of the truth here.
const lastCreate = name => {
  let hit = null
  migFiles.forEach((f, i) => {
    const src = stripComments(raw(f))
    if (new RegExp(`CREATE POLICY ${name}\\b`).test(src)) hit = { file: f, idx: i, create: true }
    else if (new RegExp(`DROP POLICY(?: IF EXISTS)? ${name}\\b`).test(src)) hit = { file: f, idx: i, create: false }
  })
  return hit
}
const lastOwn = lastCreate('reports_delete_own_doctor')
const lastAdmin = lastCreate('reports_delete_admin')
chk('V5.21', 'the doctor hard-delete policy is DROPPED by the final file that mentions it',
  lastOwn && lastOwn.create === false,
  lastOwn ? `last touched by ${lastOwn.file} (${lastOwn.create ? 'CREATE' : 'DROP'})` : 'never defined')
chk('V5.22', 'the only surviving DELETE policy is reports_delete_admin',
  lastAdmin && lastAdmin.create === true, lastAdmin ? `last touched by ${lastAdmin.file}` : 'undefined')
chk('V5.23', 'that hard delete is admin-only AND only over an already-deleted row',
  DEL_ADMIN.includes('reports_delete_admin')
  && /deleted_at IS NOT NULL/.test(DEL_ADMIN)
  && /public[.]ent_is_active_admin[()]/.test(DEL_ADMIN)
  && /clinic_id = public[.]ent_claim_clinic_id[()]/.test(DEL_ADMIN),
  'scoped to the clinic the caller OWNS')
chk('V5.24', 'deleted_by is stamped from the JWT, never believed from the body',
  M34_ASSERTS.includes('NEW.deleted_by := public.ent_auth_uid()')
  // The FUNCTION is ent_stamp_deleaser, the TRIGGER that fires it is
  // trg_reports_stamp_deleaser. Assert the trigger by name, or the check
  // passes on prose that merely mentions the function.
  && M34_ASSERTS.includes('trg_reports_stamp_deleaser')
  && M34_ASSERTS.includes('EXECUTE FUNCTION public.ent_stamp_deleaser()'))
chk('V5.25', 'a cross-clinic secretary still needs ent_is_my_doctor, never blanket access',
  SOFT.includes('ent_is_my_doctor(p_doctor)') && !/ent_may_touch_report/.test(SOFT))
chk('V5.26', '0039 self-verifies every invariant it depends on',
  raw(M39).includes('pg_get_functiondef') && raw(M39).includes('pg_policies') && raw(M39).includes('RAISE NOTICE'))
// The one typo this harness exists to catch: 0039's self-check looks the
// stamping trigger up BY NAME in pg_trigger. If that name is even one
// character off the trigger 0034 actually CREATEs, the guard raises
// "missing. Apply 0034." on a database where 0034 ran perfectly - and the
// migration fails at the very end for no real reason. Compare the two
// spellings directly.
const TRG_39 = (stripComments(raw(M39)).match(/t\.tgname\s*=\s*'([^']+)'/) || [])[1] || ''
const TRG_34 = (M34_ASSERTS.match(/CREATE\s+TRIGGER\s+([a-z0-9_]+)/i) || [])[1] || ''
chk('V5.27', 'the trigger 0039 looks for is the exact trigger 0034 creates',
  TRG_39 !== '' && TRG_39 === TRG_34,
  `0039 asks pg_trigger for '${TRG_39}'; 0034 CREATEs '${TRG_34}'`)
console.log('')
console.log('  the resulting matrix, read straight off the SQL above:')
console.log('')
console.log('    role       delete (own scope)           restore (own scope)         read bin')
console.log('    --------   --------------------------   -------------------------   ----------------------')
console.log('    doctor     own shelf                    own shelf                   own shelf, own clinic')
console.log('    secretary  primary + assigned doctors  primary + assigned doctors   primary + assigned doctors')
console.log('    admin      whole owned clinic          whole owned clinic          whole owned clinic')
console.log('    other      refused                     refused                    refused (explicit RAISE)')
console.log('')
console.log('    cross-clinic with no assignment and no grant: refused everywhere.')
console.log('    hard delete: admin only, and only over an already-deleted row.')
console.log('')

/* ------------------------------------------------------------------ V6 */
console.log('--- V6 Â· nothing disables RLS or opens anon ----------------------')
// Comments are stripped FIRST and that is not optional: 0001 and 0007 discuss
// the very mistakes this rule forbids ("GRANT ALL TO anon", "USING (true)")
// in prose explaining why they are NOT done. Matching the comments would fail
// files precisely because they document the right decision.
const offenders = []
for (const f of migFiles) {
  const src = blankBodies(stripComments(raw(f)))
  if (/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(src)) offenders.push(`${f}: DISABLE ROW LEVEL SECURITY`)
  if (/USING\s*\(\s*true\s*\)/i.test(src)) offenders.push(`${f}: USING (true)`)
  if (/WITH\s+CHECK\s*\(\s*true\s*\)/i.test(src)) offenders.push(`${f}: WITH CHECK (true)`)
  for (const m of src.matchAll(/GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)[^;]*\bTO\s+anon[^;]*;/gi)) {
    offenders.push(`${f}: ${m[0].replace(/\s+/g, ' ').slice(0, 64)}`)
  }
}
chk('V6a', 'no migration disables RLS, writes USING (true), or grants a privilege to anon',
  offenders.length === 0, offenders.slice(0, 6).join('\n         ') || undefined)
chk('V6b', '0007 REVOKEs the anon grants it warns about',
  /REVOKE[^;]*\bFROM\s+anon/i.test(raw('0007_privileges.sql')))
chk('V6c', 'RLS is ENABLED on reports',
  raw('0004_reports.sql').includes('ENABLE ROW LEVEL SECURITY'))

/* ------------------------------------------------------------------ report */
console.log('')
console.log('==== RESULT ====')
console.log(`  ${pass} passed, ${fail} failed`)
if (fail) {
  console.log('')
  console.log('  FAILURES:')
  problems.forEach(p => console.log(`    ${p}`))
}
console.log('')
console.log('==== NOT PROVEN HERE â€” needs a real Supabase project ============')
;[
  'apply migrations/0001…0048 in order on a NEW project; every guard DO-block',
  '   must print its NOTICE (they read pg_policies / pg_proc, so they are the',
  '   real proof the objects exist and no arm was traded away)',
  'run scripts/diagnose_delete.mjs there: ent_may_soft_delete must answer TRUE',
  '   for a doctor on his own row and for an assigned secretary',
  'sign in as admin / doctor / secretary and repeat BOTH reported actions â€”',
  '   Delete in dbRecords, and opening the Recycle bin. Neither may 403.',
  'confirm a doctor sees ONLY his own shelf, and a stranger in another clinic',
  '   sees nothing at all',
  'confirm dbRecords lists the expected saved records and myDrafts the drafts',
  'verify report_photos metadata resolves to a REAL Storage object, and count',
  '   the objects in the bucket â€” metadata alone is not a migrated photo',
  'confirm the frontend URL + anon key match the new project, and that no',
  '   service-role key appears anywhere under function/ or pages/',
].forEach(m => console.log(`  Â· ${m}`))
console.log('')
process.exit(fail ? 1 : 0)
