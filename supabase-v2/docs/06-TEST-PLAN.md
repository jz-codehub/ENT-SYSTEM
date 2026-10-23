# 06 · Test plan (v2)

Run this **before** any real patient data exists in the project. Everything
here is executable against a project that has been through
`README.md` steps 1-5 — synthetic accounts, synthetic reports, no real names.

**Evidence rule.** A test is not "it looked right". It is the request you made,
the status/row-count you got, and the `activity_logs` line it produced.
Copy those three into the row for the test. A test with no evidence attached
is an untested requirement.

## 0 · The in-editor probe

The whole security model can be poked from the SQL editor without a browser,
because the RLS helpers read the claim GUCs that PostgREST would set. This is
the fast loop; the browser tests below prove the same things from the outside.

```sql
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"<doctor-uuid>","role":"authenticated",
      "app_metadata":{"role":"doctor","clinic_id":"<main-clinic-uuid>"}}';

  select count(*) as own_shelf        from public.reports;              -- expect: only his
  select count(*) as other_clinic     from public.reports
    where clinic_id = '00000000-0000-4000-8000-00000000c21c';           -- expect: 0
  select count(*) as staff_directory  from public.staff_profiles;       -- expect: per policy
  select public.ent_capability('photo_storage');                        -- expect: false
reset role;
rollback;
```

Run the same block with `set local role anon;` and no claims: **every** `select`
must raise `permission denied`. A `0` is also a failure here — `0` means the
table was readable and empty, which is a hole, not a pass.

> Claims come from a signed JWT and `app_metadata` can only be written by the
> service role, so a user cannot change their own claim. `auth-admin` updates
> `app_metadata` **and revokes the sessions** whenever a role changes
> (`index.ts` ~line 263), so a demoted admin has no window in which a stale
> claim still works. `PRIV-04` below is the test that proves it.

## A · AUTH — sign-in and identity

| ID | Do | Must see |
|---|---|---|
| AUTH-01 | Sign in as `testdoc1` with the printed password | 200; `auth.users.last_sign_in_at` set; `staff_profiles.last_login_at` set |
| AUTH-02 | Same, wrong password | 401 `invalid credentials` — identical wording to a wrong username. No hint which half was wrong |
| AUTH-03 | Same, correct password, `is_active = false` (flip via `auth-admin` `set_active`) | 403 `account disabled`. **Not** 401: it is a different fact |
| AUTH-04 | `must_change_password` account signs in, then calls a data endpoint **without** finishing the change | Blocked; the only allowed call is `finish_password_change` |
| AUTH-05 | `auth-admin` `{action:'finish_password_change'}` with that session | `ok:true`, column now false, `PASSWORD_CHANGED` in `activity_logs` |
| AUTH-06 | Take `testdoc1`'s JWT, call `auth-admin` `{action:'list'}` after the admin has demoted him to secretary | 403 — role re-read from `staff_profiles`, the JWT's claim is ignored |
| AUTH-07 | Call `auth-admin` with no `authorization` header | 401, and `health` still answers 200 (it reports nothing sensitive) |
| AUTH-08 | Sign in with the old v1 scheme: `sha256(salt + password)` hex as the password | Fails. There is no code path that accepts a pre-hashed password — this is the migration being *closed*, not just unused |

## B · CRED — nothing that smells like a credential leaves the database

| ID | Do | Must see |
|---|---|---|
| CRED-01 | `select column_name from information_schema.columns where table_schema='public' and column_name in ('password_hash','salt','token','password','session_token')` | **0 rows.** `staff_profiles` has no credential column by design |
| CRED-02 | `GET /rest/v1/staff_profiles?select=*` with the **anon** key | 401/403. The v1 probe downloaded the whole hash table; this must not return rows at all |
| CRED-03 | Same, with `testdoc1`'s session | Only his clinic's rows, only the granted columns, never a hash |
| CRED-04 | In the app console: `Object.values(window).join(' ').includes('service_role')` | `false` |
| CRED-05 | Read every response body from the app for the string `service` | No service-role key anywhere. `auth-admin` returns a **starter password once** at creation — that single response is the only credential that ever crosses the wire, and it is printed for the admin, not stored |
| CRED-06 | `select rolname, rolconfig from pg_roles where rolname in ('anon','authenticated')` and `select * from information_schema.role_table_grants where grantee='anon' and table_schema='public'` | 0 grants on tables |

