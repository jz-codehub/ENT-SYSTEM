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
async function call(path, opts = {}) {
  const r = await fetch(BASE + path, { headers: { ...H, 'Content-Type': 'application/json' }, ...opts })
  const t = await r.text()
  let j = null
  try { j = JSON.parse(t) } catch { j = t }
  if (!r.ok) throw new Error(`${path} -> ${r.status}: ${String(t).slice(0, 200)}`)
  return j
}
// NEW staff by username, NEW clinics
const staff = await call('/rest/v1/staff_profiles?select=id,username,clinic_id')
const clinics = await call('/rest/v1/clinics?select=id,code,name')
console.log('NEW staff: ' + staff.length)
for (const s of staff) console.log('  ' + s.username + ' ' + s.id.slice(0, 8) + ' clinic=' + s.clinic_id.slice(0, 8))
console.log('NEW clinics: ' + clinics.length)
for (const c of clinics) console.log('  ' + c.id.slice(0, 8) + ' ' + c.code + ' ' + c.name)
// report columns in NEW project
const probe = await call('/rest/v1/reports?select=*&limit=1')
console.log('NEW reports cols: ' + Object.keys(probe[0] || { EMPTY: 1 }).join(','))
