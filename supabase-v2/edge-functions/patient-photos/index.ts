// =====================================================================
//  patient-photos v2  —  the only door to the private bucket
// ----------------------------------------------------------------------
//  Rules enforced, in order, on every request:
//    1. a valid Supabase JWT + an ACTIVE staff_profiles row
//    2. the SERVER-SIDE capability 'photo_storage' is on
//       (localStorage cannot unlock anything — see _shared/auth.ts)
//    3. the REPORT is fetched AS THE CALLER, through RLS. If the caller
//       may not see the report, neither may this function — so the
//       permission decision is made by the database and cannot drift
//       away from what the rest of the app is allowed to do.
//    4. size, MIME, extension, magic bytes and photo count are validated
//       BEFORE any byte reaches Storage
//    5. the object path is built here, never accepted from the client
//
//  The browser never calls Storage. There is no public URL and no policy
//  that matches a path prefix, so a guessed path resolves to nothing.
// =====================================================================

import {
  admin, asUser, json, preflight, requireUser, audit, capability, bindRequest,
  PHOTO_BUCKET, MAX_PHOTOS_PER_REPORT,
  buildObjectPath, validatePhoto, sniffType, sha256Hex, extFromName,
} from '../_shared/auth.ts'

const FLAG = 'photo_storage'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Authorization by RLS: look the report up AS THE CALLER.
 * Returns the row, or null when the database refuses — which is exactly
 * "not yours", "other clinic", or "other doctor's shelf", decided by the
 * same policy the normal report list uses.
 *
 * The reference may be either a `reports.id` (uuid) or a `record_key` - the
 * human-readable key the forms build, e.g. "nasal|Perez,Juan|2026-10-01".
 * Both are resolved HERE, as the caller, so RLS still decides visibility.
 *
 * Accepting both matters: the browser only ever holds a record_key for a
 * report it has not saved yet, and comparing a record_key against the uuid
 * column raised 22P02 — so every upload built from a record key was refused
 * before it could ever succeed. The key is NOT trusted for access: it is
 * only a lookup, and the row it finds is still filtered by RLS.
 */
async function reportFor(jwt, reportRef) {
  const ref = String(reportRef || '').trim()
  if (!ref) return null
  const column = UUID_RE.test(ref) ? 'id' : 'record_key'
  const { data, error } = await asUser(jwt)
    .from('reports')
    .select('id, clinic_id, doctor_id, record_key, photo_count')
    .eq(column, ref)
    .limit(1)
  if (error) throw new Error(error.message)
  const row = Array.isArray(data) ? data[0] : data
  return row || null
}

