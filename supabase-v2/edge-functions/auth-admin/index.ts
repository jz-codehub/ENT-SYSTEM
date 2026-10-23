// =====================================================================
//  auth-admin  —  the ONLY door through which an account changes
// ----------------------------------------------------------------------
//  Replaces: the browser PATCHing clinic_users directly
//            (function/admin.js saveUser / toggleActive,
//             function/auth.js setPassword).
//
//  Why an Edge Function instead of a table the admin PATCHes:
//  creating or changing an account touches TWO stores — auth.users
//  (identity, password, app_metadata) and staff_profiles (role, clinic,
//  assignment). Only service_role may write auth.users, and that key may
//  not exist in a browser. So the write has to be server-side, and doing
//  both halves in one function is what stops them drifting apart.
//
//  Everything is admin-gated except `health`, `capabilities`,
//  `finish_password_change`, which act on the caller's own row only.
//
//  Secrets required (never in the repo, never in the browser):
//    SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// =====================================================================

import {
  admin, json, preflight,
  requireUser, requireAdmin, capability, audit, bindRequest, authenticate,
  asUser,
} from '../_shared/auth.ts'

/** A starter password the admin never has to type into a browser form. */
function starterPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%'
  const bytes = crypto.getRandomValues(new Uint8Array(14))
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('')
}

const ROLES = ['admin', 'doctor', 'secretary']

/**
 * The domain every account's GoTrue address is built from.
 *
 * MUST equal EMAIL_DOMAIN in function/auth.js — the login screen appends
 * this to a bare username before calling signInWithPassword(). If the two
 * drift apart, accounts are created under an address the login page never
 * queries and nobody can ever sign in. test_live_rls.mjs / the probe
 * scripts assert they match.
 *
 * `.invalid` is reserved by RFC 2606: it can never resolve, so no mail can
 * ever be delivered to one.
 */
const ACCOUNT_EMAIL_DOMAIN = 'zztest.invalid'

/**
 * Shortest password this function will accept.
 *
 * 6 IS A HARD FLOOR, NOT A PREFERENCE. It is GoTrue's own project setting
 * ("Password should be at least 6 characters"), and it is enforced below
 * this code. Proved against the live project: 5 characters is rejected with
 * HTTP 422 by /auth/v1/admin/users, so no amount of relaxing this number
 * buys anything under 6. Lowering it further requires changing the setting
 * in the Supabase dashboard (Authentication -> Providers -> Email ->
 * Minimum password length), which is global and affects real sign-ins too.
 *
 * This used to say 10, while the browser said 6 and auth.js said 8 — three
 * different numbers, so a password the admin screen accepted was refused by
 * the server with no explanation of which rule applied.
 */
const MIN_PASSWORD_LENGTH = 6

