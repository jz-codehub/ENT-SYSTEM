import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENV_FILE = join(HERE, '.env.local')
const EMAIL_DOMAIN = 'zztest.invalid'
const APPLY = process.argv.includes('--apply')
const clinics = [
  {
    code: 'doc_vince',
    name: 'Doc Vince Clinic',
    username: 'vince',
    fullName: 'VINCENT MARK M. JARDIN, MD, DPBO-HNS, FPSO-HNS',
  },
  {
    code: 'doc_luspo',
    name: 'Doc Luspo Clinic',
    username: 'florita',
    fullName: 'FLORITA L. TE - LUSPO, MD',
  },
]

if (!APPLY) {
  console.log('Provisioning plan (no changes made):')
  for (const clinic of clinics) {
    console.log(`  ${clinic.code}: ${clinic.name} -> doctor ${clinic.username}`)
  }
  console.log('Run with --apply to create missing clinics and doctor accounts.')
  process.exit(0)
}

if (!existsSync(ENV_FILE)) {
  throw new Error('Missing supabase-v2/scripts/.env.local; no changes were made.')
}

const env = {}
for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
  const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, '')
}

const BASE = String(env.SUPABASE_URL || '').replace(/\/+$/, '')
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
const ANON_KEY = env.SUPABASE_ANON_KEY
if (!BASE || !SERVICE_KEY || !ANON_KEY) {
  throw new Error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_ANON_KEY are required.')
}

const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
}

async function request(path, { method = 'GET', body, prefer } = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: { ...headers, ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  })
  const text = await response.text()
  let result
  try {
    result = text ? JSON.parse(text) : null
  } catch {
    result = text
  }
  if (!response.ok) {
    const message = result && (result.msg || result.message || result.error_description)
    throw new Error(`${method} ${path} failed (${response.status}): ${message || String(text).slice(0, 180)}`)
  }
  return result
}

async function listAuthUsers() {
  const users = []
  for (let page = 1; page <= 100; page++) {
    const result = await request(`/auth/v1/admin/users?page=${page}&per_page=1000`)
    const batch = Array.isArray(result) ? result : result.users || []
    users.push(...batch)
    if (batch.length < 1000) return users
  }
  throw new Error('Stopped after 100,000 auth users; refusing incomplete account checks.')
}

async function profileFor(username) {
  const rows = await request(
    `/rest/v1/staff_profiles?username=eq.${encodeURIComponent(username)}` +
    '&select=id,username,full_name,role,clinic_id,is_active,must_change_password',
  )
  return Array.isArray(rows) ? rows[0] || null : null
}

async function clinicFor(code) {
  const rows = await request(
    `/rest/v1/clinics?code=eq.${encodeURIComponent(code)}` +
    '&select=id,code,name,is_active,managed_by',
  )
  return Array.isArray(rows) ? rows[0] || null : null
}

function temporaryPassword() {
  return randomBytes(24).toString('base64url')
}

