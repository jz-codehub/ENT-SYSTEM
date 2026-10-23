import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const env = {}
for (const l of readFileSync(join(HERE, '..', 'supabase-v2', 'scripts', '.env.local'), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)
  if (m) env[m[1]] = m[2].trim()
}
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY }
const BASE = env.SUPABASE_URL.replace(/\/+$/, '')
// 1. verify auth count
const r = await fetch(`${BASE}/auth/v1/admin/users?page=1&per_page=100`, { headers: H })
const j = await r.json()
console.log('NEW auth.users: ' + (j.users || []).length)
for (const u of (j.users || [])) console.log('  ' + u.email)
// 2. inspect clinic rows fully
const d = join(HERE, '..', 'supabase-v2', 'backup', 'v2-2026-10-11T23-44-19-717Z')
const clinics = JSON.parse(readFileSync(join(d, 'clinics.json'), 'utf8'))
console.log('=== CLINICS full ===')
for (const c of clinics) console.log(JSON.stringify(c))
// 3. one staff row full
const staff = JSON.parse(readFileSync(join(d, 'staff_profiles.json'), 'utf8'))
console.log('=== ONE STAFF ROW ===')
console.log(JSON.stringify(staff[0], null, 1).slice(0, 1500))