Deno.serve(async (req) => {
  bindRequest(req)
  if (req.method === 'OPTIONS') return preflight(req)

  let body = {}
  try { body = await req.json() } catch { body = {} }
  const action = String(body?.action || 'health')

  try {
    // ---------------- health: reports nothing sensitive ---------------
    if (action === 'health') {
      return json({
        ok: true, service: 'auth-admin', schema: 'v2',
        writePath: 'auth.users + staff_profiles',
      })
    }

    // ---------------- what is allowed on this device? -----------------
    // The browser asks HERE instead of trusting its own localStorage.
    if (action === 'capabilities') {
      const got = await requireUser(req)
      if (got.error) return got.error
      const [photos, readCloud, writeCloud] = await Promise.all([
        capability('photo_storage', false),
        capability('cloud_reports_read', true),
        capability('cloud_reports_write', true),
      ])
      return json({
        ok: true,
        capabilities: {
          photo_storage: photos,
          cloud_reports_read: readCloud,
          cloud_reports_write: writeCloud,
        },
        user: {
          id: got.user.id,
          username: got.user.username,
          displayName: got.user.displayName,
          role: got.user.role,
          clinicId: got.user.clinicId,
          doctorId: got.user.doctorId,
          mustChangePassword: got.user.mustChangePassword,
        },
      })
    }

    // ---------------- caller finished a forced password change --------
    // The browser already changed it with supabase.auth.updateUser(),
    // which requires a live session, so only the flag remains — on the
    // caller's OWN row. The role/clinic in app_metadata are untouched.
    //
    // WHY authenticate() AND NOT requireUser() HERE — this is the one
    // place the forced-password gate must NOT be consulted, because it is
    // the action that CLEARS that gate:
    //
    //     requireUser()  -> 403 PASSWORD_CHANGE_REQUIRED while the flag is set
    //     finish_...    -> needs requireUser() to pass
    //
    // That is a deadlock: the flag could never be cleared, so a brand new
    // account could never use any feature at all.
    //
    // authenticate() is the UNGATED identity check, and it is still strict
    // about everything that matters: it verifies the JWT signature and
    // expiry with GoTrue (auth.getUser) and then re-reads the LIVE
    // staff_profiles row, returning null when the account is missing or
    // is_active = false. What it does NOT do is check
    // must_change_password — which is exactly the flag this call exists
    // to remove.
    //
    // Nothing else changes: requireUser(), requireAdmin() and the
    // must_change_password protection are untouched, and this branch
    // still runs BEFORE the ADMIN-ONLY section below.
    if (action === 'finish_password_change') {
      // 1. authenticate FIRST — no service-role call happens before this.
      const who = await authenticate(req)
      if (!who) {
        return json({ ok: false, error: 'Authentication required.' }, 401)
      }
      // 2. Only this caller's own row. `who.id` comes from the verified
      //    token's staff_profiles row, never from the request body, so a
      //    client cannot clear anybody else's flag.
      const { error } = await admin()
        .from('staff_profiles')
        .update({ must_change_password: false })
        .eq('id', who.id)
      if (error) return json({ ok: false, error: error.message }, 500)
      await audit(who, 'PASSWORD_CHANGED', 'own password changed', 'staff', who.id)
      return json({ ok: true, must_change_password: false })
    }

    // ==================================================================
    //  ADMIN-ONLY FROM HERE ON
    //  requireAdmin reads the LIVE staff_profiles row, so an account that
    //  was just demoted stops being able to administer on its next
    //  request — even while its old JWT still claims role=admin.
    // ==================================================================

    if (action === 'list') {
      const got = await requireAdmin(req)
      if (got.error) return got.error
      // service_role bypasses RLS, so the clinic filter is written out
      // explicitly: an admin sees every clinic he administers - his own,
      // plus the ones he created for his doctors - and nothing else.
      const covered = await coveredClinicIds(got.user)
      const { data, error } = await admin()
        .from('staff_profiles')
        .select('id, username, full_name, role, assigned_doctor_id, specialty, license_no, email, phone, is_active, must_change_password, last_login_at, created_at, clinic_id')
        .in('clinic_id', covered)
        .order('full_name')
      if (error) return json({ ok: false, error: error.message }, 500)
      return json({ ok: true, users: data || [] })
    }

    if (action === 'create') {
      const got = await requireAdmin(req)
      if (got.error) return got.error
      const me = got.user

      const username = String(body?.username || '').trim().toLowerCase()
      const role = String(body?.role || '')
      const fullName = String(body?.full_name || '').trim()
      const assigned = body?.assigned_doctor_id ? String(body.assigned_doctor_id) : null
      const email = String(body?.email || '').trim()
      // Generated here unless the admin insists on supplying one, so a
      // real password never has to be typed into a browser form field.
      const password = body?.password ? String(body.password) : starterPassword()

      if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
        return json({ ok: false, error: 'Username must be 3-32 characters: letters, numbers, dot, dash, underscore.' }, 400)
      }
      if (!ROLES.includes(role)) {
        return json({ ok: false, error: 'Role must be admin, doctor or secretary.' }, 400)
      }
      if (role === 'secretary' && !assigned) {
        return json({ ok: false, error: 'A secretary must be assigned to a doctor.' }, 400)
      }
      if (role !== 'secretary' && assigned) {
        return json({ ok: false, error: 'Only a secretary can be assigned to a doctor.' }, 400)
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        return json({ ok: false, error: `Starter password must be at least ${MIN_PASSWORD_LENGTH} characters.` }, 400)
      }

      const covered = await coveredClinicIds(me)

      // The assigned doctor must be a real, active doctor IN A CLINIC THIS
      // ADMIN ADMINISTERS. Otherwise an admin could link his secretary to
      // another admin's doctor and read straight through the link.
      let assignDoctor = null
      if (assigned) {
        const { data: doc } = await admin()
          .from('staff_profiles')
          .select('id, role, clinic_id, is_active')
          .eq('id', assigned)
          .maybeSingle()
        if (!doc || doc.role !== 'doctor' || doc.is_active === false
            || !covered.includes(doc.clinic_id)) {
          return json({ ok: false, error: 'That doctor does not belong to a clinic you administer.' }, 403)
        }
        assignDoctor = doc
      }

      /* WHERE THE NEW ACCOUNT LIVES
       *
       * A DOCTOR gets his own clinic, named after him ("ENT-clinic doc.
       * Juan Dela Cruz" - FULL name, the format required 2026-10-11) and
       * owned by the admin who created him, so the console can rank
       * clinics and each doctor's work is its own, named, tally. A
       * SECRETARY lives in HER DOCTOR's clinic, because that is what
       * makes the report policies treat her and her doctor as the same
       * tenant. An ADMIN lives in the admin's clinic.
       *
       * The write is service_role only: a browser has no column grant on
       * public.clinics at all (0016), so nothing here is reachable from a page.
       */
      let targetClinicId = me.clinicId
      // TRUE only when THIS call inserted the clinic. A failed
      // provisioning after that point (duplicate username at createUser,
      // a refused profile insert) must not leave an orphaned clinic
      // behind, so the rollbacks below delete exactly what this call
      // created - never a clinic that pre-existed or was adopted.
      let clinicCreatedHere = false
      if (role === 'doctor') {
        const name = clinicNameForDoctor(fullName, username)
        // IDEMPOTENT RETRY: an earlier attempt for this username may have
        // inserted the clinic and then failed at createUser (username
        // already taken, network blip). The code is derived from the
        // username, so it is stable across retries - find it and ADOPT
        // it instead of minting a second clinic with the same name on
        // every retry.
        const wantCode = clinicCodeFor(username)
        let made = null
        if (wantCode) {
          const { data: existing } = await admin()
            .from('clinics')
            .select('id')
            .eq('code', wantCode)
            .eq('managed_by', me.id)
            .maybeSingle()
          if (existing) made = existing
        }
        for (let attempt = 0; attempt < 3 && !made; attempt++) {
          const base = wantCode || ('ent-' + crypto.randomUUID().slice(0, 8))
          const code = attempt === 0
            ? base
            : `${base.slice(0, 26)}-${crypto.randomUUID().slice(0, 4)}`
          const { data, error } = await admin()
            .from('clinics')
            .insert({ code, name, managed_by: me.id })
            .select('id')
            .single()
          if (!error && data) { made = data; clinicCreatedHere = true; break }
          if (error && !/duplicate|unique/i.test(error.message)) {
            return json({ ok: false, error: "Could not create the doctor's clinic: " + error.message }, 400)
          }
        }
        if (!made) {
          return json({ ok: false, error: 'Could not create a clinic for that doctor (name clash).' }, 400)
        }
        targetClinicId = made.id
      } else if (role === 'secretary' && assignDoctor) {
        targetClinicId = assignDoctor.clinic_id
      }

      // 1. Identity + the claims that will be signed into the JWT.
      //    app_metadata can only be written by the admin API — which is
      //    precisely why a user cannot change their own role.
      //
      //    The address is DERIVED, never collected. The admin console has no
      //    email field, and it must not grow one: the clinic identifies its
      //    people by username, and GoTrue only needs a unique, unroutable
      //    key. `.invalid` is reserved by RFC 2606 and can never resolve, so
      //    nothing can be delivered to it.
      //
      //    The domain MUST stay identical to EMAIL_DOMAIN in
      //    function/auth.js. When this said `clinic.invalid` while the login
      //    page appended `zztest.invalid`, every account created here was
      //    given an address the sign-in screen never looks for — the account
      //    was created, listed in Admin -> Users, and then could not sign in
      //    at all. That was invisible for as long as admin.js threw
      //    "email is not defined" before the request was ever sent.
      const { data: created, error: cErr } = await admin().auth.admin.createUser({
        email: email || `${username}@${ACCOUNT_EMAIL_DOMAIN}`,
        password,
        email_confirm: true,
        user_metadata: { username, full_name: fullName },
        app_metadata: { role, clinic_id: targetClinicId },
      })
      if (cErr) {
        // Roll the CLINIC back when this call created it, so a taken
        // username cannot leave an ever-growing pile of orphaned clinics
        // behind the console. An adopted clinic is left alone on purpose.
        if (clinicCreatedHere) {
          await admin().from('clinics').delete().eq('id', targetClinicId)
        }
        return json({ ok: false, error: cErr.message }, 400)
      }

      // 2. The profile row. The guard triggers allow this write because
      //    the caller is service_role, not a browser.
      const { error: pErr } = await admin().from('staff_profiles').insert({
        id: created.user.id,
        clinic_id: targetClinicId,
        username,
        full_name: fullName,
        role,
        assigned_doctor_id: assigned,
        specialty: String(body?.specialty || ''),
        license_no: String(body?.license_no || ''),
        email,
        phone: String(body?.phone || ''),
        // Honour the "Account is active" checkbox. This used to be hardcoded
        // true, so an admin who unticked it and pressed Save still got an
        // active account and no warning — the form silently disagreed with
        // the database. Pre-provisioning a disabled account is a legitimate
        // thing to want, so the value is now carried through.
        is_active: body?.is_active === undefined ? true : Boolean(body.is_active),
        must_change_password: true,
      })

      if (pErr) {
        // Roll the identity back so no orphan account is left behind...
        await admin().auth.admin.deleteUser(created.user.id)
        // ...and the CLINIC too when this call created it. A doctor whose
        // profile insert failed must not leave a half-provisioned clinic
        // with nobody attached to it. An ADOPTED clinic (a retry after a
        // partial failure) is never deleted: the retry that reaches this
        // point with the same code reuses it.
        if (clinicCreatedHere) {
          await admin().from('clinics').delete().eq('id', targetClinicId)
        }
        return json({ ok: false, error: pErr.message }, 400)
      }

      // 0037: seed the junction with the primary doctor, so the picker and
      // ent_is_my_doctor are consistent from day one. The primary also
      // lives in assigned_doctor_id; keeping it here too means the console
      // can treat secretary_assignments as the complete "may work under"
      // set without special-casing the primary. ON CONFLICT is a no-op if
      // it somehow already exists.
      if (role === 'secretary' && assigned) {
        await admin().from('secretary_assignments')
          .upsert([{ secretary_id: created.user.id, doctor_id: assigned }],
            { onConflict: 'secretary_id,doctor_id' })
      }

      await audit(me, 'USER_CREATED', `Created ${username} (${role})`, 'staff', created.user.id)
      return json({
        ok: true,
        id: created.user.id,
        username,
        // Shown once, then it exists nowhere. must_change_password forces
        // the user to replace it at first sign-in.
        starter_password: password,
      })
    }


    if (action === 'update') {
      const got = await requireAdmin(req)
      if (got.error) return got.error
      const me = got.user
      const targetId = String(body?.id || '')
      if (!targetId) return json({ ok: false, error: 'Missing account id.' }, 400)

      const target = await loadTarget(me, targetId)
      if (target.error) return target.error
      const tgt = target.profile

      const patch = {}
      if (body.full_name !== undefined) patch.full_name = String(body.full_name).trim()
      if (body.specialty !== undefined) patch.specialty = String(body.specialty)
      if (body.license_no !== undefined) patch.license_no = String(body.license_no)
      if (body.email !== undefined) patch.email = String(body.email).trim()
      if (body.phone !== undefined) patch.phone = String(body.phone)

      const roleChanged = body.role !== undefined && body.role !== tgt.role
      const assignChanged = body.assigned_doctor_id !== undefined &&
        (body.assigned_doctor_id || null) !== tgt.assigned_doctor_id

      if (roleChanged || assignChanged) {
        const nextRole = roleChanged ? String(body.role) : tgt.role
        const nextAssign = assignChanged
          ? (body.assigned_doctor_id || null)
          : tgt.assigned_doctor_id
        if (!ROLES.includes(nextRole)) {
          return json({ ok: false, error: 'Role must be admin, doctor or secretary.' }, 400)
        }
        if (nextRole === 'secretary' && !nextAssign) {
          return json({ ok: false, error: 'A secretary must be assigned to a doctor.' }, 400)
        }
        if (nextRole !== 'secretary' && nextAssign) {
          return json({ ok: false, error: 'Only a secretary can be assigned to a doctor.' }, 400)
        }
        if (nextAssign === targetId) {
          return json({ ok: false, error: 'A secretary cannot be assigned to herself.' }, 400)
        }

        // A secretary belongs to HER DOCTOR's clinic. That is the tenant the
        // report policies compare, so re-assigning her must move her WITH him
        // or she would keep seeing the old doctor's shelves and lose the new
        // one's. The doctor must be in a clinic this admin administers.
        let nextClinicId = tgt.clinic_id
        if (nextRole === 'secretary' && nextAssign) {
          const covered = await coveredClinicIds(me)
          const { data: doc } = await admin()
            .from('staff_profiles')
            .select('id, role, clinic_id, is_active')
            .eq('id', String(nextAssign))
            .maybeSingle()
          if (!doc || doc.role !== 'doctor' || doc.is_active === false
              || !covered.includes(doc.clinic_id)) {
            return json({ ok: false, error: 'That doctor does not belong to a clinic you administer.' }, 403)
          }
          nextClinicId = doc.clinic_id
        }
        patch.role = nextRole
        patch.assigned_doctor_id = nextAssign || null
        if (nextClinicId !== tgt.clinic_id) patch.clinic_id = nextClinicId

        if (roleChanged || nextClinicId !== tgt.clinic_id) {
          // A role or clinic change makes the claims inside any live token
          // wrong. Update app_metadata AND end the sessions, so the stale
          // claim cannot keep working until it happens to expire.
          await admin().auth.admin.updateUserById(targetId, {
            app_metadata: { role: nextRole, clinic_id: nextClinicId },
          })
          await admin().auth.admin.signOut(targetId, 'global')
          await audit(me, 'USER_ROLE_CHANGED',
            `${tgt.username}: ${tgt.role} -> ${nextRole}`, 'staff', targetId)
        }
      }

      if (Object.keys(patch).length) {
        const { error } = await admin().from('staff_profiles').update(patch).eq('id', targetId)
        if (error) return json({ ok: false, error: error.message }, 400)
        await audit(me, 'USER_UPDATED', `Updated ${tgt.username}`, 'staff', targetId)
      }
      return json({ ok: true })
    }

    if (action === 'set_active') {
      const got = await requireAdmin(req)
      if (got.error) return got.error
      const me = got.user
      const targetId = String(body?.id || '')
      const active = Boolean(body?.is_active)
      if (!targetId) return json({ ok: false, error: 'Missing account id.' }, 400)
      if (targetId === me.id && !active) {
        return json({ ok: false, error: 'You cannot deactivate your own account.' }, 400)
      }
      const target = await loadTarget(me, targetId)
      if (target.error) return target.error

      // The RPC performs the write and the audit insert, so the admin
      // path and every future path behave identically.
      //
      // This call goes out as the CALLER, not as service_role. The RPC is
      // SECURITY DEFINER but its first statement re-checks the caller with
      // ent_is_active_admin() -> ent_auth_uid() -> auth.uid(). A
      // service_role request has NO `sub` in its JWT, so auth.uid() is NULL,
      // the check finds no staff_profiles row, and the function refused
      // every de/activation with "refused: administrator role required"
      // (HTTP 400). Sending the caller's own JWT is what lets the database
      // see who is asking and run its own check — which is the whole point
      // of the guard. admin() is still used for the session revoke below,
      // which genuinely needs service_role.
      const { error } = await asUser(me.jwt).rpc('ent_admin_set_active', {
        p_user_id: targetId, p_active: active,
      })
      if (error) return json({ ok: false, error: error.message }, 400)

      if (!active) {
        // The piece the old app could not do: it only set a `revoked`
        // boolean in a table nothing consulted. signOut() genuinely ends
        // the Supabase sessions on every device.
        await admin().auth.admin.signOut(targetId, 'global')
        await audit(me, 'SESSION_REVOKED',
          `Ended all sessions for ${target.profile.username}`, 'staff', targetId)
      }
      return json({ ok: true })
    }


    if (action === 'reset_password') {
      const got = await requireAdmin(req)
      if (got.error) return got.error
      const me = got.user
      const targetId = String(body?.id || '')
      const target = await loadTarget(me, targetId)
      if (target.error) return target.error

      const password = body?.password ? String(body.password) : starterPassword()
      if (password.length < MIN_PASSWORD_LENGTH) {
        return json({ ok: false, error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` }, 400)
      }
      const { error } = await admin().auth.admin.updateUserById(targetId, { password })
      if (error) return json({ ok: false, error: error.message }, 400)

      // Force a replacement at next sign-in, and end current sessions so a
      // reset actually locks the previous holder out.
      await admin().from('staff_profiles')
        .update({ must_change_password: true }).eq('id', targetId)
      await admin().auth.admin.signOut(targetId, 'global')
      await audit(me, 'PASSWORD_RESET',
        `Password reset for ${target.profile.username}`, 'staff', targetId)

      return json({ ok: true, starter_password: password })
    }

    if (action === 'revoke_sessions') {
      const got = await requireAdmin(req)
      if (got.error) return got.error
      const targetId = String(body?.id || '')
      const target = await loadTarget(got.user, targetId)
      if (target.error) return target.error
      await admin().auth.admin.signOut(targetId, 'global')
      await audit(got.user, 'SESSION_REVOKED',
        `Signed ${target.profile.username} out of every device`, 'staff', targetId)
      return json({ ok: true })
    }

    /* DELETE AN ACCOUNT
     *
     * The most destructive action in the console, so it is the one with the
     * most ceremony behind it, deliberately:
     *
     *   - the CALLER must re-enter their own password. A hijacked or borrowed
     *     session that reached an open admin tab must not be able to delete a
     *     colleague with one click, and requiring the password proves the
     *     person at the keyboard is the account owner rather than merely
     *     holding their token. The password is verified against the caller's
     *     OWN auth record and is never stored, logged or returned.
     *   - an admin cannot delete themselves, which would leave the clinic with
     *     no administrator and no way back in.
     *   - the LAST remaining active admin cannot be deleted by anybody.
     *   - the target must still be inside a clinic the caller administers
     *     (loadTarget), so this cannot reach another clinic's staff.
     *   - it is audited, like every other change here.
     */
    if (action === 'delete') {
      const got = await requireAdmin(req)
      if (got.error) return got.error
      const me = got.user
      const targetId = String(body?.id || '')
      const password = String(body?.password || '')
      if (!targetId) return json({ ok: false, error: 'Missing account id.' }, 400)

      if (targetId === me.id) {
        return json({ ok: false, error: 'You cannot delete your own account.' }, 400)
      }
      // Re-authenticate the CALLER, not the target. Typing the target's
      // password would prove nothing about who is sitting at the keyboard.
      if (!password) {
        return json({ ok: false, error: 'Enter your own admin password to confirm.' }, 400)
      }
      const { error: authErr } = await admin().auth.signInWithPassword({
        email: String(me.email || ''),
        password
      })
      if (authErr) {
        await audit(me, 'DELETE_REFUSED', `wrong password confirming delete of ${targetId}`, 'staff', targetId)
        return json({ ok: false, error: 'That password is not correct.' }, 403)
      }

      const target = await loadTarget(me, targetId)
      if (target.error) return target.error

      // Refuse to remove the clinic's last way in.
      if (target.profile.role === 'admin' && target.profile.is_active !== false) {
        const { data: others } = await admin()
          .from('staff_profiles')
          .select('id')
          .eq('role', 'admin')
          .eq('is_active', true)
          .neq('id', targetId)
        if (!others || !others.length) {
          return json({ ok: false, error: 'That is the last active administrator. Create another admin first.' }, 400)
        }
      }

      // The identity goes first; staff_profiles cascades from it, and a row
      // left behind with no identity would be an account nobody can sign into
      // but that still counts towards the clinic's head count.
      //
      // BUT a doctor who still owns patient records cannot simply be removed:
      // reports.doctor_id and report_photos.doctor_id are ON DELETE RESTRICT
      // (a deliberate safety choice - see delete_synthetic_accounts.mjs), so
      // deleteUser would be refused with 23503 and the account would survive.
      // 0035 adds the other half: REASSIGN the departing doctor's shelf onto
      // another active doctor of the SAME clinic first, so nothing is
      // orphaned and nothing is deleted - the records simply move onto a
      // living doctor's shelf, dedup and clinic ownership intact. created_by
      // / uploaded_by go to NULL via their 0035 SET NULL FK, with
      // created_by_name (0028) preserving the real author's name.
      if (target.profile.role === 'doctor') {
        const receiver = await pickReassignTarget(me, target.profile)
        if (receiver) {
          // The CALLER's JWT, not service_role - the same rule set_active
          // learned in 0011: the RPC is SECURITY DEFINER but its first
          // statements re-check the caller with ent_auth_uid() /
          // ent_is_active_admin(), and 0035 wrote that guard on purpose
          // ("service_role is NOT special-cased here"). A service_role
          // JWT has no `sub`, so auth.uid() is NULL and the guard would
          // refuse every reassignment - before 0040 it could not even
          // get that far (no EXECUTE for service_role: HTTP 42501).
          // me.jwt lets the database see the admin and run its own
          // check; 0035's authenticated grant is all this call needs.
          const { error: reErr } = await asUser(me.jwt).rpc('ent_reassign_doctor_records', {
            p_from: targetId,
            p_to: receiver,
          })
          if (reErr) return json({ ok: false, error: 'Could not move this doctor\'s records before deleting: ' + reErr.message }, 400)
          await audit(me, 'RECORDS_REASSIGNED', `Moved ${target.profile.username}'s records to ${receiver}`, 'staff', targetId)
        }
      }

      const { error: delErr } = await admin().auth.admin.deleteUser(targetId)
      if (delErr) return json({ ok: false, error: delErr.message }, 400)

      // Only now record it, and only what identifies the person. The audit row
      // is the whole point of deleting, so it has to outlive the account.
      await audit(me, 'USER_DELETED',
        `Deleted account ${target.profile.username} (${target.profile.role})`, 'staff', null)
      return json({ ok: true, deleted: target.profile.username })
    }

    /*
     * set_assignments — manage a secretary's ADDITIONAL doctors (0037).
     *
     * This is the ONLY writer of public.secretary_assignments, which has
     * no INSERT/UPDATE/DELETE policy - exactly like accounts. It lets one
     * secretary float between several ENT clinics: her PRIMARY stays in
     * staff_profiles.assigned_doctor_id (and governs her home clinic), and
     * this call sets the extra doctors she may also work under, across
     * clinics, through the ent_is_my_doctor predicate.
     *
     * GUARDS:
     *   · admin only (requireAdmin), re-reading the live role;
     *   · the target must be an active SECRETARY inside a clinic this
     *     admin covers (loadTarget);
     *   · every doctor named must be a real, active DOCTOR in a clinic
     *     this admin covers - so the link can never reach another admin's
     *     staff, the same rule the primary assignment already obeys.
     * The whole set is REPLACED (add + remove), so the console sends the
     * complete list it wants and does not have to compute a diff.
     */
    if (action === 'set_assignments') {
      const got = await requireAdmin(req)
      if (got.error) return got.error
      const me = got.user
      const targetId = String(body?.id || '')
      const wanted = Array.isArray(body?.doctor_ids)
        ? body.doctor_ids.map((x) => String(x)).filter(Boolean)
        : null
      if (!targetId) return json({ ok: false, error: 'Missing account id.' }, 400)
      if (!wanted) return json({ ok: false, error: 'doctor_ids must be an array.' }, 400)

      const target = await loadTarget(me, targetId)
      if (target.error) return target.error
      if (target.profile.role !== 'secretary') {
        return json({ ok: false, error: 'Only a secretary can be assigned to doctors.' }, 400)
      }

      const covered = await coveredClinicIds(me)
      const clean = []
      for (const docId of wanted) {
        if (docId === targetId) {
          return json({ ok: false, error: 'A secretary cannot be assigned to herself.' }, 400)
        }
        const { data: doc } = await admin()
          .from('staff_profiles')
          .select('id, role, clinic_id, is_active')
          .eq('id', docId)
          .maybeSingle()
        if (!doc || doc.role !== 'doctor' || doc.is_active === false
            || !covered.includes(doc.clinic_id)) {
          return json({ ok: false, error: 'One of those doctors does not belong to a clinic you administer.' }, 403)
        }
        if (!clean.includes(docId)) clean.push(docId)
      }

      // Replace the set: remove what is no longer wanted, add what is new.
      // A failure to delete the stale rows is not fatal (the primary arm
      // still works), but a failure to insert the wanted ones is - the
      // admin asked for access that would silently not exist.
      const { error: delErr } = await admin()
        .from('secretary_assignments')
        .delete()
        .eq('secretary_id', targetId)
        .not('doctor_id', 'in', `(${clean.map((d) => `"${d}"`).join(',')})`)
      if (delErr && clean.length) {
        return json({ ok: false, error: 'Could not update assignments: ' + delErr.message }, 400)
      }
      if (clean.length) {
        const { error: insErr } = await admin()
          .from('secretary_assignments')
          .upsert(
            clean.map((doctor_id) => ({ secretary_id: targetId, doctor_id })),
            { onConflict: 'secretary_id,doctor_id' },
          )
        if (insErr) return json({ ok: false, error: insErr.message }, 400)
      }

      await audit(me, 'SECRETARY_ASSIGNMENTS_SET',
        `${target.profile.username} now works under ${clean.length} additional doctor(s)`, 'staff', targetId)
      return json({ ok: true, doctor_ids: clean })
    }

    if (action === 'set_flag') {
      const got = await requireAdmin(req)
      if (got.error) return got.error
      // Same caller-JWT pattern as set_active. As a service_role request this
      // RPC has no `sub` in its JWT, so ent_is_active_admin() resolves
      // auth.uid() to NULL and the function refuses with "refused: administrator
      // role required". Handing PostgREST the caller's own JWT is what lets the
      // database see who is asking and run its own check. It also means no
      // further GRANT is needed: the caller's token carries role
      // `authenticated`, which 0010 already granted EXECUTE to.
      const { data, error } = await asUser(got.user.jwt).rpc('ent_set_flag', {
        p_flag_key: String(body?.flag_key || ''),
        p_enabled: Boolean(body?.enabled),
        p_note: String(body?.note || ''),
      })
      if (error) return json({ ok: false, error: error.message }, 400)
      await audit(got.user, 'SETTING_UPDATED',
        `flag: ${JSON.stringify(data)}`, 'flag', String(body?.flag_key || ''))
      return json({ ok: true, flag: data })
    }

    if (action === 'presence') {
      const got = await requireAdmin(req)
      if (got.error) return got.error
      // Admin -> Overview "active now". No token column exists anywhere,
      // so this view can no longer leak a credential.
      const { data, error } = await admin()
        .from('user_presence')
        .select('user_id, device_label, role_at_seen, seen_at')
        .in('clinic_id', await coveredClinicIds(got.user))
        .order('seen_at', { ascending: false })
        .limit(200)
      if (error) return json({ ok: false, error: error.message }, 500)
      return json({ ok: true, presence: data || [] })
    }

    return json({ ok: false, error: `Unknown action: ${action}` }, 400)
  } catch (err) {
    // Never echo internals or configuration; this message is safe to show.
    return json({ ok: false, error: String(err?.message || err) }, 500)
  }
})

