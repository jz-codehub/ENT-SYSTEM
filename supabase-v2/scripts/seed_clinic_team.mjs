/* =====================================================================
 *  seed_clinic_team.mjs - two real-looking clinics, six named staff.
 * ---------------------------------------------------------------------
 *  Why this exists.
 *
 *  RLS on tickets is scoped per clinic, and a single-clinic fixture cannot
 *  show that scoping working. It also cannot answer the question a secretary
 *  actually has, which is "did the administrator reply to ME" - so the
 *  second clinic is the point, not decoration.
 *
 *    Clinic A   ENT Manila - Dr. Jess Ramos     jess, tara, kaye, gina
 *    Clinic B   ENT Quezon - Dr. Monique Cruz    monique, lian
 *
 *  Three doctors and three secretaries, each secretary attached to a doctor
 *  in the SAME clinic, because staff_secretary_requires_doctor refuses a
 *  secretary without one and will not accept a doctor from another clinic.
 *
 *  Clinic names carry ENT and the doctor, because that is how the two would
 *  be told apart at a glance in a queue.
 *
 *  One ticket is filed per person and one of them is answered, so "Your
 *  tickets" and "Needs you" have something real to show on first login
 *  instead of an empty state nobody can screenshot.
 *
 *  Idempotent: run it twice and the second run only repairs.
 *  NEEDS THE SERVICE-ROLE KEY (.env.local, git-ignored). That key bypasses
 *  RLS and must never reach a browser or a URL.
 *
 *      node seed_clinic_team.mjs
 *      node seed_clinic_team.mjs --dry
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
const BASE = String(env.SUPABASE_URL || '').replace(/\/+$/, '')
const SVC = env.SUPABASE_SERVICE_ROLE_KEY
const ANON = env.SUPABASE_ANON_KEY
const EMAIL_DOMAIN = 'zztest.invalid'
const H = { apikey: SVC, Authorization: 'Bearer ' + SVC, 'Content-Type': 'application/json' }
const DRY = process.argv.includes('--dry')

if (!BASE || !SVC) {
  console.error('  SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (.env.local)')
  process.exit(1)
}

let failed = 0
const ok = (s) => console.log('  ok   ' + s)
const bad = (s) => { failed++; console.log('  FAIL ' + s) }

async function call(path, { method = 'GET', body, prefer } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...H, ...(prefer ? { prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  })
  const text = await r.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  if (!r.ok) {
    const msg = (json && (json.msg || json.message || json.error_description)) || String(text).slice(0, 200)
    const e = new Error(`${method} ${path} -> ${r.status}: ${msg}`)
    e.status = r.status
    throw e
  }
  return json
}
/* ------------------------------------------------------------------ */
/*  The plan - everything asked for, in one readable table.            */
/* ------------------------------------------------------------------ */
const CLINICS = [
  {
    code: 'main_clinic',
    name: 'ENT Manila - Dr. Jess Ramos',
    address: '123 Tomas Mapua St, Manila',
    staff: [
      { username: 'jess',    fullName: 'Jess Ramos',      role: 'doctor',    pw: 'jess123' },
      { username: 'tara',    fullName: 'Tara Bautista',   role: 'secretary', pw: 'tara123', to: 'jess' },
      { username: 'kaye',    fullName: 'Kaye Villanueva', role: 'doctor',    pw: 'kaye123' },
      { username: 'gina',    fullName: 'Gina Mercado',    role: 'secretary', pw: 'gina123', to: 'jess' },
    ],
  },
  {
    code: 'satellite_clinic',
    name: 'ENT Quezon - Dr. Monique Cruz',
    address: '45 North Avenue, Quezon City',
    staff: [
      { username: 'monique', fullName: 'Monique Cruz',    role: 'doctor',    pw: 'monique123' },
      { username: 'lian',    fullName: 'Lian Santiago',   role: 'secretary', pw: 'lian123', to: 'monique' },
    ],
  },
]

/* One ticket each so every account opens to something real. Clinic A's
   admin answers Tara's, which lights up "New reply" for Tara and "Needs
   you" for the admin from the same row - both halves of the notification
   proven by one insert. */
