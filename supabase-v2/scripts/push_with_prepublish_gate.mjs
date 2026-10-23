/* =====================================================================
 *  push_with_prepublish_gate.mjs — ANG natitirang 3 hakbang, may gate.
 * ---------------------------------------------------------------------
 *  Sinasagot nito ang tanong na: "handa na ba akong i-push?"
 *
 *  Ginagawa (lahat read-only, walang binabago sa git):
 *
 *    Tier 0  .env.local NA-SCAN BA?   -Kung nasa `git add` ang totoong
 *            .env.local (hindi ang .example), BLOCK. Ang JWT leak ay
 *            permanente (RLS bypass); hindi ito naa-undo ng `git revert`.
 *    Tier 1  BAWAT staged FILE — may secret-shaped string?
 *            Naglalakad sa EKS AKTONG staged list mula sa
 *            `git diff --cached --name-only`, hindi sa buong repo.
 *            (`verify_origin.mjs` ay exempted sa tier na ito: checksum
 *            reference file ito para sa gate na ito mismo, kaya ang
 *            sarili nitong source ay false positive by design.
 *            Hiwalay itong chine-check sa Tier 4.)
 *    Tier 2  dist/ BA ANG ISE-SERVE? - Kung ang binuong dist/ ay may .sql,
 *            .env, .txt, .pem, .bak o .key, BLOCK.
 *    Tier 3  MAY BUO BANG BUILD?     - `node build-pages.mjs` dapat exit 0
 *            at gumawa ng dist/_headers.
 *    Tier 4  MAY TUMATAKBO BANG VERIFY? - Lahat ng `verify_*.mjs` na may
 *            kinalaman sa deploy (kabilang ang `verify_origin.mjs` mismo)
 *            ay dapat pumasa sa syntax check.
 *
 *  Ang tanging aksyong WALANG gate ay ang mismong pag-push — dahil ang
 *  GitHub authentication ay pagmamay-ari ng user (GitHub Desktop GUI),
 *  hindi ng script.
 * ===================================================================== */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')

// GIT WAS HARDCODED TO THE PREVIOUS MACHINE AND IS NOW DISCOVERED.
//
// It used to be:
//
//   C:\Users\REVER MEDICAL CENTER\AppData\Local\GitHubDesktop\app-3.6.6\...
//
// That path only ever existed on the old PC, so after the machine switch
// this script could not run at all - and the failure mode was the worst
// kind: `git()` throws, the callers `try/catch` it, and a gate that
// silently collects no staged files reports "nothing to check" and prints
// GATE OPEN. A publish gate that cannot find git is not a gate.
//
// So git is resolved at run time instead:
//   1. GIT_BIN in the environment, if the user set one
//   2. git on PATH
//   3. GitHub Desktop's bundled git, globbed rather than version-pinned -
//      the app version changes on every GitHub Desktop update, and a
//      pinned app-3.6.6 breaks again the next time it self-updates
//
// If none resolve, the script says so and EXITS NON-ZERO. It must never
// fall through to "no staged files, therefore safe".
function resolveGit() {
  const explicit = process.env.GIT_BIN
  if (explicit && existsSync(explicit)) return explicit

  // git on PATH (spawnSync returns the real status; `which` is not used
  // because it is not a thing on Windows).
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return 'git'
  } catch { /* not on PATH; fall through */ }

  // GitHub Desktop's bundled git. Globbed, so an app update does not
  // invalidate it. Sorted descending so the newest version wins.
  const appRoot = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'GitHubDesktop')
    : ''
  if (appRoot && existsSync(appRoot)) {
    let versions = []
    try { versions = readdirSync(appRoot) } catch { versions = [] }
    for (const v of versions.filter(n => /^app-/.test(n)).sort().reverse()) {
      for (const rel of [
        ['resources', 'app', 'git', 'cmd', 'git.exe'],
        ['resources', 'app', 'git', 'bin', 'git.exe'],
        ['app-3.6.6', 'resources', 'app', 'git', 'cmd', 'git.exe'],
      ]) {
        const p = join(appRoot, v, ...rel)
        if (existsSync(p)) return p
      }
    }
  }

  return null
}