/**
 * The clinics this administrator may administer: his OWN, plus every clinic
 * he created (clinics.managed_by = him).
 *
 * service_role bypasses RLS, so this list IS the authorization boundary for
 * everything below and is therefore written out explicitly rather than left
 * to a policy. It mirrors ent_admin_covers_clinic() in migration 0016, which
 * is the same rule enforced inside the database.
 */
async function coveredClinicIds(me) {
  const { data, error } = await admin()
    .from('clinics')
    .select('id')
    .or(`id.eq.${me.clinicId},managed_by.eq.${me.id}`)
  if (error) return [me.clinicId]
  const ids = (data || []).map(r => r.id).filter(Boolean)
  return ids.length ? ids : [me.clinicId]
}

/**
 * Choose who inherits a departing doctor's records (0035).
 *
 * Preference order, all inside the SAME clinic and never the target:
 *   1. another active DOCTOR of that clinic - the natural new shelf;
 *   2. failing that, the admin performing the delete himself, but ONLY
 *      if he is a member of that very clinic (his own shelf is a valid
 *      destination; a clinic he merely manages from outside is not).
 *
 * Returns a staff uuid, or null when there is genuinely nowhere to put
 * them (a lone doctor in a clinic the admin only manages). A null means
 * the caller must NOT delete: reports.doctor_id would then RESTRICT the
 * delete, so refusing here is honest rather than letting a 23503 through.
 */
