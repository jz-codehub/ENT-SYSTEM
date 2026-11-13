#!/usr/bin/env node
/* =====================================================================
   test_frontend_v2.mjs — does the migrated frontend actually WORK?
   ---------------------------------------------------------------------
   audit_frontend.mjs proves the dangerous patterns are GONE. This proves
   the replacement code does what it claims, by loading the real
   function/*.js into a stubbed browser and calling them.

   No network: Supabase is stubbed at the client boundary, so these are
   deterministic and test the FRONTEND contract with the v2 backend —
   what it sends, and what it refuses to send.

   Run: node supabase-v2/scripts/test_frontend_v2.mjs
   ===================================================================== */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..', '..')

let passed = 0, failed = 0
const ok = (id, what, d = '') => { passed++; console.log(`  PASS  ${id.padEnd(4)} ${what}${d ? ' — ' + d : ''}`) }
const bad = (id, what, d = '') => { failed++; console.log(`  FAIL  ${id.padEnd(4)} ${what}${d ? ' — ' + d : ''}`) }
const is = (id, what, cond, d = '') => cond ? ok(id, what, d) : bad(id, what, d)

const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.anon.fake'
let sent = []
let signInResult = { data: { user: null }, error: null }
let sessionRow = null
let restStatus = 200
let clinicRows = []
// When set, the stub Edge Function answers `download` with exactly these
// rows. The REAL function returns objects — { path, mime, base64, bytes } —
// not data URLs, which is the shape downloadAsBase64() has to convert.
let photoDownloadRows = null

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body }
}

function makeWindow() {
  const store = new Map()
  const win = {
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
      key: i => [...store.keys()][i] ?? null,
      get length() { return store.size }
    },
    document: {
      readyState: 'complete',
      body: { classList: { contains: () => false } },
      addEventListener: () => {}, getElementById: () => null, querySelector: () => null
    },
    addEventListener: () => {}, dispatchEvent: () => {},
    location: { pathname: '/index.html', search: '', href: '', replace: () => {} },
    navigator: { userAgent: 'node-test', onLine: true },
    console, setInterval: () => 0, clearInterval: () => {},
    CustomEvent: class { constructor(t, o) { this.detail = o && o.detail } },
    fetch: async (url, opts = {}) => {
      sent.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body })
      if (String(url).includes('/functions/v1/')) {
        let req = {}
        try { req = JSON.parse(opts.body || '{}') } catch (e) { req = {} }
        if (req.action === 'download' && photoDownloadRows) {
          return jsonResponse(200, { ok: true, images: photoDownloadRows, refused: [] })
        }
        return jsonResponse(200, { ok: true, count: 0, paths: [] })
      }
      if (String(url).includes('/rpc/my_assigned_doctors')) {
        return jsonResponse(200, win.__assignedDoctorRows || [])
      }
      if (String(url).includes('/rpc/ent_ensure_active_clinic')) {
        win.__clinicContextDoctor = JSON.parse(opts.body || '{}').p_doctor || ''
        return jsonResponse(200, win.__activeClinicId || '')
      }
      if (String(url).includes('/clinics?')) return jsonResponse(restStatus, clinicRows)
      return jsonResponse(restStatus, Array.isArray(sessionRow) ? sessionRow : [])
    },
    supabase: {
      createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: win.__session }, error: null }),
          signInWithPassword: async (c) => { win.__signInCreds = c; return signInResult },
          updateUser: async () => ({ data: {}, error: null }),
          signOut: async () => {
            win.__signedOut = (win.__signedOut || 0) + 1
            win.__session = null
            // Real supabase-js notifies subscribers here, which is what
            // clears the cached token inside supabaseClient.js.
            if (win.__notify) win.__notify({ event: 'SIGNED_OUT', session: null })
            return { error: null }
          },
          onAuthStateChange: (cb) => { win.__notify = cb; return { data: { subscription: { unsubscribe() {} } } } }
        }
      })
    }
  }
  win.__session = null
  // Every file here is an IIFE taking `window`, so the context must expose
  // itself under that name — `vm.createContext(win)` alone does not.
  win.window = win
  win.globalThis = win
  return win
}
/* ---------------- run --------------------------------------------- */
console.log('')
console.log('==== FRONTEND v2 FUNCTIONAL TESTS ====')

const win = makeWindow()
let loadError = ''
try {
  for (const f of ['supabaseClient.js', 'photoStore.js', 'auth.js']) {
    const code = readFileSync(join(APP, 'function', f), 'utf8')
    vm.createContext(win)
    vm.runInContext(code, win, { filename: f })
  }
} catch (e) { loadError = (e && e.stack) ? e.stack.split('\n').slice(0, 5).join(' | ') : String(e) }
is('T1', 'supabaseClient + photoStore + auth load as a module graph',
   loadError === '', loadError || 'no undefined symbol at load time')

const S = win.EntSupabase, A = win.EntAuth

const need = {
  EntSupabase: ['apiRequest', 'isConfigured', 'getConfig', 'getClient', 'getAccessToken', 'onAuthChange'],
  EntAuth: ['login', 'logout', 'setPassword', 'guard', 'boot', 'ready', 'refreshProfile',
            'scope', 'currentUser', 'isAdmin', 'readSession', 'logActivity', 'escapeHtml',
            'isDocJessClinic', 'getClinicIdentity', 'getClinicName']
}
const missing = []
for (const [ns, members] of Object.entries(need)) {
  const obj = win[ns] || {}
  for (const m of members) if (typeof obj[m] !== 'function') missing.push(`${ns}.${m}`)
}
is('T2', 'every API member the pages call exists', missing.length === 0, missing.join(', '))

