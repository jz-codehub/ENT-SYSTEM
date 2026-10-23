/* =====================================================================
 *  make_account.mjs - provision real clinic accounts.
 * ---------------------------------------------------------------------
 *  The admin console normally does this through the auth-admin Edge
 *  Function, which holds the service-role key. This script exists for
 *  the cases the console cannot cover:
 *
 *    · bootstrapping the very first real accounts, before the console
 *      can be trusted to be reachable
 *    · the deployed auth-admin is still the OLD build, whose 10-character
 *      password rule refuses a 7-character password that GoTrue itself
 *      accepts happily (its floor is 6)
 *
 *  It uses the same service-role Admin API as create_test_accounts.mjs,
 *  so it writes auth.users + staff_profiles exactly the way the Edge
 *  Function does, and writes the same audit row.
 *
 *  IT NEEDS THE SERVICE-ROLE KEY. That key bypasses RLS entirely and must
 *  never reach a browser, a URL, or git. It is read from .env.local,
 *  which is git-ignored, and pre-publish.ps1 refuses to let it be pushed.
 *
 *  Usage:
 *    node make_account.mjs
 *      bokskie Bokskie admin     bokskie123
 *      jess     Jess   doctor    jess123
 *      tara     Tara   secretary  tara123 [assignedToUsername]
 *
 *    A secretary MUST name a doctor, or the database refuses it
 *    (staff_secretary_requires_doctor). Order matters: create the doctor
 *    first, and pass their username here.
 * ===================================================================== */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const env = {}
