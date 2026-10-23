# 08 · RISKS & DECISIONS

Ang mga desisyong naka-lock sa v2 schema, at ang dahilan kada isa. Bawat
`DEC-nn` ay tinutukoy ng isang migration; kung may alin sa mga ito na
mukhang sobra o kulang, **dito** dapat ayusin — hindi sa SQL — para
manatiling iisang bersyon ng kwento.

---

## DEC-01 · Isang `reports` table, hindi tatlo

**Nasa:** `0004_reports.sql` (header)

Hindi naghahati ang CF4 / nasal / laryngeal sa hiwalay na table. Ang
`report_type` ang discriminator at ang editable form nasa `payload` jsonb.

**Bakit:** Higit-higit na query ang kailangang baguhin sa `dbRecords.js`,
`syncEngine.js`, `draftsBrowser.js` at ang PDF open path — para sa **walang**
security o integrity gain. Ang brief mismo ang nagsabi: huwag maghiwalay
ng walang clear na technical na dahilan. Wala.

---

## DEC-02 · `anon` ay walang baganman

**Nasa:** `0007_privileges.sql`, at inaassert sa bawat migration na susunod

Ang lumang schema ay naggrant ng `GRANT ALL ON ALL TABLES IN SCHEMA public
TO anon, authenticated` at `ALTER DEFAULT PRIVILEGES ... GRANT ALL`. Ang
anon key ay naging master key kapag permissive ang policy.

**Bakit:** Privileges ay ibinibigay **table-by-table**, sa
`authenticated` lamang. Tandaan ang ordering: privilege ang sasabi
"maaari mo ba gamitin ang table na ito", RLS ang sasabi "kanino ang mga
row". Hindi palitan ang isa ng isa.

**Beripikasyon** (`0007`, `0017`, `0018`): ang assertion ay dapat
mag-return ng **0 rows**.

```sql
SELECT table_name FROM information_schema.role_table_grants
 WHERE grantee = 'anon' AND table_schema = 'public';
```

---

## DEC-03 · Delete ay mas makitid kaysa edit

**Nasa:** `0008_rls_core.sql`, pinalitan ng `0026_soft_delete_recycle_bin.sql`
(`reports_delete_admin` na may `deleted_at IS NOT NULL`), at
`0034_secretary_shelf_delete.sql`

Maaaring mag-file at mag-correct ng report ang isang secretary — at mula
**0034**, maaari na rin siyang mag-**soft delete** ng kahit anong record sa
shelf ng assigned doctor niya (gaya ng doctor sa kanyang sariling rows, ng
author sa kanyang unfinished draft, at ng admin sa kanyang clinic). Pero ang
**permanenteng** pagwasak ay **admin lamang**, at **soft-deleted na row
lamang** — doon lang, sa Admin Console → "Delete forever".

**Bakit noon:** Ang deletion ay permanent at hindi naibalik ng anumang draft
o sync. Ang edit ay nananatiling nasapareho. Kung may maling delete, wala
nang paraan.

**Bakit ganoon pa rin ang mahigpit na bahagi:** Ang tanong ay hindi na
"ino ang may pindot" kundi "ino ang may **huling** pindot". Ang soft delete
(0026) ay marka pa rin — buo ang row, payload at larawan, nakatago sa RLS,
may Restore para sa admin o sa secretary ng shelf. Ang tanging `DELETE` sa
buong schema ay ang `reports_delete_admin`, na tinatanggap lamang ang row
na `deleted_at IS NOT NULL` **at** active admin — iyon lang ang buong ng
"Delete forever" (may `deleted_at=not.null` na query guard pa sa UI).
Kahit ang secretary na nagtatanggal ay hindi kailanman makaabot sa
permanenteng delete; kaya ligtas ang pindot kahit kanino ibinigay.

---

## DEC-04 · Ownership ay SERVER-stamped, hindi client-chosen

**Nasa:** `0004_reports.sql` (`ent_stamp_report_ownership`),
`0018` (pinatibay)

Noon, galing sa `localStorage` ang `clinic_id` at galing sa JS scope object
ang `doctor_id` — diretso sa POST body. Ang pag-edit ng request sa DevTools
ay naglilipat ng patient row sa ibang clinic o sa ibang doctor's shelf, at
**wala** ang ginawa ng RLS dito.

## DEC-05 · Base64 photos sa payload, may ceiling

**Nasa:** `0004_reports.sql` (`reports_payload_ceiling`)

