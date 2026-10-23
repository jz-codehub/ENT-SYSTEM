import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const env = {}
for (const line of readFileSync(join(HERE, '.env.local'), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const BASE = env.SUPABASE_URL.replace(/\/+$/, '')
// A file:// page is sent by the browser as Origin: null. This is exactly
// what the browser does, so it is a faithful test.
const O = { Origin: 'null' }
const A = { apikey: env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }
async function t(label, url, opts) {
  try {
    const r = await fetch(url, opts)
    const acao = r.headers.get('access-control-allow-origin')
    return { label, status: r.status, acao, ok: !!acao }
  } catch (e) { return { label, status: 'ERR', acao: e.message, ok: false } }
}
console.log('\n==== WHAT WORKS ON A file:// PAGE? (browser sends Origin: null) ====\n')
const rows = []
rows.push(await t('sign-in (GoTrue)', BASE + '/auth/v1/token?grant_type=password', {
  method: 'POST', headers: { ...A, ...O },
  body: JSON.stringify({ email: env.TEST_EMAIL, password: env.TEST_PASSWORD }),
}))
rows.push(await t('read staff_profiles (RLS)', BASE + '/rest/v1/staff_profiles?select=id,username,role&limit=1', {
  headers: { apikey: env.SUPABASE_ANON_KEY, ...O },
}))
rows.push(await t('save a report (RLS)', BASE + '/rest/v1/reports?select=id&limit=1', {
  headers: { apikey: env.SUPABASE_ANON_KEY, ...O },
}))
rows.push(await t('auth-admin (OUR function)', BASE + '/functions/v1/auth-admin', {
  method: 'OPTIONS',
  headers: { ...O, 'Access-Control-Request-Method': 'POST',
             'Access-Control-Request-Headers': 'authorization,content-type,apikey' },
}))
for (const r of rows) {
  console.log('  ' + (r.ok ? 'WORKS  ' : 'BLOCKED') + ' HTTP ' + String(r.status).padEnd(5) +
    'ACAO=' + String(r.acao === null ? 'ABSENT' : r.acao).padEnd(8) + r.label)
}
console.log('')
console.log('  Supabase\'s own API (auth + database) allows ANY origin, so those')
console.log('  keep working from a file:// page. Only OUR Edge Function has a')
console.log('  strict origin allowlist, so only that one is blocked.')
console.log('')