const TICKETS = [
  { by: 'tara',    scope: 'nasal',     category: 'bug',      priority: 'high',
    subject: 'Patient list will not load on the CF4 tab',
    body: 'I open the CF4 form for a new patient and the list of previous patients is empty. Refreshing does nothing. It worked on Monday.',
    adminReplies: true },
  { by: 'jess',    scope: 'laryngeal', category: 'question', priority: 'normal',
    subject: 'Can I file a report for a patient I saw last week?',
    body: 'A patient came back yesterday about their laryngeal result but is no longer on the active list. Should I still use this form?',
    adminReplies: false },
  { by: 'kaye',    scope: 'system',    category: 'access',   priority: 'urgent',
    subject: 'Signed out every time I open the app',
    body: 'I sign in, and about ten seconds later the app returns me to the login page. It happens on every device.',
    adminReplies: false },
  { by: 'gina',    scope: 'nasal',     category: 'other',    priority: 'low',
    subject: 'Where did the old patient photos go?',
    body: 'The photos we uploaded last month are not showing on the patient page any more. Are they deleted?',
    adminReplies: false },
  { by: 'lian',    scope: 'cf4',       category: 'data',     priority: 'normal',
    subject: 'PhilHealth number will not save',
    body: 'I type the PhilHealth number and click next, but when I come back it is blank again. The rest of the form saves fine.',
    adminReplies: true },
  { by: 'monique', scope: 'laryngeal', category: 'bug',      priority: 'high',
    subject: 'Laryngeal report prints without the patient name',
    body: 'The printed report has an empty header. On screen the name is there, but the PDF leaves it out.',
    adminReplies: false },
]

async function ensureClinic(c) {
  const existing = await call('/rest/v1/clinics?code=eq.' + encodeURIComponent(c.code) + '&select=id,code,name')
  const row = Array.isArray(existing) ? existing[0] : null
  if (DRY) return row ? row.id : '(would create ' + c.code + ')'
  if (row) {
    // Rename only when it differs, so re-running stays quiet and the
    // updated_at trigger does not fire every time.
    if (row.name !== c.name) {
      await call('/rest/v1/clinics?id=eq.' + row.id, {
        method: 'PATCH', body: { name: c.name, address: c.address },
      })
    }
    return row.id
  }
  const made = await call('/rest/v1/clinics', {
    method: 'POST', prefer: 'return=representation',
    body: { code: c.code, name: c.name, address: c.address, is_active: true },
  })
  return (Array.isArray(made) ? made[0] : made).id
}

async function ensureStaff(spec, clinicId, byUsername) {
  const email = spec.username.toLowerCase() + '@' + EMAIL_DOMAIN
  const list = await call('/auth/v1/admin/users?page=1&per_page=1000')
  const all = Array.isArray(list) ? list : (list.users || [])
  let user = all.find(u => String(u.email || '').toLowerCase() === email)

  if (!user) {
    user = await call('/auth/v1/admin/users', {
      method: 'POST',
      body: {
        email, password: spec.pw, email_confirm: true,
        user_metadata: { username: spec.username, full_name: spec.fullName },
        app_metadata: { role: spec.role },
      },
    })
  } else {
    // Repair the password, so the credentials printed at the end really work.
    // A test account that cannot sign in is worse than no account.
    await call('/auth/v1/admin/users/' + user.id, {
      method: 'PUT', body: { password: spec.pw, email_confirm: true },
    })
  }

  let assignedId = null
  if (spec.role === 'secretary') {
    const doc = byUsername.get(spec.to)
    if (!doc) throw new Error('no doctor named "' + spec.to + '" yet - create them first')
    assignedId = doc.id
  }

  await call('/rest/v1/staff_profiles', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: [{
      id: user.id,
      clinic_id: clinicId,
      username: spec.username,
      full_name: spec.fullName,
      role: spec.role,
      assigned_doctor_id: assignedId,
      specialty: spec.role === 'doctor' ? 'ENT' : '',
      license_no: '', email: '', phone: '',
      is_active: true,
      must_change_password: false,
    }],
  })

  byUsername.set(spec.username, {
    id: user.id, role: spec.role, clinicId,
    fullName: spec.fullName, pw: spec.pw,
  })
  return user.id
}

