import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const env = {}
const p = join(HERE, '..', 'supabase-v2', 'scripts', '.env.old-backup')
for (const line of readFileSync(p, 'utf8').split('\n')) {
  const m = /^\s*([^=]+?)\s*=\s*(.*?)\s*$/.exec(line)
  if (m) env[m[1].trim()] = m[2].trim()
}
const SVC = env.service_role_key || ''
const BASE = (env.url || '').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '')
console.log('project: ' + BASE.replace(/(https:\/\/)(.{4}).*(\.supabase\.co)/, '$1$2***$3'))
for (const t of ['clinics', 'staff_profiles', 'reports', 'report_photos', 'system_flags', 'activity_logs']) {
  try {
    const r = await fetch(`${BASE}/rest/v1/${t}?select=id&limit=1`, { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } })
    console.log(`  ${t.padEnd(16)} HTTP ${r.status}`)
  } catch (e) { console.log(`  ${t.padEnd(16)} ERR ${e.message.slice(0, 80)}`) }
}
try {
  const r = await fetch(`${BASE}/auth/v1/admin/users?page=1&per_page=1`, { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } })
  console.log(`  auth.users       HTTP ${r.status}`)
} catch (e) { console.log(`  auth.users       ERR ${e.message.slice(0, 80)}`) }