async function pickReassignTarget(me, targetProfile) {
  const clinicId = targetProfile.clinic_id
  // 1. another active doctor in the same clinic.
  const { data: doctors } = await admin()
    .from('staff_profiles')
    .select('id')
    .eq('clinic_id', clinicId)
    .eq('role', 'doctor')
    .eq('is_active', true)
    .neq('id', targetProfile.id)
    .limit(1)
  if (doctors && doctors.length) return doctors[0].id
  // 2. the admin himself, only if he actually belongs to that clinic.
  if (me.clinicId === clinicId && me.id !== targetProfile.id) return me.id
  return null
}


/**
 * A clinic code that satisfies clinics_code_shape
 * (^[a-z0-9][a-z0-9_-]{1,31}$). Derived from the username so it is stable
 * and recognisable; a clash is retried with a random suffix by the caller.
 */
function clinicCodeFor(username) {
  const slug = String(username || '').toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 26)
  const code = ('ent-' + slug).replace(/-+$/, '')
  return /^[a-z0-9][a-z0-9_-]{1,31}$/.test(code) ? code : ''
}

/**
 * The display name a doctor's clinic gets.
 *
 * "ENT-clinic doc. <FULL NAME>" - the format required on 2026-10-11:
 * "Juan Dela Cruz" -> "ENT-clinic doc. Juan Dela Cruz". The FULL name, not
 * a first name alone: two doctors can share a given name, and this string
 * is the only thing an administrator sees when they ask "which clinic is
 * this?". A leading honorific ("Dr." / "Doc.") is stripped so the name is
 * not doubled; a missing name falls back to the username rather than
 * producing "ENT-clinic doc." with nobody after it, which would
 * be indistinguishable from a dozen other nameless clinics in the picker.
 *
 * Idempotency: the name is stable for a given doctor, so a retried
 * provisioning adopts the existing clinic (matched on code, managed by
 * this admin) instead of creating a second clinic with the same name.
 */