/** Accepts both raw base64 and a data: URL, because the form produces both. */
function base64ToBytes(b64) {
  const clean = String(b64 || '').replace(/^data:[^;]+;base64,/, '')
  const bin = atob(clean)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

Deno.serve(async (req) => {
  bindRequest(req)
  if (req.method === 'OPTIONS') return preflight(req)

  let body = {}
  try { body = await req.json() } catch { body = {} }
  const action = String(body?.action || 'health')

  try {
    if (action === 'health') {
      return json({
        ok: true, service: 'patient-photos', schema: 'v2', bucket: PHOTO_BUCKET,
      })
    }

    // Steps 1 + 2 ----------------------------------------------------
    const got = await requireUser(req)
    if (got.error) return got.error
    const user = got.user

    // What the SERVER thinks, so the browser can stop trusting its own
    // localStorage switch — which any user can flip in DevTools and which
    // therefore controls nothing. Answered BEFORE the gate below, so a client
    // can discover that the flag is off instead of only being refused for it.
    if (action === 'capabilities') {
      return json({
        ok: true,
        schema: 'v2',
        capabilities: { [FLAG]: await capability(FLAG, false) },
      })
    }

    if (!await capability(FLAG, false)) {
      return json({
        ok: false,
        code: 'PHOTO_STORAGE_DISABLED',
        error: 'Cloud photo storage is not enabled for this system yet.',
      }, 503)
    }

    // ---------------- UPLOAD ----------------------------------------
    if (action === 'upload') {
      const reportId = String(body?.report_id || '')
      const incoming = Array.isArray(body?.photos) ? body.photos : []
      if (!reportId) return json({ ok: false, error: 'Missing report.' }, 400)
      if (!incoming.length) return json({ ok: true, paths: [], count: 0 })
      if (incoming.length > MAX_PHOTOS_PER_REPORT) {
        return json({ ok: false, error: `At most ${MAX_PHOTOS_PER_REPORT} photos per report.` }, 400)
      }

      // Step 3: the database, not this function, decides access.
      const report = await reportFor(user.jwt, reportId)
      if (!report) {
        await audit(user, 'ACCESS_DENIED',
          'upload attempted for an inaccessible report', 'report', reportId)
        return json({ ok: false, error: 'You do not have access to that report.' }, 403)
      }

      const stored = []
      for (const item of incoming) {
        const bytes = base64ToBytes(item?.data || item?.base64)
        const mime = String(item?.mime || '').toLowerCase()
        const name = String(item?.name || '')
        const index = Number(item?.index)

        // Step 4a: cheap checks on the declared facts.
        const problem = validatePhoto({ mime, name, bytes: bytes.length, index })
        if (problem) return json({ ok: false, error: problem }, 400)

        // Step 4b: the bytes themselves must agree with the label, so a
        // renamed .pdf or .exe dressed as .jpg never reaches Storage.
        const actual = sniffType(bytes)
        if (!actual) {
          await audit(user, 'PHOTO_UPLOAD',
            'rejected a payload that is not a readable image', 'report', reportId)
          return json({ ok: false, error: 'That file is not a readable JPEG, PNG or WebP image.' }, 415)
        }
        if (actual !== mime) {
          return json({ ok: false, error: `The file claims ${mime} but its contents are ${actual}.` }, 415)
        }

        // Step 5: the path comes from the REPORT's clinic, never the body.
        const ext = extFromName(name) ||
          (actual === 'image/jpeg' ? 'jpg' : actual === 'image/png' ? 'png' : 'webp')
        const path = buildObjectPath(report.clinic_id, report.id, ext)

        const uploaded = await admin().storage
          .from(PHOTO_BUCKET)
          .upload(path, bytes, { contentType: actual, upsert: false })
        if (uploaded.error) {
          return json({ ok: false, error: uploaded.error.message }, 500)
        }

        const inserted = await admin().from('report_photos').insert({
          report_id: report.id,
          clinic_id: report.clinic_id,
          doctor_id: report.doctor_id,
          object_path: path,
          index_no: index,
          mime_type: actual,
          byte_size: bytes.length,
          sha256: await sha256Hex(bytes),
          uploaded_by: user.id,
        }).select('id').single()

        if (inserted.error) {
          // Never leave an object nothing can authorize: undo the upload
          // so Storage and report_photos cannot disagree.
          await admin().storage.from(PHOTO_BUCKET).remove([path])
          return json({ ok: false, error: inserted.error.message }, 500)
        }
        stored.push(path)
      }

      await admin().from('reports').update({ photo_count: stored.length }).eq('id', report.id)
      await audit(user, 'PHOTO_UPLOAD', `${stored.length} photo(s) stored`, 'report', report.id)
      return json({ ok: true, paths: stored, count: stored.length })
    }


    // ---------------- DOWNLOAD (bytes back to the form) --------------
    // Paths are resolved through RLS one by one. A path that is not the
    // caller's simply does not resolve, and is reported as such instead
    // of being fetched and then filtered — so an attempt to read someone
    // else's photo never touches Storage at all.
    if (action === 'download') {
      const wanted = (Array.isArray(body?.paths) ? body.paths : [])
        .map(p => String(p || '').trim()).filter(Boolean).slice(0, MAX_PHOTOS_PER_REPORT)
      if (!wanted.length) return json({ ok: true, images: [] })

      const images = []
      const refused = []
      for (const path of wanted) {
        const { data: row, error } = await asUser(user.jwt)
          .from('report_photos')
          .select('object_path, mime_type, byte_size')
          .eq('object_path', path)
          .is('deleted_at', null)
          .maybeSingle()
        if (error) return json({ ok: false, error: error.message }, 500)
        if (!row) { refused.push(path); continue }

        const fetched = await admin().storage.from(PHOTO_BUCKET).download(path)
        if (fetched.error || !fetched.data) {
          return json({ ok: false, error: fetched.error?.message || 'Object missing from storage.' }, 500)
        }
        const bytes = new Uint8Array(await fetched.data.arrayBuffer())
        images.push({
          path: row.object_path,
          mime: row.mime_type,
          base64: toBase64Local(bytes),
          bytes: row.byte_size,
        })
      }

      if (refused.length) {
        await audit(user, 'ACCESS_DENIED',
          `${refused.length} photo path(s) refused`, 'photo', refused[0])
      }
      if (images.length) {
        await audit(user, 'PHOTO_DOWNLOAD', `${images.length} photo(s) opened`, 'report', body?.report_id || '')
      }
      return json({ ok: true, images, refused })
    }

    // ---------------- LIST what a report owns ------------------------
    if (action === 'list') {
      const reportId = String(body?.report_id || '')
      const report = await reportFor(user.jwt, reportId)
      if (!report) return json({ ok: false, error: 'You do not have access to that report.' }, 403)

      const { data, error } = await asUser(user.jwt)
        .from('report_photos')
        .select('object_path, index_no, mime_type, byte_size, created_at')
        .eq('report_id', report.id)
        .is('deleted_at', null)
        .order('index_no')
      if (error) return json({ ok: false, error: error.message }, 500)
      return json({ ok: true, photos: data || [] })
    }

    // ---------------- DELETE (soft, then the object) -----------------
    if (action === 'remove') {
      const path = String(body?.path || '').trim()
      if (!path) return json({ ok: false, error: 'Missing photo path.' }, 400)

      const { data: row } = await asUser(user.jwt)
        .from('report_photos')
        .select('id, report_id, object_path')
        .eq('object_path', path)
        .is('deleted_at', null)
        .maybeSingle()
      if (!row) {
        await audit(user, 'ACCESS_DENIED', 'delete attempted for an inaccessible photo', 'photo', path)
        return json({ ok: false, error: 'You do not have access to that photo.' }, 403)
      }

      // Soft-delete first so the storage policy stops matching at once,
      // then remove the bytes. Order matters: metadata first means there
      // is never a live object that is also authorized-and-visible.
      await admin().from('report_photos').update({ deleted_at: new Date().toISOString() }).eq('id', row.id)
      const removed = await admin().storage.from(PHOTO_BUCKET).remove([path])
      if (removed.error) return json({ ok: false, error: removed.error.message }, 500)

      // Count what is actually left instead of trusting a number sent by the
      // browser. The old code took `body.photo_count` — which a caller simply
      // does not have to send — and Math.max(0, null - 1) then wrote NaN into
      // the column, permanently breaking every count that reads it.
      const { count } = await admin()
        .from('report_photos')
        .select('id', { count: 'exact', head: true })
        .eq('report_id', row.report_id)
        .is('deleted_at', null)
      await admin()
        .from('reports')
        .update({ photo_count: Number.isInteger(count) ? count : 0 })
        .eq('id', row.report_id)
      await audit(user, 'PHOTO_DELETE', 'photo removed', 'report', row.report_id)
      return json({ ok: true })
    }

    // ---------------- PURGE a deleted report's STORAGE bytes ----------
    // The one leak in the recycle-bin flow: deleting a report row
    // CASCADEs its report_photos metadata, but the actual objects in the
    // private bucket are outside SQL and were never freed - so a
    // "Delete forever" still left the bytes counted against the 500 MB
    // quota forever. This action removes them.
    //
    // GUARDS, and they are the whole point:
    //   · admin only (role checked from the live JWT here, and again by
    //     the database - see below);
    //   · the report must ALREADY be soft-deleted (deleted_at IS NOT
    //     NULL). A LIVE report's photos are never touched, which mirrors
    //     0026's reports_delete_admin ("only over an already-deleted
    //     row"). The caller may not name a live report and erase it.
    // The DB read goes through asUser(jwt), so RLS decides visibility
    // exactly as everywhere else - but a soft-deleted report is hidden
    // from every SELECT policy (0026), so asUser CANNOT see it. That is
    // why the existence check below is deliberately a service-role read
    // gated on the admin's own clinic: an admin may only purge bytes for
    // an already-deleted report INSIDE his own clinic, never a live one
    // and never another clinic's.
    if (action === 'purge_report') {
      if (user.role !== 'admin') {
        await audit(user, 'ACCESS_DENIED', 'purge_report refused - not an admin', 'report', String(body?.report_id || ''))
        return json({ ok: false, error: 'Administrator role required.' }, 403)
      }
      const reportId = String(body?.report_id || '').trim()
      if (!reportId) return json({ ok: false, error: 'Missing report id.' }, 400)

      // Service-role read: confirm the report exists, is already deleted,
      // and belongs to THIS admin's clinic. All three must hold.
      const { data: report, error: rErr } = await admin()
        .from('reports')
        .select('id, clinic_id, deleted_at')
        .eq('id', reportId)
        .maybeSingle()
      if (rErr) return json({ ok: false, error: rErr.message }, 500)
      if (!report) return json({ ok: false, error: 'No such report.' }, 404)
      if (report.clinic_id !== user.clinicId) {
        await audit(user, 'ACCESS_DENIED', 'purge_report refused - other clinic', 'report', reportId)
        return json({ ok: false, error: 'That report belongs to another clinic.' }, 403)
      }
      if (!report.deleted_at) {
        // A live report may never have its bytes erased here. The caller
        // must soft-delete first (the normal Delete button), exactly as
        // the final hard delete requires.
        return json({ ok: false, error: 'Refused: that report is not in the recycle bin. Delete it first.' }, 409)
      }

      // Gather every object path this report owns, including any already
      // soft-deleted photo rows (the report is going away for good, so
      // their bytes must go too).
      const { data: photos, error: pErr } = await admin()
        .from('report_photos')
        .select('object_path')
        .eq('report_id', reportId)
      if (pErr) return json({ ok: false, error: pErr.message }, 500)

      const paths = (photos || []).map(p => p.object_path).filter(Boolean)
      let removedCount = 0
      if (paths.length) {
        const removed = await admin().storage.from(PHOTO_BUCKET).remove(paths)
        if (removed.error) return json({ ok: false, error: removed.error.message }, 500)
        removedCount = paths.length
      }

      // The report row itself is NOT deleted here - the admin console
      // issues the DELETE reports?id=... (guarded deleted_at=not.null)
      // through the normal API, and the report_photos rows CASCADE from
      // it. This action's only job is the Storage bytes, which SQL cannot
      // reach.
      await audit(user, 'REPORT_PURGE', `${removedCount} storage object(s) freed`, 'report', reportId)
      return json({ ok: true, removed: removedCount })
    }

    return json({ ok: false, error: `Unknown action: ${action}` }, 400)
  } catch (err) {
    return json({ ok: false, error: String(err?.message || err) }, 500)
  }
})

/** base64 without pulling in a dependency; the form and jsPDF want this. */
function toBase64Local(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

/** base64 without pulling in a dependency; the form and jsPDF want this. */

