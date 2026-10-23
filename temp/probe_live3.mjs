/* temp/probe_live3.mjs — READ-ONLY.
   a) decode the `ref` claim out of each key's JWT payload (no secret printed,
      only the project reference the key was minted for);
   b) read TRUE row totals per table via Content-Range (no row payload is
      transferred: Range 0-0 asks for at most one row, and only the count
      header is reported here).
   temp/ is gitignored. */
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
const FE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1reXh0bGZhcG9pYm94ZXBreGR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3OTY1MzgsImV4cCI6MjEwNjM3MjUzOH0.klFFrccrgZBIQNzK_KM0AGpxdJFeKjxMuIjZOwFcgAY'

const refOf = (jwt) => {
  try {
    const p = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))
    return { ref: p.ref, role: p.role }
  } catch { return { ref: '(undecodable)', role: '?' } }
}

const KEYS = [
  ['.env.local  SUPABASE_ANON_KEY        ', env.SUPABASE_ANON_KEY],
  ['.env.local  SUPABASE_SERVICE_ROLE_KEY', env.SUPABASE_SERVICE_ROLE_KEY],
  ['supabaseClient.js ANON_KEY (frontend) ', FE_ANON],
]

console.log('=== which project was each key minted for? (ref claim only) ===')
for (const [label, k] of KEYS) {
  if (!k) { console.log(`  ${label} : absent`); continue }
  const { ref, role } = refOf(k)
  console.log(`  ${label} : ref=${ref}  role=${role}`)
}
console.log(`\n  .env.local SUPABASE_URL ref  : ${(env.SUPABASE_URL || '').replace(/\/+$/, '').replace('https://', '').split('.')[0]}`)
console.log(`  supabaseClient.js PROJECT_REF: mkyxtlfapoiboxepkxdz`)

// True totals. Range 0-0 + count=exact gives "0-0/TOTAL" without shipping rows.
async function counts(ref, key, label) {
  console.log('')
  console.log('='.repeat(74))
  console.log(`${ref}   with ${label}`)
  console.log('='.repeat(74))
  if (!key) { console.log('  no key'); return }
  for (const t of ['clinics', 'staff_profiles', 'reports', 'report_photos', 'activity_logs', 'report_access_grants', 'secretary_assignments', 'tickets']) {
    try {
      const r = await fetch(`https://${ref}.supabase.co/rest/v1/${t}?select=%2A&limit=1`, {
        headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact', Range: '0-0' },
      })
      const cr = r.headers.get('content-range') || ''
      const total = cr.includes('/') ? cr.split('/')[1] : ''
      console.log(`  ${t.padEnd(22)} HTTP ${r.status}  total=${total || '-'} ${r.ok ? '' : (await r.text()).slice(0, 90)}`)
    } catch (e) { console.log(`  ${t.padEnd(22)} FETCH FAILED ${e.message}`) }
  }
}

await counts('bvzuraltazxtaxnmbmcr', env.SUPABASE_SERVICE_ROLE_KEY, 'SERVICE ROLE (from .env.local)')
await counts('bvzuraltazxtaxnmbmcr', env.SUPABASE_ANON_KEY, 'ANON (from .env.local)')
await counts('mkyxtlfapoiboxepkxdz', FE_ANON, 'ANON (from supabaseClient.js)')
await counts('mkyxtlfapoiboxepkxdz', env.SUPABASE_SERVICE_ROLE_KEY, '.env.local SERVICE ROLE (mismatched project?)')
