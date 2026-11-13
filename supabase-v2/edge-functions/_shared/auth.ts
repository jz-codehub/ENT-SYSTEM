// =====================================================================
//  ENT RECORDS v2 — SHARED SERVER-SIDE AUTH
//  imported by auth-admin and patient-photos so the rule cannot drift.
// ----------------------------------------------------------------------
//  WHAT CHANGED FROM THE OLD _shared/auth.ts, and why:
//
//  OLD (supabase/edge-functions/_shared/auth.ts)
//    · read clinic_users.password_hash + salt and compared
//      SHA-256(salt + password) itself          -> custom password hash
//    · issueToken() minted its own "typ":"ENT" HMAC bearer, signed with
//      the service-role key, replayed by the browser for 12 hours
//                                               -> custom session system
//    · authenticate() trusted that token, so identity came from a token
//      the platform neither issued nor could revoke -> second source of
//        truth
//
//  NEW
//    · exactly ONE authentication system: Supabase Auth. The browser
//      signs in with supabase.auth.signInWithPassword() and brings the
//      resulting JWT here as `Authorization: Bearer`.
//    · this module never sees a password, a hash, or a salt. It asks
//      GoTrue to verify the JWT, then reads the LIVE profile row.
//    · there is no token minting anywhere in this file. Revoking an
//      account is real: auth.admin.signOut() ends the Supabase session,
//      and every policy re-reads staff_profiles.is_active.
// =====================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export const PHOTO_BUCKET = 'patient-photos'
export const MAX_PHOTOS_PER_REPORT = 6
export const MAX_BYTES_PER_PHOTO = 10 * 1024 * 1024      // 10 MB
export const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp']
export const ALLOWED_EXT = ['jpg', 'jpeg', 'png', 'webp']

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''

/* ---------------------------------------------------------------------
   KEY RESOLUTION — new mechanism first, legacy as a fallback.

   Supabase is deprecating the long-lived `anon` / `service_role` JWTs by
   the end of 2026. The replacements arrive as JSON DICTIONARIES, not
   plain strings:

       SUPABASE_SECRET_KEYS       -> {"default":"sb_secret_...","r1":"..."}
       SUPABASE_PUBLISHABLE_KEYS  -> {"default":"sb_publishable_..."}

   So the shape of the variable is different, and reading it naively
   (`Deno.env.get('SUPABASE_SECRET_KEYS')` used directly) would hand
   supabase-js a whole JSON object as the "key" and fail confusingly.

   Reading the new key first and falling back to the legacy one means
   this deploy works today AND after the deprecation date, with no second
   migration. A named key can be preferred (e.g. 'patient-photos' gets
   its own secret so a leak in one function cannot be reused in another).
   ------------------------------------------------------------------- */
function keyFrom(dictVar, legacyVar, preferredName) {
  const raw = Deno.env.get(dictVar)
  if (raw) {
    try {
      const dict = JSON.parse(raw)
      const pick = (preferredName && dict[preferredName]) || dict.default
      if (pick) return pick
    } catch {
      // Not JSON — fall through to the legacy variable.
    }
  }
  return Deno.env.get(legacyVar) || ''
}

// A named key is preferred over `default` so each function can be issued
// its OWN secret: a leak in patient-photos would then not automatically be
// valid in auth-admin.
const SERVICE_KEY = keyFrom('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY', 'ent-records')
const ANON_KEY = keyFrom('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY', 'ent-records')

/* ---------------------------------------------------------------------
   CORS — an ALLOWLIST, not a single origin.

   ENT_ALLOWED_ORIGIN accepts a comma-separated list, so the SAME deployed
   function can serve local development and the published site at once:

       ENT_ALLOWED_ORIGIN=http://localhost:5500,https://yourname.github.io

   Why this matters, and what it is NOT:

   · Access-Control-Allow-Origin is NOT an authentication control. Anyone
     can curl this endpoint from anywhere; CORS only stops ANOTHER
     website's JavaScript from reading a response out of the victim's
     browser. The real gate is authenticate()/requireUser()/requireAdmin,
     which runs before any service-role call and does not care where the
     request came from. So a tight allowlist is defence-in-depth for the
     browser, never the thing standing between an attacker and the data.
   · Therefore the origin is ECHOED, never hard-coded: a browser only
     accepts the response if ACAO matches its own origin exactly.
   · `Vary: Origin` is required, or a shared cache could serve one
     origin's ACAO to another.
   · An empty/unset value means "no allowlist configured", which fails
     CLOSED (no ACAO header at all) rather than defaulting to `*`. The old
     `|| '*'` silently allowed every site, which is the opposite of the
     intent and would have been a real footgun on a production deploy.

   NOTE on GitHub Pages: the Origin header never contains a path. A
   project site served from https://user.github.io/repo/ still sends
   Origin: https://user.github.io — list the bare host, not the URL.
   --------------------------------------------------------------------- */
