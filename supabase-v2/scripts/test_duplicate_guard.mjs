#!/usr/bin/env node
/* test_duplicate_guard.mjs — the 0041 duplicate-patient guard, offline.
   CLIENT half: the identity matcher is sliced out of function/dbRecords.js
   and driven with a mocked apiRequest, so the tested code IS the shipped
   code. SERVER half: the SQL text of 0041. The live database is the final
   authority — run the post-deploy acceptance script after 0001→0041 — but
   every contract this side of the wire is checked here.
   Run: node supabase-v2/scripts/test_duplicate_guard.mjs */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..', '..')
let passed = 0, failed = 0
const ok = (id, what, d = '') => { passed++; console.log(`  PASS  ${id.padEnd(4)} ${what}${d ? ' — ' + d : ''}`) }
const bad = (id, what, d = '') => { failed++; console.log(`  FAIL  ${id.padEnd(4)} ${what}${d ? ' — ' + d : ''}`) }
const is = (id, what, cond, d = '') => cond ? ok(id, what, d) : bad(id, what, d)

const dbSrc = readFileSync(join(APP, 'function', 'dbRecords.js'), 'utf8')
const migSrc = readFileSync(join(APP, 'supabase-v2', 'migrations', '0041_duplicate_patient_guard.sql'), 'utf8')
const freshSrc = readFileSync(join(APP, 'supabase-v2', 'migrations', '0041_duplicate_patient_guard.sql'), 'utf8')
const adminSrc = readFileSync(join(APP, 'function', 'admin.js'), 'utf8')
const adminHtml = readFileSync(join(APP, 'pages', 'admin.html'), 'utf8')
const authSrc = readFileSync(join(APP, 'supabase-v2', 'edge-functions', 'auth-admin', 'index.ts'), 'utf8')
const hash = (s) => createHash('sha256').update(s).digest('hex')

console.log('==== DUPLICATE-PATIENT GUARD (0041) ====')
console.log('')

/* 1. THE REAL MATCHER, driven with a mock server. The slice runs from
   `const PATIENT_ID_KEYS` to the next top-level function — exactly the
   two 0041 additions, i.e. the code that actually ships. */
const sliceStart = dbSrc.indexOf('const PATIENT_ID_KEYS')
const sliceEnd = dbSrc.indexOf('function dupDateLabel')
is('M0', 'the identity matcher is present in dbRecords.js', sliceStart > 0 && sliceEnd > sliceStart)

const calls = []
let nextRows = []
const mockWindow = {
  EntSupabase: {
    apiRequest: async (url) => { calls.push(url); return nextRows }
  }
}
const { patientIdentityOf, findSameIdentityRecord } =
  new Function('window', `${dbSrc.slice(sliceStart, sliceEnd)}; return { patientIdentityOf, findSameIdentityRecord };`)(mockWindow)

/* F1 — same hospital ID (case/whitespace variants are ONE identity):
   the matcher returns the existing record_key so the save MERGES. */
{
  calls.length = 0
  nextRows = [{ id: 'row-1', record_key: 'nasal|id:mrn-77|2026-10-12', patient_id: ' MRN-77 ', patient_name: 'Dela Cruz, Juan', procedure_date: '2026-10-12' }]
  const got = await findSameIdentityRecord('nasal', { patientPin: 'mrn-77' }, '2026-10-12')
  is('F1', 'same patient ID + type + date -> the existing record_key is returned (merge, not duplicate)',
     got === 'nasal|id:mrn-77|2026-10-12', `got ${got}`)
  is('F1b', 'the lookup excludes drafts so a scratch row never absorbs a final save',
     calls[0] && calls[0].includes('is_draft=eq.false'), calls[0] || 'no request')
  is('F1c', 'the lookup is scoped to the exact type and date',
     calls[0] && calls[0].includes('report_type=eq.nasal') && calls[0].includes('procedure_date=eq.2026-10-12'))
  is('F1d', 'the lookup selects ONLY identity columns — never payload or photos',
     calls[0] && calls[0].includes('select=id,record_key,patient_id,patient_name,procedure_date')
       && !calls[0].includes('payload'))
}

