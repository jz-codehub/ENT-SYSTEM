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
   (ngayon: `0046_rename_main_clinic_doc_jess.sql`). Isa-isa; hintayin ang
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

## Mga tuntunin

- Ang folder NA ITO ang **source of truth** — dito mag-edit, walang kopyahin.
- Idinodoble ng `../scripts/check_migrations.mjs` ang mga file dito
  (350 checks), at ang `../scripts/validate_migrations.mjs` ang nagpapatunay
  na ang set ay kumpleto at tama ang order (kasama ang 0023 gap).
- Ang order ay **lexicographic** sa pamamagitan ng filename — kaya ang
  4-digit prefix ay hindi decorasyon: huwag baguhin ang mga numero.
