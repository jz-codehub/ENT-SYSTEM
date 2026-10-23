/* =====================================================================
 *  create_test_accounts.mjs — provision SYNTHETIC test accounts.
 * ---------------------------------------------------------------------
 *  auth.users rows cannot be created from plain SQL (GoTrue owns the
 *  password hash), which is why this exists.
 *
 *  Every account here is fake, and every address uses .zztest.invalid, a
 *  domain that can never receive mail. No real username, no real password,
 *  no real patient.
 *
 *  Usage:
 *      cd supabase-v2/scripts
 *      create .env.local with SUPABASE_URL + the two keys, then fill in
 *      node create_test_accounts.mjs            # create / repair
 *      node create_test_accounts.mjs --rotate   # force new passwords
 *      node create_test_accounts.mjs --teardown # delete everything
 *
 *  Needs the SERVICE-ROLE key. That key bypasses RLS, so it must never
 *  appear in the frontend, in a URL, or in git. .env.local is git-ignored.
 * ===================================================================== */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const rotate = process.argv.includes('--rotate')
const teardown = process.argv.includes('--teardown')

function loadEnv(file) {
  const path = join(HERE, file)
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}
const env = { ...loadEnv('.env.local'), ...process.env }
const URL_BASE = (env.SUPABASE_URL || '').replace(/\/+$/, '')
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!URL_BASE || !SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.')
  console.error('Create supabase-v2/scripts/.env.local with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY for the target project, then run again.')
  process.exit(1)
}
const HEADERS = {
  apikey: SERVICE_KEY,
  authorization: `Bearer ${SERVICE_KEY}`,
  'content-type': 'application/json',
}

/* ------------------------------------------------------------------ */
/*  The synthetic roster                                               */
/* ------------------------------------------------------------------ */
/*  The shape is deliberate:
 *    · two doctors in main_clinic     → report lists, secretary scoping
 *    · one secretary in main_clinic   → the doctorFilter() replacement
 *    · one admin in main_clinic       → the management UI
 *  The satellite_clinic roster (zzbadmin/zcbdoc1) was removed together
 *  with the satellite_clinic row in 0002_clinics.sql - both were test
 *  data. Re-create a second clinic by hand, in a throwaway test project
 *  only, before running any ISO-* cross-clinic test.
 *  Passwords are generated per run and printed once — never committed.
 */
const ROSTER = [
  { username: 'testadmin', full_name: 'SYNTHETIC Test Admin', role: 'admin', clinic: 'main_clinic', license_no: 'ZZ-0001' },
  { username: 'testdoc1', full_name: 'SYNTHETIC Test Doctor One', role: 'doctor', clinic: 'main_clinic', specialty: 'ENT', license_no: 'ZZ-1001' },
  { username: 'testdoc2', full_name: 'SYNTHETIC Test Doctor Two', role: 'doctor', clinic: 'main_clinic', specialty: 'ENT', license_no: 'ZZ-1002' },
  { username: 'testsec1', full_name: 'SYNTHETIC Test Secretary', role: 'secretary', clinic: 'main_clinic', assigned_to: 'testdoc1' },
]

/** A password that satisfies any reasonable policy, minus lookalikes. */
function testPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(14)
  let out = ''
  for (let i = 0; i < 14; i++) out += alphabet[bytes[i] % alphabet.length]
  return `Zz!${out}`
}
/** Deterministic, unroutable, obviously synthetic. */
const emailFor = (username) => `${username}@zztest.invalid`

