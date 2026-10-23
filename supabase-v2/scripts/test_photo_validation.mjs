#!/usr/bin/env node
/* =====================================================================
   test_photo_validation.mjs  —  OFFLINE tests for the photo gate
   ---------------------------------------------------------------------
   WHY THIS FILE EXISTS
   docs/06-TEST-PLAN.md group F (STORAGE-01..08) is a MANUAL checklist, and
   it is the sign-off gate for `photo_storage`. But STORAGE-01/02/03/04 can
   only be executed against a DEPLOYED function with the flag ON — which is
   exactly the state the live clinic must stay out of until they pass. So the
   code that decides whether a byte is ever ACCEPTED had no executable
   coverage at all: a regression in validatePhoto() or sniffType() would
   pass every existing script and only surface as a rejected upload in a
   doctor's hands.

   These tests lift the REAL validators out of edge-functions/_shared/auth.ts
   by parsing that file. Not a copy: if validatePhoto() changes, these follow
   it. Nothing here needs the network, the service-role key, a deployed
   function, or the flag, so this is SAFE TO RUN against the live project.

     STORAGE-02  content sniffing — a PDF named .jpg is refused
     STORAGE-03  per-file size cap
     STORAGE-04  MAX_PHOTOS_PER_REPORT = 6

   Still need the live project (flag ON, test clinic):
     STORAGE-01 upload lands, STORAGE-05 path guessing, STORAGE-06 RLS
     refusal, STORAGE-07 no public URL. F10-F13 in test_live_functions.mjs
     cover the upload half of those.

   Run: node supabase-v2/scripts/test_photo_validation.mjs
   ===================================================================== */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AUTH_TS = path.join(ROOT, 'edge-functions', '_shared', 'auth.ts')
const PHOTOS_TS = path.join(ROOT, 'edge-functions', 'patient-photos', 'index.ts')
const BUCKET_SQL = path.join(ROOT, 'migrations', '0009_storage_policies.sql')
const REPORTS_SQL = path.join(ROOT, 'migrations', '0004_reports.sql')

let acorn = null
try { acorn = require('acorn') } catch { acorn = null }

let passed = 0, failed = 0
const ok = (id, what, d = '') => { passed++; console.log('  PASS  ' + id.padEnd(6) + ' ' + what + (d ? ' — ' + d : '')) }
const bad = (id, what, d = '') => { failed++; console.log('  FAIL  ' + id.padEnd(6) + ' ' + what + (d ? ' — ' + d : '')) }
const is = (id, what, cond, d = '') => (cond ? ok(id, what, d) : bad(id, what, d))

console.log('')
console.log('==== OFFLINE PHOTO VALIDATION TESTS (no network, no flag) ====')
console.log('')

if (!acorn) {
  console.log('  FAIL  acorn is required to read the real validators from source.')
  console.log('        Run:  cd supabase-v2/scripts && npm install')
  console.log('')
  process.exit(2)
}

/* ---------------------------------------------------------------------
   EXTRACTOR — pull named top-level declarations out of a real .ts file.
   auth.ts is Deno code (Deno.env, an esm.sh import) and cannot be imported
   into Node, but the validators we want are pure. acorn gives exact source
   ranges, so the text we evaluate IS the text that is deployed; unwrapping
   ExportNamedDeclaration is what keeps the leading `export ` out of the slice.
   --------------------------------------------------------------------- */
function extract(source, fileLabel, wanted) {
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', ranges: true })
  const found = {}
  for (const node of ast.body) {
    const decl = node.type === 'ExportNamedDeclaration' ? node.declaration : node
    if (!decl) continue
    if (decl.type === 'FunctionDeclaration' && decl.id && wanted.includes(decl.id.name)) {
      found[decl.id.name] = source.slice(decl.start, decl.end)
    } else if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id && d.id.type === 'Identifier' && wanted.includes(d.id.name)) {
          found[d.id.name] = source.slice(decl.start, decl.end)
        }
      }
    }
  }
  const missing = wanted.filter(function (n) { return !found[n] })
  if (missing.length) {
    throw new Error(fileLabel + ' no longer declares: ' + missing.join(', ') +
      ' — update this test to match the source, never let it shrink silently.')
  }
  return found
}

// Explicit, so a rename in auth.ts FAILS loudly instead of quietly reducing
// what is covered.
const WANTED = ['MAX_PHOTOS_PER_REPORT', 'MAX_BYTES_PER_PHOTO', 'ALLOWED_MIME', 'ALLOWED_EXT',
  'extFromName', 'extFromMime', 'sniffType', 'validatePhoto']

