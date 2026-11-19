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
     V7  admin clinic context is live-validated and session-bound
     V8  clinic suggestions are allowlisted, private, and server-scoped
     V9  the combined clinic-wide doctor-work migration is safe and scoped
     V10 clinic-wide doctor-work totals and status rows share one private result
     V11 report history is data-only, scoped, and expires after 90 days
     V12 doctors manage their own PNG signature; assigned secretaries can read it

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
const source = file => readFileSync(join(ROOT, '..', file), 'utf8')

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
chk('V1e', 'Super Secretary selected-doctor access and active-clinic SQL share migration 0050',
  execFiles.includes('0050_super_secretary_network_scope.sql')
    && !migFiles.includes('0051_super_secretary_active_clinic.sql')
    && !migFiles.includes('0052_selected_super_secretary_doctors.sql')
    && raw('0050_super_secretary_network_scope.sql').includes('CREATE TABLE IF NOT EXISTS public.ent_super_secretary_active_clinics')
    && raw('0050_super_secretary_network_scope.sql').includes('CREATE OR REPLACE FUNCTION public.ent_set_active_clinic(p_doctor uuid)')
    && raw('0050_super_secretary_network_scope.sql').includes('INSERT INTO public.secretary_assignments (secretary_id, doctor_id)'))

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
const M50 = stripComments(raw('0050_super_secretary_network_scope.sql'))
function lastFunctionDefinition(source, signature) {
  const start = source.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${signature}`)
  if (start < 0) return ''
  return (source.slice(start).match(/CREATE OR REPLACE FUNCTION[\s\S]*?\n\$\$;/) || [''])[0]
}
const M50_DOCTOR_SCOPE = lastFunctionDefinition(M50, 'ent_is_my_doctor(p_doctor uuid)')
const M50_SWITCH_SCOPE = lastFunctionDefinition(M50, 'ent_super_secretary_network_doctor(p_doctor uuid)')
const M50_VIEW_ALL_INDEX = lastFunctionDefinition(M50, 'ent_view_all_index(')
chk('V5.28', 'Super Secretary clinic context is bound to the authenticated session',
  M50.includes('PRIMARY KEY (user_id, session_id)')
    && M50.includes("auth.jwt() ->> 'session_id'")
    && M50.includes('ent_set_active_clinic'))
chk('V5.29', 'clinic switching validates only primary and explicitly assigned doctors',
  M50_SWITCH_SCOPE.includes('secretary_assignments')
    && !M50_SWITCH_SCOPE.includes('managed_by'))
chk('V5.30', 'report and photo read/write policies all enforce the active clinic',
  ['reports_select_owner', 'reports_insert_owner', 'reports_update_owner',
    'photos_select_owner', 'photos_insert_owner', 'photos_update_owner'].every(name => {
    const start = M50.lastIndexOf(`CREATE POLICY ${name} ON public.`)
    if (start < 0) return false
    const end = M50.indexOf(';', start)
    return end > start && M50.slice(start, end).includes('ent_super_secretary_context_matches')
  }))
chk('V5.31', 'SECURITY DEFINER patient index and full-record checks apply the active clinic too',
  M50.includes('AND public.ent_super_secretary_context_matches(r.clinic_id)')
    && M50.includes('CREATE OR REPLACE FUNCTION public.ent_may_open_report(p_report uuid)')
    && M50.includes('public.ent_may_open_report(r.id)'))
chk('V5.32', 'Super Secretary record scope and clinic switching require explicit doctor assignments',
  M50_DOCTOR_SCOPE.includes('secretary_assignments')
    && M50_DOCTOR_SCOPE.includes('ent_active_super_secretary_clinic_id')
    && !M50_DOCTOR_SCOPE.includes('managed_by')
    && M50_SWITCH_SCOPE.includes('secretary_assignments')
    && !M50_SWITCH_SCOPE.includes('managed_by'))
chk('V5.33', 'Super Secretary View All metadata is filtered to assigned doctors',
  M50_VIEW_ALL_INDEX.includes('NOT public.ent_is_active_super_secretary()')
    && M50_VIEW_ALL_INDEX.includes('OR public.ent_is_my_doctor(report.doctor_id)'))
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

/* ------------------------------------------------------------------ V7 */
console.log('')
console.log('--- V7 · admin clinic context is live-validated -------------------')
const M52 = raw('0052_admin_active_clinic_context.sql')
chk('V7.1', 'admin clinic context storage is RLS-enabled and inaccessible to clients',
  /ALTER TABLE public\.ent_admin_active_clinics ENABLE ROW LEVEL SECURITY/.test(M52)
    && /REVOKE ALL ON TABLE public\.ent_admin_active_clinics FROM PUBLIC, anon, authenticated/.test(M52))
chk('V7.2', 'available clinics come from live admin ownership, not a client-supplied scope',
  /FUNCTION public\.ent_admin_available_doctors\(\)/.test(M52)
    && /me\.role = 'admin'[\s\S]*?me\.is_active[\s\S]*?public\.ent_admin_covers_clinic\(clinic\.id\)/.test(M52))
chk('V7.3', 'clinic switching validates the active doctor and binds context to the auth session',
  /FUNCTION public\.ent_set_admin_active_clinic\(p_doctor uuid\)/.test(M52)
    && /doctor\.role = 'doctor'[\s\S]*?doctor\.is_active[\s\S]*?public\.ent_admin_covers_clinic\(doctor\.clinic_id\)/.test(M52)
    && /session_key := nullif\(auth\.jwt\(\) ->> 'session_id', ''\)/.test(M52)
    && /VALUES \(public\.ent_auth_uid\(\), session_key, target_clinic, p_doctor, now\(\)\)/.test(M52))
chk('V7.4', 'an existing but invalid admin context fails closed at the clinic predicate',
  /WHEN public\.ent_is_active_admin\(\)[\s\S]*?FROM public\.ent_admin_active_clinics active[\s\S]*?p_clinic = public\.ent_admin_active_clinic_id\(\)/.test(M52))
chk('V7.5', 'managed-clinic report reads and writes require the selected server context',
  /me\.role = 'admin'[\s\S]*?p_clinic = public\.ent_admin_active_clinic_id\(\)[\s\S]*?public\.ent_admin_covers_clinic\(p_clinic\)/.test(M52)
    && /keep_clinic = public\.ent_admin_active_clinic_id\(\)/.test(M52)
    && /NEW\.doctor_id IS DISTINCT FROM public\.ent_admin_active_doctor_id\(\)/.test(M52))
chk('V7.6', 'context RPCs are granted only to authenticated users',
  /REVOKE ALL ON FUNCTION public\.ent_set_admin_active_clinic\(uuid\) FROM PUBLIC, anon/.test(M52)
    && /GRANT EXECUTE ON FUNCTION public\.ent_set_admin_active_clinic\(uuid\) TO authenticated/.test(M52)
    && !/GRANT EXECUTE ON FUNCTION public\.ent_set_admin_active_clinic\(uuid\) TO anon/.test(M52))
chk('V7.7', 'editing an existing doctor shelf preserves its clinic and doctor identity',
  /existing\.clinic_id = keep_clinic[\s\S]*?existing\.doctor_id = NEW\.doctor_id[\s\S]*?existing\.record_key = NEW\.record_key/.test(M52)
    && /record_key,clinic_id,doctor_id,payload/.test(
      readFileSync(join(ROOT, '..', 'function', 'dbRecords.js'), 'utf8')))

/* ------------------------------------------------------------------ V8 */
console.log('')
console.log('--- V8 · clinic clinical suggestions are restricted --------------')
const M54 = stripComments(raw('0054_clinic_clinical_suggestions.sql'))
const M54_RPC = lastFunctionDefinition(M54, 'ent_clinic_clinical_suggestions(')
const M54_EXTRACTOR = lastFunctionDefinition(M54, 'ent_clinical_suggestion_values(')
chk('V8.1', 'suggestion rows are RLS-enabled and inaccessible to direct client queries',
  /ALTER TABLE public\.ent_clinic_clinical_suggestions ENABLE ROW LEVEL SECURITY/.test(M54)
    && /REVOKE ALL ON TABLE public\.ent_clinic_clinical_suggestions FROM PUBLIC, anon, authenticated/.test(M54))
chk('V8.2', 'historical and live extraction use explicit clinical fields and omit patient/HCI fields',
  M54_EXTRACTOR.includes("'chiefComplaint'")
    && M54_EXTRACTOR.includes("'preOpDiagnosis'")
    && M54_EXTRACTOR.includes("'imageFinding'")
    && !M54_EXTRACTOR.includes("'patientFirstName'")
    && !M54_EXTRACTOR.includes("'patientPin'")
    && !M54_EXTRACTOR.includes("'originatingHci'"))
chk('V8.3', 'backfill and trigger ignore deleted/draft reports and exclude known patient identifiers',
  /report\.deleted_at IS NULL[\s\S]*?NOT report\.is_draft/.test(M54)
    && /NEW\.deleted_at IS NOT NULL OR NEW\.is_draft/.test(M54)
    && M54.includes('NEW.patient_name')
    && M54.includes('report.patient_name')
    && M54.includes('report.case_number'))
chk('V8.4', 'live report changes refresh only the report-scoped suggestion rows',
  /CREATE TRIGGER trg_reports_refresh_clinical_suggestions[\s\S]*?AFTER INSERT OR UPDATE OR DELETE[\s\S]*?EXECUTE FUNCTION public\.ent_refresh_clinical_suggestions\(\)/.test(M54)
    && M54.includes('DELETE FROM public.ent_clinic_clinical_suggestions WHERE report_id = NEW.id'))
chk('V8.5', 'the RPC validates doctor, secretary assignment, and admin clinic scope',
  M54_RPC.includes("me.role = 'doctor'")
    && M54_RPC.includes('me.id <> target_doctor.id')
    && M54_RPC.includes("me.role = 'secretary'")
    && M54_RPC.includes('public.ent_is_my_doctor(target_doctor.id)')
    && M54_RPC.includes('public.ent_admin_covers_clinic(target_doctor.clinic_id)')
    && M54_RPC.includes('public.ent_admin_active_clinic_id()')
    && M54_RPC.includes('target_doctor.clinic_id IS DISTINCT FROM me.clinic_id'))
chk('V8.6', 'only authenticated users can execute the data-minimized RPC',
  /REVOKE ALL ON FUNCTION public\.ent_clinic_clinical_suggestions\(text, uuid\) FROM PUBLIC, anon/.test(M54)
    && /GRANT EXECUTE ON FUNCTION public\.ent_clinic_clinical_suggestions\(text, uuid\) TO authenticated/.test(M54)
    && M54_RPC.includes('RETURNS TABLE (field_key text, suggestion_value text)'))

/* ------------------------------------------------------------------ V9 */
console.log('')
console.log('--- V9 · combined clinic-wide Doctor work migration ---------------')
const M55 = stripComments(raw('0055_clinic_doctor_work_counts.sql'))
const M55_COUNTS = lastFunctionDefinition(M55, 'ent_clinic_doctor_work_counts(p_doctor_id uuid)')
const M55_STATUS = lastFunctionDefinition(M55, 'ent_clinic_doctor_work_status(p_doctor_id uuid)')
chk('V9.1', 'the combined migration keeps the report index idempotent',
  M55.includes('CREATE INDEX IF NOT EXISTS idx_reports_clinic_doctor_work_counts'))
chk('V9.2', 'the legacy counts RPC delegates to the status RPC',
  M55_COUNTS.includes('public.ent_clinic_doctor_work_status(p_doctor_id)'))
chk('V9.3', 'the combined migration uses replaceable RPC definitions',
  M55.includes('CREATE OR REPLACE FUNCTION public.ent_clinic_doctor_work_status')
    && M55.includes('CREATE OR REPLACE FUNCTION public.ent_clinic_doctor_work_counts'))

/* ----------------------------------------------------------------- V10 */
console.log('')
console.log('--- V10 · clinic status rows and totals share one scoped result -----')
chk('V10.1', 'status access is validated and reports are restricted to the selected doctor clinic',
  M55_STATUS.includes("me.role = 'doctor'")
    && M55_STATUS.includes("me.role = 'secretary'")
    && M55_STATUS.includes('public.ent_is_my_doctor(target_doctor.id)')
    && M55_STATUS.includes('public.ent_admin_active_clinic_id()')
    && M55_STATUS.includes('report.clinic_id = target_doctor.clinic_id'))
chk('V10.2', 'status rows use only Doctor work completion and the same patient/date grouping',
  M55_STATUS.includes('public.ent_doctor_work_percent(report.report_type, report.payload)')
    && M55_STATUS.includes('GROUP BY patient_key, visit_date')
    && M55_STATUS.includes('bool_and(is_complete) AS is_complete')
    && M55_STATUS.includes('count(*) FILTER (WHERE is_complete)')
    && M55_STATUS.includes('count(*) FILTER (WHERE NOT is_complete)')
    && M55_STATUS.includes('report.is_draft IS FALSE')
    && !M55_STATUS.includes('draftShared'))
chk('V10.3', 'one JSON result returns counts and matching status rows without patient IDs or form payload',
  M55_STATUS.includes("'completed_count', completed_count")
    && M55_STATUS.includes("'incomplete_count', incomplete_count")
    && M55_STATUS.includes("'total_count', completed_count + incomplete_count")
    && M55_STATUS.includes("'records', records")
    && !M55_STATUS.includes("'patient_id',")
    && !M55_STATUS.includes("'payload',"))
chk('V10.4', 'open-report keys are included only for reports on the selected doctor shelf',
  M55_STATUS.includes('FILTER (WHERE doctor_id = target_doctor.id)')
    && M55_STATUS.includes("'record_key', record_key")
    && M55_STATUS.includes("'action_report_type', action_report_type"))
chk('V10.5', 'the status RPC is executable only by authenticated users',
  /REVOKE ALL ON FUNCTION public\.ent_clinic_doctor_work_status\(uuid\)[\s\S]*?FROM PUBLIC, anon, authenticated/.test(M55)
    && /GRANT EXECUTE ON FUNCTION public\.ent_clinic_doctor_work_status\(uuid\)[\s\S]*?TO authenticated/.test(M55)
    && M55.includes('has_function_privilege(\'anon\'')
    && M55.includes('0055 verified'))
chk('V10.6', 'the legacy counts RPC reads the same final-only status result',
  M55.includes('public.ent_clinic_doctor_work_status(p_doctor_id)')
    && /REVOKE ALL ON FUNCTION public\.ent_clinic_doctor_work_counts\(uuid\)[\s\S]*?FROM PUBLIC, anon, authenticated/.test(M55)
    && /GRANT EXECUTE ON FUNCTION public\.ent_clinic_doctor_work_counts\(uuid\)[\s\S]*?TO authenticated/.test(M55))

/* ----------------------------------------------------------------- V11 */
console.log('')
console.log('--- V11 · report versions are scoped, data-only, and time-limited ---')
const M56 = stripComments(raw('0056_report_version_history.sql'))
const M56_CAPTURE = lastFunctionDefinition(M56, 'ent_capture_report_version()')
const M56_RESTORE = lastFunctionDefinition(M56, 'ent_restore_report_version(p_version_id uuid)')
const M56_PURGE = lastFunctionDefinition(M56, 'ent_purge_expired_report_versions()')
const M56_PAYLOAD = lastFunctionDefinition(M56, 'ent_report_history_payload(p_payload jsonb)')
chk('V11.1', 'history rows link to reports, keep actor attribution, and expire after 90 days',
  /report_id\s+uuid\s+NOT NULL REFERENCES public\.reports\(id\) ON DELETE CASCADE/.test(M56)
    && M56.includes('actor_id')
    && M56.includes('actor_label')
    && /expires_at\s+timestamptz NOT NULL DEFAULT \(now\(\) \+ interval '90 days'\)/.test(M56))
chk('V11.2', 'version rows are RLS-enabled and clients receive SELECT only',
  M56.includes('ALTER TABLE public.report_versions ENABLE ROW LEVEL SECURITY')
    && /REVOKE ALL ON TABLE public\.report_versions FROM PUBLIC, anon, authenticated/.test(M56)
    && /GRANT SELECT ON TABLE public\.report_versions TO authenticated/.test(M56)
    && !/GRANT (?:INSERT|UPDATE|DELETE|ALL)[^;]*report_versions[^;]* TO authenticated/i.test(M56))
chk('V11.3', 'history reads require an unexpired version and access to its parent report',
  /CREATE POLICY report_versions_select_report_access ON public\.report_versions[\s\S]*?expires_at > now\(\)[\s\S]*?FROM public\.reports report[\s\S]*?WHERE report\.id = public\.report_versions\.report_id/.test(M56))
chk('V11.4', 'only edits to existing final reports capture the previous version',
  M56.includes('CREATE TRIGGER trg_reports_capture_version')
    && /BEFORE UPDATE ON public\.reports[\s\S]*?EXECUTE FUNCTION public\.ent_capture_report_version\(\)/.test(M56)
    && M56_CAPTURE.includes('OLD.is_draft')
    && M56_CAPTURE.includes("OLD.payload -> 'formData'")
    && M56_CAPTURE.includes('OLD.id')
    && M56_CAPTURE.includes('OLD.patient_name')
    && M56_CAPTURE.includes('OLD.payload'))
chk('V11.5', 'snapshots omit photo data and ignore image-only changes',
  /-\s*'images'/.test(M56_PAYLOAD)
    && M56_PAYLOAD.includes("'photos'")
    && M56_PAYLOAD.includes("'photos'")
    && M56_CAPTURE.includes('ent_report_history_payload(OLD.payload)')
    && M56_CAPTURE.includes('ent_report_history_payload(NEW.payload)'))
chk('V11.6', 'restore runs as the caller, validates an unexpired version, and preserves current photos',
  /SECURITY INVOKER/.test(M56_RESTORE)
    && M56_RESTORE.includes('expires_at > now()')
    && M56_RESTORE.includes('v_current.payload')
    && M56_RESTORE.includes("'{images}'")
    && M56_RESTORE.includes('v_current_images')
    && !/SET[\s\S]*?photo_count\s*=/.test(M56_RESTORE)
    && !M56_RESTORE.includes('report_photos'))
chk('V11.7', 'daily pg_cron purges expired versions and stops clearly if Cron is unavailable',
  M56.includes("name = 'pg_cron'")
    && M56.includes('RAISE EXCEPTION')
    && M56_PURGE.includes('DELETE FROM public.report_versions')
    && M56_PURGE.includes('expires_at <= now()')
    && M56.includes("'17 3 * * *'")
    && M56.includes('ent-report-version-retention'))
chk('V11.8', 'the restore RPC is callable only by authenticated users',
  /REVOKE ALL ON FUNCTION public\.ent_restore_report_version\(uuid\) FROM PUBLIC, anon, authenticated/.test(M56)
    && /GRANT EXECUTE ON FUNCTION public\.ent_restore_report_version\(uuid\) TO authenticated/.test(M56))

/* ----------------------------------------------------------------- V12 */
console.log('')
console.log('--- V12 · doctors manage their own signatures ---')
const M57 = stripComments(raw('0057_doctor_signatures.sql'))
const M57_SELECT = M57.match(/CREATE POLICY doctor_signatures_select_assigned[\s\S]*?;/)
const M57_INSERT = M57.match(/CREATE POLICY doctor_signatures_insert_own[\s\S]*?;/)
const M57_UPDATE = M57.match(/CREATE POLICY doctor_signatures_update_own[\s\S]*?;/)
const M57_DELETE = M57.match(/CREATE POLICY doctor_signatures_delete_own[\s\S]*?;/)
chk('V12.1', 'one PNG signature per doctor account with a bounded data URL',
  /doctor_id\s+uuid\s+PRIMARY KEY REFERENCES public\.staff_profiles\(id\) ON DELETE CASCADE/.test(M57)
    && M57.includes('length(signature_data_url) <= 150000')
    && M57.includes('data:image/png;base64,'))
chk('V12.2', 'signatures are RLS-enabled and never available to anon',
  M57.includes('ALTER TABLE public.doctor_signatures ENABLE ROW LEVEL SECURITY')
    && /REVOKE ALL ON TABLE public\.doctor_signatures FROM PUBLIC, anon, authenticated/.test(M57)
    && /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.doctor_signatures TO authenticated/.test(M57)
    && /GRANT ALL ON TABLE public\.doctor_signatures TO service_role/.test(M57))
chk('V12.3', 'signature insert, update, and delete require the caller to own an active doctor profile',
  [M57_INSERT, M57_UPDATE, M57_DELETE].every(policy =>
    policy && policy[0].includes('doctor_id = public.ent_auth_uid()')
      && policy[0].includes("profile.role = 'doctor'")
      && policy[0].includes('profile.is_active')))
chk('V12.4', 'signature management UI is present on both endoscopy forms',
  /id="manageDoctorSignature"/.test(source('pages/nasalEndoscopy.html'))
    && /id="manageDoctorSignature"/.test(source('pages/laryngealEndoscopy.html'))
    && M57.includes('doctor_signatures'))
chk('V12.5', 'the print builder uses a saved signature only for the matching surgeon name',
  /normalizedName\(surgeonName\)/.test(source('function/doctorSignature.js'))
    && /EntDoctorSignature\.forSurgeon\(data\.physician\)/.test(source('function/index.js'))
    && /signatureImage/.test(source('function/index.js')))
chk('V12.6', 'assigned secretaries can read signatures only through the live doctor-assignment predicate',
  !!M57_SELECT && M57_SELECT[0].includes('public.ent_is_my_doctor(doctor_id)')
    && M57_SELECT[0].includes('doctor_id = public.ent_auth_uid()'))
chk('V12.7', 'the signature form previews authorized doctors on both endoscopy pages',
  /id="doctorSignaturePreview"/.test(source('pages/nasalEndoscopy.html'))
    && /id="doctorSignaturePreview"/.test(source('pages/laryngealEndoscopy.html'))
    && /fetchAssignedDoctors/.test(source('function/doctorSignature.js'))
    && /doctor_signatures\?select=signature_data_url&doctor_id=eq\./.test(source('function/doctorSignature.js')))
chk('V12.8', 'secretaries cannot write signatures and selected signatures are included in print',
  [M57_INSERT, M57_UPDATE, M57_DELETE].every(policy =>
    policy && !policy[0].includes('secretary') && policy[0].includes("profile.role = 'doctor'")
  ) && /signatureImage/.test(source('function/index.js')))

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
  'apply migrations/0001…0057 in order on a NEW project; every guard DO-block',
  '   must print its NOTICE (they read pg_policies / pg_proc, so they are the',
  '   real proof the objects exist and no arm was traded away)',
  'sign in as a Super Secretary and verify switching clinic changes the',
  '   active-clinic context before reports, DB Records, photos and summaries load',
  'verify the selected clinic can see only assigned doctors, while unassigned',
  '   doctors, the View All index, and medical-document actions stay isolated',
  'sign in as an admin and verify the clinic switcher lists only owned clinics',
  '   and that report reads/writes stop when the selected clinic or doctor is revoked',
  'run scripts/diagnose_delete.mjs there: ent_may_soft_delete must answer TRUE',
  '   for a doctor on his own row and for an assigned secretary',
  'sign in as admin / doctor / secretary and repeat BOTH reported actions â€”',
  '   Delete in dbRecords, and opening the Recycle bin. Neither may 403.',
  'confirm a doctor sees ONLY his own shelf, and a stranger in another clinic',
  '   sees nothing at all',
  'confirm dbRecords lists the expected saved records and myDrafts the drafts',
  'verify clinic suggestions backfill only allowlisted clinical fields and stay isolated across doctor, secretary, and admin clinic contexts',
  'verify clinic-wide Doctor work totals equal the patient/date status rows and never include another clinic',
  'with pg_cron enabled, verify report version capture, permission-scoped restore, photo preservation, and daily expiry purge',
  'verify report_photos metadata resolves to a REAL Storage object, and count',
  '   the objects in the bucket â€” metadata alone is not a migrated photo',
  'confirm the frontend URL + anon key match the new project, and that no',
  '   service-role key appears anywhere under function/ or pages/',
].forEach(m => console.log(`  Â· ${m}`))
console.log('')
process.exit(fail ? 1 : 0)