const ALLOWED_ORIGINS = (Deno.env.get('ENT_ALLOWED_ORIGIN') || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const CORS_HEADERS = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

/**
 * The in-flight request, bound once at the top of the handler.
 *
 * json() is called from ~67 places across the three functions and almost
 * none of them want to thread `req` through by hand just to echo an
 * Origin header. Binding it once here keeps every call site unchanged
 * while still guaranteeing the header is per-request rather than a
 * module-level constant baked in at cold start.
 */
let CURRENT_REQ = null
export function bindRequest(req) { CURRENT_REQ = req }

/** CORS headers for one request: echo the caller's origin if allowed. */
function cors(req) {
  const source = req || CURRENT_REQ
  const origin = (source?.headers?.get?.('origin') || '').trim()
  const headers = { ...CORS_HEADERS, Vary: 'Origin' }
  // No allowlist configured -> no ACAO header -> the browser blocks it.
  if (ALLOWED_ORIGINS.length && ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

export function json(body, status = 200, req = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), 'Content-Type': 'application/json' },
  })
}

/**
 * Answer a CORS preflight.
 *
 * The body MUST be null. 204 No Content is a null-body status per the Fetch
 * spec, and constructing a 204 with a body throws
 *
 *     TypeError: Response constructor: Invalid response status code 204
 *
 * which Deno surfaces as HTTP 500 `sb-error-code: EDGE_FUNCTION_ERROR` with
 * no Access-Control-Allow-Origin header at all. The browser then refuses to
 * send the real request, and the page sees only "Failed to fetch" — while
 * every Node-based test in this repo reports the function as perfectly
 * healthy, because Node never performs a preflight. The admin console was
 * completely unreachable from the browser this way.
 *
 * A preflight only needs the status and the CORS headers, so null is both
 * correct and sufficient.
 */
export function preflight(req) {
  return new Response(null, { status: 204, headers: cors(req) })
}

