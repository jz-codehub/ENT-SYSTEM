# supabase-v2 — the rebuild

This folder contains the current v2 schema and Edge Functions. The checked-in
frontend is integrated with v2 for authentication, reports, account
administration, and photo operations. The older v1 implementation may still
exist in a deployed project; this repository cannot confirm which backend or
migrations are currently live. Verify the deployed project before changing
schemas, switching traffic, or removing a legacy function.

`docs/07-FRONTEND-INTEGRATION.md` records the original migration plan and
summarizes the integration status. Do not treat its historical steps as work
that is still pending.

The DB Records paging RPCs require `0047_bounded_patient_record_reads.sql`
to be applied before deploying the matching browser build. Existing builds
fall back to the older paged REST queries if the migration has not yet been
applied; do not mistake that compatibility path for the bounded optimized path.

Exact dashboard count tiles and activity-day summaries require
`0048_dashboard_summary_counts.sql`. Before it is applied, the dashboard keeps
working but its cloud counts may be limited to the newest 3,000 loaded rows.
Recent-patient and follow-up panels remain intentionally bounded after 0048.

The doctor/secretary dashboard also reminds each account monthly to download
its RLS-visible saved reports as a dated JSON file. This is a private,
user-scoped report export, not a full project backup; separately stored photos,
deleted rows, and auth accounts are excluded. The reminder state is per
browser/device.

## What changes, in one line each

| Was | Now |
|---|---|
| `clinic_users` with `password_hash` + `salt`, readable over REST | `auth.users` (GoTrue) + `staff_profiles` with **no credential column at all** |
| SHA-256 of `salt + password` computed in the browser (`function/auth.js`) | GoTrue `signInWithPassword`, bcrypt behind it |
| Role read from the JWT / localStorage, trusted for 12 h | `requireAdmin()` re-reads `staff_profiles` on **every** request |
| Browser `PATCH`ing `clinic_users` directly | only `auth-admin` may write an account |
| `localStorage.entFeaturePhotoStorage = 'on'` enabled photos | `system_flags` read through `ent_capability()` inside the function |
| Storage policies matched on a guessed path prefix | the browser never calls Storage; `patient-photos` proxies every byte |
| One clinic hardcoded as `'main_clinic'` | `clinics.id` is a real FK on every row |

## Migrations, in order

