# 10 · DEPLOY-NEW-PROJECT — the exact sequence (2026-10-11)

Panday para sa **bagong** Supabase project `ybnlvfdvfrwnmdvhxeof`. Ang
lumang project `mkyxtlfapoiboxepkxdz` ay **hindi ginagalaw** — buhay pa
iyon ang fallback hangga't hindi napapatunayan ang bago.

## Alalahanin bago magsimula

- Ang frontend source (`function/supabaseClient.js` + CSP sa
  `build-pages.mjs`) ay **naka-point na sa `ybnlvfdvfrwnmdvhxeof`**, pero
  **hindi pa iyon naka-deploy**. Ang live site ay nasa lumang project
  hangga't walang `git push` → Cloudflare build.
- Ang bagong project ay **walang laman** (na-verify 2026-10-11: 0 tables,
  0 functions, 0 edge functions, 0 storage). Walang sisirain.
- Huwag i-push hangga't tapos na ang hakbang 1–4 sa ibaba.

## Hakbang 1 — Database: 0001 → 0041 (isang paste bawat file)

Sa **SQL Editor** ng bagong project, i-paste sunod-sunod ang bawat file sa
`supabase-v2/migrations/` (README doon ang gabay). Tingnan ang `0023` —
**sinasadyang walang 0023**: superseded, never applied
(`0023_SUPERSEDED_README.md`). Kaya ang chain ay `0001…0022`, `0024…0041`.

Bawat file ay may sariling `DO` guard na dapat mag-`RAISE NOTICE '… OK'`.
Kapag bumagsak ang isa: **huminto**, ayusin, ulitin ang file lang.

**Check ito:** `node supabase-v2/scripts/check_migrations.mjs` (350/350
bago pa man i-paste — ang console ng project ang tunay na hurado).

## Hakbang 2 — Storage: bucket + 4 na patakaran sa Dashboard

1. `0009_storage_policies.sql` (nasa SQL Editor din) ang gumagawa ng
   **private** bucket na `patient-photos` — kasama na iyon sa hakbang 1.
2. Sa **Dashboard → Storage → Policies → New policy**, gumawa ng **4**
   patakaran gaya ng nakasulat sa `0009b_storage_policies_dashboard.sql`
   (comment-only iyon; hindi iyon ipa-paste sa SQL Editor —
   `storage.objects` ay pag-aari ng `supabase_storage_admin`).
   `ent_may_access_photo()` muna bago ang mga ito (nasa 0009/0010 chain).

## Hakbang 3 — Edge Functions (2 functions, 1 paste bawat isa)

```
node supabase-v2/scripts/bundle_for_dashboard.mjs
```
→ `supabase-v2/dist/auth-admin.bundle.ts` at `patient-photos.bundle.ts`
(na-regenerate na raw; na-parse-verify). Sa **Dashboard → Edge Functions**
(puwedeng baguhin ang Verify JWT — OFF; sariling JWT check ng function):
pindutin ang bawat function → **Edit** → `Ctrl+A`, `Delete`, `Ctrl+V` ng
bundle → **Deploy**.

Sa **Project Settings → Edge Functions → Secrets**:

| Name | Value |
|---|---|
| `ENT_ALLOWED_ORIGIN` | `https://ent-system.johnzynd.workers.dev` |

> **HUWAG i-set ang `SUPABASE_SERVICE_ROLE_KEY`.** Ang `SUPABASE_`
> prefix ay reserved — awtomatikong ini-inject ng Supabase ang
> `SUPABASE_URL`, `SUPABASE_ANON_KEY` at `SUPABASE_SERVICE_ROLE_KEY` sa
> loob ng bawat Edge Function (kaya tinatanggihan ng dashboard ang
> manual na secret na nagsisimula sa `SUPABASE_`). Ang
> `_shared/auth.ts` ay bumabasa nito via
> `keyFrom('SUPABASE_SECRET_KEYS','SUPABASE_SERVICE_ROLE_KEY',…)`.
> **`ENT_ALLOWED_ORIGIN` na lang ang kailangan mong i-set.**

## Hakbang 4 — ang UNANG totoong admin account (walang test user)

Bagong project = walang account, at ang auth-admin ay nangangailangan ng
admin — kaya ang unang admin ay ginagawa nang isang beses gamit ang
service role (nasa `.env.local`, gitignored):

```
node supabase-v2/scripts/make_account.mjs <username> "<Buong Pangalan>" admin <matatag na password>
```

Halimbawa: `node supabase-v2/scripts/make_account.mjs bokskie "Bokskie Dela Cruz" admin Bokskie123!`

Mula noon, **lahat** ng account (doctor, secretary, admin) ay ginagawa na
sa Admin console (auth-admin) — at awtomatikong may sariling
`ENT-clinic doc. <Pangalan>` ang bawat bagong doctor (0041 guard +
idempotent provisioning). Walang test account, walang test clinic.

Pagkatapos: buksan ang site (o `npm run smoke` mula sa scripts para sa
Edge Functions), mag-login bilang admin, at i-verify:
- Admin console → Users/Database/Overview ay tumutugon
- gumawa ng 1 doctor + 1 secretary (may "Also works at" assignment)
- i-save ng doctor ang parehong patient ID + form + date sa **dalawang
  tab** — ang pangalawa ay dapat **dumikit sa parehong row** (0041
  race recovery), hindi bumuo ng pangalawang row
- Delete → Recycle Bin → Restore (0039) para sa doctor at secretary

## Hakbang 5 — GitHub + Cloudflare

```
node supabase-v2/scripts/push_with_prepublish_gate.mjs   # secrets scan muna
```
Cloudflare Pages (build command `node build-pages.mjs`, output `dist/`)
ang magma-micro-deploy mula sa `main`. Kapag nag-deploy na:

1. Buksan ang site → `index.html`. Sa DevTools → Network: ang lahat ng
   `/rest/v1/` at `/functions/v1/` ay kay `ybnlvfdvfrwnmdvhxeof`.
2. `sw.js` ay `ent-report-system-v34a-duplicate-guard` (hard refresh o
   bagong tab kapag nag-test).
3. Login bawat role; i-run ang acceptance checklist sa dulo ng 06-TEST-PLAN.

## Kung may masama

- **Huwag i-delete ang lumang project.** Ang rollback ay: ibalik ang
  `PROJECT_REF`/`ANON_KEY` sa `function/supabaseClient.js` at ang CSP sa
  `build-pages.mjs` sa `mkyxtlfapoiboxepkxdz`, i-push, at ang Cloudflare
  ay babalik sa lumang backend sa loob ng isang build.
- Ang lumang site at lumang data ay buo pa rin hangga't hindi tinatanggal.

## Checklist bago ideklarang "connected"

- [ ] 0001→0041 lahat Success, may `0041 OK` NOTICE
- [ ] 4 storage policies nasa Dashboard
- [ ] 2 edge functions DEPLOYED (smoke_test 5/5)
- [ ] secrets: service-role + `ENT_ALLOWED_ORIGIN`
- [ ] test accounts + live RLS + diagnose_delete pass
- [ ] 0041 live race test (dalawang tab, iisang patient ID)
- [ ] Cloudflare deploy: lahat ng tawag ay kay `ybnlvfdvfrwnmdvhxeof`
- [ ] login/records/save/delete/bin/restore tatlong role