function clinicNameForDoctor(fullName, username) {
  const who = String(fullName || '').trim() || String(username || '').trim()
  if (!who) return 'ENT-clinic doc. Unassigned'
  // "Dr. Jess Ramos" must not become "ENT-clinic doc. Dr. Jess Ramos", and a
  // bare honorific has nobody left to name the clinic after.
  const bare = who.replace(/^(dr\.?|doc\.?)\s+/i, '').trim() || who
  return ('ENT-clinic doc. ' + bare).slice(0, 80)
}

/**
 * Load the account an admin wants to touch and confirm it lives in a clinic
 * that admin administers (his own, or one he created). Cross-clinic
 * administration of somebody ELSE's clinic is still refused here. A refused
 * attempt is itself audited.
 */
async function loadTarget(me, targetId) {
  const { data: profile, error } = await admin()
    .from('staff_profiles')
    .select('id, username, full_name, role, clinic_id, assigned_doctor_id, is_active')
    .eq('id', targetId)
    .maybeSingle()
  if (error) return { error: json({ ok: false, error: error.message }, 500) }
  if (!profile) return { error: json({ ok: false, error: 'Unknown account.' }, 404) }
  const covered = await coveredClinicIds(me)
  if (!covered.includes(profile.clinic_id)) {
    await audit(me, 'ACCESS_DENIED',
      `attempted to manage ${profile.username} outside his clinics`, 'staff', targetId)
    return { error: json({ ok: false, error: 'That account belongs to another clinic.' }, 403) }
  }
  return { profile }
}

