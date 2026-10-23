# 07 · Frontend integration — the map, not the move

**No file in `function/` has been changed.** This is the plan for that work,
written down so the move is a sequence of small, checkable steps instead of one
rewrite. Do it in this order; each step leaves the app working.

The rule for every step: **the browser stops deciding anything.** It may *ask*
for a role, a clinic, a flag, or a photo. It may not *state* one.

## Step 0 · Nothing is deleted yet

v1 (`supabase/edge-functions/`) and v2 coexist: different tables, different
functions, same project. Until Step 5 the app still runs entirely on v1, so a
v2 failure costs nothing. Keep both deployed.

## Step 1 · `function/supabaseClient.js`

Current: `defaultConfig` hardcodes the project URL, the anon key and
`clinicId: 'main_clinic'`, all merged over `localStorage['ent_supabase_config_v1']`.

| Item | Verdict |
|---|---|
| `supabaseUrl`, `supabaseAnonKey` | Fine to keep. The anon key is public by design; RLS, not secrecy, is what protects the rows |
| `clinicId: 'main_clinic'` | **Must go.** Clinic membership is a fact in `staff_profiles`. v2 has no endpoint that accepts a clinic from the client |
| localStorage as the config source | Keep for the URL only, so a demo can be repointed; never for identity |

Add the supabase-js bundle (`@supabase/supabase-js@2`, same version the
functions use) and expose one client instance. Do **not** add a second client
built from a service key — there is no such thing as a browser-side service key.

## Step 2 · `function/auth.js` — the big one

This file currently *is* the authentication system: a pure-JS SHA-256
(`sha256Hex`, ~line 42) because `crypto.subtle` is missing on non-secure
contexts, `hashPassword(salt, password)` (~line 96), a comparison at ~420, and
`setPassword` writing `salt` + `password_hash` at ~609-625.

| Current | v2 |
|---|---|
| `api('clinic_users?username=eq.…&select=*')` (line 424) to fetch the user's hash | `supabase.auth.signInWithPassword({ email, password })` — the browser never sees a hash, because there is none to see |
| `hashPassword(user.salt, password) === user.password_hash` (line 420) | Deleted. GoTrue compares with bcrypt server-side |
| `api('clinic_users?select=*&order=full_name.asc')` (line 360) | `auth-admin` `{action:'list'}` — only an admin's session gets rows back |
| `PATCH clinic_users?id=eq.…` (lines 567, 611) | `auth-admin` `{action:'set_active' \| 'reset_password' \| 'finish_password_change'}` |
| Session kept in localStorage by hand | `supabase.auth` keeps and refreshes the session; subscribe with `onAuthStateChange` and drive the UI from that |
| `must_change_password` enforced in the page | The account still carries the flag, but `auth-admin` refuses every other action until `finish_password_change` succeeds — the check is not in the JS any more |

**The username problem, stated plainly.** GoTrue wants an email; the clinic
logs in with a bare username. v2 provisions synthetic accounts as
`<username>@zztest.invalid`, and real accounts must get a real unroutable
address such as `<username>@<clinic>.internal` at migration time. That is a
decision to make **before** migrating anyone: it is baked into `auth.users`,
and changing it later means re-linking every account. Test `AUTH-01` is the
gate for it.

What stays: everything about *presentation* — the login screen, the "must
change password" prompt, the redirect after sign-in. Only the decisions move.

## Step 3 · `function/admin.js`

Three direct writes, all of which become one function call:

| Line | Now | After |
|---|---|---|
| `admin.js:451` | `PATCH clinic_users?id=eq.<id>` with a hand-built patch | `auth-admin` `{action:'update', …}` |
| `admin.js:461` | `POST clinic_users` with a new row | `auth-admin` `{action:'create', …}` — the function creates the `auth.users` row, the profile, and returns a starter password **once** |
| `admin.js:496` | `PATCH` `{is_active}` | `auth-admin` `{action:'set_active', …}` |

The admin screen should also start calling `{action:'capabilities'}` instead of
reading feature flags out of localStorage, and `{action:'presence'}` for the
who-is-on line.

## Step 4 · `function/photoStore.js`

Already shaped correctly: `call(payload)` POSTs to
`/functions/v1/patient-photos` with the caller's own bearer token and throws on
`ok === false`. v2 keeps the same endpoint and the same envelope, so the change
is the **payload**, not the plumbing:

| v1 payload | v2 payload |
|---|---|
| `{ action:'store', report_id, photos:[base64…] }` | `{ action:'upload', report_id, photos:[{name, data_base64}], photo_count }` |
| — | `{action:'list', report_id}` / `{action:'download', report_id, photo_id}` / `{action:'remove', …}` |

Errors come back as `{ok:false, code:'…'}` — surface `code`, not just the
message, so `PHOTO_STORAGE_DISABLED` can be shown as "not enabled yet" rather
than as a scary failure. `MAX_PHOTOS_PER_REPORT`, the MIME list and the size
cap all live in `_shared/auth.ts`; if the frontend needs them for a friendly
hint, ask `{action:'capabilities'}` rather than duplicating the numbers.

## Step 5 · The session, and the two caches that must die

`function/auth.js:15-16`:

```js
const SESSION_KEY     = 'entSessionV1';      // { token, sessionId, … }
const USERS_CACHE_KEY = 'entUsersCacheV1';   // every account, in the browser
```

`entSessionV1` is replaced by the supabase-js session
(`sb-<project-ref>-auth-token`), which is refreshed automatically and cleared by
`signOut()`. Two consequences worth knowing before you start:

- `auth-admin` `{action:'revoke_sessions'}` invalidates a token server-side, but
  the copy in that browser's localStorage does not vanish. The next request
  fails, and the UI must treat "the server stopped accepting my token" as
  *signed out*, not as a network error. Handle the 401 in one place.
- `entUsersCacheV1` — a full copy of the user table in every browser — goes
  away with no replacement. `list` returns the clinic's directory to an admin
  when the admin screen asks for it. Cache it in memory for the page, not in
  localStorage for the week: a cached role is exactly the stale claim `PRIV-04`
  tests.

## Step 6 · Read paths: `dbRecords.js`, `dashboard.js`, `patientRecords.js`, `draftsBrowser.js`

These talk to PostgREST directly, which is *correct* in v2 — RLS is the
authorization layer, and a browser reading its own clinic's rows through a
policy is the design. What changes is the shape:

| v1 | v2 |
|---|---|
| `patient_records` | `reports` (payload jsonb; `record_key`, `is_draft`, `photo_count` are columns, not jsonb guesses) |
| `?clinic_id=eq.main_clinic` written into the query string | **removed.** `clinic_id` is filtered by the policy from the JWT. A client-supplied clinic filter is at best redundant and at worst the hole |
| `doctorFilter()` in JS for a secretary's view | removed from the read path; the policy already restricts rows. Keep any JS filtering only as a *display* grouping |
| `settings.html` writes clinic settings into localStorage | `clinic_settings`, allowed keys listed in `0006`; the sync path stays, the target changes |
| `storageStats.js` / `admin.js` counts | `reports` + `user_presence`; keep the queries direct |

Leave `sw.js` alone except to confirm it never caches a response that carries a
token or a report body. A service worker that caches `/rest/v1/reports` turns a
per-user permission into a file on disk shared by whoever next uses that laptop —
that is the one change in this list that is a security fix rather than a refactor.

## Order of work, and the state after each step

| # | Change | App still works? | Gate before continuing |
|---|---|---|---|
| 0 | v2 schema applied to a **test** project, functions deployed | yes (v1 untouched) | both scripts pass |
| 1 | supabase-js client added | yes | nothing else touched |
| 2 | `auth.js` sign-in via GoTrue | yes, for one test account | `AUTH-01…08` pass |
| 3 | `admin.js` → `auth-admin` | yes | `PRIV-*` pass |
| 4 | `photoStore.js` payload → v2, flag still OFF | yes (flag OFF = old path) | `FLAG-*` pass |
| 5 | session/cache keys retired | yes | re-test `AUTH-06` after clearing storage |
| 6 | read paths → `reports`, client clinic filter removed | yes | `ISO-*`, `PHASE-6.9` pass |
| 7 | `photo_storage` ON for the test clinic | yes | `STORAGE-*` pass |
| 8 | **only now** plan the real-data migration | — | sign-off list in `06-TEST-PLAN.md` |

## What must not change while any of this happens

- No file in `function/` may contain the service-role key. `CRED-04` is a
  one-line check; run it after every step.
- The IndexedDB draft path and the PDF/print path are not part of this work.
- The v1 functions stay deployed until step 8. Removing them early converts a
  staged migration into a big-bang one.
- `login.html` may keep asking for a username and a password — that is a UI
  decision, not a security one. What has to stop is the browser *verifying*
  the password.

