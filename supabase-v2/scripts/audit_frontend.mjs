#!/usr/bin/env node
/* =====================================================================
   audit_frontend.mjs — is it safe to publish?
   ---------------------------------------------------------------------
   Everything in this folder is SHIPPED TO A BROWSER, including the
   source, so "it is only on the client" is not a defence: anything here
   is readable by anyone who opens DevTools.

     F1  no privileged key anywhere in the frontend
     F2  no reference to the deleted v1 Supabase project
     F3  no browser-side password verification
     F4  no table v2 deleted
     F5  no self-minted session token
     F6  no client-chosen clinic in a query string
     F7  supabase-js is actually loaded by every page that needs auth

   Exit 0 = safe to publish. Non-zero = stop.
   Run:  node supabase-v2/scripts/audit_frontend.mjs
   ===================================================================== */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..', '..')

let failures = 0
let checks = 0
const ok = (l, d = '') => { checks++; console.log(`  PASS  ${l}${d ? ' — ' + d : ''}`) }
const bad = (l, d = '') => { checks++; failures++; console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`) }

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const full = join(dir, e)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

// Everything the browser downloads, and nothing else.
//
// The rule is: skip anything build-pages.mjs does not copy. It copies an
// explicit allowlist (PAGES + DIRS), so the authoritative definition of
// "shipped" is that list - and this regex has to agree with it. When the
// two drift, this audit reports on files nobody will ever publish.
//
// That already happened once. `_legacy/` was missing from SKIP, so F3
// reported "2 BLOCKER(S) - DO NOT PUBLISH" against
// _legacy/scripts-v1/test_login_flow.js and test_phase_a.js, both of which
// contain `password_hash` and `salt` because they deliberately reproduce the
// v1 password flow to prove it is gone. Neither file can ship: build-pages
// copies only PAGES + DIRS, and _legacy/ is in neither, and .gitignore
// excludes it. dist/_legacy does not exist after a build.
//
// A publish gate that cries wolf on unshippable files gets ignored, and then
// it stops catching the ones that matter. dist/ was checked to confirm
// viewAll.html and function/viewAllAccess.js ARE shipped, so the new page is
// genuinely covered by this audit.
//
// Keep the two in step: if you add a directory to build-pages.mjs, add it
// here, and if you add one here, add it there.
const SKIP = /node_modules|[\\/]\.git[\\/]|^scripts[\\/]|^supabase-v2[\\/]scripts[\\/]|supabase-v2[\\/]edge-functions|supabase-v2[\\/]migrations|^js[\\/]lib[\\/]|^supabase[\\/]|^backup[\\/]|^_legacy[\\/]|^dist[\\/]|^docs[\\/]|admin\.html\.bak/

const shipped = walk(APP)
  .filter(f => /\.(js|html)$/i.test(f))
  .filter(f => !SKIP.test(relative(APP, f).replace(/\\/g, '/')))
  .map(f => ({ file: relative(APP, f).replace(/\\/g, '/'), text: readFileSync(f, 'utf8') }))

console.log('')
console.log('==== FRONTEND PUBLISH AUDIT ====')
console.log(`scanned ${shipped.length} shipped file(s)`)
console.log('')

/** Strip comments, then string literals: a mention in prose is not code. */
const code = t => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
const stripStrings = t => t.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
const codeOnly = t => stripStrings(code(t))

/* ---------------- F1 : no privileged key -------------------------- */
// The anon key is public BY DESIGN. A service_role key is not.
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g
let f1 = 0
for (const { file, text } of shipped) {
  const c = codeOnly(text)
  const hits = []
  let m
  JWT.lastIndex = 0
  while ((m = JWT.exec(c)) !== null) {
    try {
      const part = m[0].split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
      const json = JSON.parse(Buffer.from(part, 'base64').toString('utf8'))
      if (json.role === 'service_role') hits.push('service_role JWT literal')
    } catch (e) { /* not a decodable JWT */ }
  }
  if (/SERVICE_ROLE_KEY\s*=\s*['"][^'"]+/.test(c)) hits.push('SERVICE_ROLE_KEY assignment')
  if (hits.length) { f1++; bad(`F1 no privileged key · ${file}`, hits.join(', ')) }
}
if (!f1) ok(`F1 no service_role / secret key in any shipped file (${shipped.length} scanned)`)

/* ---------------- F2 : the deleted v1 project (2026-10-08) ---------- */
let f2 = 0
for (const { file, text } of shipped) {
  if (codeOnly(text).includes('enqrsewsydrsxvrocpjz')) {
    f2++
    bad(`F2 no reference to the v1 project · ${file}`,
        'would point the published site at a deleted project - the URL no longer resolves')
  }
}
if (!f2) ok('F2 no live reference to the v1 project enqrsewsydrsxvrocpjz')
/* ---------------- F3 : no browser-side password check -------------- */
let f3 = 0
for (const { file, text } of shipped) {
  const c = codeOnly(text)
  const hits = []
  if (/password_hash/.test(c)) hits.push('password_hash')
  if (/sha256Hex|hashPassword/.test(c)) hits.push('client-side password hashing')
  if (/\bsalt\b/.test(c)) hits.push('salt')
  if (hits.length) { f3++; bad(`F3 no browser-side password verification · ${file}`, hits.join(', ')) }
}
if (!f3) ok('F3 no password hash, salt or client-side hashing in shipped code')

/* ---------------- F4 : no table v2 deleted ------------------------- */
let f4 = 0
for (const { file, text } of shipped) {
  const c = codeOnly(text)
  const hits = ['patient_records', 'clinic_users', 'user_sessions']
    .filter(t => new RegExp('[\'"`]' + t, 'i').test(c) || new RegExp('\\b' + t + '\\?', 'i').test(c))
  if (hits.length) { f4++; bad(`F4 no retired table referenced · ${file}`, hits.join(', ')) }
}
if (!f4) ok('F4 no reference to patient_records / clinic_users / user_sessions')