async function verifySignIn(username, password, expectedProfile) {
  const response = await fetch(BASE + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${username}@${EMAIL_DOMAIN}`, password }),
    signal: AbortSignal.timeout(20000),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || !result.access_token || !result.user) {
    throw new Error(`Sign-in verification failed for ${username} (HTTP ${response.status}).`)
  }

  const rows = await request(
    `/rest/v1/staff_profiles?id=eq.${encodeURIComponent(result.user.id)}` +
    '&select=username,role,clinic_id,is_active,must_change_password',
  )
  const profile = Array.isArray(rows) ? rows[0] : null
  if (!profile || profile.username !== username || profile.role !== 'doctor' ||
      profile.clinic_id !== expectedProfile.clinic_id || profile.is_active !== true ||
      profile.must_change_password !== true) {
    throw new Error(`Profile verification failed for ${username}.`)
  }
}

async function inspectClinicRows() {
  const rows = []
  for (const clinic of clinics) {
    const existing = await clinicFor(clinic.code)
    if (existing) {
      if (existing.name !== clinic.name || existing.is_active !== true || existing.managed_by) {
        throw new Error(`Clinic code ${clinic.code} already exists with different ownership or settings; no accounts were changed.`)
      }
      rows.push({ ...clinic, id: existing.id, exists: true })
    } else {
      rows.push({ ...clinic, exists: false })
    }
  }

  return rows
}

async function createMissingClinicRows(rows) {
  const missing = rows.filter(row => !row.exists)
  if (missing.length) {
    const created = await request('/rest/v1/clinics', {
      method: 'POST',
      prefer: 'return=representation',
      body: missing.map(({ code, name }) => ({ code, name, address: '', is_active: true })),
    })
    const createdRows = Array.isArray(created) ? created : [created]
    for (const row of rows) {
      if (!row.exists) {
        const inserted = createdRows.find(item => item.code === row.code)
        if (!inserted || !inserted.id) throw new Error(`Could not confirm creation of clinic ${row.code}.`)
        row.id = inserted.id
      }
    }
  }
  return rows
}

async function preflightDoctors(clinicRows, authUsers) {
  for (const clinic of clinicRows) {
    const email = `${clinic.username}@${EMAIL_DOMAIN}`
    const profile = await profileFor(clinic.username)
    const user = authUsers.find(item => String(item.email || '').toLowerCase() === email)
    if (!profile && !user) continue
    if (!profile || !user || profile.id !== user.id) {
      throw new Error(`${clinic.username} has a partial account; refusing to overwrite or reset it.`)
    }
    if (!clinic.exists || profile.full_name !== clinic.fullName || profile.role !== 'doctor' ||
        profile.clinic_id !== clinic.id || profile.is_active !== true) {
      throw new Error(`${clinic.username} already exists with a different profile or clinic; no changes made.`)
    }
  }
}

async function ensureDoctor(clinic, authUsers) {
  const email = `${clinic.username}@${EMAIL_DOMAIN}`
  const profile = await profileFor(clinic.username)
  const user = authUsers.find(item => String(item.email || '').toLowerCase() === email)

  if (profile || user) {
    if (!profile || !user || profile.id !== user.id) {
      throw new Error(`${clinic.username} has a partial account; refusing to overwrite or reset it.`)
    }
    if (profile.full_name !== clinic.fullName || profile.role !== 'doctor' ||
        profile.clinic_id !== clinic.id || profile.is_active !== true) {
      throw new Error(`${clinic.username} already exists with a different profile or clinic; no changes made to that account.`)
    }
    console.log(`  unchanged  ${clinic.username} already belongs to ${clinic.code}`)
    return null
  }

  const password = temporaryPassword()
  const createdUser = await request('/auth/v1/admin/users', {
    method: 'POST',
    body: {
      email,
      password,
      email_confirm: true,
      user_metadata: { username: clinic.username, full_name: clinic.fullName },
      app_metadata: { role: 'doctor', clinic_id: clinic.id, clinic_code: clinic.code },
    },
  })
  if (!createdUser || !createdUser.id) throw new Error(`Auth did not return an id for ${clinic.username}.`)

  try {
    await request('/rest/v1/staff_profiles', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        id: createdUser.id,
        clinic_id: clinic.id,
        username: clinic.username,
        full_name: clinic.fullName,
        role: 'doctor',
        assigned_doctor_id: null,
        specialty: 'ENT',
        license_no: '',
        email: '',
        phone: '',
        is_active: true,
        must_change_password: true,
      },
    })
    await verifySignIn(clinic.username, password, { clinic_id: clinic.id })
  } catch (error) {
    try {
      await request(`/auth/v1/admin/users/${encodeURIComponent(createdUser.id)}`, { method: 'DELETE' })
    } catch (cleanupError) {
      throw new Error(`${error.message} Account cleanup also failed: ${cleanupError.message}`)
    }
    throw error
  }

  return { username: clinic.username, fullName: clinic.fullName, clinic: clinic.name, password }
}

console.log('Creating separate doctor clinics and accounts...')
const authUsers = await listAuthUsers()
const clinicRows = await inspectClinicRows()
await preflightDoctors(clinicRows, authUsers)
await createMissingClinicRows(clinicRows)
const credentials = []
for (const clinic of clinicRows) {
  const credential = await ensureDoctor(clinic, authUsers)
  if (credential) credentials.push(credential)
}

console.log('\nProvisioning complete. Give each doctor only their own temporary password:')
for (const credential of credentials) {
  console.log(`  ${credential.fullName}`)
  console.log(`    clinic: ${credential.clinic}`)
  console.log(`    username: ${credential.username}`)
  console.log(`    temporary password: ${credential.password}`)
}
if (!credentials.length) {
  console.log('No new passwords were generated; both accounts already existed unchanged.')
}
console.log('Both new accounts must change their password at first sign-in.')