| File | Creates |
|---|---|
| `migrations/0001_extensions_enums_helpers.sql` | citext, enums, `ent_is_authenticated()`, `ent_user_role()`, `ent_user_clinic_id()` |
| `migrations/0002_clinics.sql` | `clinics` — only the real `main_clinic` is seeded (the synthetic `satellite_clinic` was removed 2026-10-10) |
| `migrations/0003_staff_profiles.sql` | `staff_profiles` — roles, clinic membership, secretary→doctor link |
| `migrations/0004_reports.sql` | `reports` — one row per saved/final report, payload as jsonb |
| `migrations/0005_activity_and_presence.sql` | `activity_logs`, `user_presence` |
| `migrations/0006_flags_and_settings.sql` | `system_flags`, `clinic_settings` (replaces localStorage feature flags) |
| `migrations/0007_privileges.sql` | grants: what `anon` / `authenticated` may touch |
| `migrations/0008_rls_core.sql` | every RLS policy on every table |
| `migrations/0009_storage_policies.sql` | the private bucket + the authorization helpers the *function* satisfies |
| `migrations/0009b_storage_policies_dashboard.sql` | **not runnable in the SQL Editor** — the runbook for the 4 `storage.objects` policies, applied via Dashboard → Storage → Policies |
| `migrations/0010_admin_rpcs.sql` | `ent_capability`, `ent_set_active`, `ent_set_flag`, `ent_user_summary` … |
| `migrations/0011…0034` | the rest of the chain in order, ending with `0034_secretary_shelf_delete.sql` (secretary soft-delete + recycle bin scope) |
| `migrations/0035_account_deletion_safety.sql` | delete a doctor who still owns records: relax `created_by`/`uploaded_by` FKs to `ON DELETE SET NULL` (author name kept via `created_by_name`), and `ent_reassign_doctor_records()` moves a departing doctor's shelf onto another doctor of the **same** clinic — nothing orphaned, dedup intact |
| `migrations/0036_recycle_bin_retention.sql` | `ent_purge_recycle_bin()` — admin-only bulk erase of **already-deleted** rows past a cutoff (default 90 days), own clinic only; the paired `patient-photos purge_report` action frees the Storage bytes so a "Delete forever" no longer leaks the 500 MB quota |
| `migrations/0037_cross_clinic_secretary.sql` | one secretary, many doctors: the `secretary_assignments` junction plus `ent_is_my_doctor()` widen her read/write/stamp/bin to every doctor she is assigned to, **across clinics** — additive only, nothing else widened |
| `migrations/0038_enable_photo_storage.sql` | the server-side `photo_storage` flag row — the switch `ent_capability()` and the `patient-photos` gate read on every request |
| `migrations/0039_recycle_bin_doctor_and_secretary.sql` | `ent_deleted_reports()` widens to three readers (admin, the shelf's doctor, the shelf's secretary) and `ent_may_soft_delete` lets each mark their own rows |
| `migrations/0040_missing_grants.sql` | the grant-gap repair found by `check_function_grants.mjs`: `report_access_requests` + `secretary_assignments` get their table grants, 0031/0032's four RPCs get `authenticated` EXECUTE, `ent_capability` gets `service_role` EXECUTE (the 0011 defect-1 class, silent until the photo_storage switch is flipped) |
| `migrations/0041_duplicate_patient_guard.sql` | duplicate-patient protection at the DATABASE: partial unique indexes `uniq_reports_patient_day` / `uniq_reports_case_number_day` (hospital ID or case number + type + date + shelf, live final rows only — a NAME is never unique) and the read-only, SECURITY-INVOKER review RPC `ent_possible_duplicates()`; the browser adopts the existing row's `record_key` on an ID match and recovers from a 23505 race by merging into the winning row |
| `migrations/0046_rename_main_clinic_doc_jess.sql` | renames the existing `main_clinic` to `Doc Jess` and corrects doctor Jess's display name to `Doc Jess Jardin`, preserving clinic IDs and records |
| `migrations/0047_bounded_patient_record_reads.sql` | RLS-scoped DB Records paging (100 rows), photo-stripped card projections, and exact visit aggregates for only the patients on the current page |
| `migrations/0048_dashboard_summary_counts.sql` | RLS-scoped dashboard totals and daily report aggregates without sending report rows to the browser |
| `migrations/0049_notifications_and_staff_chat.sql` | staff notifications and clinic/direct chat foundation |
| `migrations/0050_super_secretary_network_scope.sql` | Super Secretary network scope, active-clinic context, and recipient-scoped staff chat delivery/read receipts |
| `migrations/0051_global_announcements.sql` | Admin-only global announcement RPC that sends each active account a private, read-tracked notification |
| `migrations/README.md` | the paste-order guide that ships WITH the set — one file at a time in the SQL Editor; `0009b` goes through Dashboard → Storage instead |

Test/synthetic seeds were **removed** on 2026-10-10 so nothing
test-related can ever reach a real database: `9100_seed_synthetic.sql`
(invented ZZTEST rows) and `0023_grant_attribution_and_revoke.sql`
(superseded, never applied) were deleted. Their history stays in git.
The seeds that remain in the chain are **config, not test data**:
`system_flags` (0006), the `patient-photos` bucket (0009) and the real
default clinic `main_clinic` (0002).

## 1 · Verify offline

Nothing below needs credentials.

```powershell
cd "supabase-v2\scripts"
npm ci
npm test                         # offline/static checks; does not contact the database
node check_migrations.mjs        # static checks over SQL + functions
node parse_check.mjs             # every Edge Function parses as an ES module
node bundle_for_dashboard.mjs    # dist/*.bundle.ts, each re-parsed
```

`check_migrations.mjs` proves things like *"no table in public is left without
RLS"*, *"no policy names `anon`"*, *"no credential column exists"*, *"the
service key is never sent to the browser"*. `parse_check.mjs` runs a real
ECMAScript parser — brace counting once reported three files as balanced that
did not compile, which is why it exists.

## 1.5 · Create the project, and fill in the keys

A new project takes about a minute: supabase.com → New project → any name, a
password you will not reuse, **region Singapore** (closest to the clinic). The
ref is the subdomain in the project URL.

Dashboard → Project Settings → API Keys gives three values. Create
`scripts/.env.local` locally; no key template is committed. This file is
git-ignored:

