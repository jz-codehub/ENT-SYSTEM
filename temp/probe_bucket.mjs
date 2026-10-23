/* temp/probe_bucket.mjs — confirm the patient-photos storage bucket exists
   and is PRIVATE (public=false). Uses the service-role key from .env.local. */
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
const SVC = env.SUPABASE_SERVICE_ROLE_KEY || ''
const r = await fetch(`${BASE}/storage/v1/bucket`, {
  headers: { apikey: SVC, Authorization: `Bearer ${SVC}` },
})
const buckets = await r.json()
if (!Array.isArray(buckets) || !buckets.length) {
  console.log('❌ NO storage buckets found (patient-photos bucket missing)')
} else {
  for (const b of buckets) {
    const mb = b.file_size_limit ? `${Math.round(b.file_size_limit / 1024 / 1024)} MB` : 'default'
    console.log(`  ${b.id}  public=${b.public}  limit=${mb}  ${b.public ? '⚠️ PUBLIC' : '✅ private'}`)
  }
}
