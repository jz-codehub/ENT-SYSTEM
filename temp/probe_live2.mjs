/* temp/probe_live2.mjs — READ-ONLY reachability/key-validity probe.
   Does not read patient data: every request asks for count only, with a
   limit of 0, so no row payload is ever transferred. temp/ is gitignored. */
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

const REFS = {
  'bvzuraltazxtaxnmbmcr': { label: '.env.local SUPABASE_URL ref', key: env.SUPABASE_SERVICE_ROLE_KEY },
  'mkyxtlfapoiboxepkxdz': {
    label: 'frontend supabaseClient.js ref',
    key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1reXh0bGZhcG9pYm94ZXBreGR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3OTY1MzgsImV4cCI6MjEwNjM3MjUzOH0.klFFrccrgZBIQNzK_KM0AGpxdJFeKjxMuIjZOwFcgAY',
  },
}

// HEAD-style count probe: Prefer: count=exact + Range 0-0 returns a
// Content-Range header with the total, and zero bytes of row data.
async function probe(ref, info) {
  const base = `https://${ref}.supabase.co`
  console.log('')
  console.log('-'.repeat(72))
  console.log(`${ref}   (${info.label})`)
  console.log('-'.repeat(72))
  if (!info.key) { console.log('  no key to try'); return }
  for (const table of ['clinics', 'staff_profiles', 'reports', 'report_photos']) {
    try {
      const r = await fetch(`${base}/rest/v1/${table}?select=id&limit=0`, {
        method: 'GET',
        headers: {
          apikey: info.key,
          Authorization: `Bearer ${info.key}`,
          Prefer: 'count=exact',
          Range: '0-0',
        },
      })
      const range = r.headers.get('content-range') || ''
      const body = r.ok ? '' : (await r.text()).slice(0, 120)
      console.log(`  ${table.padEnd(15)} HTTP ${r.status} ${range} ${body}`)
    } catch (e) {
      console.log(`  ${table.padEnd(15)} FETCH FAILED: ${e.message}`)
    }
  }
  // Storage bucket listing (metadata only, no object bytes)
  try {
    const r = await fetch(`${base}/storage/v1/object/list/patient-photos`, {
      method: 'POST',
      headers: { apikey: info.key, Authorization: `Bearer ${info.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 1, offset: 0 }),
    })
    console.log(`  storage bucket    HTTP ${r.status} ${r.ok ? '(reachable)' : (await r.text()).slice(0, 100)}`)
  } catch (e) { console.log(`  storage bucket    FETCH FAILED: ${e.message}`) }
  // Auth health
  try {
    const r = await fetch(`${base}/auth/v1/settings`, { headers: { apikey: info.key } })
    const j = r.ok ? await r.json() : null
    console.log(`  auth /settings    HTTP ${r.status} ${j ? '(reachable)' : (await r.text()).slice(0, 80)}`)
  } catch (e) { console.log(`  auth /settings    FETCH FAILED: ${e.message}`) }
}

for (const [ref, info] of Object.entries(REFS)) await probe(ref, info)