/* F2 — a DIFFERENT patient with a similar NAME but another hospital ID
   is never merged: a name is not an identifier. */
{
  calls.length = 0
  nextRows = [{ id: 'row-2', record_key: 'nasal|id:mrn-88', patient_id: 'mrn-88', patient_name: 'Dela Cruz, Juan', procedure_date: '2026-10-12' }]
  const got = await findSameIdentityRecord('nasal', { patientPin: 'mrn-77' }, '2026-10-12')
  is('F2', 'same NAME but a different patient ID -> NOT merged (null)', got === null, `got ${got}`)
}

/* F3 — no ID typed: the matcher stays silent and sends NO request. */
{
  calls.length = 0
  nextRows = [{ id: 'row-3', record_key: 'nasal|name:x', patient_id: '', patient_name: 'Dela Cruz, Juan', procedure_date: '2026-10-12' }]
  const got = await findSameIdentityRecord('nasal', { patientLastName: 'Dela Cruz', patientFirstName: 'Juan' }, '2026-10-12')
  is('F3', 'no hospital ID typed -> null AND no server request (the name prompt handles names)', got === null && calls.length === 0)
}

/* F4 — the identifier chain matches patientRecords.extractMetadata. */
is('F4', 'the identifier chain is patientPin / mrn / patientId / caseNumber',
   patientIdentityOf({ patientPin: 'A', mrn: 'B' }) === 'A'
     && patientIdentityOf({ mrn: 'B', patientId: 'C' }) === 'B'
     && patientIdentityOf({ patientId: 'C' }) === 'C'
     && patientIdentityOf({ caseNumber: 'D' }) === 'D'
     && patientIdentityOf({}) === '')

/* F5 — without a date there is no "same visit", so nothing matches. */
{
  calls.length = 0
  const got = await findSameIdentityRecord('nasal', { patientPin: 'mrn-77' }, '')
  is('F5', 'no report date -> null and no request', got === null && calls.length === 0)
}