/* ---------------- F5 : no self-minted session in USE ---------------- */
// Naming a retired key is not a leak: storageStats.js keeps a map that
// explains "entSessionV1 — legacy, safe to clear" so an old device's
// leftovers are legible. What must not exist is code that READS or WRITES
// one, i.e. a session the app keeps outside supabase-js.
let f5 = 0
const V1_SESSION_KEYS = ['entSessionV1', 'entBridgeTokenV1']
for (const { file, text } of shipped) {
  const c = codeOnly(text)
  for (const key of V1_SESSION_KEYS) {
    // localStorage.getItem('entSessionV1') / setItem(KEY, …) / removeItem(…)
    const used = new RegExp('(?:getItem|setItem|removeItem)\\s*\\([^)]*' + key, 'i').test(c)
      || new RegExp(key + "\\s*['\"]?\\s*,", 'i').test(c)   // passed as an argument
    if (used) {
      f5++
      bad(`F5 no self-minted session in use · ${file}`, `${key} is still read or written`)
      break
    }
  }
}
if (!f5) ok('F5 no hand-rolled session token is read or written')

/* ---------------- F6 : no client-chosen clinic in a query ---------- */
let f6 = 0
for (const { file, text } of shipped) {
  if (/clinic_id=eq\.|clinicId\s*\|\|/.test(codeOnly(text))) {
    f6++
    bad(`F6 no client-chosen clinic in a query · ${file}`,
        'the clinic must come from staff_profiles via RLS, not the query string')
  }
}
if (!f6) ok('F6 no clinic filter written into a query string')

/* ---------------- F7 : supabase-js is loaded ----------------------- */
// Every page that calls signInWithPassword() needs the library on the page
// BEFORE supabaseClient.js. It is vendored at js/lib/supabase.min.js (the
// folder already vendors jspdf, cropper and html2canvas); a CDN tag counts
// too, because either way the script is there.
// Every page except index.html moved into pages/, so these paths carry the
// prefix. Keep every deployed page that needs Supabase in this check; this is
// a subset of the build allowlist, not the full deployment page list.
const PAGES = ['index.html', 'pages/login.html', 'pages/offlineWorkspace.html', 'pages/admin.html', 'pages/settings.html',
               'pages/cf4Form.html', 'pages/nasalEndoscopy.html', 'pages/laryngealEndoscopy.html']
const hasSupabaseJs = html =>
    /js\/lib\/supabase(\.min)?\.js/.test(html) || /@supabase\/supabase-js/.test(html)
const missing = PAGES
  .filter(p => existsSync(join(APP, p)))
  .filter(p => !hasSupabaseJs(readFileSync(join(APP, p), 'utf8')))
if (missing.length) bad('F7 supabase-js loaded by every page', `missing in: ${missing.join(', ')}`)
else ok(`F7 supabase-js loaded by every page (${PAGES.length} checked)`)

// And it must load BEFORE supabaseClient.js on each page, or getClient()
// runs against an undefined window.supabase.
const misordered = PAGES
  .filter(p => existsSync(join(APP, p)))
  .filter(p => {
    const html = readFileSync(join(APP, p), 'utf8')
    if (!hasSupabaseJs(html)) return false
    return html.indexOf('supabase.min.js') > html.indexOf('function/supabaseClient.js')
  })
if (misordered.length) bad('F7 supabase-js loads before supabaseClient.js', `wrong order in: ${misordered.join(', ')}`)
else ok('F7 script order correct on every page')

console.log('')
console.log(`==== ${failures === 0 ? 'SAFE TO PUBLISH' : failures + ' BLOCKER(S) — DO NOT PUBLISH'} · ${checks} checks ====`)
console.log('')
if (failures === 0) {
  console.log('NOTE: static review of the FRONTEND only. It does not prove the')
  console.log('backend behaves correctly. Run smoke_test.mjs as well.')
  console.log('')
}
process.exit(failures === 0 ? 0 : 1)