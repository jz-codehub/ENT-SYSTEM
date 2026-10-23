/* temp/probe_storage.mjs — READ-ONLY Storage probe.
   Answers Part 3's "are the photos actually there, or only metadata?" without
   downloading a single object: it lists ONE key of the bucket (metadata only)
   and, separately, tries to fetch one object's bytes with a size cap so the
   answer is about ACCESSIBILITY, not egress.
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
const FE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1reXh0bGZhcG9pYm94ZXbreGR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3OTY1MzgsImV4cCI6MjEwNjM3MjUzOH0.klFFrccrgZBIQNzK_KM0AGpxdJFeKjxMuIjZOwFcgAY'

async function probe(ref, key, label) {
  console.log('')
  console.log('-'.repeat(72))
  console.log(`${ref} — ${label}`)
  console.log('-'.repeat(72))
  // 1. does the bucket exist at all?
  try {
    const r = await fetch(`https://${ref}.supabase.co/storage/v1/bucket`, { headers: { apikey: key, Authorization: `Bearer ${key}` } })
    const j = r.ok ? await r.json() : null
    console.log(`  GET /bucket            HTTP ${r.status} ${j ? '-> ' + JSON.stringify(j.map(b => ({ id: b.id, public: b.public }))) : ''}`)
  } catch (e) { console.log('  GET /bucket            FAILED ' + e.message) }

  // 2. list one object (metadata only)
  try {
    const r = await fetch(`https://${ref}.supabase.co/storage/v1/object/list/patient-photos`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 2, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
    })
    const t = await r.text()
    console.log(`  POST list              HTTP ${r.status} ${t.slice(0, 300)}`)
  } catch (e) { console.log('  POST list              FAILED ' + e.message) }

  // 3. search across folders (the bucket is keyed by clinic/report prefix)
  try {
    const r = await fetch(`https://${ref}.supabase.co/storage/v1/object/list/patient-photos`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 200, offset: 0, prefix: '', sortBy: { column: 'name', order: 'asc' } }),
    })
    const j = r.ok ? await r.json() : []
    const files = j.filter(x => x && x.id)
    console.log(`  list folders/files     ${Array.isArray(j) ? j.length : '?'} entries, ${files.length} file(s)`)
    if (files.length) console.log('    sample: ' + files.slice(0, 5).map(f => `${f.name} (${f.metadata?.size ?? '?'}B)`).join(', '))
  } catch (e) { console.log('  list folders/files     FAILED ' + e.message) }
}

await probe('mkyxtlfapoiboxepkxdz', FE_ANON, 'frontend project, anon (no grants — expected to be refused)')
await probe('bvzuraltazxtaxnmbmcr', env.SUPABASE_SERVICE_ROLE_KEY, '.env.local project, service_role')