/* 2. THE SAVE FLOW — the contracts saveToDatabase now keeps. */
is('S6', 'an ID match SKIPS the name prompt (which would only repeat what the ID proved)',
   /if \(!adoptedKey && sameDay\.length\) \{/.test(dbSrc))
is('S7', 'the adopted key is passed as the carried recordKey so the upsert MERGES',
   dbSrc.includes("adoptedKey ? { format: 'Database', recordKey: adoptedKey } : { format: 'Database' }"))
is('S8a', 'a 23505 race re-queries the winning row instead of failing the save',
   /racedWinner = raced/.test(dbSrc) && /findSameIdentityRecord\(record\.reportType, formData, today\)/.test(dbSrc))
is('S8b', 'the race recovery merges into the WINNER record_key and marks it saved too',
   dbSrc.includes('record_key: racedWinner') && dbSrc.includes('markKeySaved(racedWinner)'))
is('S8c', 'the save tells the user plainly that the EXISTING record was updated',
   dbSrc.includes('no duplicate was created'))

/* 3. THE DATABASE HALF — the SQL text. */
is('S1', 'migrations/0041 exists and the paste-order README ships with the set',
   hash(migSrc) === hash(freshSrc)
     && existsSync(join(APP, 'supabase-v2', 'migrations', 'README.md'))
     && !existsSync(join(APP, 'supabase-v2', 'fresh-setup')))

const idxPatient = migSrc.slice(
  migSrc.indexOf('DROP INDEX IF EXISTS public.uniq_reports_patient_day'),
  migSrc.indexOf('DROP INDEX IF EXISTS public.uniq_reports_case_number_day'))
const idxCase = migSrc.slice(
  migSrc.indexOf('DROP INDEX IF EXISTS public.uniq_reports_case_number_day'),
  migSrc.indexOf('-- 3. THE REVIEW LIST'))
is('S2a', 'the patient-day index is partial: live FINAL rows only (drafts + deleted excluded)',
   /WHERE NOT is_draft/.test(idxPatient) && /deleted_at IS NULL/.test(idxPatient))
is('S2b', 'the patient-day index normalises the ID (lower/btrim) and the date (coalesce)',
   /lower\(btrim\(patient_id\)\)/.test(idxPatient) && /coalesce\(procedure_date/.test(idxPatient))
is('S3', 'the case-number index applies ONLY where patient_id is empty — the two identifiers never both judge a row',
   /btrim\(patient_id\) = ''/.test(idxCase))
is('S3b', 'the case-number index is scoped the same way (live final rows only)',
   /WHERE NOT is_draft/.test(idxCase) && /deleted_at IS NULL/.test(idxCase))
is('S4', 'NO name-based unique constraint — a name is not an identifier',
   !/UNIQUE INDEX[\s\S]{0,600}patient_name/.test(migSrc))
is('S5a', 'the review function is SECURITY INVOKER (no DEFINER) so RLS is never bypassed',
   !/SECURITY DEFINER/.test(migSrc))
is('S5b', 'the review function is revoked from anon/public and granted to authenticated only',
   /REVOKE ALL ON FUNCTION public\.ent_possible_duplicates\(\) FROM anon, public;/.test(migSrc)
     && /GRANT  EXECUTE ON FUNCTION public\.ent_possible_duplicates\(\) TO authenticated;/.test(migSrc))
{
  const fnBlock = migSrc.slice(migSrc.indexOf('ent_possible_duplicates()'), migSrc.indexOf('REVOKE ALL'))
  is('S5c', 'the review function has NO merge or delete power — it only SELECTs groups',
     /LANGUAGE sql/.test(fnBlock) && /HAVING count\(\*\) > 1/.test(fnBlock)
       && !/\bUPDATE\b|\bDELETE\b|\bINSERT\b/.test(fnBlock))
}


/* 4. THE ADMIN REVIEW CARD and the doctor-clinic provisioning rules. */
is('A1', 'admin.html carries the Possible-duplicates card',
   adminHtml.includes('id="adminDuplicates"') && adminHtml.includes('id="dupHint"'))
{
  const block = adminSrc.slice(adminSrc.indexOf('function renderDuplicates'), adminSrc.indexOf('async function loadUsage'))
  is('A2', 'the card reads the RPC and is READ-ONLY (no write verbs in its renderer)',
     adminSrc.includes('rpc/ent_possible_duplicates') && !/method:\s*'DELETE'|method:\s*'PATCH'/.test(block))
}
{
  const fn = authSrc.slice(authSrc.indexOf('function clinicNameForDoctor'), authSrc.indexOf('function clinicNameForDoctor') + 900)
  is('C1', 'a new doctor clinic is named with the FULL name: "ENT-clinic doc. <Full Name>"',
     authSrc.includes("('ENT-clinic doc. ' + bare).slice(0, 80)") && !/parts\[0\]/.test(fn))
}
is('C2', 'provisioning is idempotent — an existing clinic for this admin+code is ADOPTED, not re-created',
   /const \{ data: existing \} = await admin\(\)[\s\S]{0,200}\.from\('clinics'\)[\s\S]{0,200}\.eq\('managed_by', me\.id\)/.test(authSrc))
is('C3', 'a failed createUser or profile insert rolls the NEW clinic back (no orphans)',
   /clinicCreatedHere/.test(authSrc)
     && (authSrc.match(/if \(clinicCreatedHere\) \{\s*\n\s*await admin\(\)\.from\('clinics'\)\.delete\(\)/g) || []).length >= 2)

console.log('')
console.log(`==== ${failed === 0 ? 'ALL DUPLICATE-GUARD TESTS PASSED' : failed + ' FAILED'} · ${passed + failed} tests ====`)
console.log('')
console.log('NOTE: offline contracts only. The live 23505 behaviour and the')
console.log('review RPC against real RLS are proven by the post-deploy')
console.log('acceptance script once 0001→0041 are applied to the new project.')
process.exit(failed === 0 ? 0 : 1)

