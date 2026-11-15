# migrations — the v2 schema as SEPARATE SQL files

Para ito sa **bagong Supabase project**: i-paste ang mga file nang **isa-isa**
sa SQL Editor, **hindi** lahat nang minsan. Ito lang ang SQL shape:
separate files, walang all-in-one.

> **2026-10-11 — isang folder na lang.** Ang dating `../fresh-setup/` mirror,
> ang `../scripts/build_fresh_setup.mjs` copy-builder at ang
> `../scripts/.env.example` ay tinanggal na. Ang folder NA ITO ang
> **source of truth** — wala nang pangalawang kopyang puwedeng mag-drift,
> at wala nang test user / test clinic / synthetic seed kahit saan.

## Paano gamitin

1. **I-paste ang bawat file nang sunod-sunod** sa Supabase **SQL Editor** —
   mula `0001_extensions_enums_helpers.sql` hanggang ang pinakabagong
   (ngayon: `0052_admin_active_clinic_context.sql`). Isa-isa; hintayin ang
   bawat "Success" bago ang susunod. Kapag bumagsak ang isa, doon ka pa
   lang mag-troubleshoot — hindi mo mahihiwalayan ang problema sa one-shot.

2. **Ang 4 storage policies sa Dashboard** — ang `0009b_storage_policies_dashboard.sql`
   ay comment-only: ang `storage.objects` ay hindi pag-aari ng SQL Editor, kaya
   i-paste ang nasa loob nito sa **Dashboard → Storage → Policies** (tingnan ang
   file para sa eksaktong 4 na patakaran).

3. **Ang UNANG admin account** — bagong project = walang account. Gamitin ang
   `node ../scripts/make_account.mjs <username> <Pangalan> admin <password>`
   (nangangailangan ng service-role key sa `.env.local`) para sa isang
   **totoo** na admin; mula roon, lahat ng iba pang account ay ginagawa na
   sa Admin console (auth-admin). Walang test account na ginagawa para sa iyo.

4. **Walang test/synthetic data** sa mga file na ito. Mula 2026-10-10 ay
   na-purge na ang `9100_seed_synthetic.sql` at ang `satellite_clinic` seed —
   ang tanging default row sa `0002_clinics.sql` ay ang totoong `main_clinic`.
   Ang mga INSERT na nakikita mo sa loob ng function bodies ay runtime logic
   (audit, access logs), hindi seed data.

5. **Wala nang `0023` — sadya, hindi nakakalimutan.** Ang `0022` ay direktang
   tumutungo sa `0024`. Ang orihinal na `0023_grant_attribution_and_revoke.sql`
   ay minarkahang SUPERSEDED bago pa i-apply sa kahit anong database: ang
   tunay na ayos ay nasa `0024` (JWT sa stamp trigger), ang `granted_by_name`
   ay sa `0025`, at ang `ent_may_revoke_grant` ay sa `0032`. Buong detalye at
   ang patunay na wala nang nawawala: tingnan ang
   **`0023_SUPERSEDED_README.md`** sa folder na ito. Huwag mag-renumber at
   huwag gumawa ng `0023` para punan ang numerasyon.

6. Pagkatapos ng schema: ang account/record restore ay nasa
   `../scripts/backup_v2.mjs` at `../scripts/restore_v2.mjs`
   (tingnan ang `../README.md` §2 para sa buong runbook ng bagong project).

7. Ang `0047_bounded_patient_record_reads.sql` ay nagbibigay ng RLS-scoped,
   100-row DB Records page at patient visit aggregates. I-apply muna ito bago
   i-deploy ang browser code na gumagamit sa mga bagong RPC; hindi nito
   binabago ang table data o RLS policies.

8. Ang `0048_dashboard_summary_counts.sql` ay nagdaragdag ng RLS-scoped
   dashboard summary. Numero lang ang ibinabalik nito para sa mga period at
   araw na kailangan ng dashboard; hindi nito dina-download ang lahat ng
   patient records. I-apply muna ito bago i-deploy ang matching browser build.
   Mananatiling tig-3,000-row bounded ang recent-patient at follow-up panels.

9. Kasama sa `0050_super_secretary_network_scope.sql` ang Super Secretary
   active-clinic context, selected-doctor access, at per-recipient staff chat
   receipts, atomic secretary-assignment replacement, last-active-admin
   safeguards, at staged admin TOTP enforcement. Existing active admins are
   not forced into MFA during the schema rollout; new admins and reactivated
   admin accounts must enroll before using admin features.
   Para sa existing project na na-run na ang dating 0050, i-run
   ulit ang updated na file: idempotent ang assignment backfill, function,
   table, at trigger statements. Ini-import nito minsan ang dating network
   access bilang assignments para manatili ang kasalukuyang access; puwedeng
   alisin ng admin ang hindi na kailangan. I-apply bago i-deploy ang browser
   code at `auth-admin` bundle para sa clinic switching, doctor assignments,
   chat receipts, at admin hardening.

10. Kasama sa `0049_notifications_and_staff_chat.sql` ang notification kapag
    umabot sa 100% ang Doctor's work ng final CF4, Nasal, o Laryngeal report,
    pati ang RPC para mag-delete ang active user ng sarili niyang notification.
    Para sa existing project na na-run na ang dating 0049, i-run ulit nang
    isang beses ang updated na 0049 file para idagdag ang delete RPC at trigger.
    Kasama na rito ang `announcement` kind para manatiling compatible kapag
    inulit matapos ang 0051; hindi nito binabago ang ibang recipients' rows.

11. Ang `0051_global_announcements.sql` ay nagdaragdag ng admin-only RPC para
    magpadala ng announcement bilang pribadong notification sa lahat ng active
    accounts. I-run ito matapos ang 0050 at bago i-deploy ang Admin composer at
    updated notification center.

12. Ang `0052_admin_active_clinic_context.sql` ay nagdaragdag ng server-validated
    clinic/doctor context para sa admin app preview. Isang clinic lang ang
    active sa bawat Supabase session; nire-recheck ng database ang admin,
    managed clinic, at aktibong doctor bago magbasa o gumawa/mag-edit ng report.
    I-run ito matapos ang 0051 at bago i-deploy ang admin clinic switcher.

## Mga tuntunin

- Ang folder NA ITO ang **source of truth** — dito mag-edit, walang kopyahin.
- Idinodoble ng `../scripts/check_migrations.mjs` ang mga file dito
  (bilangin ang checks mula sa aktuwal na output; nagbabago ito habang
  nadaragdagan ang migrations), at ang `../scripts/validate_migrations.mjs`
  ang nagpapatunay na ang set ay kumpleto at tama ang order (kasama ang 0023 gap).
- Ang order ay **lexicographic** sa pamamagitan ng filename — kaya ang
  4-digit prefix ay hindi decorasyon: huwag baguhin ang mga numero.
