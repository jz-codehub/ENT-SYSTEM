/* temp/audit_live2.mjs - READ-ONLY follow-up: (a) are the DEPLOYED edge
   functions the fixed bundle or the old one? (b) do the v2 columns really
   exist? (c) how big is reports.payload on average - the free-plan number
   that matters? Nothing is written. */
import { readFileSync } from 'node:fs'
const env = {}
for (const line of readFileSync(new URL('../supabase-v2/scripts/.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
const URL0 = env.SUPABASE_URL.replace(/\/+$/, '')
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

/* (a) POST (not OPTIONS) with an ALLOWED origin. The fixed bundle echoes
   ACAO on every response, the old one has no CORS code at all. */
console.log('\n===== A. EDGE FUNCTION POST with allowed origin =====')
for (const fn of ['auth-admin', 'patient-photos']) {
  const res = await fetch(`${URL0}/functions/v1/${fn}`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json', Origin: env.ENT_ALLOWED_ORIGIN },
    body: JSON.stringify({})
  })
  console.log(`  ${fn} POST -> HTTP ${res.status} ACAO=${res.headers.get('access-control-allow-origin') || 'ABSENT'}`)
  console.log('   body:', (await res.text()).slice(0, 220).replace(/\s+/g, ' '))
}

/* (b) the columns the whole v2 frontend is built on */
console.log('\n===== B. v2 COLUMNS on reports =====')
try {
  const res = await fetch(`${URL0}/rest/v1/reports?select=id,record_key,is_draft,photo_count,created_by_name,deleted_at,saved_at,doctor_id,clinic_id,payload->>site,payload->>dbSaved&order=updated_at.desc&limit=2`, { headers: H })
  console.log('  HTTP', res.status, JSON.stringify(await res.json()).slice(0, 400))
} catch (e) { console.log('  ERROR', e.message) }

/* (c) payload size sample -> the free-plan DB number */
console.log('\n===== C. PAYLOAD SIZE SAMPLE (newest 20, all types) =====')
try {
  const res = await fetch(`${URL0}/rest/v1/reports?select=payload&order=updated_at.desc&limit=20`, { headers: H })
  const rows = await res.json()
  const bytes = rows.map(r => JSON.stringify(r.payload || {}).length)
  const total = bytes.reduce((a, b) => a + b, 0)
  const avg = Math.round(total / (rows.length || 1))
  console.log(`  sample n=${rows.length} avg=${(avg / 1024).toFixed(1)} KB max=${(Math.max(...bytes, 0) / 1024).toFixed(1)} KB`)
  console.log(`  extrapolated for 328 reports: ~${(avg * 328 / 1024 / 1024).toFixed(2)} MB of payload`)
  const withImages = rows.filter(r => Array.isArray(r.payload?.formData?.images) && r.payload.formData.images.filter(Boolean).length).length
  console.log('  rows in this sample still holding INLINE base64 photos:', withImages, 'of', rows.length)
} catch (e) { console.log('  ERROR', e.message) }

/* (d) photos: how many reports point at the bucket vs inline */
console.log('\n===== D. PHOTO WIRING =====')
try {
  const res = await fetch(`${URL0}/rest/v1/report_photos?select=id,report_id,storage_path,created_at&limit=10`, { headers: H })
  console.log('  report_photos:', JSON.stringify(await res.json()).slice(0, 400))
} catch (e) { console.log('  ERROR', e.message) }
try {
  const res = await fetch(`${URL0}/storage/v1/object/list/patient-photos`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: '', limit: 20 })
  })
  const j = await res.json()
  console.log('  bucket objects:', Array.isArray(j) ? j.map(o => `${o.name}(${((o.metadata?.size || 0) / 1024).toFixed(0)}KB)`).join(' ') : JSON.stringify(j).slice(0, 300))
} catch (e) { console.log('  ERROR', e.message) }
console.log('\ndone.\n')