const authSrc = fs.readFileSync(AUTH_TS, 'utf8')
let V
try {
  const found = extract(authSrc, '_shared/auth.ts', WANTED)
  const code = WANTED.map(function (n) { return found[n] }).join('\n')
  V = new vm.Script(code + '\n;({ ' + WANTED.join(', ') + ' })').runInContext(vm.createContext({}))
  is('PV-00', 'extracted the real validators from _shared/auth.ts',
     WANTED.every(function (n) { return typeof V[n] !== 'undefined' }),
     WANTED.length + ' declarations')
} catch (error) {
  console.log('  FAIL  PV-00  could not load _shared/auth.ts — ' + error.message)
  console.log('')
  console.log('==== EXTRACTION FAILED — no result below is trustworthy ====')
  console.log('')
  process.exit(2)
}

// ---- extractor self-test: trust the tool before its verdict -------------
// If `extract` silently returned nothing, every assertion below would run
// against undefined and "pass" for entirely the wrong reason. parse_check.mjs
// sets the same precedent, for the same reason.
try {
  const good = extract('export const A = 1\nexport function f(){ return A }\n', 'good', ['A', 'f'])
  const probe = new vm.Script(good.A + '\n' + good.f + '\n;({ A, f })').runInContext(vm.createContext({}))
  let threw = false
  try { extract('export const A = 1\n', 'incomplete', ['A', 'f']) } catch { threw = true }
  is('PV-01', 'extractor self-test (reads a good module, rejects an incomplete one)',
     probe.A === 1 && probe.f() === 1 && threw,
     'A=1, f()=1, missing name throws')
} catch (error) {
  bad('PV-01', 'extractor self-test', error.message)
}

/* =====================================================================
   STORAGE-02 — content sniffing.
   The declared MIME must agree with the ACTUAL first bytes, so a PDF or an
   .exe renamed to .jpg is refused before any byte reaches Storage.
   ===================================================================== */
console.log('')
console.log('---- STORAGE-02 · content sniffing ----')

const bytesOf = function () { return new Uint8Array(Array.prototype.slice.call(arguments)) }
const JPEG = bytesOf(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46)
const PNG = bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00)
// WebP is 'RIFF' + 4 size bytes + 'WEBP' = 12 header bytes, and sniffType()
// tests `b.length > 12`, so the stub needs real chunk bytes after it. The
// first version of this file used a bare 12-byte stub and PV-12 failed — the
// guard was right and the fixture was wrong.
const WEBP = bytesOf(0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  0x56, 0x50, 0x38, 0x20)
const WEBP_TRUNCATED = bytesOf(0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50)
const PDF = bytesOf(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37)   // %PDF-1.7
const ELF = bytesOf(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00)   // a Linux binary

is('PV-10', 'a real JPEG sniffs as image/jpeg', V.sniffType(JPEG) === 'image/jpeg')
is('PV-11', 'a real PNG sniffs as image/png', V.sniffType(PNG) === 'image/png')
is('PV-12', 'a real WebP sniffs as image/webp', V.sniffType(WEBP) === 'image/webp')

// A 12-byte RIFF/WEBP header with no chunk is not a usable image, and the
// `length > 12` guard refuses it. Worth pinning: it is the safe direction,
// and if the guard is ever loosened this is the test that notices.
is('PV-12b', 'a 12-byte truncated WebP (header only) is refused',
   V.sniffType(WEBP_TRUNCATED) === '', 'sniffType="" expected')

// The heart of STORAGE-02: these must return '' so the caller refuses.
is('PV-13', 'a PDF is NOT recognised as any image',
   V.sniffType(PDF) === '', 'sniffType(PDF)="' + V.sniffType(PDF) + '"')
is('PV-14', 'an ELF binary is NOT recognised as any image',
   V.sniffType(ELF) === '', 'sniffType(ELF)="' + V.sniffType(ELF) + '"')

// The decision patient-photos/index.ts actually makes: sniff, then compare
// against the DECLARED mime, refusing on either gap. validatePhoto alone
// cannot catch this — it never sees the bytes — so this assertion exists to
// pin the pairing, not to re-test validatePhoto.
function acceptsUpload(bytes, declaredMime) {
  const problem = V.validatePhoto({ mime: declaredMime, name: 'photo-1.jpg', bytes: bytes.length, index: 1 })
  if (problem) return { ok: false, why: 'validatePhoto: ' + problem }
  const actual = V.sniffType(bytes)
  if (!actual) return { ok: false, why: 'not a readable image (415)' }
  if (actual !== declaredMime) return { ok: false, why: 'declared ' + declaredMime + ' but contents are ' + actual + ' (415)' }
  return { ok: true, why: 'accepted' }
}

