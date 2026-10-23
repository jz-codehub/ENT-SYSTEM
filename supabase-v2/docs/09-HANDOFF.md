# =====================================================================
#  HANDOFF · ENT v2 cross-clinic grants · state of play
#  Written 2026-10-03. UPDATED 2026-10-11 after re-verifying on a new PC.
#
#  READ THIS FILE FIRST. It is the whole state of play.
# =====================================================================

## -6 · UPDATE 2026-10-11 (gabi) — NEW SUPABASE PROJECT · 0041 DUP-GUARD · FULL-NAME CLINIC · v34a

**1. BAGONG PROJECT: `ybnlvfdvfrwnmdvhxeof`** (na-verify: DNS + API buhay,
0 tables/functions/edge-functions/storage = tunay na sariwa). Ang dati
kong hawak na `bvzuraltazxtaxnmbmcr` (sa lumang `.env.local`) ay
**hindi na nagre-resolve sa DNS** — dapat na itong ituring na deleted;
huwag nang balikan. Ang frontend (`function/supabaseClient.js` PROJECT_REF
+ ANON_KEY, at ang CSP `connect-src` sa `build-pages.mjs`) ay naka-point
na sa bagong ref, at `sw.js` CACHE_NAME = `…-v34a-duplicate-guard` (mga
file na `?v=v34a`: dashboard.js/css sa index, dbRecords.js sa 3 form,
admin.js sa admin.html). **HINDI PA NAKA-PUSH** — ang live site ay nasa
lumang project hangga't walang Cloudflare build. Buong hakbang:
`docs/10-DEPLOY-NEW-PROJECT.md`.

**2. Migration `0041_duplicate_patient_guard.sql`** — ang sagot sa
"nagkakaroon ng kopya-kopya ang pasyente". Dalawang **partial unique
index** sa LIVE FINAL rows lang: `uniq_reports_patient_day` at
`uniq_reports_case_number_day` (case_number lang kapag walang
patient_id) — lower+btrim sa identifier, coalesce sa petsa, bawat doctor
shelf. **Walang name-based constraint**: ang pangalan ay hindi
identifier. Ang pangalan ay napupunta sa **`ent_possible_duplicates()`**
— read-only, **SECURITY INVOKER** (RLS ng caller pa rin ang hurado),
walang merge/delete; lilitaw sa bagong admin Overview card na "Possible
duplicates". `dbRecords.saveToDatabase`: kapag kaparehong patient ID +
type + petsa ang nasa cloud, **in-aadopt nito ang record_key** (merge,
hindi bagong row, at nilalaktawan ang name-prompt); kapag 23505 race,
hindi bumabagsak — hinahanap ang nanalong row at doon inimerge. Bagong
`test_duplicate_guard.mjs` **28/28**; `check_migrations` **350/350**;
`check_function_grants` **32/32**.

**3. Doctor clinic naming = `ENT-clinic doc. <Buong Pangalan>`** (hindi
"first name only" + hospital suffix tulad noon): "Juan Dela Cruz" →
`ENT-clinic doc. Juan Dela Cruz`. Idinagdag ang **idempotent retry**
(adopt ng clinic na may parehong code na pag-aari nitong admin) at
**orphan compensation** (kapag bumagsak ang createUser/profile insert,
binubura lamang ang clinic na *nilikha nitong call*). `dist/*.bundle.ts`
na-regenerate (parse-verified).

**4. Libreng plano — `docs/11-FREE-PLAN-SUSTAINABILITY.md`.** Bagong
quota mula sa pricing page ngayon: 500 MB DB, 5 GB egress, **1 GB file
storage**, 2 project, at — pinakamahalaga — **"Free projects are paused
after 1 week of inactivity"**. Unang bottleneck: **Storage** (~12 buwan
sa 100 bisita/buwan kung naka-on ang larawan; ~4 na buwan sa 300). Pangalawa:
**inactivity pause** (kailangang may gamit kahit isang beses bawat
linggo, o mag-Pro). Ang `photo_storage = ON` ay hindi lang feature —
kaytagal ng DB quota iyon.

**5. Repo cleanup — ISANG folder na (2026-10-11).** Tinanggal ang
`supabase-v2/fresh-setup/` (byte-identical mirror ng migrations),
`scripts/build_fresh_setup.mjs` at `scripts/.env.example`. Ang
`supabase-v2/migrations/` na lang ang source of truth, kasama ang
`migrations/README.md` (paste order, unang-admin step via
`scripts/make_account.mjs`, 0009b Dashboard step). Ang
`validate_fresh_setup.mjs` ay naging **`validate_migrations.mjs`**
(V2 check: isang folder talaga, walang mirror na puwedeng mag-drift).
Walang test user / test clinic / synthetic seed kahit saan — ang
`create_test_accounts.mjs` ay dev tool na lang, hindi ginagamit sa
deployment.

**6. Mga tool/pattern na dapat tandaan.** `node temp/probe_new_project.mjs`
(read-only status ng project gamit ang anon key: table na umiiral =
42501/403, wala = 42P01/404). PowerShell quirks sa PC na ito: ang `& node`
minsang walang output — `| Out-String` o `$o = & node … 2>&1` ang sagot;
ang `Invoke-WebRequest` ay tinatanggihan ang `Range` header (gamitin ang
node fetch).

## -5 · UPDATE 2026-10-11 (huli) — 1-DAY STREAK · MIGRATION 0040 (GRANTS) · ADMIN DELETE NG DOCTOR