```text
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
```

| Value | Where it may appear |
|---|---|
| Project URL | `.env.local`, and the Edge Function env |
| `anon` key | `.env.local`, the Edge Function env, **and the browser** |
| `service_role` key | `.env.local` and the Edge Function secret. **Never in `function/`** |

Then set the functions' env in Dashboard → Configuration → Edge Functions →
Secrets (section 3 below) — before deploying, so the first boot has them.

This project is under version control. Keep credentials and local test output
out of commits; run the repository's pre-publish check before pushing.


## 2 · Apply the schema

**Use a throwaway project first.** For an existing project, confirm its schema
and migration history before applying anything. Do not run the whole chain
against the live app's database or assume repeated application is safe.

For a new test project, Dashboard → SQL Editor → run each file **in order**,
one at a time. If any file fails, stop and inspect the resulting database state
before deciding whether to retry or continue; the presence of guards in some
migrations does not make the entire chain safe to replay.
### The mechanics, once

1. SQL Editor → **New query**. Give it a name like `0001` (or leave it
   unnamed; the tab title is the only thing that helps you not lose track).
2. Open the file in the editor and copy **the whole thing**, `Ctrl+A` then
   `Ctrl+C`. Do not delete or "tidy" anything first — no line needs editing,
   and there are no placeholders in these ten files. Nothing to substitute.
3. Paste into the blank query. **Run** (or `Ctrl+Enter`).
4. Expected result: `Success. No rows returned.` That is normal for DDL — the
   absence of an error IS the pass. `NOTIFY pgrst` is not an error either.
5. Check **Table Editor → Refresh** every few files. Seeing the tables appear
   is the cheapest confirmation that you are pointed at the right project.
6. Repeat with the next file. Closing the tab is safe; the SQL already ran.

There is no psql metacommand (`\c`, `\i`), no `ALTER ROLE`/`ALTER SYSTEM`, and
no superuser-only statement anywhere in `0001`–`0010`, so the Dashboard editor
can run every one of them as-is. `CREATE EXTENSION pgcrypto, citext` is
allowed on Supabase without extra permissions.

Two things that are *not* safe to skip: the files must run in order —
`migrations/` IS the chain as **separate** files (one folder, one source
of truth since 2026-10-11; the old `fresh-setup/` mirror, its
`build_fresh_setup.mjs` builder and `.env.example` are gone). Paste them
one by one.

### One file the SQL Editor cannot run: `0009b`

`0009b_storage_policies_dashboard.sql` is a **runbook, not a script.** It
holds the four `storage.objects` policies, and pasting it fails:

```
ERROR: 42501: must be owner of table objects
```

`storage.objects` is owned by `supabase_storage_admin`. The SQL editor runs
as `postgres`, which is neither the owner nor a member of that role. That is
by design — Supabase's docs call the storage schema read-only. Apply those
four policies through **Dashboard → Storage → Policies**, using the
name/command/expression table written in that file. It is a five-minute
click-through and it is worth doing: the app's Edge Function holds the
service-role key and bypasses those policies, so they are the wall that
stands if direct Storage access is ever granted to the browser.



### The five .sql files in the repo ROOT are NOT for this project

```
supabase_schema.sql   supabase_auth_schema.sql   supabase_photo_storage.sql
fix_permissions.sql   supabase_admin_insights.sql
backup\pre-phaseA\ROLLBACK_PHASE_A.sql
```

Those are the v1 scripts — they build `patient_records` / `clinic_users` and
they were run against the old project long ago. `fix_permissions.sql` in
particular opens with:

```sql
GRANT USAGE ON SCHEMA public TO anon, authenticated;
```

which is the exact privilege `0007_privileges.sql` exists to revoke. Paste it
into the new project and the anon-master-key finding is back, with RLS as the
only wall again. Only `supabase-v2\migrations\*.sql` belongs in the new editor.

Run them **one file per run**, not concatenated. A batch stops at the first
error and reports a line number into the combined paste, which sends you
counting lines; one file at a time points straight at the file that failed.

Write the numbers down before you start, and again afterwards — the v1
README's habit is worth keeping:

```sql
select (select count(*) from clinic_users)    as legacy_users,
       (select count(*) from patient_records) as legacy_records;
```

Expected afterwards: `0008` ends with a `NOTIFY pgrst, 'reload schema'`; if a
file raises `EXCEPTION`, stop and fix it — the guards inside these files are
the test, not decoration.