/** A service_role client. The key exists only inside this runtime. */
export function admin() {
  if (!SERVICE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set on this Edge Function.')
  }
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/**
 * A client that ACTS AS THE CALLER: everything it queries is filtered by
 * RLS exactly as if the browser had run it. Used wherever we want the
 * database — not this function — to make the permission decision.
 */
export function asUser(jwt) {
  return createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

function bearer(req) {
  const raw = (req.headers.get('authorization') || '').trim()
  return raw.replace(/^Bearer\s+/i, '').trim()
}

/**
 * Identify the caller from the Supabase JWT only.
 * Returns null when the token is missing, expired, or belongs to an
 * account with no active staff_profiles row.
 */
export async function authenticate(req) {
  const jwt = bearer(req)
  if (!jwt) return null

  // getUser() verifies the signature with GoTrue and rejects expired
  // tokens, so "invalid and expired sessions are rejected" is handled
  // here rather than by a hand-rolled expiry check.
  const probe = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: verified, error } = await probe.auth.getUser(jwt)
  if (error || !verified?.user) return null

  const { data: profile, error: pErr } = await admin()
    .from('staff_profiles')
    .select('id, username, full_name, role, clinic_id, assigned_doctor_id, is_super_secretary, is_active, must_change_password')
    .eq('id', verified.user.id)
    .maybeSingle()
  if (pErr) throw new Error(pErr.message)

  // No profile, or a deactivated one, is a hard stop — even though the
  // JWT is still cryptographically valid. That is what makes
  // "account deactivated" take effect on the NEXT request, not at
  // token expiry.
  if (!profile || profile.is_active === false) return null

  return {
    jwt,
    id: profile.id,
    username: profile.username,
    displayName: profile.full_name || profile.username,
    role: profile.role,
    isSuperSecretary: !!profile.is_super_secretary,
    // The clinic is a fact in the database: never from the body, the
    // query string, a header, or localStorage.
    clinicId: profile.clinic_id,
    doctorId: profile.role === 'doctor' ? profile.id : (profile.assigned_doctor_id || null),
    mustChangePassword: !!profile.must_change_password,
  }
}

/** Require a signed-in caller, or return the rejection response. */
export async function requireUser(req) {
  let user = null
  try {
    user = await authenticate(req)
  } catch (err) {
    return { error: json({ ok: false, error: 'Sign-in check failed.', detail: String(err && err.message || err) }, 500) }
  }
  if (!user) {
    return { error: json({ ok: false, error: 'Authentication required.' }, 401) }
  }
  if (user.mustChangePassword) {
    return {
      error: json({
        ok: false,
        code: 'PASSWORD_CHANGE_REQUIRED',
        error: 'Choose a new password before this feature becomes available.',
      }, 403),
    }
  }
  return { user }
}

/**
 * Admin-only gate. Reads the LIVE row via requireUser, so an account that
 * was just demoted or deactivated is refused on the next request even if
 * its JWT still says "admin".
 */
export async function requireAdmin(req) {
  const got = await requireUser(req)
  if (got.error) return got
  if (got.user.role !== 'admin') {
    await audit(got.user, 'ACCESS_DENIED', `refused admin action`, '', '')
    return { error: json({ ok: false, error: 'Administrator role required.' }, 403) }
  }
  return got
}

/**
 * Ask the DATABASE whether a capability is on.
 * This is the replacement for localStorage.entFeaturePhotoStorage as a
 * control. The browser may cache the answer for one page load; this
 * function asks again on every request, so flipping a localStorage value
 * cannot unlock photo storage.
 */
export async function capability(flagKey, fallback = false) {
  try {
    const { data, error } = await admin().rpc('ent_capability', { p_flag_key: flagKey })
    if (error || data === null || data === undefined) return fallback
    return Boolean(data)
  } catch {
    return fallback
  }
}

/** Append an audit row. The trigger stamps the actor from the id anyway. */
export async function audit(user, action, detail, targetType = '', targetId = '') {
  if (!user) return
  try {
    await admin().from('activity_logs').insert({
      actor_id: user.id,
      actor_role: user.role,
      actor_label: user.displayName,
      clinic_id: user.clinicId,
      action,
      // No PHI: the audit trail is read by every admin in the clinic.
      detail: String(detail || '').slice(0, 2000),
      target_type: targetType,
      target_id: String(targetId || ''),
    })
  } catch { /* an audit failure must never break a legitimate save */ }
}

// ---------------------------------------------------------------------
// Object paths. Built ONLY here — the browser is never given a choice.
//   clinics/<clinicId>/reports/<reportId>/<uuid>.<ext>
// The uuid segment is why guessing a path is pointless: authorization
// comes from the matching report_photos row, and 0009 contains no
// prefix-matching policy that guessing could ever satisfy.
// ---------------------------------------------------------------------
export function buildObjectPath(clinicId, reportId, ext) {
  const safeExt = ALLOWED_EXT.includes(String(ext).toLowerCase()) ? String(ext).toLowerCase() : 'jpg'
  return `clinics/${clinicId}/reports/${reportId}/${crypto.randomUUID()}.${safeExt}`
}

export function extFromName(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''))
  return m ? m[1].toLowerCase() : ''
}

export function extFromMime(mime) {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/png') return 'png'
  if (mime === 'image/webp') return 'webp'
  return ''
}

/**
 * Magic-byte sniff: the declared type must agree with the actual first
 * bytes, so a renamed .exe or .pdf dressed up as .jpg is refused before
 * a single byte reaches Storage.
 */
export function sniffType(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length > 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return ''
}

export function validatePhoto({ mime, name, bytes, index }) {
  if (!Number.isInteger(index) || index < 1 || index > MAX_PHOTOS_PER_REPORT) {
    return `Photo position must be between 1 and ${MAX_PHOTOS_PER_REPORT}.`
  }
  if (!ALLOWED_MIME.includes(mime)) {
    return `Photo type ${mime || '(none)'} is not allowed. Use JPEG, PNG or WebP.`
  }
  const declaredExt = extFromName(name)
  if (declaredExt && !ALLOWED_EXT.includes(declaredExt)) {
    return `Photo extension .${declaredExt} is not allowed.`
  }
  const expected = extFromMime(mime)
  if (declaredExt && expected && declaredExt !== expected &&
      !(mime === 'image/jpeg' && declaredExt === 'jpeg')) {
    return `Photo extension .${declaredExt} does not match its content type (${mime}).`
  }
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Photo is empty.'
  if (bytes > MAX_BYTES_PER_PHOTO) {
    return `Photo is larger than ${Math.floor(MAX_BYTES_PER_PHOTO / (1024 * 1024))} MB.`
  }
  return null
}

export async function sha256Hex(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** base64 (no wrapping) — the shape the form and jsPDF already expect. */
export function toBase64(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input)
  let bin = ''
  for (let i = 0; i < b.length; i += 0x8000) {
    bin += String.fromCharCode(...b.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