**1. Streak pill (frontend, v33as).** "meron 1 patient today dapat lalabas
1-day streak" — `renderHero` drew the streak only from `streak >= 2`, so the
first save of the day rendered no line at all. Threshold is now `>= 1`; zero
stays hidden AND cleared (the v33ar fix stands). `test_frontend_v2` D80–D82
lock it in; `index.html` marks dashboard.js/css at `?v=v33as` and `sw.js`
CACHE_NAME bumped to `…-v33as-streak-one-day`.

**2. `migrations/0040_missing_grants.sql` — the grant-gap repair (found
OFFLINE, before any deploy).** New `scripts/check_function_grants.mjs`
auditors every FUNCTION against who actually calls it (browser `rpc/…`,
policy bodies via `authenticated`, Edge Functions via `admin()` /
`asUser()`). With 0040 in place: 30/30 checks; `check_grants.mjs` (tables)
went exit 1 → exit 0. What 0040 fixes:

* `report_access_requests` (0031) + `secretary_assignments` (0037) had
  ZERO table grants. The junction is read by admin.js with the caller's
  JWT and written by auth-admin with service_role — so "Also works at"
  always rendered empty and `set_assignments` always failed 42501.
* 0031/0032's four RPCs (`ent_request_report`,
  `ent_handle_access_request`, `ent_view_incoming_access_requests`,
  `ent_view_my_access_requests`) had no EXECUTE for `authenticated` →
  viewAllAccess.js's whole "ask the other clinic" workflow answered 42501.
* `ent_capability(text)`: EXECUTE only to `authenticated`, but BOTH Edge
  Functions call it `admin().rpc()` = service_role; the 403 is caught and
  turned into the fallback, so it was SILENT — flipping `photo_storage`
  ON would have changed nothing server-side. service_role EXECUTE added
  (the body checks no caller — the 0011 pattern, applied).
* `ent_default_clinic_id()` (0002): never granted at all.