Hanggang `photo_storage` ay OFF, nasa `payload` pa rin ang mga base64
photo — kaya nasa database, hindi sa Storage.

**Bakit:** Isang malaking CHECK lang ang `octet_length(payload::text) <
20000000` (~20 MB bawat row). Ito ay isang hadlang **hindi** hard limit:
hinahawakan ng Supabase ang malaking row, kaya ang tunay na hangganan ay
ang libreng 500 MB ng database.

**Hindi pa nasasagot ng DEC na ito** ⚠️ — ang totoong RISK, at hindi pa
ito na-a-address ng schema:

- Free plan = **500 MB**, walang Point-in-Time Recovery, at
  **nag-pause** kapag 1 linggo ang idle.
- ~25 max-size report lang ang kasya bago mapuno.
- Ang isang tunay na report sa base64 (6 larawan) ay madaling 10–20 MB.

**Kailangan pa:** mag-schedule ng backup/export, at i-roll out ang
`photo_storage` para mailabas ang bytes sa payload. Hindi ito schema work —
operational. Hindi pa nagawa.

---

## DEC-06 · Walang credential column, kahit kailanman

**Nasa:** `0005` (header), `0007`, at `docs/06-TEST-PLAN.md` CRED-01

Walang `password_hash`, walang `salt`, walang `token` sa public schema.
Si GoTrue ang may hawak ng password (bcrypt, server-side), at Supabase
Auth ang may hawak ng session.

**Bakit:** Ang browser ay **hindi** dapat kailanman ma-download ang
credential upang i-verify ito. Ang lumang app ay ginawa exactly iyon.

**Beripikasyon** (CRED-01): dapat **0 rows**.

---

## DEC-07 · Audit trail ay append-only, walang PHI

**Nasa:** `0005_activity_and_presence.sql`

Walang UPDATE, walang DELETE — **pareho sa policy at sa trigger**
(`trg_audit_append_only`). Ang `detail` ay may CHECK
(`audit_no_patient_name`).

**Bakit:** Ang audit row ay dapat manaas kung ano ang nangyari noon, kahit
na magbago ang role ng tao pagkatapos. Kaya nga `actor_role` ay text at
hindi FK.

### ⚠️ DEC-07 · Ang CHECK ay mahina, pero hindi na aktwal na nag-le-leak

**Nail-update 2026-10-03 (docs-only; walang production code ang binago).**

**Ang CHECK ay humahanap lang sa JSON-key form** (`"patient_name":`).
Hindi nito nahah catch ang **plain-text** na pangalan. **TAMA PA RIN ITO** —
wala nang tinatawag ang lumang kahinaan na iyon.

**Ang dating paglalarawan dito ay STALE.** Sinasabi nitong *"Nakasulat pa
rin ngayon"* sa `dbRecords.js:668` at `:1093`, at *"Hindi pa na-fix"*.
**Hindi na totoo.** Ang code ngayon ay:

    dbRecords.js:672   logActivity('SAVE_RECORD', `Record saved (${record.reportType})`);
    dbRecords.js:1104  logActivity('OPEN_RECORD', `Record opened (${row.report_type})`);

**Parehong `report_type` lang. Walang pangalan.** May comment sa tabi ng
bawat isa na nagsasabi *bakit* — dahil ang plain-text na leak ay dumadaan
rin sa CHECK (na JSON-key lang ang hinahanap).

**Ang toto pang gap ngayon** ay hindi ang pagkakasulat, kundi ang
**kulang-kulang pagsalakad**: ang CHECK ay hindi makakapagbigay ng error sa
`logActivity('X', 'Opened ' + patientName)` na sinulat ngayon. Sinuri ang
**18 call site** ng `logActivity` sa `function/*.js` noong 2026-10-03 at
**walang isa** ang nagdadala ng pangalan ng pasyente — pero **wala ding
makina** na pumipigil sa susunod na tao. (Hindi ito saklaw ng isang
automated test; ito ay manual na pagbasa ng code. MagandangCandidate ang
isang lint, ngunit hindi pa ginawa.)

**Kung gusto pang patiginan:** alisin ang plain-text na pangalan sa
pagkakataon (magdagdag ng `report_id` column, o i-redirect ang
`logActivity` sa Edge Function na `service_role`), **o palakasin ang
CHECK** para tumigil din sa plain text. **Hindi ito parte ng Tier 1 na
pagbabago ng polling** at hindi pa ginawa — kailangan pa ng hatol.

**Bakit ito mahalaga kapag naisulat na:** `audit_select_admin` (`0008`) ay
nagbibasa nito ng **bawat admin ng clinic**, at ang mismong rule ng table ay
*"Reference reports by id, never by patient name."*

