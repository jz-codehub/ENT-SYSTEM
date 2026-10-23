/* Prove the L3c/L3d/L3e guards actually FAIL on the original buggy code.
   Temporarily re-introduces each defect, runs the same assertions the live
   suite uses, and restores the file. Backs up first; always restores. */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = join(HERE, '..', '..')
const P = {
  admin: join(APP, 'function', 'admin.js'),
  auth: join(APP, 'function', 'auth.js'),
  login: join(APP, 'pages', 'login.html'),
  fn: join(APP, 'supabase-v2', 'edge-functions', 'auth-admin', 'index.ts'),
}
const orig = {}
for (const [k, p] of Object.entries(P)) {
  orig[k] = readFileSync(p, 'utf8')
  copyFileSync(p, p + '.mutationbak')
}

function restore() {
  for (const [k, p] of Object.entries(P)) writeFileSync(p, orig[k])
  for (const p of Object.values(P)) { try { unlinkSync(p + '.mutationbak') } catch { /* ignore */ } }
}

// The exact assertions test_live_rls.mjs runs.
const a = (s) => !/\bemail\b\s*:/.test((s.match(/action:\s*'create'[\s\S]{0,400}/) || [''])[0].replace(/\/\/[^\n]*/g, ''))
const d = (auth, fn) => (auth.match(/const EMAIL_DOMAIN = '([^']+)'/) || [])[1] === (fn.match(/const ACCOUNT_EMAIL_DOMAIN = '([^']+)'/) || [])[1]
const e = (auth, admin, fn) =>
  (auth.match(/const MIN_PASSWORD_LENGTH = (\d+)/) || [])[1] === '6' &&
  (admin.match(/MIN_PASSWORD_LENGTH = Auth\.MIN_PASSWORD_LENGTH \|\| (\d+)/) || [])[1] === '6' &&
  (fn.match(/const MIN_PASSWORD_LENGTH = (\d+)/) || [])[1] === '6'

let allGood = true
const report = (label, ok) => {
  console.log('  ' + (ok ? 'OK   ' : 'BAD  ') + label)
  if (!ok) allGood = false
}

console.log('\n==== DO THE GUARDS ACTUALLY CATCH THE ORIGINAL BUGS? ====\n')
console.log('  [1] the fixed code must SATISFY every guard')
report('L3c  no undefined `email` in the create payload', a(orig.admin))
report('L3d  sign-in domain == auth-admin domain', d(orig.auth, orig.fn))
report('L3e  all three layers use a floor of 6', e(orig.auth, orig.admin, orig.fn))

console.log('\n  [2] re-introducing each original defect must VIOLATE its guard')
try {
  // Bug 1: the undeclared `email` variable, exactly as it shipped.
  writeFileSync(P.admin, orig.admin.replace(
    "                    password: password || undefined,",
    "                    password: password || undefined,\n                    email: email || 'x',"))
  report('L3c  DETECTS the undeclared `email`', !a(readFileSync(P.admin, 'utf8')))
  restore()

  // Bug 2: the domain mismatch, exactly as it shipped.
  writeFileSync(P.fn, orig.fn.replace("const ACCOUNT_EMAIL_DOMAIN = 'zztest.invalid'", "const ACCOUNT_EMAIL_DOMAIN = 'clinic.invalid'"))
  report('L3d  DETECTS clinic.invalid vs zztest.invalid', !d(orig.auth, readFileSync(P.fn, 'utf8')))
  restore()

  // Bug 3: the three-way floor split, exactly as it shipped.
  writeFileSync(P.fn, orig.fn.replace('const MIN_PASSWORD_LENGTH = 6', 'const MIN_PASSWORD_LENGTH = 10'))
  report('L3e  DETECTS auth-admin=10 while auth.js=6', !e(orig.auth, orig.admin, readFileSync(P.fn, 'utf8')))
  restore()
} finally {
  restore()
}

// Prove the files are byte-identical to where we started.
const clean = Object.entries(P).every(([k, p]) => readFileSync(p, 'utf8') === orig[k])
console.log('\n  files restored byte-for-byte: ' + (clean ? 'YES' : 'NO'))
console.log('  ' + (clean && allGood
  ? 'every guard is proven to fail on the old code and pass on the new'
  : 'PROBLEM - investigate before trusting the suite') + '\n')
process.exitCode = (clean && allGood) ? 0 : 1
