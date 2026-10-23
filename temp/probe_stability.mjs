/* temp/probe_stability.mjs — READ-ONLY stability test.
   Two earlier probes disagreed about ent_stamp_report_ownership and
   secretary_assignments within minutes of each other. PostgREST rebuilds its
   schema cache asynchronously after `NOTIFY pgrst, 'reload schema'`, which
   every migration ends with — so a transient 404 can mean "cache rebuilding",
   not "object absent". This calls each probe N times with a pause and reports
   how many of the N calls saw the object, so a flapping answer is visible
   instead of being mistaken for a fact.
   temp/ is gitignored. */
const REF = 'mkyxtlfapoiboxepkxdz'
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1reXh0bGZhcG9pYm94ZXbreGR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3OTY1MzgsImV4cCI6MjEwNjM3MjUzOH0.klFFrccrgZBIQNzK_KM0AGpxdJFeKjxMuIjZOwFcgAY'
const U = '00000000-0000-0000-0000-000000000000'
const N = 6

const PROBES = [
  ['rpc', 'ent_is_my_doctor', { p_doctor: U }, '0037 — secretary junction scope'],
  ['rpc', 'my_assigned_doctors', {}, '0037 — secretary picker'],
  ['rpc', 'ent_purge_recycle_bin', { p_before: new Date().toISOString(), p_limit: 1 }, '0036 — bin retention'],
  ['rpc', 'ent_reassign_doctor_records', { p_from: U, p_to: U }, '0035 — account deletion safety'],
  ['rpc', 'ent_stamp_report_ownership', {}, '0004/0018/0028/0037 trigger'],
  ['rpc', 'ent_deleted_reports', { p_limit: 10 }, '0026/0034/0037 — the bin'],
  ['rpc', 'ent_may_soft_delete', { p_clinic: U, p_doctor: U, p_id: U }, '0026/0029/0034 — delete'],
  ['table', 'secretary_assignments', null, '0037 junction table'],
]

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function once(kind, name, body) {
  const url = kind === 'rpc'
    ? `https://${REF}.supabase.co/rest/v1/rpc/${name}`
    : `https://${REF}.supabase.co/rest/v1/${name}?select=%2A&limit=1`
  const r = await fetch(url, {
    method: kind === 'rpc' ? 'POST' : 'GET',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json', Range: '0-0' },
    body: kind === 'rpc' ? JSON.stringify(body) : undefined,
  })
  const t = await r.text()
  let code = ''
  try { code = JSON.parse(t).code || '' } catch {}
  const notFound = code === 'PGRST202' || code === 'PGRST205' || r.status === 404
  return { notFound, status: r.status, code }
}

console.log(`# ${REF} — ${N} samples per probe (looking for a flapping answer)`)
console.log('')
for (const [kind, name, body, note] of PROBES) {
  const seen = []
  for (let i = 0; i < N; i++) {
    seen.push((await once(kind, name, body)).notFound ? 'X' : '.')
    await sleep(400)
  }
  const missing = seen.filter(s => s === 'X').length
  const verdict = missing === 0 ? 'ALWAYS PRESENT -> deployed'
    : missing === N ? 'ALWAYS ABSENT  -> genuinely NOT deployed'
    : `FLAPPING ${missing}/${N} absent -> cache reloading, inconclusive`
  console.log(`  ${name.padEnd(30)} [${seen.join('')}]  ${verdict}`)
  console.log(`  ${' '.repeat(30)}   ${note}`)
}
