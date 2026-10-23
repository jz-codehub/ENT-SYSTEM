/* =====================================================================
 *  build-pages.mjs — Cloudflare Pages build step
 * ---------------------------------------------------------------------
 *  WHY THIS EXISTS
 *  Cloudflare Pages publishes whatever is in the build output directory.
 *  This repo also holds things that must NEVER be reachable over HTTP:
 *
 *      supabase-v2/migrations/*.sql   the whole schema, incl. seed data
 *      supabase-v2/scripts/*.mjs      test drivers that embed live JWTs
 *      supabase-v2/scripts/*.txt      dumps of real API responses + JWTs
 *      supabase-v2/scripts/.env.local the SERVICE-ROLE key
 *      _legacy/                       v1 probes carrying a v1 credential
 *                                       (folder deleted 2026-10-08; keep excluding it)
 *      backup/                        rollback SQL
 *
 *  So instead of publishing the repo root, we copy an explicit allowlist
 *  of runtime files into dist/ and publish that. Anything not named here
 *  does not ship — a new sensitive file added later is excluded by
 *  default rather than by someone remembering to gitignore it.
 *
 *  Usage:   node build-pages.mjs
 *  Output:  dist/   (set this as the Pages "build output directory")
 *  Build command:  node build-pages.mjs
 * ===================================================================== */
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)))
const OUT = join(ROOT, 'dist')

// --- the app -------------------------------------------------------------
// Every page EXCEPT index.html lives in pages/. index.html stays at the app
// root because it is the entry point: the service worker falls back to it,
// manifest.json points start_url at it, and a bare "/" has to serve it.
//
// This list is an ALLOWLIST, and it is the single source of truth for what
// gets published - audit_frontend.mjs asserts against the same set. A page
// that nobody adds here is NOT published, which is the safe default.
const PAGES = [
  '_redirects',
  'index.html',
  'pages/login.html',
  'pages/offlineWorkspace.html',
  'pages/admin.html',
  'pages/settings.html',
  'pages/nasalEndoscopy.html',
  'pages/laryngealEndoscopy.html',
  'pages/cf4Form.html',
  // The cross-clinic permission UI. Listed explicitly, like every other
  // page: this build copies an ALLOWLIST, so a new page that nobody adds
  // here is excluded by default rather than published by accident. It also
  // cannot publish itself, because adding it here is a deliberate act.
  'pages/viewAll.html',
  // The offline workspace is a direct navigation target after offline sign-in
  // and is also required by sw.js precaching. If it is absent from this
  // allowlist, its 404 rejects the service-worker install for the whole app.
  // The in-app problem-report page has the same requirement.
  'pages/tickets.html',
  // READ-ONLY diagnostic: answers one question — are Lilian's Sept–Oct CF4
  // records in the CLOUD (so a deploy shows them) or still on a DEVICE
  // (so only syncing that device recovers them). Writes/deletes nothing.
  'pages/records-doctor.html',
  'manifest.json',
  'sw.js',
]
const DIRS = ['function', 'style', 'css', 'image', 'js']

// --- security headers ----------------------------------------------------
// Every value below was derived from what THIS app actually loads, not from
// a generic template: see supabase-v2/docs or the audit notes.
// The NEW Supabase project (2026-10-11 fresh deployment). This constant
// is the CSP connect-src/wss-src target — it must match the PROJECT_REF
// in function/supabaseClient.js exactly, or the browser blocks every
// API call at the CSP layer even though the JS points the right way.
const SUPABASE = 'ybnlvfdvfrwnmdvhxeof.supabase.co'
const CSP = [
  "default-src 'self'",
  // 'unsafe-inline' is required TODAY by the inline <script> blocks in
  // cf4Form.html / login.html / diagnose.html and by style="" attributes
  // across every page. cdnjs.cloudflare.com is only a FALLBACK used by
  // loadLocalOrCdn() when a local js/lib copy is missing — remove BOTH the
  // fallback calls and this source together to tighten the policy later.
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  // data: for base64 endoscopy photos, blob: for the cropper/PDF preview
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self' https://${SUPABASE} wss://${SUPABASE}`,
  // service worker + pdf.js worker
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ')

const HEADERS = `/*
  Content-Security-Policy: ${CSP}
  Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
  Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(), usb=()
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin
`

// --- build ---------------------------------------------------------------
let missing = 0
let copied = 0

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

for (const rel of PAGES) {
  const src = join(ROOT, rel)
  if (!existsSync(src)) {
    console.warn(`  MISSING  ${rel}`)
    missing++
    continue
  }
  // The pages now live in a pages/ subfolder, so the destination's parent
  // directory does not exist yet on a clean build. mkdirSync is recursive
  // and idempotent, so a root-level page is unaffected.
  mkdirSync(dirname(join(OUT, rel)), { recursive: true })
  cpSync(src, join(OUT, rel))
  copied++
}

for (const dir of DIRS) {
  const src = join(ROOT, dir)
  if (!existsSync(src)) {
    console.warn(`  MISSING  ${dir}/`)
    missing++
    continue
  }
  cpSync(src, join(OUT, dir), { recursive: true })
  copied += readdirSync(src).length
}

writeFileSync(join(OUT, '_headers'), HEADERS, 'utf8')
// Lets a static server (and Cloudflare) know this is not a Jekyll site, and
// keeps the manifest reachable under the bare site root.
writeFileSync(join(OUT, '.nojekyll'), '', 'utf8')

// --- publish-safety check ------------------------------------------------
// Belt and braces: if a secret-shaped file ever lands in dist/, fail the
// build so the deploy stops instead of leaking.
const FORBIDDEN = [/\.env(\.local)?$/i, /\.sql$/i, /\.pem$/i, /\.key$/i, /\.txt$/i, /\.bak$/i]
const leaks = []
;(function walk(dir) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name)
    if (name.isDirectory()) walk(full)
    else if (FORBIDDEN.some((re) => re.test(name.name))) leaks.push(full.slice(OUT.length + 1))
  }
})(OUT)

console.log(`\n  built ${copied} entr${copied === 1 ? 'y' : 'ies'} -> dist/`)
if (missing) console.warn(`  ${missing} expected entr${missing === 1 ? 'y' : 'ies'} missing`)
if (leaks.length) {
  console.error('\n  BUILD FAILED: these must never be published:')
  leaks.forEach((f) => console.error(`     ${f}`))
  process.exit(1)
}
console.log('  no .env / .sql / .txt / .key / .pem / .bak in dist — safe to publish')
console.log('\n  Cloudflare Pages -> Build command:  node build-pages.mjs')
console.log('                     Output dir:      dist')
