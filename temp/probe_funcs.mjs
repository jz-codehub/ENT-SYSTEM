/* temp/probe_funcs.mjs — re-probe the arg-taking RPCs with DUMMY args.
   A function that EXISTS but refuses (401/403/400 on bad args) proves it
   is deployed; only 404 / 42883 / PGRST202 means truly absent. */
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
const BASE = (env.SUPABASE_URL || '').replace(/\/+$/, '')
const ANON = env.SUPABASE_ANON_KEY || ''
const H = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }
const U = '00000000-0000-4000-8000-000000000000'

const FNS = [
  ['ent_is_my_doctor', { p_doctor: U }],
  ['ent_capability', { p_flag_key: 'photo_storage' }],
  ['ent_may_soft_delete', { p_clinic: U, p_doctor: U, p_id: U }],
]
for (const [name, body] of FNS) {
  const r = await fetch(`${BASE}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: H, body: JSON.stringify(body),
  })
  const txt = await r.text()
  let verdict
  if (r.status === 404 || txt.includes('42883') || txt.includes('PGRST202')) verdict = 'TRULY MISSING ❌'
  else if (r.status === 401 || r.status === 403 || txt.includes('42501')) verdict = 'EXISTS ✅ (refused anon = correct)'
  else verdict = `EXISTS ✅ (HTTP ${r.status}: ${txt.slice(0, 70)})`
  console.log(`  ${name.padEnd(24)} ${verdict}`)
}
