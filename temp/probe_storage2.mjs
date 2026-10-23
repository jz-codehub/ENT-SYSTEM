/* temp/probe_storage2.mjs — READ-ONLY Storage probe (correct payload shape).
   The Storage API requires `prefix` in the list body; without it every call
   answers 400 regardless of the bucket's contents, which is why probe_storage
   could not tell "empty" from "unknown". This walks the folder tree the way
   the patient-photos proxy keys it (clinic id / report id) and reports object
   counts and sizes from METADATA only — no object bytes are downloaded.
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

const list = async (ref, key, prefix) => {
  const r = await fetch(`https://${ref}.supabase.co/storage/v1/object/list/patient-photos`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 1000, offset: 0, prefix, sortBy: { column: 'name', order: 'asc' } }),
  })
  if (!r.ok) return { error: `HTTP ${r.status} ${(await r.text()).slice(0, 120)}`, items: [] }
  const j = await r.json()
  return { items: Array.isArray(j) ? j : [] }
}

async function walk(ref, key, label) {
  console.log('')
  console.log('='.repeat(74))
  console.log(`${ref} — ${label}`)
  console.log('='.repeat(74))

  const b = await fetch(`https://${ref}.supabase.co/storage/v1/bucket`, { headers: { apikey: key, Authorization: `Bearer ${key}` } })
  console.log(`  buckets: HTTP ${b.status} ${b.ok ? JSON.stringify((await b.json()).map(x => x.id + (x.public ? ' (public)' : ' (private)'))) : (await b.text()).slice(0, 100)}`)

  // depth 1: clinic folders (or files at the root)
  const top = await list(ref, key, '')
  if (top.error) { console.log('  root list: ' + top.error); return }
  const folders = top.items.filter(i => !i.id)
  const rootFiles = top.items.filter(i => i.id)
  console.log(`  root: ${folders.length} folder(s), ${rootFiles.length} file(s)`)
  if (rootFiles.length) console.log('    root files: ' + rootFiles.slice(0, 5).map(f => `${f.name} (${f.metadata?.size ?? '?'}B)`).join(', '))

  let totalFiles = rootFiles.length, totalBytes = rootFiles.reduce((s, f) => s + (+(f.metadata?.size || 0)), 0)
  const seen = []
  for (const d of folders) {
    const lvl2 = await list(ref, key, d.name + '/')
    if (lvl2.error) { seen.push(`${d.name}/ -> ${lvl2.error}`); continue }
    const f2 = lvl2.items.filter(i => i.id)
    const sub = lvl2.items.filter(i => !i.id)
    totalFiles += f2.length
    totalBytes += f2.reduce((s, f) => s + (+(f.metadata?.size || 0)), 0)
    seen.push(`${d.name}/ -> ${sub.length} subfolder(s), ${f2.length} file(s)`)
    for (const s of sub.slice(0, 40)) {
      const lvl3 = await list(ref, key, `${d.name}/${s.name}/`)
      if (lvl3.error) { seen.push(`  ${d.name}/${s.name}/ -> ${lvl3.error}`); continue }
      const f3 = lvl3.items.filter(i => i.id)
      totalFiles += f3.length
      totalBytes += f3.reduce((s2, f) => s2 + (+(f.metadata?.size || 0)), 0)
      if (f3.length) seen.push(`  ${d.name}/${s.name}/ -> ${f3.length} file(s), e.g. ${f3[0].name} (${f3[0].metadata?.size ?? '?'}B)`)
    }
  }
  seen.slice(0, 30).forEach(s => console.log('    ' + s))
  console.log(`  TOTAL: ${totalFiles} object(s), ${(totalBytes / 1048576).toFixed(2)} MB`)
}

await walk('bvzuraltazxtaxnmbmcr', env.SUPABASE_SERVICE_ROLE_KEY, '.env.local project, service_role')
await walk('mkyxtlfapoiboxepkxdz', FE_ANON, 'frontend project, anon key')