## C · ISO — clinic isolation

This group needs a **second** clinic. `satellite_clinic` (and its roster
`zzbadmin` / `zcbdoc1`) was test data and has been **removed from the
migrations** — in a throwaway test project, insert it by hand first:

```sql
insert into public.clinics (code, name) values ('satellite_clinic', 'Satellite ENT Clinic (test)');
```

then create its two accounts by hand (or re-add the two roster lines in
`create_test_accounts.mjs` temporarily). A live project never needs this
group's clinic: ISO-* is a test-project-only scenario.

| ID | Do | Must see |
|---|---|---|
| ISO-01 | `zcbdoc1` lists reports | 0 rows from main clinic. **Empty, not an error** — an error would leak that the clinic exists |
| ISO-02 | `zcbdoc1` calls `auth-admin` `{action:'update', target_id:<main-clinic uuid>}` | 403 `That account belongs to another clinic`, plus an `ACCESS_DENIED` audit row naming the target |
| ISO-03 | `testdoc1` requests a satellite report id directly from `/rest/v1/reports?id=eq.<uuid>` | 0 rows |
| ISO-04 | `testdoc1` requests a photo from `patient-photos` for a satellite report | 404 (or 403) and **no bytes**; the function resolved the report *as the caller* through RLS and was refused |
| ISO-05 | Two doctors, same clinic: `testdoc2` reads `testdoc1`'s report | Follows the policy in `0008` exactly — decide deliberately which is allowed, then assert it here. Whatever the answer, the list screen and the photo proxy must give the **same** answer |

## D · PRIV — roles do what they say

| ID | Do | Must see |
|---|---|---|
| PRIV-01 | `testsec1` lists reports | Only `testdoc1`'s shelf — the server-side replacement for `doctorFilter()` in the old JS |
| PRIV-02 | `testsec1` POSTs `{action:'update', role:'admin'}` to `auth-admin` | 403. A secretary cannot reach any admin action |
| PRIV-03 | `testdoc1` (not admin) posts the same | 403 |
| PRIV-04 | `testadmin` demotes himself (`update` → role `doctor`), then immediately calls `{action:'list'}` with the session he already holds | 403. The claim in his JWT still says admin; `requireAdmin()` read `staff_profiles`. His sessions are revoked in the same call, so the claim dies too |
| PRIV-05 | `testadmin` demotes the last active admin in the clinic | Refused by the guard in `0010` — a clinic must keep an admin |
| PRIV-06 | Assign `testsec1` to `zcbdoc1` (another clinic) | Rejected: the doctor must be in the same clinic, and the self-referencing FK will not accept a dangling uuid |
| PRIV-07 | Create a `doctor` with `assigned_doctor_id` set | Rejected by `staff_secretary_requires_doctor` — the constraint, not the UI |

## E · FLAG — the server decides

| ID | Do | Must see |
|---|---|---|
| FLAG-01 | `localStorage.setItem('entFeaturePhotoStorage','on')`, reload, upload a photo while `photo_storage = false` | Rejected `PHOTO_STORAGE_DISABLED`. localStorage is cosmetic; `ent_capability()` is the gate |
| FLAG-02 | `auth-admin` `{action:'set_flag'}` as `testadmin`, then ask `capabilities` | Flag flips, `capabilities` reflects it on the next request, `activity_logs` records who flipped it |
| FLAG-03 | `set_flag` as `testdoc1` | 403 |
| FLAG-04 | Make the flag's RPC unreadable and ask `capabilities` | Falls back to the **default the caller passed**, and `patient-photos` passes `false` — an unreadable flag means *off*, never *on* |

## F · STORAGE — photos, once `photo_storage` is on

| ID | Do | Must see |
|---|---|---|
| STORAGE-01 | Upload a real JPEG (valid magic bytes) on your own report | Stored; path built by the function, never accepted from the client; `photo_count` increments |
| STORAGE-02 | Upload `fake.jpg` whose bytes are actually a PDF | Rejected by content sniffing, before any byte reaches Storage |
| STORAGE-03 | Upload a `.png` over the per-file cap | Rejected with a size error and no partial object left behind |
| STORAGE-04 | Upload past `MAX_PHOTOS_PER_REPORT` | Rejected, with the current count in the message |
| STORAGE-05 | Guess a storage path (`…/patient-photos/<other-clinic>/<uuid>.jpg`) with a valid session | 404. There is no path-prefix policy to guess into |
| STORAGE-06 | `list` / `download` / `remove` for a report you may not see | Refused through RLS on the report, exactly as ISO-04 |
| STORAGE-07 | Dashboard → Storage → bucket | Public URL absent; policies only cover the service path |
| STORAGE-08 | Turn the flag back **off**, retry the upload | Refused again — proof the flag is read per request and not cached |

