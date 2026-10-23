/* temp/probe_old_usage.mjs — READ-ONLY usage snapshot of the OLD live
   project (mkyxtlfapoiboxepkxdz), for the free-plan sustainability
   report. Row totals via Content-Range (Range 0-0 = header only); the
   largest report payloads are sampled by octet_length only. Writes
   nothing, prints no key material. */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const env = {}
const envPath = join(HERE, '..', 'supabase-v2', 'scripts', '.env.local')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
}
const BASE = 'https://mkyxtlfapoiboxepkxdz.supabase.co'
const SVC = env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!SVC) { console.error('no service key'); process.exit(1) }
const H = { apikey: SVC, Authorization: `Bearer ${SVC}` }

console.log('OLD PROJECT USAGE SNAPSHOT (read-only)')
for (const t of ['clinics', 'staff_profiles', 'reports', 'report_photos', 'tickets', 'ticket_messages', 'activity_logs', 'report_access_grants', 'report_access_requests', 'secretary_assignments']) {
  try {
    const r = await fetch(`${BASE}/rest/v1/${t}?select=id&limit=1`, {
      headers: { ...H, Prefer: 'count=exact', Range: '0-0' }, method: 'GET',
    })
    const cr = r.headers.get('content-range')
    console.log(`  ${t.padEnd(24)} ${cr || `HTTP ${r.status}`}`)
  } catch (e) { console.log(`  ${t.padEnd(24)} ERR ${e.message}`) }
}

// payload weight: average octet_length of the newest 50 report payloads
try {
  const r = await fetch(`${BASE}/rest/v1/reports?select=payload&order=created_at.desc&limit=50`, { headers: H })
  const rows = await r.json()
  const sizes = (Array.isArray(rows) ? rows : []).map(x => JSON.stringify(x.payload || '').length)
  const avg = sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : 0
  const max = sizes.length ? Math.max(...sizes) : 0
  console.log(`  newest-50 payload avg ${(avg / 1024).toFixed(1)} KB, max ${(max / 1024).toFixed(1)} KB`)
} catch (e) { console.log(`  payload sample ERR ${e.message}`) }

try {
  const r = await fetch(`${BASE}/storage/v1/bucket`, { headers: H })
  console.log(`  storage buckets: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`)
} catch (e) { console.log(`  storage ERR ${e.message}`) }