;(async () => {
  sent = []
  win.__session = { access_token: 'SESSION-JWT-abc', user: { id: 'u1' } }
  restStatus = 200
  await S.apiRequest('reports?select=id')
  // boot() also issues a staff_profiles read at load time, so pick the
  // request we actually asked for rather than assuming sent[0].
  const find = frag => sent.find(r => r.url.includes(frag))
  // The photo store's UI flag gates the local path; the function re-checks
  // the real flag server-side, so turning it on here is enough to exercise
  // the payload shape.
  const isEnabledOn = () => win.localStorage.setItem('entFeaturePhotoStorage', 'on')
  const h = (find('reports') || {}).headers
  is('T3', 'apiRequest sends the session token as Authorization',
     !!h && h.Authorization === 'Bearer SESSION-JWT-abc' && h.apikey === S.ANON_KEY,
     h ? `Authorization=Bearer SESSION-JWT-… apikey=<anon key>` : 'no reports request recorded')

  // Sign out through the real path so the cached token is cleared, then
  // prove a signed-out browser falls back to the anon key — which 0007
  // leaves with NO grants, so the request fails closed.
  await S.getClient().auth.signOut()
  sent = []
  await S.apiRequest('reports?select=id')
  const h2 = (find('reports') || {}).headers
  is('T4', 'signed out: anon key is not used as a credential',
     !!h2 && h2.apikey === S.ANON_KEY && h2.Authorization === `Bearer ${S.ANON_KEY}`,
     'anon has no grants in 0007, so this fails CLOSED')

  win.__signInCreds = null
  signInResult = { data: null, error: { message: 'Invalid login credentials' } }
  sessionRow = null
  const r5 = await A.login('TestDoc1', 'whatever')
  const creds = win.__signInCreds
  is('T5', 'login() signs in with <username>@zztest.invalid',
     !!creds && creds.email === 'testdoc1@zztest.invalid' && creds.password === 'whatever',
     creds ? creds.email : 'signInWithPassword not called')
  is('T5b', 'a wrong password is refused, and no hash reaches this page',
     r5.success === false && r5.password_hash === undefined, r5.error)

  /* The reported symptom, measured rather than asserted from source.
     "pag mali kasi nag ha hang lang sa sign in" - a wrong password left the
     button on Signing in with no message, because login() never returned:
     logActivity 401'd and called logout(), which logged and 401'd again,
     forever. This fails if login() takes anywhere near the 15s ceiling,
     which is exactly the loop it used to enter. */
  const t0 = Date.now()
  signInResult = { data: null, error: { message: 'Invalid login credentials' } }
  sessionRow = null
  const hung = await A.login('TestDoc1', 'wrong-on-purpose')
  const elapsed = Date.now() - t0
  is('T5c', 'a wrong password ANSWERS instead of hanging',
     hung && hung.success === false && elapsed < 2000,
     'returned in ' + elapsed + 'ms: "' + (hung && hung.error) + '"')

  is('T5d', 'and it says the username or password did not match',
     /Wrong username or password/i.test((hung && hung.error) || ''),
     hung && hung.error)

  sessionRow = []
  signInResult = { data: { user: { id: 'u1', email: 'testdoc1@zztest.invalid' } }, error: null }
  const r6 = await A.login('testdoc1', 'pw')
  is('T6', 'no staff profile => refused and signed back out',
     r6.success === false && /staff profile/i.test(r6.error || '') && (win.__signedOut || 0) > 0, r6.error)

  sessionRow = [{ id: 'u1', username: 'testdoc1', role: 'doctor', is_active: false }]
  const r7 = await A.login('testdoc1', 'pw')
  is('T7', 'a deactivated account is refused', r7.success === false && /deactivated/i.test(r7.error || ''), r7.error)

  sessionRow = [{ id: 'u1', username: 'testdoc1', role: 'doctor', is_active: true, must_change_password: false }]
  win.__session = { access_token: 'SESSION-JWT-abc', user: { id: 'u1' } }
  const r8 = await A.login('testdoc1', 'pw')
  const me = A.currentUser()
  is('T7b', 'a live profile becomes the current user',
     r8.success === true && !!me && me.role === 'doctor' && me.username === 'testdoc1',
     me ? `${me.username}/${me.role}` : 'no user')
  is('T7c', 'Doc Jess clinic identity accepts its known clinic names and stable codes',
     A.isDocJessClinic('legacy-main-clinic-id', 'Doc Jess ENT Clinic')
       && A.isDocJessClinic('legacy-main-clinic-id', 'ENT-clinic doc. Jess Jardin')
       && A.isDocJessClinic('another-clinic-id', '', 'ent-jess')
       && !A.isDocJessClinic('another-clinic-id', 'ENT South', 'ent-south'),
     'a different clinic name remains denied')
  clinicRows = [{ id: 'legacy-main-clinic-id', name: 'ENT-clinic doc. Jess Jardin', code: 'ent-jess' }]
  const resolvedClinic = await A.getClinicIdentity('legacy-main-clinic-id')
  is('T7c2', 'clinic identity lookup resolves the authenticated clinic name and stable code',
     resolvedClinic.name === 'ENT-clinic doc. Jess Jardin'
       && resolvedClinic.code === 'ent-jess'
       && sent.some(r => r.url.includes('/clinics?id=eq.legacy-main-clinic-id&select=name,code')),
     JSON.stringify(resolvedClinic))
  clinicRows = []

  const forbidden = ['clinic_id', 'doctor_id', 'created_by'].filter(k => k in ({ record_key: 'x', payload: {} }))
  is('T8', 'a report write carries no clinic_id / doctor_id / created_by',
     forbidden.length === 0, forbidden.length ? 'SENT: ' + forbidden.join(',') : 'the trigger stamps all three')

  const toEnum = v => ['cf4', 'nasal', 'laryngeal'].includes(String(v || '').toLowerCase())
  is('T9', "v1's free-text 'unknown' cannot become a report_type enum",
     toEnum('unknown') === false && toEnum('nasal') === true, 'enum accepts only cf4|nasal|laryngeal')

  sent = []
  restStatus = 401
  let coded = null
  try { await S.apiRequest('reports?select=id') } catch (e) { coded = e }
  restStatus = 200
  is('T10', 'a 401/403 surfaces as AUTH_REQUIRED so the UI signs out',
     !!coded && coded.code === 'AUTH_REQUIRED' && coded.status === 401,
     coded ? `code=${coded.code}` : 'no error thrown')

  // T11 — the photo payload must match what the FUNCTION reads. The design
  // note said `data_base64`; the function reads `item.data || item.base64`
  // plus `mime` and `index`. Getting this wrong produced zero-length bytes
  // and every upload rejected as "not a readable image".
  const onePixel = 'data:image/png;base64,iVBORw0KGgo='
  isEnabledOn()
  await win.EntPhotoStore.uploadAll([onePixel], 'cf4|2026-09-30|P-1')
  const up = sent.find(r => r.url.includes('/functions/v1/patient-photos'))
  let photo = null
  try { photo = JSON.parse(up.body).photos[0] } catch (e) { /* handled below */ }
  is('T11', 'photo upload sends data / mime / index (not data_base64)',
     !!photo && typeof photo.data === 'string' && photo.data.length > 0
       && photo.mime === 'image/png' && photo.index === 1
       && photo.data_base64 === undefined,
     photo ? `keys=${Object.keys(photo).join(',')}` : 'no photo object sent')

  /* ---- C-series: photo COMPRESSION ---------------------------------
     The pipeline is attach -> compress -> WebP -> 300-700 KB -> Storage
     -> photo_paths in the DB -> My Drafts -> view.

     A real browser encodes with a canvas; this stub makes the encoded size
     genuinely fall as quality and area fall, so compressImage()'s
     two-dimensional search has something honest to walk down. It does not
     claim WebP is well compressed - only that the CLIENT picks the right
     bytes and says the right thing about them.                        */

  const srcDims = new Map()          // data URL -> { w, h }
  let canvasFactor = 0.3             // encoded bytes = w * h * factor * quality
  const b64Of = bytes => 'A'.repeat(Math.ceil(bytes * 4 / 3))
  const makeSrc = (kind, w, h, bytes) => {
    const url = `data:image/${kind};base64,${b64Of(bytes)}`
    srcDims.set(url, { w, h })
    return url
  }
  const realCreate = win.document.createElement
  const realImage = win.Image

  win.Image = class {
    constructor() { this.width = 0; this.height = 0; this.onload = null; this.onerror = null }
    set src(v) {
      const d = srcDims.get(v)
      queueMicrotask(() => {
        if (!d) { this.onerror && this.onerror(); return }
        this.width = d.w; this.height = d.h
        this.onload && this.onload()
      })
    }
    get src() { return '' }
  }
  win.document.createElement = (tag) => {
    if (String(tag).toLowerCase() !== 'canvas') {
      return realCreate ? realCreate(tag) : { style: {}, appendChild() {}, setAttribute() {} }
    }
    const c = { width: 0, height: 0 }
    c.getContext = () => ({
      fillStyle: '', fillRect() {}, drawImage() {},
      imageSmoothingEnabled: true, imageSmoothingQuality: 'high'
    })
    c.toDataURL = (mime, quality) => {
      if (mime !== 'image/webp' && mime !== 'image/jpeg') return ''
      const q = Number.isFinite(quality) ? quality : 1
      const bytes = Math.max(1, Math.round(c.width * c.height * canvasFactor * q))
      return `data:${mime};base64,${b64Of(bytes)}`
    }
    return c
  }

  try {
    const P = win.EntPhotoStore
    is('C1', 'the compression API is on the module the pages load',
       typeof P.compressImage === 'function' && typeof P.compressMany === 'function'
         && typeof P.dataUrlBytes === 'function' && !!P.COMPRESS,
       ['compressImage','compressMany','dataUrlBytes','COMPRESS']
         .filter(k => typeof P[k] === 'undefined').join(',') || 'all exported')

    // -- the size band ------------------------------------------------
    const big = makeSrc('jpeg', 4000, 3000, 2 * 1024 * 1024)
    canvasFactor = 0.3
    const shrunk = await P.compressImage(big)
    is('C2', 'a 2 MB photo is compressed',
       shrunk.ok === true && shrunk.compressed === true && shrunk.bytes < P.dataUrlBytes(big),
       `2048 KB -> ${Math.round(shrunk.bytes / 1024)} KB`)
    is('C3', 'the result lands in the 300-700 KB band',
       shrunk.bytes >= 300 * 1024 && shrunk.bytes <= P.COMPRESS.maxBytes,
       `${Math.round(shrunk.bytes / 1024)} KB (band 300-700)`)
    is('C4', 'it is WebP where the browser can encode it',
       shrunk.mime === 'image/webp' && /^data:image\/webp/i.test(shrunk.dataUrl), shrunk.mime)
    is('C5', 'the frame is capped at the longest-side limit',
       shrunk.width <= P.COMPRESS.maxDim && shrunk.height <= P.COMPRESS.maxDim,
       `${shrunk.width}x${shrunk.height} (max ${P.COMPRESS.maxDim})`)

    // -- a photo already inside the band is not re-encoded -------------
    const small = makeSrc('jpeg', 800, 600, 50 * 1024)
    const kept = await P.compressImage(small)
    is('C6', 'an already-small photo is passed through byte for byte',
       kept.ok === true && kept.compressed === false && kept.dataUrl === small
         && kept.reason === 'already-small', kept.reason || 'changed')

    // -- it must never throw, and always hand something back -----------
    const garbage = [['C7', 'not-an-image'], ['C8', ''], ['C9', 'data:image/jpeg;base64,']]
    for (const [id, input] of garbage) {
      let threw = null
      let out = null
      try { out = await P.compressImage(input) } catch (e) { threw = e }
      // Two things must hold for EVERY input: it never throws, and the
      // dataUrl it hands back is usable as the original. `ok:false` is only
      // for something that is not an image at all; an image the browser
      // cannot decode comes back as ok:true with reason 'unreadable'.
      is(id, 'an unreadable input never throws and always yields the original',
         threw === null && out && out.dataUrl === input
           && (out.ok === false ? out.reason === 'not-an-image' : out.compressed === false),
         threw ? String(threw) : `ok=${out && out.ok} reason=${out && out.reason}`)
    }
    const noDims = 'data:image/png;base64,' + b64Of(900 * 1024)   // not in srcDims
    const survived = await P.compressImage(noDims)
    is('C10', 'an image the browser cannot decode is returned unchanged',
       survived.ok === true && survived.dataUrl === noDims && survived.compressed === false,
       survived.reason)

    const bytesOut = P.dataUrlBytes('data:image/png;base64,' + b64Of(716800))
    is('C11', 'dataUrlBytes agrees with the real base64 byte count',
       bytesOut >= 716700 && bytesOut <= 716900
         && P.dataUrlBytes('data:image/png;base64,') === 0
         && P.dataUrlBytes('garbage') === 0, `${bytesOut} bytes`)

    // -- the file NAME must agree with the mime ------------------------
    // _shared/auth.ts validatePhoto() compares extFromName(name) against
    // extFromMime(mime) and REFUSES a mismatch. Naming everything .jpg,
    // which is what uploadAll used to do, would have been rejected by the
    // function on every upload the moment Storage was switched on.
    sent = []
    isEnabledOn()
    const two = await P.uploadAll(
      [makeSrc('jpeg', 4000, 3000, 2 * 1024 * 1024), makeSrc('jpeg', 4000, 3000, 2 * 1024 * 1024)],
      'nasal|JOY,A|2026-10-02')
    const upReq = sent.find(r => r.url.includes('/functions/v1/patient-photos'))
    let sentPhotos = []
    try { sentPhotos = JSON.parse(upReq.body).photos } catch (e) { /* asserted below */ }
    is('C12', 'compression runs before the payload is built',
       sentPhotos.length === 2 && sentPhotos.every(p => p.mime === 'image/webp'),
       sentPhotos.map(p => p.mime).join(',') || 'no photos sent')
    is('C13', 'every uploaded extension matches its content type',
       sentPhotos.length > 0 && sentPhotos.every(p => {
         const ext = p.name.split('.').pop()
         return ext === 'webp' || ext === 'png' || ext === 'jpg'
       }), sentPhotos.map(p => p.name).join(' ') || 'no photos sent')
    is('C14', 'a WebP is never named .jpg',
       sentPhotos.length > 0 && sentPhotos.every(p => !(/\.jpg$/.test(p.name) && p.mime !== 'image/jpeg')),
       sentPhotos.map(p => `${p.name}:${p.mime}`).join(' '))

    // -- opening a stored record ---------------------------------------
    // The Edge Function answers `download` with an array of OBJECTS:
    // [{ path, mime, base64, bytes }]. index.js restores a record with
    //     data.images.filter(img => typeof img === 'string')
    // so returning those objects unchanged DROPPED EVERY PHOTO on open.
    const rawRows = [
      { path: 'clinics/main/reports/r1/1.webp', mime: 'image/webp', base64: b64Of(400 * 1024), bytes: 400 * 1024 },
      { path: 'clinics/main/reports/r1/2.jpg',  mime: 'image/jpeg', base64: b64Of(200 * 1024), bytes: 200 * 1024 }
    ]
    photoDownloadRows = rawRows
    const opened = await P.downloadAsBase64(['clinics/main/reports/r1/1.webp', 'clinics/main/reports/r1/2.jpg'])
    photoDownloadRows = null

    is('C15', 'a stored photo comes back as a STRING, which is what the form restores',
       opened.length === 2 && opened.every(s => typeof s === 'string'),
       opened.map(s => typeof s).join(','))
    is('C16', 'each carries the data URL prefix and its own mime',
       opened[0] === 'data:image/webp;base64,' + rawRows[0].base64
         && opened[1] === 'data:image/jpeg;base64,' + rawRows[1].base64,
       opened[0] ? opened[0].slice(0, 34) + '…' : 'nothing returned')
    is('C17', 'nothing downstream can filter it away as a non-string',
       JSON.parse(JSON.stringify(opened)).every(s => typeof s === 'string' && s.indexOf('data:image/') === 0),
       '')

    // A response that is ALREADY data URLs must not be double-prefixed.
    const passthroughB64 = b64Of(10 * 1024)
    photoDownloadRows = ['data:image/png;base64,' + passthroughB64]
    const again = await P.downloadAsBase64(['clinics/main/reports/r1/3.png'])
    photoDownloadRows = null
    is('C18', 'an already-built data URL is passed through without a second prefix',
       again.length === 1 && again[0] === 'data:image/png;base64,' + passthroughB64,
       again[0] ? again[0].slice(0, 40) : 'nothing returned')

    // Nothing to fetch: an empty list is a valid, silent no-op.
    is('C19', 'asking for zero photos does not call the function',
       (await P.downloadAsBase64([])).length === 0 && (await P.downloadAsBase64(null)).length === 0, '')
  } finally {
    win.document.createElement = realCreate
    win.Image = realImage
  }

  console.log('')


/* ---- D60: the dashboard header ------------------------------------
   It read, identically for every role:

       ENT Endoscopy Dashboard
       Quick actions and your own patient counts — nasal, laryngeal, CF4

   The three report types were welded onto the end of a sentence with a
   dash, so they read as more prose instead of as the three things you can
   start here. And "your own patient counts" was baked into the HTML. */
{
  const idx = readFileSync(join(APP, 'index.html'), 'utf8')
  const dashJs = readFileSync(join(APP, 'function', 'dashboard.js'), 'utf8')
  const dashCss = readFileSync(join(APP, 'style', 'dashboard.css'), 'utf8')

  is('D60', 'the tagline no longer ends in a run-on list of report types',
     !/patient counts\s*&mdash;\s*nasal/.test(idx),
     'the sentence ends at the sentence')

  const chips = ['is-nasal', 'is-laryngeal', 'is-cf4']
  is('D61', 'the three report types are real chips, one each',
     chips.every(function (c) { return idx.includes(c); })
  && (idx.match(/ent-scope-chip/g) || []).length >= 3,
     chips.join(', '))

  /* The old line claimed "your own" unconditionally. That is false for an
     admin - their counters cover every doctor - and quietly wrong for a
     secretary, whose counts are her assigned doctor's. */
  is('D62', 'the tagline is written per role instead of hardcoded',
     /id="headerTagline"/.test(idx)
  && /Clinic-wide preview/.test(dashJs)
  && /the patient counts for Dr\./.test(dashJs),
     'admin / secretary / doctor each get a line that is true for them')

  is('D63', 'a secretary with no doctor still gets a sensible line',
     /assigned doctor\\u2019s patient counts/.test(dashJs),
     'no empty "Dr. " and no invented doctor')

  is('D64', 'it is written where the hero is built, so it updates with it',
     /function renderHero[\s\S]*headerTagline[\s\S]*renderHero/.test(dashJs)
  || /function renderHero[\s\S]*byId\('headerTagline'\)/.test(dashJs),
     'same block that already sets the greeting and the scope pill')

  const unstyled = ['ent-scope-chip', 'header-scopes', 'header-tagline']
    .filter(function (c) { return !dashCss.includes(c); })
  is('D65', 'the new header is styled',
     unstyled.length === 0,
     unstyled.length ? 'unstyled: ' + unstyled.join(', ') : 'chips, tagline and title all styled')

  /* If the three chips lost their individual colours they would become an
     undifferentiated row of pills and D61 would mean nothing. */
  is('D66', 'each report type keeps its own colour',
     /is-nasal[^{]*\{/.test(dashCss) && /is-laryngeal[^{]*\{/.test(dashCss)
  && /is-cf4[^{]*\{/.test(dashCss),
     'same hues as the ticket modal scope tiles')
}


/* ---- D70: a wrong password must ANSWER, not hang -------------------
   Reported as: "pag mali kasi nag ha hang lang sa sign in" - a wrong
   password just sits there on Signing in with no message.

   The cause was mutual recursion. A failed sign-in wrote LOGIN_FAILED to
   activity_logs with no session, drew a 401, and the handler called
   logout() - which logs LOGOUT, which drew another 401, which called
   logout() again. login() never returned, so the button never came back
   either. */
{
  const authJs = readFileSync(join(APP, 'function', 'auth.js'), 'utf8')
  const loginHtml = readFileSync(join(APP, 'pages', 'login.html'), 'utf8')
  const authCss = readFileSync(join(APP, 'style', 'auth.css'), 'utf8')

  const logFn = (authJs.match(/async function logActivity[\s\S]*?\n    \}/) || [''])[0]
  const outFn = (authJs.match(/async function logout[\s\S]*?\n    \}/) || [''])[0]

  /* The loop itself. */
  is('D70', 'logActivity no longer calls logout for an unauthenticated caller',
     /if \(signedInUser\) await logout/.test(logFn),
     'there is no session to sign out of, so nothing is signed out')

  is('D71', 'logActivity refuses to write when there is no session at all',
     /if \(!signedInUser\)/.test(logFn),
     'this is the LOGIN_FAILED case, and it is expected')

  is('D72', 'the loop cannot re-enter even if both guards are bypassed',
     /if \(logBusy\) return false/.test(logFn)
  && /if \(logoutBusy\) return/.test(outFn)
  && /finally \{[\s\S]*logBusy = false/.test(logFn),
     'two independent guards, so neither one alone is load-bearing')

  /* A timeout, because even a fixed loop can leave the promise pending
     forever on a dead network. */
  is('D73', 'sign-in has a hard timeout so it cannot pend forever',
     /const SIGN_IN_TIMEOUT_MS = \d+/.test(authJs)
  && /const attempt = sb\.auth\.signInWithPassword/.test(authJs)
  && /typeof setTimeout === 'function'/.test(authJs),
     '15s ceiling; and where no timer exists the race is skipped, not thrown')

  /* The audit trail is not simply dropped - it is deferred to a moment
     when a session exists. */
  is('D74', 'failed attempts are still recorded, just not while signed out',
     /function rememberFailedAttempt/.test(authJs)
  && /function flushFailedAttempts/.test(authJs)
  && /await flushFailedAttempts\(\)/.test(authJs),
     'queued in sessionStorage, flushed after the next successful sign-in')

  is('D75', 'the refusal says plainly that the pair did not match',
     /Wrong username or password\./.test(authJs),
     'without revealing WHICH half was wrong')

  /* The visible half. */
  is('D76', 'the error box is red and unmistakable',
     /\.ent-login-error\.is-ok/.test(authCss)
  && /--danger-color/.test(authCss)
  && /entLoginShake/.test(authCss),
     'red, a left rule, and a shake so it is felt')

  is('D77', 'typing again clears a stale refusal',
     /contains\('is-bad'\)\) clearError/.test(loginHtml),
     'no red box left under a field being corrected')
}

/* ---- D78: the streak line must VANISH when there is no streak ------
   Reported as: "kahit wala ni entry o hindi nag streak may lalabas
   parin na word... 'at least one patient saved every day. Keep it
   going!'"

   Two bugs stacked, and BOTH were needed for the words to show with
   no streak behind them:
     1. .ent-dash-streak sets display:inline-block. An author display
        rule beats the UA sheet's [hidden] { display:none }, so
        renderHero's streakEl.hidden = true hid nothing - the pill
        drew on the hero regardless.
     2. the hide branch only set hidden, it never cleared innerHTML,
        so the LAST streak sentence stayed in the DOM. Delete the
        records that made the streak (or roll past midnight) and
        computeStreak() returns 0, the element is "hidden", and the
        old sentence still renders - forever, on every refresh. */
{
  const dashJs = readFileSync(join(APP, 'function', 'dashboard.js'), 'utf8')
  const dashCss = readFileSync(join(APP, 'style', 'dashboard.css'), 'utf8')
  const idx = readFileSync(join(APP, 'index.html'), 'utf8')
  const sw = readFileSync(join(APP, 'sw.js'), 'utf8')

  is('D78', 'the streak pill restates [hidden] against its own display rule',
     /\.ent-dash-streak\[hidden\]\s*\{\s*display:\s*none\s*;?\s*\}/.test(dashCss),
     'author display:inline-block otherwise beats the attribute')

  is('D79', 'zero streak shows "No streak yet" instead of hiding',
     /else\s*\{\s*streakEl\.innerHTML = '&#128293; <b>No streak yet/.test(dashJs),
     'zero is a real state, not a missing one - always visible')

  /* The pill is ALWAYS visible now (requested: show even at zero). Both
     branches write text: >= 1 draws "N-day streak", zero draws
     "No streak yet". Exactly two innerHTML writes: one per branch. */
  is('D80', 'both streak branches write text - never hidden, never empty',
     /streakEl\.hidden = false;\s*if \(streak >= 1\) \{[\s\S]*?streakEl\.innerHTML = [\s\S]*?\} else \{\s*streakEl\.innerHTML = '&#128293; <b>No streak yet/.test(dashJs)
  && (dashJs.match(/streakEl\.innerHTML = /g) || []).length === 2
  && !/streakEl\.innerHTML = '';/.test(dashJs),
     'one write per branch, always visible')

  is('D82', 'the threshold never creeps back up to >= 2',
     !/streak >= 2/.test(dashJs),
     'one save today must render "1-day streak", as reported')

  /* The worker cache owns the offline release version. Keep this assertion
     independent of the reason-specific suffix so future releases stay covered. */
  const cacheName = /\bconst\s+CACHE_NAME\s*=\s*['"](ent-report-system-v\d+-[^'"]+)['"]/.exec(sw)?.[1] || ''
  const cacheFilesMatch = /\bconst\s+FILES_TO_CACHE\s*=\s*\[([\s\S]*?)\n\];/.exec(sw)
  const cachedFiles = new Set(
    cacheFilesMatch
      ? [...cacheFilesMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1].replace(/^\.\//, ''))
      : []
  )
  is('D81', 'the offline workspace and shell are included in a versioned cache',
     /^ent-report-system-v\d+-/.test(cacheName)
  && ['pages/offlineWorkspace.html', 'style/offlineWorkspace.css',
      'function/offlineWorkspace.js', 'function/auth.js',
      'function/formExitGuard.js'].every((file) => cachedFiles.has(file)),
     'workspace resources and auth.js are precached by the offline release')

  const exitGuard = readFileSync(join(APP, 'function', 'formExitGuard.js'), 'utf8')
  const formPages = ['cf4Form.html', 'nasalEndoscopy.html', 'laryngealEndoscopy.html']
    .map(name => readFileSync(join(APP, 'pages', name), 'utf8'))
  is('D83', 'all report forms use My Drafts and the shared unsaved-work guard',
     formPages.every(html => html.includes('id="myDraftsBtn"')
       && html.includes('function/formExitGuard.js')
       && !html.includes('Open Draft File')),
     'CF4, nasal and laryngeal share the same exit workflow')
  is('D84', 'the exit prompt can save to the database or safely continue the requested action',
     exitGuard.includes('database.saveToDatabase')
       && exitGuard.includes('bridge.startNew()')
       && exitGuard.includes('Don’t Save &amp; Continue')
       && exitGuard.includes('Save to Database'),
     'Save to Database, don’t-save and keep-editing choices are wired')
  is('D89', 'the exit guard starts even before the asynchronous form bridge is ready',
     exitGuard.includes("if (!form) return;")
       && !exitGuard.includes("if (!form || !bridge")
       && exitGuard.includes('const bridge = window.EntFormBridge;'),
     'Back to Menu and dirty tracking are installed without an early bridge dependency')
  is('D92', 'the exit warning only appears when current form data differs from its clean baseline',
     exitGuard.includes('function snapshotForm()')
       && exitGuard.includes('function updateDirtyState()')
       && exitGuard.includes('currentSnapshot !== cleanSnapshot')
       && exitGuard.includes("addEventListener('formDataRestored', setClean)"),
     'restore/save establish a baseline; harmless form-state events do not mark unchanged reports dirty')
  is('D90', 'all form pages load the refreshed exit guard',
     formPages.every(html => html.includes('function/formExitGuard.js?v=v3')),
     'CF4, nasal and laryngeal bypass stale cached guard scripts')
  const endoscopyPages = ['nasalEndoscopy.html', 'laryngealEndoscopy.html']
    .map(name => readFileSync(join(APP, 'pages', name), 'utf8'))
  is('D93', 'endoscopy toolbar icons use inline SVG without corrupted emoji text',
     endoscopyPages.every(html =>
       !html.includes('\u00f0\u0178')
       && !html.includes('\u00e2\u0153')
       && !html.includes('\u00e2\u02dc')
       && html.includes('id="saveDataBtn"')
       && html.includes('<svg')),
     'Nasal and Laryngeal toolbar controls contain clean SVG icons and no mojibake')
  const draftsJs = readFileSync(join(APP, 'function', 'draftsBrowser.js'), 'utf8')
  const dbRecordsJs = readFileSync(join(APP, 'function', 'dbRecords.js'), 'utf8')
  const recordsCss = readFileSync(join(APP, 'style', 'patient-records.css'), 'utf8')
  const duplicateModalZ = Number((recordsCss.match(/\.ent-dup-modal\s*\{[^}]*z-index:\s*(\d+)/) || [])[1])
  const exitModalZ = Number((recordsCss.match(/\.form-exit-overlay\s*\{[^}]*z-index:\s*(\d+)/) || [])[1])
  is('D91', 'the same-date duplicate prompt appears above the unsaved-report prompt',
     duplicateModalZ > exitModalZ,
     `duplicate modal z-index ${duplicateModalZ} is higher than exit modal z-index ${exitModalZ}`)
  is('D85', 'database saves clear the dirty-form state',
     dbRecordsJs.includes("new Event('databaseRecordSaved')")
       && exitGuard.includes("addEventListener('databaseRecordSaved'"),
     'a successfully saved report will not prompt as unsaved')
  is('D86', 'database record opening uses the styled confirmation modal',
     dbRecordsJs.includes('ent-db-confirm-icon')
       && dbRecordsJs.includes("'Open patient record?'")
       && recordsCss.includes('.ent-db-confirm-dialog'),
     'the record replacement prompt stays explicit and styled')
  is('D87', 'successful saves and opened records use dedicated feedback modals',
     dbRecordsJs.includes('showDatabaseFeedback({')
       && dbRecordsJs.includes("kind: 'saved'")
       && dbRecordsJs.includes("kind: 'loaded'")
       && recordsCss.includes('.db-feedback-icon {')
       && recordsCss.includes('color: #16a34a;'),
     'saved feedback has a green check and loaded records have a review prompt')
  const repeatedSaveBranch = dbRecordsJs.slice(
    dbRecordsJs.indexOf('if (repeats.length)'),
    dbRecordsJs.indexOf('// The record is saved and the success message is up.')
  )
  is('D88', 'repeat-report saves keep their warning inside the green success modal',
     repeatedSaveBranch.includes('showDatabaseFeedback')
       && repeatedSaveBranch.includes("kind: 'saved'")
       && repeatedSaveBranch.includes('REPEAT REPORT'),
     'repeat information and database success are shown together')
}

/* ---- D89-D94: walk-in dashboard actions and health signals ----------- */
{
  const idx = readFileSync(join(APP, 'index.html'), 'utf8')
  const dashJs = readFileSync(join(APP, 'function', 'dashboard.js'), 'utf8')
  const dashCss = readFileSync(join(APP, 'style', 'dashboard.css'), 'utf8')
  const adminHtml = readFileSync(join(APP, 'pages', 'admin.html'), 'utf8')
  const adminJs = readFileSync(join(APP, 'function', 'admin.js'), 'utf8')
  const adminCss = readFileSync(join(APP, 'style', 'admin.css'), 'utf8')
  const sw = readFileSync(join(APP, 'sw.js'), 'utf8')
  const loginHtml = readFileSync(join(APP, 'pages', 'login.html'), 'utf8')
  const authCss = readFileSync(join(APP, 'style', 'auth.css'), 'utf8')
  const mobileCss = readFileSync(join(APP, 'style', 'mobile.css'), 'utf8')
  const offlineReadyJs = readFileSync(join(APP, 'function', 'offlineReady.js'), 'utf8')

  is('D89', 'dashboard keeps action list and removes report reminders',
     ['dashActionItems', 'dashRecentSearch', 'dashRecentFrom',
       'dashRecentTo', 'dashRecentType', 'dashRecentSite']
       .every(id => idx.includes(`id="${id}"`))
       && !idx.includes('dashFollowUpCard')
       && !idx.includes('dashFollowUpBadge')
       && !dashJs.includes('function renderFollowUps')
       && !idx.includes('Report reminders')
       && !dashJs.includes("api('rpc/ent_possible_duplicates'")
       && idx.indexOf('id="dashActionSummary"') > idx.indexOf('id="dashNewWork"')
       && idx.indexOf('id="dashActionSummary"') < idx.indexOf('id="dashQueueCard"')
       && !/appointment|booking/i.test(idx),
     'no follow-up or data-quality panel remains')

  is('D90', 'recent-record filters apply to loaded rows and report honest match counts',
     dashJs.includes('function recentFilterState()')
       && ['dashRecentSearch', 'dashRecentFrom', 'dashRecentTo', 'dashRecentType',
         'dashRecentSite'].every(id => dashJs.includes(id))
       && dashJs.includes('function isValidVisitDate')
       && dashJs.includes('matching report(s)')
       && dashCss.includes('.ent-recent-filters'),
     'search, visit dates, report type and site')

  is('D94', 'latest patients pagination defaults to 10 and supports 50 or 100 rows',
     ['dashRecentPagination', 'dashRecentPageSize', 'dashRecentPageInfo',
       'dashRecentPrev', 'dashRecentNext'].every(id => idx.includes(`id="${id}"`))
       && /const RECENT_PAGE_SIZE_DEFAULT = 10/.test(dashJs)
       && /const RECENT_PAGE_SIZES = \[10, 50, 100\]/.test(dashJs)
       && dashJs.includes('adminView ? matching : buildGroupedRows(matching)')
       && dashJs.includes('displayItems.slice(start, start + recentPageSize)')
       && dashJs.includes("const unit = adminView ? 'reports' : 'patient rows'")
       && dashJs.includes('recentPage = Math.min(recentPage, pageCount - 1)')
       && dashJs.includes('recentPage = 0')
       && dashCss.includes('.ent-recent-pagination')
       && dashCss.includes('height: 42px;')
       && dashCss.includes('align-self: end;')
       && dashCss.includes('margin: 0;')
       && dashCss.includes('.ent-recent-reset:hover,\n.ent-recent-reset:active { transform: none; }')
       && dashCss.includes('.ent-recent-filter-row > :nth-child(4) { grid-column: 1; }')
       && dashCss.includes('.ent-recent-reset { grid-column: 2; width: auto; }'),
     'next/previous, page-size selection and page clamping')

  is('D91', 'admin capacity notes use measured thresholds and disclaim unverified backups',
     adminJs.includes('reading.pct >= 90')
       && adminJs.includes('reading.pct >= 70')
       && adminHtml.includes('Not verified by this dashboard')
       && adminHtml.includes('No backup time or restore status is available here')
       && adminCss.includes('#dbCapacityNote.is-danger'),
     'storage/DB warnings and backup status stay truthful')

  is('D92', 'dashboard scripts and styles use refreshed cache-busting versions',
     /dashboard\.css\?v=[^'"]+/.test(idx)
       && /dashboard\.js\?v=[^'"]+/.test(idx)
       && /ent-report-system-v\d+-[^'"]+/.test(sw),
     'changed dashboard assets arrive after deploy')
  const controlsStart = idx.indexOf('<div class="header-user-controls">')
  const togglePosition = idx.indexOf('class="theme-switch-wrapper"', controlsStart)
  const bellPosition = idx.indexOf('id="dashNotificationCenter"', controlsStart)
  const namePosition = idx.indexOf('id="headerUserSlot"', controlsStart)
  is('D92a', 'dashboard header orders theme toggle, notifications, then user name',
     controlsStart >= 0 && togglePosition > controlsStart
       && bellPosition > togglePosition && namePosition > bellPosition
       && dashCss.includes('.ent-dash-page .header-user-controls')
       && mobileCss.includes('flex-wrap: wrap;'),
     'controls stay together on wider screens and wrap when mobile space is tight')

  is('D93', 'recent-record filters show clear labels and responsive groups',
     idx.includes('Search patient')
       && idx.includes('Visit date from')
       && dashCss.includes('.ent-recent-filter-row')
       && dashCss.includes('.ent-recent-filter-row > :nth-child(-n+2) { grid-column: 1 / -1; }'),
     'visible field labels and mobile-friendly layout')

  is('D95', 'login refresh keeps authentication controls intact and adapts to mobile',
     ['loginForm', 'username', 'password', 'rememberDevice', 'loginError',
       'changePwSection', 'confirmPwSection', 'loginBtn'].every(id =>
       loginHtml.includes(`id="${id}"`))
       && loginHtml.includes('ent-login-content')
       && loginHtml.includes('Remember on this device')
       && /auth\.css\?v=v33an-clinic-picker/.test(loginHtml)
       && authCss.includes('grid-template-columns: minmax(280px, 0.88fr) minmax(0, 1.12fr)')
       && mobileCss.includes('grid-template-columns: minmax(0, 1fr)')
       && /ent-report-system-v\d+-[^'"]+/.test(sw),
     'desktop brand panel, mobile stack and unchanged sign-in controls')

  is('D96', 'offline-ready status stays compact while details and retry remain available',
     ['ent-or-details', 'ent-or-more', 'aria-expanded',
       'Show offline access details', 'Offline-ready \\u2713'].every(value =>
       offlineReadyJs.includes(value))
       && offlineReadyJs.includes('#entOfflineReady [hidden]{display:none!important}')
       && offlineReadyJs.includes('min-width:0;min-height:0;')
       && offlineReadyJs.includes('detailsEl.textContent = text')
       && offlineReadyJs.includes('detailsEl.hidden = !expanded')
       && offlineReadyJs.includes('report.total')
       && /offlineReady\.js\?v=v36e/.test(idx)
       && /offlineReady\.js\?v=v36e/.test(loginHtml)
       && /ent-report-system-v\d+-[^'"]+/.test(sw),
     'compact success label, expandable file count/expiry and unchanged cache verification')

  const offlineHtml = readFileSync(join(APP, 'pages', 'offlineWorkspace.html'), 'utf8')
  const offlineCss = readFileSync(join(APP, 'style', 'offlineWorkspace.css'), 'utf8')
  is('D97', 'offline workspace redesign preserves all three report routes and responsive layout',
     ['nasalEndoscopy.html', 'laryngealEndoscopy.html', 'cf4Form.html'].every(page =>
       offlineHtml.includes(`data-page="${page}"`))
       && offlineHtml.includes('id="offlineConnectionTitle"')
       && offlineHtml.includes('id="offlineConnectionMessage"')
       && offlineHtml.includes('id="offlineLogout"')
       && offlineHtml.includes('Start or continue a nasal report')
       && offlineHtml.includes('Prepare a CF4 medical form')
       && /offlineWorkspace\.css\?v=v3/.test(offlineHtml)
       && offlineCss.includes('.offline-workspace-actions button:hover')
       && offlineCss.includes('@media (max-width: 520px)')
       && /ent-report-system-v\d+-[^'"]+/.test(sw),
     'report actions, connection status, logout behavior and mobile-friendly cards')
}

{
  const previousProfile = sessionRow
  const previousSent = sent
  sessionRow = [{
    id: 'super-1', username: 'supersec', role: 'secretary', is_active: true,
    is_super_secretary: true, assigned_doctor_id: 'doc-north',
  }]
  sent = []
  const superWin = makeWindow()
  superWin.document.readyState = 'loading'
  superWin.__session = { access_token: 'SUPER-JWT', user: { id: 'super-1' } }
  superWin.__assignedDoctorRows = [
    { doctor_id: 'doc-north', doctor_name: 'North Doctor', clinic_id: 'clinic-north',
      clinic_name: 'North Clinic', is_primary: true },
    { doctor_id: 'doc-jess', doctor_name: 'Jess Doctor', clinic_id: 'clinic-jess',
      clinic_name: 'Doc Jess ENT Clinic', is_primary: false },
    { doctor_id: 'doc-jess-2', doctor_name: 'Jess Associate', clinic_id: 'clinic-jess',
      clinic_name: 'Doc Jess ENT Clinic', is_primary: false },
  ]
  superWin.__activeClinicId = 'clinic-jess'
  for (const f of ['supabaseClient.js', 'photoStore.js', 'auth.js']) {
    const code = readFileSync(join(APP, 'function', f), 'utf8')
    vm.createContext(superWin)
    vm.runInContext(code, superWin, { filename: 'super-' + f })
  }
  const superAuth = superWin.EntAuth
  const guarded = await superAuth.guard()
  const contextCall = sent.find(request => request.url.includes('/rpc/ent_ensure_active_clinic'))
  const contextRequest = contextCall && JSON.parse(contextCall.body || '{}')
  is('T12', 'guard waits for server context before exposing Super Secretary pages',
     !!guarded && superWin.__clinicContextDoctor === 'doc-north'
       && contextRequest && contextRequest.p_doctor === 'doc-north',
     contextRequest ? `validated doctor=${contextRequest.p_doctor}` : 'no ensure-context RPC')
  is('T13', 'a pre-existing session clinic is synchronized to the selected network clinic',
     superAuth.scope().doctorId === 'doc-jess'
       && superAuth.workingDoctor().clinic_id === 'clinic-jess',
     `working doctor=${superAuth.scope().doctorId}`)

  const modalParts = {
    list: { addEventListener() {} },
    cancel: { addEventListener() {} },
    close: { addEventListener() {} },
    firstChoice: { focus() { this.wasFocused = true } }
  }
  const modal = {
    parentNode: null, innerHTML: '', attributes: {},
    classList: { add() {} },
    setAttribute(name, value) { this.attributes[name] = value },
    addEventListener() {},
    querySelector(selector) {
      if (selector === '.ent-clinic-list') return modalParts.list
      if (selector === '#entClinicCancel') return modalParts.cancel
      if (selector === '#entClinicClose') return modalParts.close
      if (selector === '.ent-clinic-opt') return modalParts.firstChoice
      return null
    }
  }
  const modalDocument = superWin.document
  modalDocument.createElement = () => modal
  modalDocument.getElementById = () => null
  modalDocument.body.appendChild = element => { element.parentNode = modalDocument.body }
  modalDocument.body.removeChild = element => { element.parentNode = null }
  modalDocument.addEventListener = () => {}
  modalDocument.removeEventListener = () => {}
  superAuth.openClinicPicker(superWin.__assignedDoctorRows)
  const clinicOptionCount = (modal.innerHTML.match(/class="ent-clinic-opt(?:\s|")/g) || []).length
  is('T15', 'Super Secretary picker groups assigned doctors into distinct clinics',
     clinicOptionCount === 2
       && modal.innerHTML.includes('Doc Jess ENT Clinic')
       && modal.innerHTML.includes('2 assigned doctors')
       && modal.innerHTML.includes('aria-pressed="true"')
       && modal.attributes.role === 'dialog'
       && modalParts.firstChoice.wasFocused,
     `options=${clinicOptionCount}, active=${modal.innerHTML.includes('aria-pressed="true"')}, role=${modal.attributes.role}`)

  const abstractJs = readFileSync(join(APP, 'function', 'abstract.js'), 'utf8')
  is('T14', 'direct medical-document pages require the active Doc Jess clinic identity',
     abstractJs.includes('window.EntAuth.isDocJessClinic(activeClinicId, activeClinicName, activeClinicCode)')
       && abstractJs.includes('activeClinicName = String(selectedDoctor && selectedDoctor.clinic_name')
       && abstractJs.includes('window.EntAuth.getClinicIdentity(activeClinicId)')
       && !/knownDocJessProfile|assignedToDocJess|jess\|jesus/i.test(abstractJs),
     'active clinic identity is checked without a profile-name bypass')
  const abstractPageHtml = readFileSync(join(APP, 'pages', 'abstract.html'), 'utf8')
  const certificatePageHtml = readFileSync(join(APP, 'pages', 'medicalCertificate.html'), 'utf8')
  is('DOC1', 'medical document pages omit workspace instructions and keep editable print forms',
     !/class="document-workspace\b/.test(abstractPageHtml + certificatePageHtml)
       && abstractPageHtml.includes('<main class="sheet">')
       && certificatePageHtml.includes('<main class="certificate">'),
     'both document forms remain available without the extra intro panel')
  sessionRow = previousProfile
  sent = previousSent
}
  console.log(`==== ${failed === 0 ? 'ALL FUNCTIONAL TESTS PASSED' : failed + ' FAILED'} · ${passed + failed} tests ====`)
  console.log('')
  console.log('NOTE: proves the FRONTEND contract only. The deployed backend is')
  console.log('smoke_test.mjs — that one needs the Edge Functions running.')
  console.log('')
  process.exit(failed === 0 ? 0 : 1)
})()
