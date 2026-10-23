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
for (const t of ['clinics', 'staff_profiles']) {
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/' + t + '?select=*&limit=10', { headers: H })
  const j = await r.json()
  console.log('NEW ' + t + ': ' + j.length)
  for (const x of j) console.log('  ' + JSON.stringify(x).slice(0, 220))
}