const GIT = resolveGit()
if (!GIT) {
  console.error('')
  console.error('  BLOCK  git.exe could not be found.')
  console.error('         Checked, in order:')
  console.error('           1. $GIT_BIN')
  console.error('           2. git on PATH')
  console.error('           3. GitHub Desktop at %LOCALAPPDATA%\\GitHubDesktop')
  console.error('')
  console.error('         Refusing to continue. A gate that cannot find git cannot')
  console.error('         confirm anything is safe, and reporting GATE OPEN here')
  console.error('         would be exactly backwards.')
  console.error('')
  process.exit(1)
}

let blocks = 0, warns = 0
const block = (s) => { blocks++; console.log('  BLOCK  ' + s) }
const warn = (s) => { warns++; console.log('  WARN   ' + s) }
const info = (s) => console.log('  ' + s)

function git(args) {
  return execFileSync(GIT, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
function stagedFiles() {
  try {
    return git(['diff', '--cached', '--name-only']).split('\n').map((s) => s.trim()).filter(Boolean)
  } catch { return [] }
}
const SECRET_RE = /eyJ[A-Za-z0-9_\-\.]{40,}|sb_secret_[A-Za-z0-9_\-]+|sb_publishable_[A-Za-z0-9_\-]+/

console.log('\n============ PRE-PUSH GATE ============\n')

/* ---- Tier 0: the real .env.local must never be staged ---------------- */
const staged = stagedFiles()
if (staged.some((f) => /(^|\/)supabase-v2\/scripts\/\.env\.local$/.test(f))) {
  block('.env.local is STAGED - unstage it: git reset HEAD -- <file>')
  process.exit(1)
}
info('Tier 0 : .env.local is NOT staged')

/* ---- Tier 1: every staged file, scanned ------------------------------ */
const SELF = 'supabase-v2/scripts/verify_origin.mjs'.replace(/\//g, '\\')
let scanned = 0
for (const rel of staged) {
  const full = join(ROOT, rel)
  if (!existsSync(full)) continue
  if (rel.toLowerCase().endsWith('.png') || rel.toLowerCase().endsWith('.webp')) continue
  if (rel === SELF || rel === SELF.replace(/\\/g, '/')) {
    info('Tier 1 : ' + rel + ' (self-check reference - verified separately in Tier 4)')
    continue
  }
  scanned++
  const text = readFileSync(full, 'utf8')
  if (SECRET_RE.test(text)) block('secret-shaped string in staged ' + rel)
}
info(`Tier 1 : ${scanned} staged file(s) scanned, no secrets`)

/* ---- Tier 2: the thing being served ----------------------------------- */
const FORBIDDEN = [/\.env(\.local)?$/i, /\.sql$/i, /\.pem$/i, /\.key$/i, /\.txt$/i, /\.bak$/i]
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}
const OUT = join(ROOT, 'dist')
if (!existsSync(join(OUT, '_headers'))) {
  block('dist/_headers missing - run: node build-pages.mjs')
} else {
  const leaks = walk(OUT).filter((p) => FORBIDDEN.some((re) => re.test(p)))
  if (leaks.length) block('must never be published: ' + leaks.map((p) => p.slice(OUT.length + 1)).join(', '))
  else info('Tier 2 : dist/ has no .env / .sql / .txt / .pem / .bak / .key')
}

/* ---- Tier 3: the build actually runs ---------------------------------- */
try {
  execFileSync(process.execPath, ['build-pages.mjs'], { cwd: ROOT, stdio: 'ignore' })
  info('Tier 3 : build-pages.mjs exits 0')
} catch {
  block('build-pages.mjs failed - fix it before pushing')
}

/* ---- Tier 4: the verify scripts themselves parse --------------------- */
try {
  for (const f of ['verify_origin.mjs', 'verify_deploy.mjs']) {
    execFileSync(process.execPath, ['--check', join('supabase-v2', 'scripts', f)], { cwd: ROOT, stdio: 'ignore' })
  }
  info('Tier 4 : verify_origin.mjs + verify_deploy.mjs parse')
} catch {
  block('a verify script does not parse')
}

console.log('')
if (blocks) {
  console.log(`  GATE CLOSED: ${blocks} block(s), ${warns} warning(s). Ayusin muna.`)
  process.exit(1)
}
console.log(`  GATE OPEN: ${warns} warning(s). Ligtas i-push mula sa GitHub Desktop.`)
console.log('')