## 3 · Secrets

Dashboard → Configuration → Edge Functions → Secrets. The names must match
exactly, because `_shared/auth.ts` reads them and refuses to run without them:

```
SUPABASE_URL                  (injected automatically by Supabase)
SUPABASE_ANON_KEY             (injected automatically)
SUPABASE_SERVICE_ROLE_KEY     (injected automatically — the SUPABASE_
                                prefix is RESERVED; the dashboard refuses
                                to let you set it manually, which is
                                correct: it is already there. Do NOT try.)
ENT_ALLOWED_ORIGIN            ← the ONLY one you set
```

> `_shared/auth.ts` resolves the key with
> `keyFrom('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY', …)` —
> new-style JSON dict first, legacy auto-injected JWT as fallback — so
> one deploy works on both the current and the post-2026 key systems.

The service-role key exists **only** inside these functions. Confirm after
deploying, in the browser console of the running app:

```js
Object.values(window).join(' ').includes('service_role')   // must be false
```

## 4 · Deploy the functions

`auth-admin` and `patient-photos` both import `../_shared/auth.ts`, and the
dashboard editor deploys one file — so either use the CLI, or paste a bundle:

```powershell
# A — CLI, keeps the tree as the source of truth
supabase link --project-ref <ref>
supabase functions deploy auth-admin
supabase functions deploy patient-photos

# B — no CLI on this machine: node bundle_for_dashboard.mjs, then paste
#   dist/auth-admin.bundle.ts and dist/patient-photos.bundle.ts
```

Both must be deployed with **Verify JWT = OFF**: they verify the JWT themselves
via `requireUser()`, and Supabase's own check would reject the preflight
request before the function can answer it.

Then smoke-test without the frontend — one command, no browser:

```powershell
cd supabase-v2\scripts
node smoke_test.mjs          # or: npm run smoke
```

`SMK-1` proves both functions are deployed and running the v2 code. `SMK-2`
proves **Verify JWT is OFF**: the request carries the anon key, and only our own
JSON body (`Authentication required.`) means the function — not the platform —
did the refusing. After `create_test_accounts.mjs`:

```powershell
node smoke_test.mjs --email testdoc1@zztest.invalid --password 'Zz!from-its-output'
```

`SMK-4` expects `403 PASSWORD_CHANGE_REQUIRED` for a fresh account, which is the
correct answer; it becomes `200` with `photo_storage=false` once the password is
changed. `capabilities` is how the client learns what is allowed — it never
decides for itself.

<details><summary>curl, if you prefer</summary>

```powershell
curl.exe -X POST "https://<ref>.supabase.co/functions/v1/auth-admin" `
  -H "apikey: <anon-key>" -H "Authorization: Bearer <anon-key>" `
  -H "content-type: application/json" -d '{\"action\":\"health\"}'
```

</details>

## 5 · Accounts (test projects only)

```powershell
cd supabase-v2\scripts
# Create .env.local locally with the target project's URL and keys first.
node create_test_accounts.mjs    # synthetic roster, prints passwords once
```

The synthetic patient seed `migrations/9100_seed_synthetic.sql` was
**deleted on 2026-10-10** — no migration inserts test rows any more, so
nothing invented can be applied to a real project. Accounts are now the
only test fixture: run `docs/06-TEST-PLAN.md` against them directly.

`node create_test_accounts.mjs --teardown` removes the roster again; deleting
the `auth.users` row cascades to `staff_profiles`.

## 6 · Cutover rules

These stay true until the test plan says otherwise:

1. `photo_storage` stays **OFF** (`0006` seeds it FALSE). Photos keep living
   in IndexedDB exactly as they do today. Flip it only after every `STORAGE-*`
   test passes, and flip it per clinic — not by editing localStorage.
2. No real patient data is migrated until `CRED-*`, `ISO-*` and `PRIV-*` pass.
3. Keep any deployed v1 functions available only as long as the verified
   cutover or rollback plan requires them. The checked-in frontend calls v2;
   confirm the actual production traffic and backup before disabling a legacy
   function. The v1 and v2 schemas do not share a table.
4. Rollback of the schema is not a revert script — it is `drop schema public
   cascade` on a **test** project and re-apply. On the live project, restore
   the pre-cutover backup instead.