const fake = acceptsUpload(PDF, 'image/jpeg')
is('PV-15', 'STORAGE-02: fake.jpg holding a PDF is REFUSED', fake.ok === false, fake.why)
const honest = acceptsUpload(JPEG, 'image/jpeg')
is('PV-16', 'an honest JPEG is still accepted (the sniff is not refusing everything)',
   honest.ok === true, honest.why)

// STORAGE-02 also covers a disguised EXTENSION, which validatePhoto does see.
const extFake = V.validatePhoto({ mime: 'image/jpeg', name: 'evil.pdf', bytes: 2048, index: 1 })
is('PV-17', 'a .pdf extension is refused even with a valid declared mime',
   !!extFake, extFake || 'ACCEPTED — BAD')
const exeFake = V.validatePhoto({ mime: 'image/png', name: 'payload.exe', bytes: 2048, index: 1 })
is('PV-18', 'a .exe extension is refused', !!exeFake, exeFake || 'ACCEPTED — BAD')

// Source-drift guards: these decisions live in index.ts, not auth.ts, so they
// cannot be executed here. Assert the guard is still PRESENT in the source
// rather than pretending it was tested.
const photosSrc = fs.readFileSync(PHOTOS_TS, 'utf8')
is('PV-19', 'patient-photos/index.ts still sniffs and rejects an unreadable payload',
   /sniffType\(bytes\)/.test(photosSrc) && /not a readable image/.test(photosSrc))
is('PV-20', 'patient-photos/index.ts still rejects a declared/actual mime mismatch',
   /actual\s*!==\s*mime/.test(photosSrc))

/* =====================================================================
   STORAGE-03 — per-file size cap.
   Three limits have to agree, or a photo accepted by the function is
   rejected later by Storage or by the database CHECK, and the doctor gets
   "could not be uploaded" with no way to tell which layer refused it.
     1. MAX_BYTES_PER_PHOTO   _shared/auth.ts    (the function's own cap)
     2. file_size_limit       0009               (the bucket's cap)
     3. photo_size_sane       0004 report_photos (the column CHECK)
   ===================================================================== */
console.log('')
console.log('---- STORAGE-03 · per-file size cap ----')

const CAP = V.MAX_BYTES_PER_PHOTO
const over = V.validatePhoto({ mime: 'image/png', name: 'big.png', bytes: CAP + 1, index: 1 })
is('PV-30', 'STORAGE-03: one byte OVER the cap is refused',
   !!over && /larger than/i.test(over), over || 'ACCEPTED — BAD')
const atCap = V.validatePhoto({ mime: 'image/png', name: 'edge.png', bytes: CAP, index: 1 })
is('PV-31', 'exactly AT the cap is accepted (the boundary is inclusive)',
   atCap === null, atCap || 'accepted')
is('PV-32', 'an empty photo is refused',
   /empty/i.test(V.validatePhoto({ mime: 'image/png', name: 'e.png', bytes: 0, index: 1 }) || ''))
is('PV-33', 'a negative size is refused',
   !!V.validatePhoto({ mime: 'image/png', name: 'n.png', bytes: -1, index: 1 }))
is('PV-34', 'a non-numeric size is refused',
   !!V.validatePhoto({ mime: 'image/png', name: 'x.png', bytes: NaN, index: 1 }))
is('PV-35', 'a missing size is refused',
   !!V.validatePhoto({ mime: 'image/png', name: 'u.png', index: 1 }))

const bucketSql = fs.readFileSync(BUCKET_SQL, 'utf8')
const reportsSql = fs.readFileSync(REPORTS_SQL, 'utf8')