for (const line of readFileSync(join(HERE, '.env.local'), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const BASE = env.SUPABASE_URL.replace(/\/+$/, '')
const SVC = env.SUPABASE_SERVICE_ROLE_KEY
const MAIN_CLINIC = '00000000-0000-4000-8000-00000000c11c'
const EMAIL_DOMAIN = 'zztest.invalid'
const H = { apikey: SVC, Authorization: 'Bearer ' + SVC, 'Content-Type': 'application/json' }

if (!BASE || !SVC) { console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (.env.local).'); process.exit(1) }

async function call(path, { method = 'GET', body, prefer } = {}) {
  const r = await fetch(BASE + path, {
    method, headers: { ...H, ...(prefer ? { prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  })
  const text = await r.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  if (!r.ok) {
    const e = new Error(`${method} ${path} -> ${r.status}: ${(json && (json.msg || json.message || json.error_description)) || String(text).slice(0, 160)}`)
    e.status = r.status
    throw e
  }
  return json
}

async function findByEmail(email) {
  const list = await call('/auth/v1/admin/users?page=1&per_page=1000')
  const users = Array.isArray(list) ? list : (list.users || [])
  return users.find(u => String(u.email || '').toLowerCase() === email.toLowerCase()) || null
}
async function profileByUsername(username) {
  const rows = await call('/rest/v1/staff_profiles?username=eq.' + encodeURIComponent(username) + '&select=id,username,role,is_active,must_change_password')
  return Array.isArray(rows) ? rows[0] || null : null
}

/** Create (or repair) one account. Idempotent. */
async function ensure(spec) {
  const { username, fullName, role, password, assignTo } = spec
  const label = username.padEnd(11) + role.padEnd(10)

  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    console.log('  FAIL ' + label + 'username must be 3-32 chars: a-z 0-9 . _ -'); return null
  }
  if (!['admin', 'doctor', 'secretary'].includes(role)) {
    console.log('  FAIL ' + label + 'role must be admin, doctor or secretary'); return null
  }
  if (String(password || '').length < 6) {
    // GoTrue's own floor, proved live: 5 characters is HTTP 422.
    console.log('  FAIL ' + label + 'password must be at least 6 characters (GoTrue refuses shorter)'); return null
  }

  const email = username.toLowerCase() + '@' + EMAIL_DOMAIN
  let user = await findByEmail(email)
  let created = false

  if (user) {
    // Repair rather than fail: a half-finished earlier run must not block
    // the person being set up today.
    await call('/auth/v1/admin/users/' + user.id, { method: 'PUT', body: { password, email_confirm: true } })
    user = await findByEmail(email)
  } else {
    const r = await call('/auth/v1/admin/users', {
      method: 'POST',
      body: {
        email, password, email_confirm: true,
        user_metadata: { username, full_name: fullName },
        app_metadata: { role, clinic_code: 'main_clinic', clinic_id: MAIN_CLINIC },
      },
    })
    user = r
    created = true
  }
  if (!user || !user.id) { console.log('  FAIL ' + label + 'could not create the auth row'); return null }

  // The secretary link resolves by USERNAME, so the doctor must exist first.
  let assignedId = null
  if (role === 'secretary') {
    if (!assignTo) { console.log('  FAIL ' + label + 'a secretary needs a doctor (pass the username after the password)'); return null }
    const doc = await profileByUsername(assignTo)
    if (!doc) { console.log('  FAIL ' + label + 'no doctor named "' + assignTo + '" yet - create that account first'); return null }
    if (doc.role !== 'doctor') { console.log('  FAIL ' + label + '"' + assignTo + '" is a ' + doc.role + ', not a doctor'); return null }
    assignedId = doc.id
  }

  await call('/rest/v1/staff_profiles', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: [{
      id: user.id,
      clinic_id: MAIN_CLINIC,
      username,
      full_name: fullName,
      role,
      assigned_doctor_id: assignedId,
      specialty: role === 'doctor' ? 'ENT' : '',
      license_no: '',
      email: '',
      phone: '',
      is_active: true,
      // false, so the password works as given. A staff member who has to
      // invent a new one on first sign-in will be handed a weak one.
      must_change_password: false,
    }],
  })

  console.log('  ok   ' + label + (created ? 'created' : 'repaired') + '  ' + email +
    (assignedId ? '  -> works for ' + assignTo : ''))
  return { username, id: user.id, role, email }
}

/** Prove the password REALLY works, by signing in as them. */
async function verify(spec) {
  const r = await fetch(BASE + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: spec.email, password: spec.password }),
    signal: AbortSignal.timeout(20000),
  })
  const j = await r.json().catch(() => ({}))
  if (!j.access_token) return { ok: false, why: 'HTTP ' + r.status + ' ' + (j.msg || j.error_description || 'refused') }
  // And the profile must resolve to the role we asked for.
  const p = await fetch(BASE + '/rest/v1/staff_profiles?select=username,role,is_active&id=eq.' + j.user.id,
    { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + j.access_token } })
  const rows = await p.json().catch(() => [])
  const row = Array.isArray(rows) ? rows[0] : null
  return { ok: true, role: row && row.role, active: row && row.is_active }
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */
const argv = process.argv.slice(2)
const specs = []
for (let i = 0; i < argv.length; i += 4) {
  const [username, fullName, role, password, assignTo] = argv.slice(i, i + 5)
  if (!username || !role || !password) break
  specs.push({ username, fullName: fullName || username, role, password, assignTo })
}

if (!specs.length) {
  console.log('\n==== CREATE CLINIC ACCOUNTS ====\n')
  console.log('  One line per account:')
  console.log('    username  FullName  role  password  [assignedDoctorUsername]\n')
  console.log('    node make_account.mjs bokskie Bokskie admin bokskie123')
  console.log('    node make_account.mjs jess     Jess   doctor jess123')
  console.log('    node make_account.mjs tara     Tara   secretary tara123 jess\n')
  console.log('  Passwords must be at least 6 characters (GoTrue\'s own floor).')
  console.log('  A secretary must name a doctor, and that doctor must exist first.\n')
  process.exit(0)
}

console.log('\n==== CREATE CLINIC ACCOUNTS ====\n')
const made = []
for (const s of specs) {
  try {
    const r = await ensure(s)
    if (r) made.push({ ...r, password: s.password })
  } catch (e) {
    console.log('  FAIL ' + String(s.username).padEnd(11) + e.message.slice(0, 110))
  }
}

console.log('\n  ---- sign-in check (a password that was not proven is not done) ----\n')
let bad = 0
for (const m of made) {
  const v = await verify(m)
  if (v.ok && v.role === m.role) {
    console.log('  ok   ' + m.username.padEnd(11) + 'signs in as ' + v.role + '   (active=' + v.active + ')')
  } else {
    bad++
    console.log('  FAIL ' + m.username.padEnd(11) + (v.ok ? 'signed in but role=' + v.role : v.why))
  }
}

console.log('\n  ---- accounts ----\n')
for (const m of made) {
  console.log('  ' + m.username.padEnd(12) + m.role.padEnd(10) + m.email)
}
console.log('')
console.log(bad ? '  ' + bad + ' account(s) need attention' : '  all accounts created and verified')
console.log('')
process.exitCode = bad ? 1 : 0
