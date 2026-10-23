/* Reproduce the post-login redirect for a REAL admin, using the real
   functions lifted out of login.html. Read-only, nothing is changed. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const login = readFileSync(join(HERE, '..', '..', 'pages', 'login.html'), 'utf8')

/* Pull a whole function out of the source by brace matching, so the test
   always runs the REAL body and cannot drift from login.html. */
function extractFn(src, name) {
  const at = src.indexOf('function ' + name + '(')
  if (at < 0) throw new Error('could not find ' + name + ' in login.html')
  const open = src.indexOf('{', at)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1) }
  }
  throw new Error('unbalanced braces in ' + name)
}

const targetSrc = extractFn(login, 'targetPage')
const landingSrc = extractFn(login, 'landingPage')
const pageUrlSrc = extractFn(login, 'pageUrl')

/* landingPage() resolves page names through pageUrl(), which delegates to
 * function/paths.js. That file is loaded for real rather than stubbed: the
 * whole point of this script is to run the SHIPPED logic, and a hand-written
 * stand-in for the path resolver is exactly the kind of copy that drifts
 * from the app and then "passes" while the real page 404s.
 *
 * pathname is set to the real location of login.html inside the app, because
 * that is what decides whether paths.js prefixes with "./" or "../". */
const pathsSrc = readFileSync(join(HERE, '..', '..', 'function', 'paths.js'), 'utf8')

// Rebuild them in one scope, exactly as login.html has them, so
// landingPage() can see targetPage() and pageUrl(). landingPage() reads
// window.location.search, so a window stand-in is supplied.
const win = { location: { search: '', pathname: '/pages/login.html' } }
win.window = win
const landingPage = new Function('window', 'return (function(){' +
  pathsSrc + '\n' + pageUrlSrc + '\n' + targetSrc + '\n' + landingSrc +
  '\nreturn landingPage;})()')(win)

const ADMIN = { role: 'admin', username: 'testadmin' }
const DOCTOR = { role: 'doctor', username: 'testdoc1' }

console.log('\n==== WHERE DOES SIGN-IN SEND YOU? (real login.html logic) ====\n')
console.log('  login.html is served from /pages/, so a correct landing URL is')
console.log('  prefixed: siblings resolve bare, the root index.html needs "../".\n')
console.log('  ' + 'ARRIVED AT login.html VIA'.padEnd(38) + 'ADMIN lands on'.padEnd(24) + 'DOCTOR lands on')
for (const q of ['', '?next=index.html', '?next=admin.html', '?next=login.html',
                 '?next=nasalEndoscopy.html', '?next=settings.html', '?next=login']) {
  const label = q || '(typed the URL directly)'
  win.location.search = q
  const a = landingPage(ADMIN)
  win.location.search = q
  const d = landingPage(DOCTOR)
  // Only the doctor dashboard is a defect for an admin. The others are
  // intentional: if an admin explicitly asked for a page (settings.html, a
  // report form), that request is honoured rather than second-guessed.
  const flag = a === 'admin.html' ? ''
    : a === '../index.html' ? '   <-- BUG: admin dumped on the doctor dashboard'
    : ''
  console.log('  ' + label.padEnd(38) + a.padEnd(24) + d + flag)
}
console.log()