// The bucket's cap is POSITIONAL, not adjacent to its column name: 0009
// writes `INSERT INTO storage.buckets (id, name, public, file_size_limit,
// allowed_mime_types) VALUES (..., 15728640, ...)`. The first version of this
// file grepped for `file_size_limit <number>` and read NaN, because that
// pairing appears nowhere in the file. So read the tuple properly.
function bucketFileSizeLimit(sql) {
  const head = /INSERT\s+INTO\s+storage\.buckets[\s\S]*?VALUES\s*\(/i.exec(sql)
  if (!head) return NaN
  const start = head.index + head[0].length
  let depth = 1, i = start
  while (i < sql.length && depth > 0) {
    if (sql[i] === '(') depth++
    else if (sql[i] === ')') depth--
    i++
  }
  const tuple = sql.slice(start, i - 1)
  const parts = []
  let d = 0, cur = ''
  for (const ch of tuple) {
    if (ch === '(' || ch === '[') d++
    else if (ch === ')' || ch === ']') d--
    if (ch === ',' && d === 0) { parts.push(cur); cur = '' } else cur += ch
  }
  parts.push(cur)
  // (id, name, public, file_size_limit, allowed_mime_types) -> index 3
  return Number((parts[3] || '').trim())
}

const bucketLimit = bucketFileSizeLimit(bucketSql)
const colLimit = Number((/byte_size\s*>=\s*0\s+AND\s+byte_size\s*<=\s*(\d+)/.exec(reportsSql) || [])[1])

is('PV-36', 'the bucket file_size_limit is readable from 0009', bucketLimit > 0, bucketLimit + ' bytes')
is('PV-37', 'the report_photos byte_size CHECK is readable from 0004', colLimit > 0, colLimit + ' bytes')
is('PV-38', 'the function cap is not LARGER than the bucket cap',
   CAP <= bucketLimit, CAP + ' <= ' + bucketLimit)
is('PV-39', 'the function cap is not LARGER than the column CHECK',
   CAP <= colLimit, CAP + ' <= ' + colLimit)

/* =====================================================================
   STORAGE-04 — MAX_PHOTOS_PER_REPORT.
   The per-report count lives in three places that must agree: this
   constant, index.js's form limit, and the report_photos CHECK.
   ===================================================================== */
console.log('')
console.log('---- STORAGE-04 · MAX_PHOTOS_PER_REPORT ----')

is('PV-40', 'STORAGE-04: MAX_PHOTOS_PER_REPORT is 6',
   V.MAX_PHOTOS_PER_REPORT === 6, String(V.MAX_PHOTOS_PER_REPORT))

const accepted = [], refused = []
for (let i = 1; i <= V.MAX_PHOTOS_PER_REPORT; i++) {
  if (V.validatePhoto({ mime: 'image/png', name: 'p' + i + '.png', bytes: 2048, index: i }) === null) accepted.push(i)
}
for (const bad of [0, -1, 7, 1.5, '2', null, undefined, NaN]) {
  if (V.validatePhoto({ mime: 'image/png', name: 'x.png', bytes: 2048, index: bad })) refused.push(String(bad))
}
is('PV-41', 'every position 1..6 is accepted',
   accepted.length === V.MAX_PHOTOS_PER_REPORT, 'accepted ' + accepted.join(','))
is('PV-42', 'every position outside 1..6 is refused (0, -1, 7, 1.5, "2", null, undefined, NaN)',
   refused.length === 8, 'refused ' + refused.join(','))

const idxRange = Number((/index_no\s+BETWEEN\s+(\d+)\s+AND\s+(\d+)/.exec(reportsSql) || [])[2])
is('PV-43', 'the report_photos CHECK index_no upper bound matches MAX_PHOTOS_PER_REPORT',
   idxRange === V.MAX_PHOTOS_PER_REPORT,
   'CHECK says ' + idxRange + ', constant says ' + V.MAX_PHOTOS_PER_REPORT)

// The count guard itself is in index.ts, so assert it is present in source.
is('PV-44', 'patient-photos/index.ts still rejects more than MAX_PHOTOS_PER_REPORT per report',
   /incoming\.length\s*>\s*MAX_PHOTOS_PER_REPORT/.test(photosSrc) &&
   /At most \$\{MAX_PHOTOS_PER_REPORT\} photos per report/.test(photosSrc))

// A mime that is simply not on the allowlist must never pass.
const svg = V.validatePhoto({ mime: 'image/svg+xml', name: 'p.svg', bytes: 2048, index: 1 })
is('PV-45', 'a non-allowlisted mime (image/svg+xml) is refused', !!svg, svg || 'ACCEPTED — BAD')

console.log('')
const parts = []
if (failed) parts.push(failed + ' FAILED')
console.log('==== ' + (parts.length ? parts.join(' / ') : 'OFFLINE PHOTO VALIDATION OK') +
  ' — ' + passed + ' passed, ' + failed + ' failed (' + (passed + failed) + ' checks) ====')
console.log('')
process.exit(failed ? 1 : 0)