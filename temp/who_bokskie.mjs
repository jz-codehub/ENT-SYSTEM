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
const r = await fetch(BASE + '/rest/v1/staff_profiles?username=eq.bokskie&select=id,username', { headers: H })
console.log('bokskie rows: ' + JSON.stringify(await r.json()))
const r2 = await fetch(BASE + '/auth/v1/admin/users?page=1&per_page=100', { headers: H })
const j2 = await r2.json()
console.log('auth count: ' + (j2.users || []).length)
for (const u of (j2.users || [])) console.log('  ' + u.id + ' ' + u.email)