---

## DEC-08 · Ang isang admin widening (0016)

**Nasa:** `0016_doctor_clinics.sql`

Ang **tanging** widening ng admin reach sa buong v2: ang isang active
admin ay umabot sa bawat shelf ng bawat clinic na `managed_by` niya
(`clinics.managed_by = me.id`). Nakatikom ang lahat ng definition sa
`ent_admin_covers_clinic()`.

**Bakit:** Kailangan ito para gumana ang "each doctor gets his own clinic"
feature. Ngunit ang pagpapalawak ay may katiyakan, at **0018 section 1 at
2 ang bunga ng pagkalimutang i-update ang mga caller** (ang ownership
stamp at ang ticket policies). Ang lesson: **kapag nagdagdag ng bagong
rule, hanapin lahat ng lugar na nagsasabi ng "clinic"**.

### ⚠️ Inaayos ng 0019: READ ≠ WRITE

Ang original na 0016 ay pinalawak ang `ent_may_touch_report()` — pero
**iisang function** ang gumagamit sa **read** at **write** policies.
Resulta: kapag pinalawak ang read, **napalawak din ang write**.

**Ang correction** (`0019_cross_clinic_grants.sql`):

| | Read | Write |
|---|---|---|
| Own clinic | ✅ | ✅ |
| Managed clinic, **walang grant** | ✅ | ❌ **DENY** |
| Managed clinic, **may grant** | ✅ | ✅ |

Dalawang hiwalay na tanong, dalawang hiwalay na function:

- `ent_may_touch_report(clinic, doctor)` — **"may kita ka ba?"**
  Napanatili ang 0016 behavior (ang admin console ay kailangan nito).
- `ent_may_edit_report(clinic, doctor, report)` — **"maaari mo bang
  baguhin?"** Cross-clinic ay **DENIED** kahit `managed_by`, malaman may
  **explicit, per-patient grant**.

**Bakit `managed_by` hindi sapat:** ito ay sumasagot sa tanong
*"kanino ang clinic"*, hindi *"kanino ang pasiente"*. Ang isang clinic
admin ay maaaring mag-administer ng staff ng clinic B — ngunit hindi
ibalagay ang kanyang pagmamayapa sa mga pasyente ni clinic B. Magiging
**standing, clinic-wide blank cheque** ang anumang rule na
"admin may-edit ng clinic X" — kaya't **grant table** na nakatakda sa
**isang report, isang tao, may expiry**.

**Who can grant:** active admin ng **ang clinic mismo ng pasiente**, o ang
doctor mismo. **Hindi** ang manager ng ibang clinic — kung ginawa iyon,
self-signed cheque na siya at eksaktong ang butas na sinasara ang 0019.

**Ang invariant na hindi nagbabago:** kahit may grant, hindi nagbabago ang
`clinic_id` at `doctor_id`. Ang grant ay nagpapalawak ng **SINO** ang
nakakapag-edit; hindi ng **SAAN** nakatira ang row.

---

## DEC-09 · Hindi ko na-audit ang mga bagay na hindi ko naaabot

Ang listahan ng "ayoko pa sabihin" ay nasa `TODO.md`. Ang pinakaimportante
sa mgayon:

- ~~Ang legacy v1 Supabase project ay may **anon-all** policies at ang
  browser key nasa disk — **hindi ito nalikha o natanggal ng 0018**.~~
  **NAISARA 2026-10-08:** mismong project ay **deleted** na sa
  dashboard — wala nang anon-all surface, at patay na rin ang lumang
  browser key dahil patay na ang project.
- Ang `clinic_settings` ay INSERT/UPDATE ng **kahit sinong** active
  member (kasama ang secretary) — maaaring makialo ang physician lists.
- Ang `reports_type_matches_key` CHECK (0004:58) ay **tautology** —
  patay na constraint na nagbibigay ng pekeng "validated" feeling.



**Bakit:** Ang BEFORE ROW trigger ay tumatakbo bago ang NOT NULL check at
bago ang RLS `WITH CHECK`, kaya sa oras ng pag-write, server-ang-owned na
ang bawat ownership column.

**Pagkatapos ng 0018:** ang rule ay mas matibay pa — *hindi nagbabago ang
clinic ng report pagkatapos gawin*. Ito ang tumugma sa pag-iisang dahilan
na naging sanhi ng 0018 section 1 (tingnan `0018` para sa buong salaysay).

---
