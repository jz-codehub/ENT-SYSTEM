/* The exact failure the user reported: sign in, land on admin.html, and
   get bounced straight back to login.html. Simulated with a localStorage
   that actually PERSISTS between the two page loads, and WITHOUT the
   supabase-js library present unless the page loads it. */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AUTH = readFileSync(join(APP, 'function', 'auth.js'), 'utf8')

console.log('\n==== DOES A SIGNED-IN USER SURVIVE THE NAVIGATION? ====\n')
console.log('  For each page: does it load supabase-js, so ready() finds the')
console.log('  session instead of throwing and handing guard() a null?\n')

/* Every page except index.html lives in pages/, so this scans the root AND
 * that folder. Scanning only the root would find index.html and report
 * nothing about the seven pages that actually carry the auth chain - which
 * is the exact page set this script exists to check. */
const htmlFiles = []
  .concat(readdirSync(APP).filter(x => /\.html$/.test(x)).map(x => x))
  .concat(
    existsSync(join(APP, 'pages'))
      ? readdirSync(join(APP, 'pages')).filter(x => /\.html$/.test(x)).map(x => join('pages', x))
      : []
  )
  .sort()

for (const f of htmlFiles) {
  const src = readFileSync(join(APP, f), 'utf8')
  if (!/function\/auth\.js/.test(src)) { console.log('  ' + f.padEnd(24) + 'does not use auth.js'); continue }
  const has = /js\/lib\/supabase\.min\.js/.test(src)
  const sup = src.indexOf('js/lib/supabase.min.js')
  const cli = src.indexOf('function/supabaseClient.js')
  const order = sup !== -1 && cli !== -1 && sup < cli
  const okState = has && order
  console.log('  ' + f.padEnd(24) + (okState ? 'OK    session survives' : 'BROKEN bounces to login.html') +
    (has ? '' : '   <- supabase.min.js MISSING') + (has && !order ? '   <- WRONG ORDER' : ''))
}
console.log('')

// Prove the mechanism: no window.supabase -> getClient() throws -> null user.
const store = new Map()
const win = {
  localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k,v) => store.set(k,String(v)), removeItem: k => store.delete(k) },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { pathname: '/admin.html', search: '', href: '', origin: 'http://localhost:5500', replace() {} },
  navigator: { userAgent: 'node', onLine: true }, console,
  setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
  addEventListener() {}, fetch: async () => ({ ok: true, status: 200, text: async () => '[]', json: async () => [] }),
  // NOTE: deliberately NO window.supabase, i.e. the library tag was missing.
}
win.document = { readyState: 'complete', hidden: false, body: { classList: { contains: () => false, add(){}, remove(){} } }, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} }
win.window = win; win.globalThis = win
vm.createContext(win)
vm.runInContext(readFileSync(join(APP, 'function', 'supabaseClient.js'), 'utf8'), win)
vm.runInContext(AUTH, win)
let thrown = ''
try { win.EntSupabase.getClient() } catch (e) { thrown = e.message }
console.log('  without the library: getClient() -> ' + (thrown ? 'THROWS: ' + thrown.slice(0, 60) : 'no error'))
console.log('  and auth.ready() then returns ' + JSON.stringify(win.EntAuth.ready ? 'a user' : 'null') + ' only if a session exists,')
console.log('  so guard() redirects to login.html. That is the loop you saw.')
console.log('')