/* ------------------------------------------------------------------ */
/*  Minimal clients                                                    */
/* ------------------------------------------------------------------ */
async function call(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(URL_BASE + path, {
    method,
    headers: { ...HEADERS, ...(prefer ? { prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* plain-text error body */ }
  if (!res.ok) {
    const detail = json?.message || json?.error_description || text.slice(0, 200)
    const err = new Error(`${method} ${path} -> ${res.status}: ${detail}`)
    err.status = res.status
    err.body = json
    throw err
  }
  return json
}

async function findUserByEmail(email) {
  // GoTrue's admin API has no "lookup by email" route, so page through.
  // A test project fits on one page; loop anyway so a populated project
  // still resolves instead of silently creating a duplicate-ish account.
  for (let page = 1; page <= 20; page++) {
    const users = await call(`/auth/v1/admin/users?page=${page}&per_page=200`)
    const list = Array.isArray(users) ? users : (users?.users || [])
    const hit = list.find(u => (u.email || '').toLowerCase() === email.toLowerCase())
    if (hit) return hit
    if (list.length < 200) return null
  }
  return null
}

async function clinicIdByCode(code) {
  const rows = await call(`/rest/v1/clinics?code=eq.${encodeURIComponent(code)}&select=id`)
  if (!Array.isArray(rows) || !rows.length) throw new Error(`clinic '${code}' missing - run 0002_clinics.sql`)
  return rows[0].id
}

/* ------------------------------------------------------------------ */
/*  Teardown                                                           */
/* ------------------------------------------------------------------ */
async function runTeardown() {
  console.log('\nTEARDOWN - removing synthetic accounts\n')
  for (const acc of ROSTER) {
    const user = await findUserByEmail(emailFor(acc.username))
    if (!user) { console.log(`  --  ${acc.username.padEnd(11)} not present`); continue }
    // Deleting the auth.users row cascades to staff_profiles (ON DELETE
    // CASCADE in 0003), so no profile can be orphaned.
    await call(`/auth/v1/admin/users/${user.id}`, { method: 'DELETE' })
    console.log(`  ok  ${acc.username.padEnd(11)} auth.users row deleted (profile cascaded)`)
  }
  console.log('\n  Synthetic REPORTS are NOT touched. Remove them with:')
  console.log("    delete from public.reports where patient_id like 'ZZTEST-%';\n")
}

/* ------------------------------------------------------------------ */
/*  One account                                                        */
/* ------------------------------------------------------------------ */
const created = []
const failed = []

async function ensureAccount(acc) {
  const email = emailFor(acc.username)
  const clinicId = await clinicIdByCode(acc.clinic)

  // 1. auth.users ----------------------------------------------------
  let user = await findUserByEmail(email)
  if (user && rotate) {
    await call(`/auth/v1/admin/users/${user.id}`,
      { method: 'PUT', body: { password: testPassword() } })
    user = await findUserByEmail(email)
  }
  if (!user) {
    const password = testPassword()
    try {
      user = await call('/auth/v1/admin/users', {
        method: 'POST',
        body: {
          email,
          password,
          email_confirm: true,        // there is no mailbox to click
          app_metadata: { role: acc.role, clinic_code: acc.clinic },
          user_metadata: { username: acc.username, synthetic: true },
        },
      })
      created.push({ ...acc, password })
    } catch (e) {
      // A row left by a half-finished previous run still counts as
      // existing — resolve it instead of failing the whole batch.
      if (e.status === 422 && /exist/i.test(e.message)) user = await findUserByEmail(email)
      if (!user) throw e
    }
  } else {
    created.push({ ...acc, password: '(unchanged - use --rotate)' })
  }
  if (!user?.id) throw new Error(`no auth.users row for ${acc.username}`)

  // 2. staff_profiles -------------------------------------------------
  // Role and clinic membership live HERE, never in JWT metadata: the
  // claims written above are informational only and requireAdmin() re-reads
  // this row on every request, so a demotion takes effect immediately.
  const assigned = acc.assigned_to
    ? (await call(`/rest/v1/staff_profiles?username=eq.${acc.assigned_to}&select=id`))[0]?.id
    : null
  if (acc.assigned_to && !assigned) throw new Error(`${acc.assigned_to} must exist before ${acc.username} can point at it`)

  await call('/rest/v1/staff_profiles', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: [{
      id: user.id,
      clinic_id: clinicId,
      username: acc.username,
      full_name: acc.full_name,
      role: acc.role,
      assigned_doctor_id: assigned,
      specialty: acc.specialty || '',
      license_no: acc.license_no || '',
      email: '',                    // a fake account gets no mailbox
      is_active: true,
      must_change_password: true,   // exercises the forced-change path
    }],
  })
  console.log(`  ok  ${acc.username.padEnd(11)} ${acc.role.padEnd(10)} @ ${acc.clinic}`)
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */
async function main() {
  if (teardown) return runTeardown()

  console.log('\n==== CREATE TEST ACCOUNTS (synthetic only) ====')
  console.log(`  project : ${URL_BASE}`)
  console.log(`  rotate  : ${rotate ? 'yes - existing passwords will be replaced' : 'no'}\n`)

  // Order matters: staff_secretary_requires_doctor means a secretary's
  // doctor must already exist when she is written.
  const ordered = [...ROSTER].sort((a, b) =>
    (a.role === 'secretary' ? 1 : 0) - (b.role === 'secretary' ? 1 : 0))

  for (const acc of ordered) {
    try { await ensureAccount(acc) }
    catch (e) { failed.push({ acc, e }); console.log(`  FAIL ${acc.username.padEnd(11)} ${e.message}`) }
  }

  console.log('\n  Accounts (TEST ONLY - never reuse a real credential):')
  for (const c of created) {
    console.log(`    ${c.username.padEnd(11)} ${String(c.password).padEnd(32)} ${c.role} @ ${c.clinic}`)
  }
  if (failed.length) {
    console.log(`\n  ${failed.length} account(s) failed - fix and re-run, this is idempotent.\n`)
    process.exitCode = 1
    return
  }
  console.log('\n  Next: run docs/06-TEST-PLAN.md against this test project.')
  console.log('  That printed password is the only place it is written down.\n')
}
await main()