/** A ticket plus its opening message - exactly the two writes the browser makes. */
async function ensureTicket(t, reporter, admin) {
  const dupe = await call('/rest/v1/tickets?select=id&subject=eq.' + encodeURIComponent(t.subject))
  if (Array.isArray(dupe) && dupe.length) return null

  const made = await call('/rest/v1/tickets', {
    method: 'POST', prefer: 'return=representation',
    body: [{
      clinic_id: reporter.clinicId,
      created_by: reporter.id,
      subject: t.subject,
      scope: t.scope,
      category: t.category,
      priority: t.priority,
      status: 'open',
    }],
  })
  const ticket = Array.isArray(made) ? made[0] : made
  if (!ticket || !ticket.id) return null

  await call('/rest/v1/ticket_messages', {
    method: 'POST',
    body: [{ ticket_id: ticket.id, author_id: reporter.id, author_role: reporter.role, body: t.body }],
  })

  if (t.adminReplies && admin) {
    await call('/rest/v1/ticket_messages', {
      method: 'POST',
      body: [{
        ticket_id: ticket.id,
        author_id: admin.id,
        author_role: 'admin',
        body: 'Thank you for reporting this - I can see it now. I am looking into it today and will reply here once it is fixed. If it is blocking your clinic, mark it Urgent so it moves up.',
      }],
    })
  }
  return ticket.id
}

/* ------------------------------------------------------------------ */

console.log('\n=============== CLINIC TEAM SEED ===============\n')

const clinicIds = {}
const byUsername = new Map()

if (DRY) {
  console.log('  --dry run: nothing will be written\n')
  for (const c of CLINICS) {
    console.log('  [' + c.code + ']  ' + c.name)
    for (const s of c.staff) {
      console.log('      ' + s.role.padEnd(10) + s.username.padEnd(11) + s.fullName.padEnd(19) +
        (s.to ? 'works for ' + s.to : ''))
    }
  }
  console.log('\n  ' + TICKETS.length + ' tickets, ' +
    TICKETS.filter(t => t.adminReplies).length + ' of them answered by an admin\n')
} else {
  for (const c of CLINICS) {
    clinicIds[c.code] = await ensureClinic(c)
    ok('clinic  ' + c.code.padEnd(18) + c.name)
  }

  for (const c of CLINICS) {
    for (const s of c.staff) {
      try {
        await ensureStaff(s, clinicIds[c.code], byUsername)
        ok('staff   ' + s.username.padEnd(11) + s.role.padEnd(10) + s.fullName.padEnd(19) +
          (s.to ? 'works for ' + s.to : ''))
      } catch (e) {
        bad('staff   ' + s.username.padEnd(11) + e.message)
      }
    }
  }

  // An admin for clinic A, so one ticket can be answered and its reporter
  // gets a real "New reply".
  const admins = await call('/rest/v1/staff_profiles?role=eq.admin&select=id,username,clinic_id')
  const adminList = Array.isArray(admins) ? admins : []
  const adminOfA = adminList.find(a => a.clinic_id === clinicIds.main_clinic) || adminList[0] || null

  let made = 0
  for (const t of TICKETS) {
    const who = byUsername.get(t.by)
    if (!who) { bad('ticket  ' + t.by + ' has no account'); continue }
    try {
      const id = await ensureTicket(t, who, t.adminReplies ? adminOfA : null)
      if (id) { made++; ok('ticket  ' + t.by.padEnd(11) + t.subject) }
      else ok('ticket  ' + t.by.padEnd(11) + t.subject.slice(0, 46) + '  (already filed)')
    } catch (e) {
      bad('ticket  ' + t.by.padEnd(11) + e.message)
    }
  }

  // Prove the passwords: a printed credential that does not sign in is worse
  // than no credential.
  let verified = 0
  for (const spec of CLINICS.flatMap(c => c.staff)) {
    if (!byUsername.get(spec.username)) continue
    const r = await fetch(BASE + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: spec.username + '@' + EMAIL_DOMAIN, password: spec.pw }),
      signal: AbortSignal.timeout(15000),
    })
    const j = await r.json().catch(() => ({}))
    if (j.access_token) verified++
    else bad('signin ' + spec.username.padEnd(11) + (j.msg || j.error_description || ('HTTP ' + r.status)))
  }
  console.log('')
  ok(verified + ' of ' + byUsername.size + ' accounts signed in with the password shown below')
  console.log('  ' + made + ' new ticket(s) filed this run')
}

console.log('\n  --------------- SIGN IN WITH ---------------')
for (const c of CLINICS) {
  console.log('  [' + c.name + ']')
  for (const s of c.staff) {
    console.log('      ' + (s.username + '@' + EMAIL_DOMAIN).padEnd(26) + s.pw.padEnd(13) + s.role)
  }
}
console.log('  --------------------------------------------\n')

process.exitCode = failed ? 1 : 0