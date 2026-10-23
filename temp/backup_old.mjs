import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const env = {}
for (const line of readFileSync(join(HERE, '..', 'supabase-v2', 'scripts', '.env.old-backup'), 'utf8').split('\n')) {
  const m = /^\s*([^=]+?)\s*=\s*(.*?)\s*$/.exec(line)
  if (m) env[m[1].trim()] = m[2].trim()
}
const SVC = env.service_role_key || ''
const BASE = (env.url || '').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '')
const TABLES = ['clinics', 'staff_profiles', 'reports', 'report_photos', 'activity_logs', 'user_presence', 'system_flags', 'clinic_settings']
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const OUT = join(HERE, '..', 'supabase-v2', 'backup', `v2-${stamp}`)
mkdirSync(OUT, { recursive: true })
async function rows(table) {
  const slimReports = table === 'reports' && !process.argv.includes('--with-payload')
  const cols = slimReports
    ? 'id,clinic_id,doctor_id,created_by,record_key,report_type,is_draft,patient_name,patient_id,case_number,procedure_date,file_name,photo_count,created_at,updated_at,saved_at' : '*'
  const all = []
  for (let from = 0; from < 20000; from += 1000) {
    const base = `${BASE}/rest/v1/${table}?select=${cols}&limit=1000&offset=${from}`
    let r = await fetch(`${base}&order=id.asc`, { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } })
    if (!r.ok) r = await fetch(base, { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } })
    if (!r.ok) return { error: `HTTP ${r.status} ${(await r.text()).slice(0, 80)}`, rows: all }
    const j = await r.json()
    if (!Array.isArray(j) || j.length === 0) break
    all.push(...j)
    if (j.length < 1000) break
  }
  return { rows: all }
}
console.log('==== OLD PROJECT BACKUP ====')
console.log('project : ' + BASE.replace(/(https:\/\/)(.{4}).*(\.supabase\.co)/, '$1$2***$3'))
console.log('to      : ' + OUT)
const manifest = { taken_at: new Date().toISOString(), project: BASE, tables: {} }
for (const t of TABLES) {
  const { rows: data, error } = await rows(t)
  if (error) { console.log(`  SKIP  ${t.padEnd(18)} ${error}`); manifest.tables[t] = { error }; continue }
  writeFileSync(join(OUT, `${t}.json`), JSON.stringify(data, null, 2))
  manifest.tables[t] = { rows: data.length }
  console.log(`  ok    ${t.padEnd(18)} ${String(data.length).padStart(5)} row(s) -> ${t}.json`)
}
let authUsers = []
try {
  for (let page = 1; page < 200; page++) {
    const r = await fetch(`${BASE}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } })
    if (!r.ok) { console.log(`  WARN  auth.users          HTTP ${r.status}`); break }
    const j = await r.json()
    const users = Array.isArray(j.users) ? j.users : []
    authUsers.push(...users)
    if (users.length < 1000) break
  }
  writeFileSync(join(OUT, 'auth_users.json'), JSON.stringify(authUsers, null, 2))
  manifest.tables['auth.users'] = { rows: authUsers.length }
  console.log(`  ok    auth.users          ${String(authUsers.length).padStart(5)} row(s) -> auth_users.json (SENSITIVE)`)
} catch (e) { console.log(`  WARN  auth.users          ${e.message}`) }
writeFileSync(join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2))
console.log('MANIFEST: ' + OUT)
