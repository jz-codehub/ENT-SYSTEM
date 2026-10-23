import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const env = {}
for (const l of readFileSync(join(HERE, '..', 'supabase-v2', 'scripts', '.env.local'), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)
  if (m) env[m[1]] = m[2].trim()
}
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }
const BASE = env.SUPABASE_URL.replace(/\/+$/, '')
async function call(path, opts = {}) {
  const r = await fetch(BASE + path, { headers: H, ...opts })
  const t = await r.text()
  if (!r.ok) throw new Error(`${path} -> ${r.status}: ${String(t).slice(0, 300)}`)
  try { return JSON.parse(t) } catch { return t }
}
const BK = join(HERE, '..', 'supabase-v2', 'backup', 'v2-2026-10-11T23-44-19-717Z')
const oldStaff = JSON.parse(readFileSync(join(BK, 'staff_profiles.json'), 'utf8'))
const oldReports = JSON.parse(readFileSync(join(BK, 'reports.json'), 'utf8'))
const newStaff = await call('/rest/v1/staff_profiles?select=id,username')
// OLD username -> OLD id, NEW username -> NEW id
const oldByU = Object.fromEntries(oldStaff.map(s => [s.username, s.id]))
const newByU = Object.fromEntries(newStaff.map(s => [s.username, s.id]))
// OLD id -> NEW id via username
const idMap = {}
for (const [u, oid] of Object.entries(oldByU)) if (newByU[u]) idMap[oid] = newByU[u]
console.log('id remap entries: ' + Object.keys(idMap).length)
// NEW reports cols: probe
const cols = await call('/rest/v1/reports?select=*&limit=1').catch(() => [])
console.log('target empty, proceeding with insert')
let ok = 0, fail = 0
const fails = []
for (const r of oldReports) {
  const row = { ...r }
  if (row.doctor_id && idMap[row.doctor_id]) row.doctor_id = idMap[row.doctor_id]
  if (row.created_by && idMap[row.created_by]) row.created_by = idMap[row.created_by]
  // created_by_name: keep original
  try {
    await call('/rest/v1/reports?on_conflict=id', { method: 'POST', body: JSON.stringify(row) })
    ok++
  } catch (e) { fail++; if (fails.length < 5) fails.push(r.id.slice(0, 8) + ': ' + e.message.slice(0, 120)) }
  if ((ok + fail) % 50 === 0) console.log(`  ... ${ok + fail}/${oldReports.length} (ok=${ok} fail=${fail})`)
}
console.log(`REPORTS DONE: ok=${ok} fail=${fail}`)
for (const f of fails) console.log('  FAIL ' + f)
