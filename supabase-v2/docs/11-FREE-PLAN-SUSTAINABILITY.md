# 11 · SUPABASE FREE PLAN — sustainability report (2026-10-11)

## Mga quota ngayon (verified mula sa supabase.com/pricing, 2026-10-11)

| Item | Free limit |
|---|---|
| API requests | unlimited |
| Monthly active users | 50,000 |
| **Database size** | **500 MB** (shared CPU, 500 MB RAM) |
| **Egress** | **5 GB/month** (+5 GB cached egress) |
| **File storage** | **1 GB** |
| Active projects | 2 |
| **Inactivity** | **"Free projects are paused after 1 week of inactivity"** |
| Automated backups | wala (community support lang) |

Hindi itemized sa pricing page ngayon ang Realtime/Edge-function
invocation caps — hindi ko sila iniintake bilang quota dito. Ang luma
kong datos mula sa lumang project (mkyxtlfapoiboxepkxdz) ay hindi na
ma-basa: ang `.env.local` ay nagdadala na ngayon ng **bago** project
keys lamang; ang lumang service-role key ay wala na sa disk (tama —
hindi ito nakaimbak kahit saan).

## Assumptions (palitan kapag iba ang totoong volume)

- 1 clinic, 2–5 doctor, 1–3 secretary, 1 admin (~10 accounts).
- 50–300 bisita/buwan; 1–2 report type bawat bisita (nasal / laryngeal / CF4).
- 2–8 endoscopy photo bawat report, ~150–400 KB JPEG bawat isa.
- 1–3 device bawat tao; dashboard open ~20×/araw sa clinic.
- Lumang sukat (2026-09/10): ~95 pasyente → ~275 report row (bago pa
  ang 0041 dup-guard; kasama ang duplicates).

## Pagsusuri bawat area

**Database** — Ligtas. Kahit 300 report/ buwan × 5–20 KB/row (payload
lamang, walang inline photo) ≈ 6 MB/buwan ≈ **216 MB / 3 taon**. Malayo
sa 500 MB. Ang peligro lang: kapag **patay ang photo_storage flag**,
nasa `payload` ang base64 na larawan (payload ceiling = 20 MB/row sa
0004) — 100 report/ buwan × 500 KB inline ≈ 50 MB/buwan = **aabutin ang
500 MB sa ~9 buwan**. Kaya ang `photo_storage = ON` ay hindi lang
feature — ito ang unang sustainability lever.

**Indexes / queries** — Malinis: bawat listing query ay naka-index sa
`(clinic_id, doctor_id, updated_at)` (0004 partial indexes), ang search
ay trigram. Ang 0041 indexes ay partial (live final rows lang) at
expression-based — mura ang maintainer, at wala pa sa 10k rows. Wala akong
nakitang full-table read sa mga pahinang tinitingnan ko; ang bawat
dashboard read ay naka-clinic/doctor-scoped.

**Storage** — Ito ang **unang bottleneck**. 1 GB lang. Halimbawa: 100
bisita/buwan × 4 larawan × 200 KB = **80 MB/buwan → ~12 buwan bago
mapuno**; 300 bisita/buwan → ~4 na buwan. Mitigation na mayroon na:
`purge_report` (0036) kapag "Delete forever", `storageStats.js` sa app,
private bucket + `ent_may_access_photo`. Dagdag na gawin: (a) i-compress
sa client bago upload (target ≤150 KB larawan), (b) buwanang audit ng
luma/duplicate na object, (c) kapag lumagpas 600 MB → desisyon: alisin
ang abandoned photos o mag-Pro (100 GB).

**Egress** — 5 GB/buwan. Ang dashboard load ay ~100–300 KB; ang bawat
photo download ay ~200–400 KB. Kaya: ~5 GB ≈ 15,000–25,000 photo
view/buwan ≈ 500–800/araw — sapat sa 1 clinic, masikip na sa maraming
clinic na heavily browsing. Ang polling ay 60 s sa admin console lang;
ang dashboard ay hindi nagtu-tok ng realtime. Kapag lumagpas 3 GB/buwan
sa chart: bawasan ang preview resolution o mag-add ng cache.

**API requests** — Walang limit ngayon sa free. Hindi ito bottleneck.

**Realtime / presence** — Kasalukuyang hindi ginagamit ang realtime
subscriptions sa codebase (presence reads ay REST). Wala pa sa quota.

**Authentication** — 50k MAU; ~10 accounts lang. Wala sa problema.

## Tatlong-taong pagtataya (malinaw na assumptions)

| Layer | 1 taon | 3 taon | Quota | Verdict |
|---|---|---|---|---|
| DB (photo_storage ON) | ~70 MB | ~216 MB | 500 MB | ✅ ligtas |
| DB (photo_storage OFF, inline base64) | ~600 MB | ~1.8 GB | 500 MB | ❌ aabot sa ~9 buwan |
| Storage (larawan) | ~1 GB (100 pts/mo) | ~3 GB | 1 GB | ⚠️ ~12 buwan; kailangan ng lansihan |
| Egress | ~10 GB | ~30 GB | 5 GB/buwan | ✅ kaya ng monthly cap sa <5 GB/buwan na paggamit |

**Konklusyon: HINDI ako nangangako na 3 taon ito sa free.** Dalawang
bagay ang makaigga:

1. **Storage (1 GB)** — ang unang umuurong na quota kapag naka-on ang
   larawan. Praktikal na threshold: kapag **lumagpas 600 MB** o
   **<3 buwan na lang ang natitira sa trend**, magdesisyon — compress /
   purge, o Pro ($25/buwan, 100 GB).
2. **"Paused after 1 week of inactivity"** — ang pinaka-tunay na panganib
   sa pang-araw-araw. Kung may linggong walang gagamit, maaaring i-pause
   ang project (hindi mabura — maire-resume sa dashboard, pero may
   downtime + kailangang buksan muli). Mitigation: tiyaking may
   *aktwal na session* kahit isang beses bawat linggo, o tanggapin na
   kailangang i-resume kapag na-pause. Kapag hindi na garantisado ang
   lingguhang gamit → Pro na.

## Kailan mag-upgrade (praktikal na threshold)

Mag-upgrade sa **Pro ($25/buwan)** kapag kahit isa ang nangyari:

- Storage > 800 MB, o <4 buwan na lang sa trend;
- Egress > 4 GB/buwan sa chart;
- DB > 300 MB;
- Kailangan ng **automated backup** (free: walang — ang recovery plan ay
  ang buwanang `backup_v2.mjs` na i-run mo mismo; Pro: daily, 7 araw);
- Hindi na mapananahanan ang "isang beses bawat linggo" na gamit.

## Buwanang monitoring (10 minuto)

1. Dashboard → **Usage / Charts**: DB size, egress, storage bars.
2. In-app: Admin console → Database usage (admin_db_usage RPC) at
   Storage buckets (patient-photos).
3. Isulat ang tatlong numero sa isang maliit na tala kada buwan — ang
   **trend** ang mahalaga, hindi ang solong basa.
4. Kapag lumagpas sa threshold sa itaas: kilos bago mapuno, hindi pagkatapos.
