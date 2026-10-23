# Setup — step by step

Everything that has to be true for this app to work, in the order it has to
be done. Each step says how to check it, so you never have to guess whether
it worked.

---

## 0. What the moving parts are

| Thing | Where it lives | What it does |
|---|---|---|
| The app | `index.html`, `pages/*.html`, `function/`, `style/`, `js/` | Runs in the browser |
| Database | Supabase, schema in `supabase-v2/migrations/` | The real data |
| `auth-admin` | `supabase-v2/edge-functions/auth-admin/index.ts` | **The only way an account is ever created or changed** |
| `patient-photos` | `supabase-v2/edge-functions/patient-photos/index.ts` | Photo uploads (currently off by flag) |
| Shared guard | `supabase-v2/edge-functions/_shared/auth.ts` | Auth, RLS role check, CORS — imported by both |

### Where the pages live

`index.html` sits at the app root. **Every other page is in `pages/`**:
`login`, `admin`, `settings`, `viewAll`, the three report forms
(`nasalEndoscopy`, `laryngealEndoscopy`, `cf4Form`) and `diagnose`.

`index.html` stays put on purpose — it is the entry point: the service worker
falls back to it offline, `manifest.json` points `start_url` at it, and a bare
`/` has to serve it.

Because of that split, the shared modules under `function/` **cannot hardcode a
relative path**: `auth.js`, `index.js` and `cf4.js` all run both at the root and
one level down, and a browser resolves a URL against the *document*, not the
script. They ask `function/paths.js` instead:

```js
EntPaths.asset('style/auth.css')   // -> './style/…' or '../style/…'
EntPaths.page('admin.html')        // -> './pages/admin.html' or '../pages/admin.html'
```

**If you add a page:** put it in `pages/`, give it `../` on every asset path,
load `../function/paths.js` first, and add it to `PAGES` in
`build-pages.mjs` **and** `FILES_TO_CACHE` in `sw.js` (bumping `CACHE_NAME`).
Nothing publishes or pre-caches a page that is not on those two lists.

Local URLs therefore look like:

```
http://localhost:5500/                     -> index.html
http://localhost:5500/pages/login.html     -> sign in
```

The bundled file you deploy is `supabase-v2/dist/*.bundle.ts`. It is the
`_shared` code inlined into each function, because Supabase only serves files
inside a function's own folder.

---

## 1. The database — already done ✅

The numbered migrations in `supabase-v2/migrations/` (0001 through 0041,
0023 removed as superseded). They must be run in order, in the Supabase SQL
Editor — the folder is the ONE source of truth (the old `fresh-setup/`
mirror and its copy builder were removed 2026-10-11), so paste them one
by one, same order:

```
0001_extensions_enums_helpers.sql
0002_clinics.sql
0003_staff_profiles.sql
0004_reports.sql
0005_activity_and_presence.sql
0006_flags_and_settings.sql
0007_privileges.sql
0008_rls_core.sql
0009_storage_policies.sql
0009b_storage_policies_dashboard.sql
0010_admin_rpcs.sql
0011_fix_admin_rpcs.sql
0012_tickets.sql
0013_ticket_scope.sql
0014_fix_db_usage.sql
0015_assigned_doctor_name.sql
0016_doctor_clinics.sql
0017_draft_and_photo_integrity.sql
0018_ownership_ticket_scope_audit.sql
0019_cross_clinic_grants.sql
0020_view_all_and_draft_privacy.sql
0021_grant_approval_refuses_draft.sql
0022_grant_stamp_sees_grantee.sql
0024_grant_stamp_reaches_the_stamp.sql
0025_grant_author_survives_deletion.sql
0026_soft_delete_recycle_bin.sql
0027_my_secretaries.sql
0028_created_by_name.sql
0029_author_may_delete_own_draft.sql
0030_wire_soft_delete_policy.sql      ← fixes "Could not delete" (403 RLS)
0031_cross_clinic_access_requests.sql
0032_clinic_wide_request_approval.sql
0033_author_escape_hatch.sql
0034_secretary_shelf_delete.sql
0035_account_deletion_safety.sql
0036_recycle_bin_retention.sql
0037_cross_clinic_secretary.sql       ← a secretary may work under several doctors
0038_enable_photo_storage.sql         ← the server-side photo_storage flag (0038)
0039_recycle_bin_doctor_and_secretary.sql  ← the bin widens to doctors + secretaries
0040_missing_grants.sql               ← grant-gap repair: 2 tables + 5 EXECUTE grants
0041_duplicate_patient_guard.sql      ← patient-day uniqueness (hospital ID) + read-only duplicate review RPC
```

**Check it:** `node supabase-v2/scripts/check_migrations.mjs`

Re-running an applied migration is safe — they are written to be idempotent.

---

## 2. Secrets — two required

In **Supabase Dashboard → Project Settings → Edge Functions → Secrets**:

| Name | Value |
|---|---|
| `ENT_ALLOWED_ORIGIN` | see below |

> **`SUPABASE_SERVICE_ROLE_KEY` — DO NOT set this manually.** The
> `SUPABASE_` prefix is reserved: Supabase injects `SUPABASE_URL`,
> `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` into every Edge
> Function automatically. The dashboard refuses a secret whose name
> starts with `SUPABASE_` ("Name must not start with the SUPABASE_
> prefix") — that refusal is correct, the key is already there.
> `_shared/auth.ts` reads it via `keyFrom('SUPABASE_SECRET_KEYS',
> 'SUPABASE_SERVICE_ROLE_KEY', …)`: new-style dict first, legacy
> auto-injected JWT as the fallback.

### `ENT_ALLOWED_ORIGIN` — the one that bites

A comma-separated allowlist. **It must list every origin the app is served
from**, or the browser silently refuses the response.

```
ENT_ALLOWED_ORIGIN=http://localhost:5500,https://YOURNAME.github.io
```

- Local testing uses `http://localhost:5500`
- **GitHub Pages sends only the bare host** — `https://YOURNAME.github.io` —
  even from `https://YOURNAME.github.io/repo/`. Do not add the `/repo` path.
- `http://127.0.0.1:5500` is **not** the same as `localhost` and must be
  listed separately if you use it.

Changing it needs no redeploy — it takes effect immediately.

**Check it:** `node supabase-v2/scripts/verify_deploy.mjs`

---

## 3. Deploy the Edge Functions

Deploy **after** any edit to `edge-functions/`, because the source is not what
runs — `dist/*.bundle.ts` is.

### Option A — Dashboard (no CLI)

1. Supabase Dashboard → **Edge Functions**
2. Create or open `auth-admin`
3. Paste the whole contents of `supabase-v2/dist/auth-admin.bundle.ts`
4. Save, then **Deploy**
5. Repeat for `patient-photos` using `dist/patient-photos.bundle.ts`

> Use the file in `dist/`, not `edge-functions/`. The dashboard only serves
> files inside the function's own folder, which is what the bundle is for.

### Option B — CLI

The CLI is not currently installed:

```bash
npm install -g supabase
supabase login
supabase link --project-ref ybnlvfdvfrwnmdvhxeof
supabase functions deploy auth-admin --no-verify-jwt
supabase functions deploy patient-photos --no-verify-jwt
```

`--no-verify-jwt` because these functions do their own authentication via
`_shared/auth.ts`; letting the platform gate on JWT as well only adds a way
for them to fail closed on a valid admin session.

### Verify

```bash
node supabase-v2/scripts/verify_deploy.mjs
```

It checks the **preflight**, not just a `curl`. This matters: a function can
answer `POST` perfectly while its `OPTIONS` returns 500, and every browser
will refuse to send the real request — while every Node test still passes,
because Node never performs a preflight. That is exactly how the admin console
went unreachable while looking perfectly healthy.

---

## 4. Run it locally

```bash
node serve.mjs          # http://localhost:5500
```

`ENT_ALLOWED_ORIGIN` must include `http://localhost:5500` or nothing works.

---

## 5. Publish to GitHub Pages

1. `git init && git add . && git commit -m "ENT v2"`
2. Push to GitHub
3. Repo → Settings → Pages → deploy from branch
4. Note the URL — `https://YOURNAME.github.io` or
   `https://YOURNAME.github.io/ENT`
5. **Put that origin in `ENT_ALLOWED_ORIGIN` (step 2)** and nothing else
6. `.gitignore` already excludes `.env.local` and `_legacy/`

Run `.\pre-publish.ps1` before the first push. It scans for the service-role
key and fails the build if one is anywhere git would track it.

---

## Everyday checks

```bash
node supabase-v2/scripts/verify_deploy.mjs       # functions + origins
node supabase-v2/scripts/check_migrations.mjs    # database schema
node supabase-v2/scripts/check_grants.mjs        # table privileges
node supabase-v2/scripts/check_function_grants.mjs  # function EXECUTE grants
node supabase-v2/scripts/test_admin_console.mjs  # admin console
node supabase-v2/scripts/test_ticket_form.mjs    # ticket form
node supabase-v2/scripts/test_frontend_v2.mjs    # frontend contract
node supabase-v2/scripts/simulate_browser.mjs    # routing
```

## If something breaks

| Symptom | Cause |
|---|---|
| Admin console empty, "staff list" spinner | `auth-admin` not deployed, or origin not allowed |
| Everything 401 / signed out | Session token not being sent |
| Works on `localhost`, dead on Pages | Origin missing from `ENT_ALLOWED_ORIGIN` |
| Tests green, browser broken | Preflight failing — run `verify_deploy.mjs`, not the tests |
| Ticket says "Removed account" for someone who exists | `users` did not load; same cause as row 1 |