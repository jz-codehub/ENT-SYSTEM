import { connect } from 'node:net'
// Raw HTTP so the CLIENT cannot normalise ../ away before it is sent.
const PORT = Number(process.env.ENT_TEST_PORT) || 5500
function raw(path) {
  return new Promise((res) => {
    const s = connect(PORT, '127.0.0.1', () => {
      s.write('GET ' + path + ' HTTP/1.1\r\nHost: localhost:' + PORT + '\r\nConnection: close\r\n\r\n')
    })
    let buf = ''
    s.on('data', (d) => { buf += d.toString('latin1') })
    s.on('end', () => {
      const status = (buf.split('\r\n')[0] || '').match(/HTTP\/1\.1 (\d+)/)
      res({ status: status ? status[1] : '?', bytes: buf.length })
    })
    s.on('error', (e) => res({ status: 'ERR', bytes: 0, err: e.message }))
  })
}
const CASES = [
  ['/pages/login.html', 'app page - must be 200'],
  ['/function/auth.js', 'app script - must be 200'],
  ['/style/auth.css', 'app css - must be 200'],
  ['/image/ent-logo.webp', 'app image - must be 200'],
  ['/supabase-v2/scripts/.env.local', 'SERVICE-ROLE KEY - must be 403'],
  ['/.git/config', 'dotfile dir - must be 403'],
  ['/serve.log', 'build artefact - must be 403'],
  ['/fix_permissions.sql', 'root sql - must be 403'],
  ['/../supabase-v2/scripts/.env.local', 'traversal - must be 403'],
  ['/%2e%2e/supabase-v2/scripts/.env.local', 'encoded traversal - must be 403'],
  ['/node_modules/acorn/package.json', 'deps - must be 403'],
]
console.log('\n==== SERVE.MJS SAFETY + FUNCTION ====\n')
let bad = 0
for (const [p, why] of CASES) {
  const r = await raw(p)
  const want = why.includes('must be 200') ? '200' : '403'
  const ok = String(r.status) === want
  if (!ok) bad++
  console.log('  ' + (ok ? 'OK  ' : 'BAD ') + String(r.status).padEnd(4) + p.padEnd(44) + why)
}
console.log('\n  ' + (bad ? bad + ' UNEXPECTED' : 'every case behaved as required') + '\n')