**3. Admin DELETE ng doctor — was truly blocked, now fixed.** The delete
path called `admin().rpc('ent_reassign_doctor_records')`, but 0035's guard
re-reads the caller with `ent_auth_uid()` ("service_role is NOT
special-cased here" — 0035's own words) and a service_role JWT has no
`sub`: without 0040 the call died at 42501; with a blind grant it would
still raise "refused: only an active administrator". The Edge Function now
calls `asUser(me.jwt)` — the exact `set_active` pattern from 0011 — and
`asUser().rpc()` needs only the `authenticated` grant 0035 already issued.
Deleting secretaries/admins never took this path; only a doctor who still
owns records does.

**Runbook — NEW Supabase project:** paste `migrations/0001…0041` one file
at a time (0023 skips ON PURPOSE), add the 4 storage policies via
Dashboard (`0009b_storage_policies_dashboard.sql`), create the FIRST real
admin with `scripts/make_account.mjs`, then deploy BOTH Edge Functions
from the REBUNDLED `dist/*.bundle.ts` (auth-admin changed). Buong
hakbang: `docs/10-DEPLOY-NEW-PROJECT.md`.
**Existing project:** run `0040` (plus 0024→0039 if still pending).

## -4 · UPDATE 2026-10-11 — FREE-PLAN LONGEVITY · WHAT FILLS IT UP + THE TWO FIXES

**Bakit napupuno ang free plan (5 GB egress/mo, 500 MB DB, 1 GB files).** Two
culprits, and they hit different quotas:

1. **Photos stored INLINE in `reports.payload` as base64** while
   `photo_storage` is FALSE. Base64 ≈ +33% over the original, so one 700 KB
   photo ≈ 930 KB *of the database*, and a 3-photo report ≈ 2.8 MB →
   **~180 reports fills the 500 MB database** (weeks at clinic rate).
2. **Polling.** The dashboard re-fetched its whole window every 60 s, the
   admin console's analytics every 60 s, and the pending queue every 30 s —
   each tick is EGRESS. An open browser tab is a tab that keeps draining the
   5 GB cap. Worse, `backup_v2.mjs` used `select=*`, so one backup of a
   photo shelf could exceed a week's app egress.

**Fixes applied (ANTAS 1 — zero-risk config, no migration):**

* `function/dashboard.js` — `REFRESH_MS` 60 s → **180 s**, `STALE_MS` 45 s →
  **120 s**, `QUEUE_POLL_MS` 30 s → **60 s**. Nothing on screen is a live
  feed, so the cadence is invisible but cuts the dashboard's egress ~2/3.
  Manual Refresh still exists for "I just saved it".
* `function/admin.js` — `ANALYTICS_REFRESH_MS` 60 s → **120 s** (the heaviest
  recurring read: buckets + activity + usage meters). The presence poll
  (`REFRESH_MS`, 30 s) deliberately stays — it reads one tiny presence row,
  and its `LIVE_WINDOW_MS` is 5 minutes anyway.
* `supabase-v2/scripts/backup_v2.mjs` — default backup now reads `reports`
  WITHOUT the `payload` column (identity/metadata only, the part a
  "move to a new project" restore needs). Pass `--with-payload` for a
  deliberate full archive and accept the one-off egress hit.

**Fix prepared (ANTAS 2 — the one that buys YEARS):** migration
`0038_enable_photo_storage.sql` flips `system_flags.photo_storage` to TRUE
(the bucket + policies already exist from `0009`). Then photos live in the
private `patient-photos` bucket (1 GB, ~1,400 photos) and `reports.payload`
shrinks to text (~few KB/row → hundreds of thousands of records). **Intentionally
NOT auto-applied:** run it AFTER `docs/06-TEST-PLAN.md` STORAGE-* pass on a
throwaway project — never on a database with real patient photos before the
storage path is proven (same rule 0006's FALSE seed encodes). Revert = one
UPDATE back to FALSE (commented at the file's bottom).

Verified: `check_migrations.mjs` = **325** (was 317; +8 from 0038),
`test_dashboard_extras.mjs` = 24, `test_follow_up_logic.mjs` = 22,
`build-pages.mjs` = 39. Version still **v33ak** (same fresh-deploy batch).

## -3 · UPDATE 2026-10-11 — FOLLOW-UP SYSTEM (dashboard + admin) · NO MIGRATION

The follow-up date is a **payload field**, exactly like `payload.site` — no
new column, no migration, so it rides along with the fresh 0037 deploy for
free. `function/dbRecords.js` asks for an optional date at Save-to-Database
time (`askFollowUp()`), writes `payload.followUpDate` (YYYY-MM-DD) only when
one is chosen, and three surfaces read it:

* `index.html` dashboard — a red **"N due for follow-up"** badge (shown only
  when a patient is due/overdue, never at zero) and a **Follow-ups** card,
  soonest first, colour-coded overdue / today / soon / future. Doctor and
  secretary only. `function/dashboard.js` adds `followUpOf` / `followUpDays`
  / `followUpState` / `followUpRows` and reads `payload->>followUpDate`
  through the SAME three-tier select as `site`, so an older DB shape simply
  shows an empty card instead of an error.
* `pages/admin.html` console — a clinic-wide **Follow-ups due** card on the
  Overview panel: every patient across the clinic, grouped by urgency, with
  the clinic name on each row. `function/admin.js` has its own wider-window
  loader (`loadFollowUps`, 120-day lookback) for the same reason the latest
  card is only 30 days.
* Styles in `style/dashboard.css` (`.ent-followup-row` + `.ent-dash-alert.
  is-followup`) and `style/patient-records.css` (the dialog input).

The pure date logic is proven by `scripts/test_follow_up_logic.mjs`
(22 checks, no network): today = 0 days, tomorrow = 1, a malformed date is
null and never crashes the card. `check_migrations.mjs` = 317, `parse_check`
clean, `build-pages.mjs` = 39 entries, no version bump needed (still v33ak —
the follow-up files — dashboard.js, admin.js, dbRecords.js,
patient-records.css, dashboard.css — all share that tag).

## -2 · UPDATE 2026-10-10 (huli) — SOFT DELETE NG SECRETARY · RECYCLE BIN UI · FRESH-SETUP

**1. Migration `0034_secretary_shelf_delete.sql`** (kasama na sa baseline
at sa fresh-setup; `check_migrations.mjs` = 301 checks, exit 0):

  * `ent_may_soft_delete` → ika-4 braso: **secretary** (active, at
    `p_doctor = kanyang assigned_doctor_id`, sa mismong clinic ng row).
    Lahat ng naunang braso (author-ng-draft, sariling doctor,
    own-clinic admin) ay hindi ginalaw. Sinadyang **hindi** dumaan sa
    `ent_may_edit_report` — kasama doon ang cross-clinic GRANT, at ang
    grant na pang-correct ay hindi dapat maging pang-destroy (0019).
  * `ent_deleted_reports` → dalawang mambabasa na: **admin** (buong
    clinic na pag-aari niya) o **secretary** (shelf ng assigned doctor
    lang, sa sariling clinic). Doctor = `RAISE` pa rin. Payload hindi
    pa rin ibinabalik.
  * Bagong trigger `trg_reports_stamp_deleaser` → ang `deleted_by` ay
    ini-stamp mula sa **JWT**, hindi pinaniniwalaan mula sa body
    (server-owned, gaya ng ownership stamp); `service_role` exempt
    para hindi masira ang backup/restore.
  * Guard DO-block: pinatunayang **wala pa ring** hard delete kundi
    admin-sa-already-deleted-row (`reports_delete_admin`), at babalik
    ang pula kung magmuling lumitaw ang `reports_delete_own_doctor`.

**2. UI — buong flow ngayon:**

  * `function/dbRecords.js` — bumalik ang **Delete** button sa bawat
    record card (soft delete: confirm → `PATCH deleted_at` +
    `deleted_at=is.null` → refresh → `DELETE_RECORD` audit, walang PHI).
    Bagong **Recycle bin** toggle sa toolbar (admin/secretary lang;
    nakatago ang doctor) na nagta-type-scope na listahan mula sa
    `/rpc/ent_deleted_reports` na may **Restore**. Walang hard DELETE
    sa buong file.
  * `function/admin.js` + `pages/admin.html` — **🗑 Delete forever**
    button sa bawat row ng Deleted-records panel: **two-step** ang
    click (una = arm na may 4s auto-disarm, pangalawa = erase),
    `DELETE reports?id=eq.X&deleted_at=not.null` na may
    `return=representation` — kapag walang ibinalik na row, itinatanggi
    (hindi nagpapanggap na success). Restore, tulad dati, PATCH pa rin.
  * `style/patient-records.css` — estilo ng `.ent-db-del`,
    `.ent-db-trashbtn`, `.ent-db-trashcard`, `.ent-db-restore`.
  * `sw.js` → **v33ai** (cache bump; hindi aabot sa browser kung hindi).

**3. `migrations/` — separate files, HINDI all-in-one** (dating
`fresh-setup/`): ang folder na ito ang BUONG chain nang hiwalay, kasama
ang `README.md` (paste order, 0009b step, unang-admin step, restore
pointer). **2026-10-11:** tinanggal na ang mirror folder, ang
`build_fresh_setup.mjs` at ang `.env.example` — isang source of truth na,
walang puwedeng mag-drift na kopya.

**3b. UPDATE 2026-10-10 (pinakahuli) — ADMIN DELETE NG USER + STORAGE
CLEANUP + RECYCLE-BIN RETENTION** (`0035`, `0036`; `check_migrations.mjs`
= 308 checks, `test_recycle_bin_ui.mjs` = 41/41, lahat exit 0):

  * `0035_account_deletion_safety.sql` — kaya nang mag-**delete ng doctor
    na may patient records** si admin nang **walang nao-orphan at walang
    nawala**. Ang `reports.created_by` at `report_photos.uploaded_by` FK
    ay `ON DELETE SET NULL` na (nullable); ang tunay na may-akda ay
    nananatili sa `created_by_name` (0028 snapshot). Ang `doctor_id` ay
    **hindi kailanman nino-null** (kalahati ng unique key at RLS) — sa
    halip, ang bagong `ent_reassign_doctor_records(p_from, p_to)` ay
    inililipat ang buong shelf sa **ibang active doctor ng parehong
    clinic** (may guard: active admin, same clinic, active-doctor lang).
    Idinagdag sa `auth-admin` delete flow: `pickReassignTarget` → reassign
    → `deleteUser`, kaya wala nang 23503 at wala nang uli na account.
  * `patient-photos` — bagong `purge_report` action: **tinatanggal ang
    Storage bytes** ng isang **naka-soft-delete** nang report (admin-only,
    own-clinic). Ito ang #1 leak: dating ang "Delete forever" ay
    nagbababa ng row (cascade sa `report_photos`) ngunit iniwan ang
    larawan sa bucket — kumakain ng 500 MB quota magpakailanman.
  * `0036_recycle_bin_retention.sql` — `ent_purge_recycle_bin()` (admin-only,
    own-clinic, **already-deleted lang**, may 90-araw na default cutoff).
  * `function/admin.js` + `pages/admin.html` — ang `purgeTrashRow` ay
    nag-fi-free ng storage **bago** mag-DELETE (importante ang order:
    pagkatapos mag-delete, wala nang `object_path` na matitirang hanapan).
    Bagong **"Empty old bin"** button (two-step) na nagbubura ng >90-araw
    na deleted rows isa-isa para tama ang storage-then-delete order.


**4. Mga ayos na hindi kaugnad ng feature:**

  * `selftest_view_all_ui.mjs` — **pre-existing na sira** mula noong
    binago ang markup ng `viewAllAccess.js` (c165d7f): 3 mutation
    pattern + 1 panghuling assertion ang hindi na nagma-match sa
    `<span class="cca-name">` at `rows.map(renderRow)`. Inaayos na →
    **12/12**. Ang misming `viewAllAccess.js` ay HINDI hinawakan.
  * `.gitignore` — dinagdagan ng `/backup/` at `supabase-v2/backup/`
    (bagong export ng `backup_v2.mjs` = patient payloads + password
    hashes; dati, isang tracked rollback file lang ang nag-iingat sa
    folder na hindi ignorado).

**5. Verification (offline, lahat sa makina na ito):**

    check_migrations.mjs        301 checks, exit 0
    parse_check.mjs             exit 0
    check_grants.mjs            exit 0
    check_0025_assertions.mjs   exit 0
    strict_load.mjs             exit 0
    audit_frontend.mjs          exit 0
    test_recycle_bin_ui.mjs     32/0   ← BAGO
    test_db_records_card        85/0   test_db_records_site     28/0
    test_drafts_team            43/0   test_dashboard_team      40/0
    test_admin_console          96/0   test_frontend_v2         49/0
    test_ticket_form            42/0   test_view_all_ui         50/0
    selftest_view_all_ui        12/0   test_stable_report_id    17/0
    test_draft_photo_invariants 19/0   test_presence_polling    19/0
    test_photo_validation       30/0   test_growth_month        32/0
    test_usage_estimate         20/0   test_cf4_restore          9/0
    test_cf4_header_logo         7/0

  Ang `simulate_browser.mjs` ay LIVE sign-in test (6 na account, lahat
  "SIGN-IN REFUSED" offline) — hindi ito offline suite, at hindi
  hinawakan ng pagbabagong ito.

<!-- @@UPDATE-2026-10-10-2@@ -->

## -1 · UPDATE 2026-10-10 — TEST DATA PURGED · BASELINE · RESTORE TOOLING

**1. All test data is GONE from `migrations/`.** Nothing test-related can
be applied to a real database any more:

  * `9100_seed_synthetic.sql` — **DELETED** (ZZTEST synthetic patients,
    synthetic `clinic_settings`, drafts).
  * `satellite_clinic` seed row — **removed from `0002_clinics.sql`**
    (it existed only for ISO-01). `main_clinic` STAYS: it is the real
    default clinic `ent_default_clinic_id()` resolves.
  * `0023_grant_attribution_and_revoke.sql` — **DELETED** (superseded,
    never applied; see section 4. History still in git).
  * What remains are **config, not test data**: `system_flags` (0006),
    the `patient-photos` bucket (0009), `main_clinic` (0002), and the
    `activity_logs` / `report_access_*` INSERTs that live *inside* RPC
    function bodies (runtime logic, not seeds).
  * `create_test_accounts.mjs` roster trimmed to `main_clinic` only —
    the satellite accounts would now fail (`clinic 'satellite_clinic'
    missing`), which is correct: ISO-* needs a hand-made test clinic.

**2. New-project schema: `migrations/` — SEPARATE files.** Paste them
one by one in order (see `migrations/README.md`).
Caveat baked in: `0009b` is comment-only — the four
`storage.objects` policies must still be added by hand via
Dashboard → Storage → Policies (the SQL editor cannot own that table).

**3. Backup/restore tooling for moving to a fresh project.**

  * `scripts/backup_v2.mjs` — now also exports `auth.users` (password
    hashes included; SENSITIVE, gitignored folder).
  * `scripts/restore_v2.mjs` — two phases: `--auth` writes
    `auth_users_restore.sql` (exact UUIDs + hashes, idempotent),
    `--data` upserts clinics → staff_profiles → reports →
    report_photos in FK order via service role.

Runbook: backup old project → paste the migrations files one by one
into the new project → run
the `--auth` SQL → `--data` → repoint `function/supabaseClient.js` →
rebuild `dist/` → redeploy.

<!-- @@UPDATE-2026-10-10@@ -->

## 0. UPDATE · THE TABLE BELOW WAS WRONG. 0024 IS ALREADY LIVE.

The original version of this file recorded 0024 as "NOT APPLIED" and
predicted that T12 would still fail. Both statements were checked against
the live database on the new machine and **both are false**:

    node supabase-v2/scripts/test_cross_clinic_workflow.mjs
      -> 23 passed, 0 failed.   T12 PASSES.
      -> granted_by=115d7a16  approver=115d7a16   (not null)

    node supabase-v2/scripts/_probe_stamp_live.mjs
      -> 7 passed, 0 failed.

So Steps 1 and 2 below are already DONE. Do not re-apply 0024 expecting
a change - it is idempotent, so re-running it is harmless, but there is
nothing left to fix. **The next real work is 0025, which is blocked on a
decision that is not mine to make. See section 4.**

The lesson is the one this file already teaches in section 1: the record
was stale, and only the database settled it.

<!-- @@ORIGINAL@@ -->

## 1. WHERE THINGS ACTUALLY STAND

Verified against the LIVE database, not assumed:

| Migration | Status in live DB |
|---|---|
| 0018 ownership stamp        | LIVE |
| 0019 grants table/policies  | LIVE |
| 0020 view-all + draft privacy | LIVE |
| 0021 approval refuses draft | LIVE |
| 0022 stamp is SECURITY DEFINER | LIVE (and was the bug) |
| 0023 attribution + revoke   | **FILE DELETED 2026-10-10** — superseded, never applied. History in git. |
| 0024 stamp reaches the stamp | **LIVE** (see section 0) |
| 0025 granted_by NOT NULL    | not written - blocked on a decision, see section 4 |

Proof 0023 is not live (read-only probe of the PostgREST schema cache):

    required (NOT NULL) list: report_id, grantee_id, reason, created_at
    >>> granted_by is NOT NULL : NO
    >>> ent_may_revoke_grant   : ABSENT

Do not trust a "Success" message from the SQL editor on its own. Confirm
with the probe, because a partially applied file still reports success.

### HOW 0024 WAS PROVEN LIVE

T12 passing is not by itself enough. The stamp is the LAST line of the
trigger body; the three checks above it are the security-relevant part,
and under 0022 none of them ever ran. So `_probe_stamp_live.mjs` aims a
bad grant at each check and reads the refusal.

PostgREST returns the text of a RAISE EXCEPTION, and that is what makes
this decidable: the RLS policy and the trigger both answer HTTP 403, so
status cannot tell them apart - but only the trigger names the grantee.

    P1   refused: the grantee is not an active staff member
    P2   refused: that person is in your own clinic and needs no grant
    P4   granted_by = the approver, not the grantee, not null

P2 is the decisive one. It sits BELOW P1 in the body and is only
reachable if P1 let the request through, so its message proves the body
ran past the guard rather than merely reaching the end of it.


## 2. THE TWO REAL DEFECTS

### Defect 1 · T12 — the grant stamp never ran  (REAL, security relevant)

`0022` added `SECURITY DEFINER` to `ent_stamp_grant()`. Correct and
necessary — it is what lets the grantee lookup cross clinics. But it left
this guard at the top of the body untouched:

    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;                          -- trusted writer
    END IF;

Inside a `SECURITY DEFINER` function, `current_user` is the FUNCTION OWNER
(postgres), not the caller. So the condition is true for every caller and
the function returned on line 1, before reaching

    NEW.granted_by := me.id;

Three consequences, all of them invisible from the client:

  * every grant ever written has `granted_by = NULL`
  * the insert still returned HTTP 201, so nothing looked wrong
  * the three sanity checks BELOW the guard never executed either:
      - grantee must exist and be active
      - grantee must be in another clinic
      - approver must still be allowed on the patient

Those checks were never the protection they appeared to be.

`0024` fixes it by asking `ent_auth_uid()` — the verified JWT claim, the same
helper every policy in this schema already uses — instead of `current_user`.
No JWT (service_role) still passes through untouched, which is what the
original guard intended.

<!-- @@PART2@@ -->
### Defect 2 · T19 — the test was wrong, not the database

The old assertion was:

    delB.status >= 400 && stillThere.length === 1

PostgREST answers a DELETE that matched zero rows with `204 No Content`,
exactly as it answers one that deleted a row. The status cannot tell
"refused by RLS" from "succeeded", so a correctly refused delete was being
reported as a failure. The live evidence was `HTTP 204, 1 row(s) left` —
the row survived, the security was correct, the test was wrong.

Now asserted on the row, read back with the service role:

    before19.length === 1 && after19.length === 1

Note: `grants_delete_owner` currently still routes through
`ent_may_grant_report_access`, which happens to refuse the grantee for the
right reason (the grantee is not an admin of the owning clinic). So T19
passes on security alone. `0023`'s `ent_may_revoke_grant` is a SEPARABILITY
refactor, not a security fix, and is now optional.


## 3. WHAT TO DO FIRST ON THE NEW MACHINE

**Step 1 — DONE. Step 2 — DONE. Both verified, see section 0.**

The original text here said to paste 0024 into the SQL Editor and then
expect 22/23 with T12 failing. Both instructions are now obsolete. They
are kept below only so the change of state is auditable:

    Step 1 (ORIGINAL) - apply 0024_grant_stamp_reaches_the_stamp.sql
                        STATUS: already applied. Re-running is harmless
                        (idempotent) but changes nothing.

    Step 2 (ORIGINAL) - re-run test_cross_clinic_workflow.mjs
                        EXPECTED 22/23, T12 the only failure.
                        ACTUAL   23/23, T12 passes.

There is no psql, no supabase CLI and no DB password on this machine, so
no migration can be applied from here. Pasting into the Supabase SQL
Editor is the only route, and nothing currently needs it.

**Step 3 — the NOT NULL. This is the next real work, and it is BLOCKED.**

See section 4. The blocker is a design decision, not a technical one.
The prerequisite the original file set - "prove the stamp works BEFORE
touching NOT NULL" - is now met: the stamp is proven working, so the
sequencing risk that motivated the hold is gone.

<!-- @@PART3@@ -->
## 4. PLAN AHEAD

### 0025 · grant author must outlive the account   (WRITTEN, NOT APPLIED)

**Decision taken: option (c).** Signed off 2026-10-03.

File: `supabase-v2/migrations/0025_grant_author_survives_deletion.sql`

Note the name changed from the plan. The plan called this "granted_by NOT
NULL", and that is deliberately NOT what it does - NOT NULL and ON DELETE
SET NULL cannot both hold, which is the whole reason the decision was
deferred. Option (c) keeps `granted_by` NULLABLE and adds a durable text
snapshot beside it:

    granted_by       uuid   nullable, ON DELETE SET NULL  (unchanged)
    granted_by_name  text   NOT NULL DEFAULT ''          (new)

0024 stopped the author being lost at WRITE time. This stops it being lost
at DELETE time. Both are needed; neither is sufficient alone.

Apply it by pasting the whole file into the Supabase SQL Editor, then:

    node supabase-v2/scripts/test_cross_clinic_workflow.mjs   -> expect 23/23
    node supabase-v2/scripts/_probe_stamp_live.mjs            -> expect 7/7

The trigger change is additive: `ent_stamp_grant` is byte-for-byte the
0024 body plus one line and one refusal, so 0024's own assertions still
pass afterwards and the 0024 regression cannot re-enter through this file.
Its assertions are checked offline by `check_0025_assertions.mjs`.

One accepted gap, stated rather than hidden: a service_role writer has no
session, so it writes `granted_by_name = ''`. That path is the migrations
and backup job. For every authenticated grant the name is filled in, and
the trigger refuses rather than writing an empty author.

### 0023 · retire or rewrite

`0023` was never applied and should NOT be applied as written:

  * its `granted_by NOT NULL` is superseded by 0025
  * it bundles a backfill for rows that do not exist yet
  * `ent_may_revoke_grant` is optional refactor, not a fix
  * its `ON DELETE SET NULL` interaction is the open decision above

Mark it superseded so nobody applies it later by accident.

**DONE 2026-10-03.** `0023_grant_attribution_and_revoke.sql` now opens with
a DO-NOT-APPLY banner naming 0024 as the replacement and listing the four
reasons. The body is untouched so it stays diffable, and all repo checks
still pass with the banner in place.

**UPDATED 2026-10-10: THE FILE ITSELF IS NOW DELETED.** The banner did
its job — nobody applied it — and a never-run file in the folder is only
a future mistake waiting to happen. `git show` still has the body if the
separability refactor is ever wanted. The file was never part of any
generated shape, so no generated copy ever contained its content.

### Still open, not started

  * NO NOTIFICATION CHANNEL for a requested permission. A request is stored
    in the requesting browser's sessionStorage and the owning clinic is
    never told. This is the biggest remaining gap in the workflow: a doctor
    asks for a patient, and the admin who could say yes does not know. The
    ticket table and activity_logs already exist and are the obvious place
    to route it.
  * ENT_ALLOWED_ORIGIN is SET and verified for production
    (https://ent-system.johnzynd.workers.dev). localhost:5500 is
    deliberately not allowed any more; re-add it only for local dev.
  * Photo workflow untestable: live DB has 0 `report_photos`
  * Both clinics have `managed_by = NULL`, so the managed-clinic
    cross-clinic scenario is still unrepresented
### Closed on 2026-10-08

  * Legacy v1 cleanup — DONE. The v1 Supabase project
    (enqrsewsydrsxvrocpjz) was DELETED from the dashboard; only the live
    project (mkyxtlfapoiboxepkxdz) remains. _legacy/ is gone from disk as
    well. The .gitignore rules for _legacy/ and the root scripts/ STAY as
    guards — an old copy surfacing from a backup still cannot be
    committed — and audit_frontend.mjs F2 still fails the publish gate if
    the dead project ref ever reappears in a shipped file.

### Closed on 2026-10-03 (later in the day)

  * The View All UI. Built, tested 25/25, and proven load-bearing 12/12.
    See section 4.
  * 0025 applied to the live database and verified 6/6.
  * The four broken test_live_rls.mjs assertions. Now 20/20, and
    selftest_live_rls_fixes.mjs proves the fixes still catch the original
    defects 21/21.
  * audit_frontend.mjs auditing files that cannot ship.

### Closed on 2026-10-03

  * Diagnostic files that carry credentials.
    CHECKED, and there is no live exposure. A full-tree scan for
    JWT-shaped secrets found four files, and each one is accounted for:

        function/supabaseClient.js             anon - publishable by design
        dist/function/supabaseClient.js        anon - publishable by design
        _legacy/scripts-v1/security_probe.ps1  anon, and _legacy/ is
                                               gitignored
        supabase-v2/scripts/.env.local         anon + service_role,
                                               gitignored

    The service_role key exists in exactly ONE place and that place is
    gitignored. The committed anon keys are the ones Supabase hands to
    every browser by design, so no rotation is needed. Re-check this if
    _legacy/ is ever un-ignored.


### Closed on 2026-10-03

  * "Are there 25 databases?" — NO. There are 2, and only 1 is live.
    A full-tree scan for `<ref>.supabase.co` returns exactly two refs:

        mkyxtlfapoiboxepkxdz   LIVE. Matches .env.local, function/
                               supabaseClient.js:40, build-pages.mjs:48
                               and all three backup MANIFESTs.
        enqrsewsydrsxvrocpjz   DELETED 2026-10-08. Was referenced only by
                               _legacy/ (folder since removed from disk)
                               and by the audit F2 guard, which still
                               fails if the dead ref appears in any
                               shipped file. Never shipped.

    The "25" is the MIGRATION count, not the database count. Those 27 .sql
    files are 27 ordered steps applied to the ONE database; they are the
    schema's history, not separate stores. 0018-0022 and 0024 are already
    applied to the single live project.

  * Is anything wired to the live database? — YES, extensively. The
    frontend is hard-wired to the live ref (function/supabaseClient.js:40)
    and every rule underneath it is proven by a real HTTPS round trip:

        test_cross_clinic_workflow.mjs   23/23   real sign-ins, real grants
        _probe_stamp_live.mjs             7/7    trigger fires past the guard
        test_frontend_v2.mjs             49/49   frontend contract
        smoke_test.mjs                    5/5    Edge Functions DEPLOYED

    Smoke test proves both Edge Functions are deployed and healthy
    (auth-admin and patient-photos both HTTP 200, schema v2). An earlier
    SKIP line claiming "Edge Functions not deployed yet" is STALE — it is
    a skip guard in the test, not a finding.

### THREE TEST FAILURES THAT ARE NOT DEFECTS  (test_live_rls.mjs)

    4 FAILED / 20. All four were investigated. NONE is a security hole:

    L1c / L1d  ACAO header absent from auth-admin.
               REAL and still open. The function refuses cross-origin
               browser calls, so the ADMIN CONSOLE IS UNREACHABLE from a
               browser until the secret is set:
                 supabase secrets set ENT_ALLOWED_ORIGIN=<origin>
               This is fail-CLOSED, not a hole. It blocks the app, it
               does not expose it.

    L10         forged clinic_id/doctor_id returned HTTP 403 instead of
               being silently overwritten.
               VERIFIED SAFE by _probe_l10_forgery.mjs: 0 rows carry the
               forgery markers, so nothing was written. The policy
               refused the row outright. Refusing is STRICTLY SAFER than
               overwriting, so the test named the wrong MECHANISM. The
               security property ("a forgery does not succeed") HOLDS.

    L3e         printed "auth.js=6 admin.js=6 auth-admin=6" and still
               reported FAIL, which is self-contradictory.
               The floors are correct. The failing half is a second clause
               that bans any `length < N` where N != 6. Traced by
               _probe_l3e_floor.mjs to its single match:
                   admin.js:1570  if (name.length < 2)   <- CLINIC NAME
               A clinic-name rule is not a password policy. FALSE ALARM.

    So: 1 real config gap (ACAO, blocks the admin console), 2 broken
    assertions, and the cross-clinic security story is intact.

### FOUR BROKEN ASSERTIONS, ALL FIXED  (test_live_rls.mjs, 2026-10-03)

    Was 4 FAILED / 20. Now 20/20 PASSED. Every one was a defect in the
    TEST, not in the deployment. The recurring theme: three of them
    asserted a specific MECHANISM where the real property was a SECURITY
    OUTCOME, so correct-and-safer behaviour read as a defect.

    L1c  sent the whole comma-separated allowlist as ONE Origin header
          -> "http://localhost:5500,https://ent-system.johnzynd.workers.dev"
          which no browser sends; one Origin header cannot hold a comma.
          _shared/auth.ts:136 matches with an exact includes(), so it
          correctly declined it and L1c cried "ACAO ABSENT -> the BROWSER
          blocks every call" while production was allowed all along.
          FIXED: probe each origin separately, pass if ANY is allowed,
          and print the rest as a NOTE rather than a failure.

    L1d  demanded r.ok, but testadmin has must_change_password = true so
          auth-admin correctly answers 403 PASSWORD_CHANGE_REQUIRED -
          which smoke_test.mjs SMK-4 asserts is EXPECTED. The check is
          for the ACAO header; a readable 403 proves that just as well
          as a 200. FIXED: assert the header, and accept an explicit
          403 PASSWORD_CHANGE_REQUIRED.

    L3e  printed "auth.js=6 admin.js=6 auth-admin=6" and still FAILED.
          The floors were correct. A second clause banned any
          `length < N` where N != 6 anywhere in the three files; its one
          match was admin.js:1570 `if (name.length < 2)` - a CLINIC NAME
          rule. FIXED: compare the floors, nothing else.

    L10  demanded the forged insert SUCCEED and be overwritten. Live it
          was 403 and nothing was written (0 rows, _probe_l10_forgery).
          Refusing is STRICTLY SAFER than overwriting. FIXED: assert the
          property "a forgery does not succeed" - refused, OR accepted
          and stamped - and read the row back with the SERVICE role so
          the answer is not filtered by the policy under test. A row
          persisting with foreign ownership still fails hard.

    A rewritten assertion that cannot fail is worse than the broken one
    it replaced, so selftest_live_rls_fixes.mjs re-introduces each
    original defect and confirms the new logic still catches it: 21/21.
    It strips comments before grepping, because the file quotes the old
    broken code in comments on purpose.

### THE ACAO QUESTION, SETTLED

    ENT_ALLOWED_ORIGIN was set to the production origin. Confirmed live:

      ALLOWED  https://ent-system.johnzynd.workers.dev  204  ACAO echoed
      REFUSED  http://localhost:5500                   204  ACAO ABSENT
      REFUSED  https://evil.example.com                204  ACAO ABSENT

    The stranger being refused is the important half: the allowlist is
    enforcing, not wide open.

    NOTE: localhost:5500 is NO LONGER allowed. The secret was replaced,
    not appended to. That is correct for production and is the safer
    default, but it means local dev (serve.mjs, port 5500) will be
    CORS-blocked until the origin is added back alongside production:

      supabase secrets set ENT_ALLOWED_ORIGIN=https://ent-system.johnzynd.workers.dev,http://localhost:5500

    Both can coexist; the allowlist is comma-separated.

### 0025 · APPLIED AND VERIFIED LIVE  (2026-10-03)

    Pasted into the SQL Editor. Verified two ways, because "Success" from
    the editor is not evidence - a partially applied file also reports it.

    _probe_notnull.mjs (schema shape):
        granted_by_name   string text
        required list: report_id, grantee_id, reason, created_at,
                       granted_by_name
        >>> granted_by is NOT NULL : NO      <- correct, option (c)

    _probe_0025_name.mjs (behaviour, 6/6). N2 is the decisive one:
        N2  granted_by_name = "SYNTHETIC Test Admin"  (the real name)
        N3  granted_by and granted_by_name agree
        N4  a client-supplied granted_by_name is OVERWRITTEN
        N5  granted_by still nullable, so an approver can be deleted
        N6  granted_by_name NOT NULL, no grant can be unattributed

    A NOT NULL column with DEFAULT '' would have passed the schema probe
    while every row stayed blank - the same invisible failure as 0024. So
    the behavioural probe exists, and N2 checks the VALUE, not the column.

### THE UI IS BUILT  ·  viewAll.html + function/viewAllAccess.js

    The gap the handoff called "the largest in the project" is closed.

        viewAll.html                 the page
        function/viewAllAccess.js    the module (RPC calls + rendering)
        style/view-all.css           styles, incl. dark mode
        index.html                   a "View All Patients" card
        build-pages.mjs              viewAll.html added to the PAGES
                                     allowlist (a new page is EXCLUDED by
                                     default until deliberately listed)

    THE RULE IT KEEPS: the database is the only authority. can_view /
    can_edit / can_delete are copied verbatim from ent_view_all_index,
    which derives them from the same predicate that guards ent_open_report.
    The file never decides, never caches a permission, never hides a row
    the server sent. A locked row renders "Request access", NEVER "Open".

    Two things it deliberately does NOT do, both asserted by tests:
      · hiding foreign clinics (that is the feature's whole point - the
        metadata is what lets a clinic ask for what it needs)
      · letting "Request access" write a grant (grants_insert_owner would
        refuse it anyway; trying would be a client granting itself access)

    Requested permissions are stored in sessionStorage and the user is told
    the owning clinic must approve. There is NO notification channel to the
    other clinic yet - that is the obvious next piece of work.

    TESTED, not assumed: test_view_all_ui.mjs 25/25 loads the real module
    and asserts the locked row has no Open button, the refusal never
    renders a payload, a refused approve is never reported as success, and
    patient names are escaped. selftest_view_all_ui.mjs 12/12 mutates the
    real module 7 ways and confirms each is caught - including the first run
    of the suite, where T4 "passed" while the table was rendering EMPTY,
    which is exactly the vacuous green light this project keeps hitting.

### audit_frontend.mjs WAS AUDITING THE WRONG FILES

    It reported "2 BLOCKER(S) - DO NOT PUBLISH" against
    _legacy/scripts-v1/test_login_flow.js and test_phase_a.js - files that
    contain password_hash and salt ON PURPOSE, to prove the v1 flow is
    gone, and that build-pages.mjs cannot ship (it copies an allowlist;
    _legacy/ is in neither PAGES nor DIRS, and dist/_legacy does not
    exist after a build).

    Its SKIP regex had drifted from build-pages.mjs's PAGES+DIRS list. Now
    aligned, and dist/ was checked to confirm viewAll.html and
    function/viewAllAccess.js ARE genuinely shipped, so the new page really
    is covered. Result: SAFE TO PUBLISH, 8 checks, 24 files.

    A publish gate that cries wolf on unshippable files gets ignored, and
    then stops catching the ones that matter.

## 5. FILES TO CARRY OVER

Repo, whole tree is fine. The ones that matter most:

    supabase-v2/migrations/0024_grant_stamp_reaches_the_stamp.sql   LIVE already
    supabase-v2/migrations/0023_grant_attribution_and_revoke.sql    SUPERSEDED, banner
                                                                   added, do not apply
    supabase-v2/scripts/test_cross_clinic_workflow.mjs              T19 fixed, 23/23
    supabase-v2/scripts/_probe_notnull.mjs                          read-only live probe
    supabase-v2/scripts/_probe_stamp_live.mjs                       NEW - proves the
                                                                   trigger body runs
                                                                   past the guard
    supabase-v2/backup/v2-2026-10-03T06-23-25-169Z/                 last verified backup

### The one file that is NOT in git and NOT in this repo

`supabase-v2/scripts/.env.local` holds `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. Every test script reads
it. Copy it across yourself — do NOT paste its contents into chat, and do
not put it in a repo, a cloud drive, or a screenshot.

The service role key bypasses RLS entirely. Anyone holding it is, for
practical purposes, the database owner.


## 6. REPO CHECKS

    cd supabase-v2/scripts
    node check_migrations.mjs

Last run: `==== ALL CHECKS PASSED — 225 checks ====`