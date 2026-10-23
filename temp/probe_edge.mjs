/* temp/probe_edge.mjs — check the Edge Function under EVERY plausible name.
   A deployed function answers with OUR json; a missing one is 404. */
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

const NAMES = ['auth-admin', 'patient-photos', 'patient-photos-bundle', 'auth-admin-bundle']
for (const fn of NAMES) {
  const r = await fetch(`${BASE}/functions/v1/${fn}`, {
    method: 'POST', headers: H, body: JSON.stringify({ action: '__probe__' }),
  })
  const txt = await r.text()
  const live = !(r.status === 404 && /NOT_FOUND|not found/i.test(txt))
  console.log(`  ${fn.padEnd(22)} HTTP ${r.status}  ${live ? '✅ LIVE' : '❌ not found'}`)
}