## G · AUD — the trail answers "who changed this"

| ID | Do | Must see |
|---|---|---|
| AUD-01 | Create, update, disable, reset-password, revoke-sessions on one account | Five rows in `activity_logs`, actor stamped server-side, target named |
| AUD-02 | Repeat the refusals from ISO-02 / PRIV-02 / PRIV-03 | Refusals are logged too. A denied action that leaves no trace is the one you cannot investigate |
| AUD-03 | `delete from activity_logs` as `authenticated` | Rejected: insert-only for app roles |
| AUD-04 | Heartbeat from two tabs of the same account | Presence rows appear and expire; no cross-clinic presence is visible |

## H · PHASE-6 — behaviour the v1 app already had

| ID | Do | Must see |
|---|---|---|
| PHASE-6.1 | Repeat group B with the network tab open | Unauthenticated access impossible |
| PHASE-6.7 | Close the tab mid-report, reopen | Draft still in IndexedDB, unchanged — v2 does not touch the draft path yet |
| PHASE-6.9 | Save a report with DevTools "Offline" for 5 s mid-save | No duplicate `record_key`: `0004` is unique on `(clinic_id, doctor_id, record_key)`, so the retry updates instead of duplicating |

## I · DEL — soft delete, recycle bin, final delete

Migration `0034` + the DB Records Delete button + the two bins. Offline
guard first, then the browser:

    node supabase-v2/scripts/test_recycle_bin_ui.mjs     → 32/32, 0 failed

| ID | Do | Must see |
|---|---|---|
| DEL-01 | Secretary, DB Records → **Delete** on a record of her assigned doctor → confirm | Row vanishes from the list (RLS); `reports.deleted_at` set; `deleted_by` = **her** uuid — the value the browser sent is ignored (0034's stamp) |
| DEL-02 | Same attempt by hand: `PATCH /reports?id=eq.X` with `deleted_at` from a different-clinic session | 403 / 0 rows — `ent_may_soft_delete` keys on her own `staff_profiles` row |
| DEL-03 | Secretary opens **Recycle bin** in DB Records; admin opens Admin Console → Deleted records; a *doctor* calls `/rpc/ent_deleted_reports` | Secretary sees ONLY her assigned doctor's shelf; admin sees the whole owned clinic; doctor → `42501 refused` |
| DEL-04 | Restore from either bin | `deleted_at`/`deleted_by` NULL, record back with payload and photos; bin count drops |
| DEL-05 | Admin Console → **Delete forever** (click once → armed → click again) | Row gone from `reports` **for good**; toast "Record permanently deleted." |
| DEL-06 | The same DELETE against a LIVE row (craft it: `DELETE /reports?id=eq.<live>`), and from a non-admin session | 0 rows deleted both times — `reports_delete_admin` requires `deleted_at IS NOT NULL` + active admin; `reports_delete_own_doctor` does not exist |
| DEL-07 | Secretary tries "Delete forever" anywhere | No such button outside the Admin Console, and `DELETE /reports` → 403 regardless |

## Sign-off

Nothing real moves until every row above has evidence attached and these hold:

- [ ] No test rows anywhere: `select count(*) from public.reports where payload->>'synthetic' = 'true'` → **0** (the synthetic seed `9100_seed_synthetic.sql` was deleted 2026-10-10)
- [ ] Groups A-G pass on a **test** project
- [ ] `photo_storage` is still OFF for the live clinic, and stays off until group F passes there
- [ ] The v1 functions are still deployed and untouched
- [ ] A restore point / backup exists for the live project, taken *before* cutover
- [ ] `node check_migrations.mjs` and `node parse_check.mjs` pass at the exact commit being deployed
- [ ] `node test_recycle_bin_ui.mjs` → 32/32 (soft delete · bins · final delete)

Not covered here, worth a manual look once the frontend is wired: session
persistence across a hard refresh, the forced password-change screen on a real
device, and the JWT expiry boundary.


