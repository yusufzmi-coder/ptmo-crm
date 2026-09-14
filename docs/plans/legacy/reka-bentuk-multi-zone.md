# HQ Multi-Zone Access + Zone Switcher — PTMO CRM

## Context

PTMO CRM ialah fork `ArnasDon/wacrm` (Next.js 16 App Router + Supabase). Empat commit fork
sudah mendarat di `feat/multi-number`: branding PTMO + MYR, ops SLA/"Belum Dibalas",
satu account banyak nombor WhatsApp (migration 040), dan presence "siapa tengah buka
thread" (migration 041).

Keperluan baru: **Zone A/B/C/D setiap satu account berasingan**. Staf zone hanya nampak
zone sendiri. Satu login HQ boleh tukar active zone, baca dan balas inbox zone terpilih,
dan kemudian lihat dashboard gabungan semua zone.

Halangan teras: pangkalan kod hari ini menganggap **satu user = satu account, selamanya**.
- `profiles.account_id` + `profiles.account_role` — satu baris, satu account
- `accounts` ada `UNIQUE(owner_user_id)` (`idx_accounts_one_per_owner`) — satu user tak boleh
  miliki dua account
- Tiada jadual membership langsung

Hasil yang dituju: HQ boleh tukar zone tanpa satu pun kebocoran data merentas zone, dan
tanpa menulis semula 119 polisi RLS.

---

## Penemuan audit yang menentukan reka bentuk

Empat fakta ini yang membentuk keseluruhan pelan. Semuanya disahkan dalam kod, bukan andaian.

**1. Ada satu titik sempit RLS.** Setiap polisi dalam repo — 119 rujukan merentas 11 fail
migration — melalui satu fungsi sahaja:
`is_account_member(target_account_id, min_role)` di `supabase/migrations/017_account_sharing.sql:136`.
Ia `SECURITY DEFINER`, membaca `profiles` untuk `auth.uid()`. Tukar fungsi ini, semua polisi
ikut. Tak perlu sentuh satu polisi pun.

**2. Kod sedia ada bergantung pada RLS sahaja untuk tenancy — di banyak tempat.** Ini
faktor risiko paling besar:
- 41 tapak mutasi Supabase terus dari client (`src/components/**`, `src/app/(dashboard)/**`
  — `contact-form.tsx`, `deal-form.tsx`, `tag-manager.tsx`, `conversation-list.tsx`, dll)
  langsung tiada tapisan `account_id`
- Query ops (`src/lib/ops/unanswered.ts:200`, `src/lib/ops/response-time.ts:193`) juga
  tiada `.eq("account_id", …)`

Implikasinya tegas: **kalau RLS dilonggarkan kepada "mana-mana zone saya ahli", semua tapak
ini serta-merta membocorkan data merentas zone.** Sebarang reka bentuk yang meluaskan RLS
kemudian bergantung pada lapisan aplikasi untuk menyempitkan semula adalah fail-open — dan
mustahil dipastikan selamat merentas 41 tapak.

**3. `touch_presence()` membaca `profiles.account_id`** (migration 041, baris 89-90). Kalau
lajur itu kekal bermakna "zone aktif", presence ikut zone switcher secara percuma.

**4. Guard 034 ada laluan keluar yang sah.**
`enforce_profile_privilege_columns()` (`supabase/migrations/034_fix_profiles_update_rls.sql:64`)
hanya melempar pengecualian bila `current_user = 'authenticated'`. RPC `SECURITY DEFINER`
milik `postgres` berjalan sebagai `postgres`, jadi ia dibenarkan menulis. Corak ini sudah
digunakan oleh RPC 018/019.

---

## Reka bentuk pilihan: active zone kekal *di dalam* RLS (fail-closed)

Pisahkan dua konsep yang hari ini bercampur dalam satu lajur:

| Konsep | Tempat | Makna |
|---|---|---|
| **Keahlian** (tahan lama) | jadual baru `account_members` | zone mana user ini *dibenarkan* masuk, dan peranan di setiap satu |
| **Zone aktif** (satu ketika) | `profiles.account_id` + `profiles.account_role` — *guna semula* | zone mana user ini sedang lihat **sekarang** |

`is_account_member()` **kekal bermaksud "zone aktif saya"**. Badan fungsi ditulis semula
supaya peranan diambil dari `account_members`, tetapi syarat `p.account_id = target_account_id`
kekal. Kesannya:

- RLS kekal **fail-closed**: seorang HQ yang aktif di Zone B tidak boleh baca Zone C
  walaupun dia ahli Zone C
- 119 polisi: **tidak disentuh**
- `getCurrentAccount()` (`src/lib/auth/account.ts`): **tidak disentuh**
- `touch_presence()`: **tidak disentuh**
- 41 mutasi client-side dan query ops: **automatik betul**, tiada audit kebocoran diperlukan
- Menukar zone = satu RPC yang mengemas kini `profiles.account_id` + `account_role`

Dashboard gabungan merentas zone **tidak** melalui RLS biasa. Ia melalui RPC
`SECURITY DEFINER` khusus yang menyemak keahlian (bukan zone aktif) dan memulangkan
**agregat sahaja** — bukan baris mentah. Itu satu permukaan sempit yang boleh diaudit,
bukan pelonggaran menyeluruh.

### Kenapa bukan pendekatan lain

- **Cookie / header `X-Zone-Id` sebagai sumber kebenaran** — RLS tak nampak cookie. Terpaksa
  longgarkan RLS ke "mana-mana zone" dan sempitkan di aplikasi → fail-open merentas 41 tapak
  di atas. Ditolak.
- **Satu account, zone jadi lajur** — bercanggah dengan keperluan "setiap zone account
  berasingan", dan staf zone akan berkongsi satu ruang RLS. Ditolak.
- **JWT custom claim** — perlu Supabase Auth Hook, dan token perlu dikeluar semula setiap
  kali tukar zone (latency + kerumitan refresh). Boleh jadi penambahbaikan kemudian; bukan
  untuk versi pertama.

### Kos yang aku terima secara sedar

**Zone aktif adalah per-user, bukan per-tab.** Kalau HQ buka dua tab dan tukar zone di satu,
tab satu lagi kini menunjuk zone lain tanpa sedar. Ini pertukaran langsung untuk keselamatan
fail-closed. Mitigasi (Fasa 4): header `X-Zone-Id` dihantar setiap permintaan tulis; server
membandingkannya dengan zone aktif sebenar dan memulangkan **409 Conflict** kalau tak sepadan,
dengan UI memaksa muat semula. Tab basi tak boleh hantar mesej ke zone yang salah — itu
kegagalan yang paling mahal, dan ia ditutup.

---

## Fasa

### Fasa 0 — Kemas sebelum sentuh apa-apa (tiada perubahan skema)
Semua ini prasyarat keselamatan, bukan kerja sampingan.

1. Commit perubahan `.gitignore` (peraturan `_scratch/` masih **tidak** dalam git — fail SQL
   yang mengandungi emel dan keadaan pangkalan data belum terlindung)
2. Push `feat/multi-number` ke `origin` — commit `337410f` dan `940fcd3` hanya wujud di mesin ni
3. Selaraskan ledger migration. Bukti kuat 040/041 diguna pakai secara manual di luar
   Supabase CLI (`_scratch/01_apply_041.sql` salinan byte-identical, dan
   `_scratch/00_semak_keadaan.sql` wujud khusus untuk menyemak sama ada 041 sudah jalan).
   Sahkan `supabase_migrations.schema_migrations` sebelum `db push` seterusnya, jika tidak
   migration baru akan berlanggar.
4. Tambah remote `upstream` supaya patch keselamatan wacrm boleh ditarik

**Tiada kod ditulis dalam fasa ni.** Ia pagar keselamatan sebelum perubahan skema.

### Fasa 1 — Lapisan keahlian (migration 042)
Fail baru: `supabase/migrations/042_account_memberships.sql`

1. `account_members (user_id, account_id, role account_role_enum, created_at)`, PK gabungan
   `(user_id, account_id)`, kedua-dua FK `ON DELETE CASCADE`; indeks pada `(user_id)` dan
   `(account_id, role)`
2. **Backfill dari `profiles`** — setiap baris `profiles` dengan `account_id` bukan null jadi
   satu baris `account_members`. Ini menjadikan keadaan sedia ada sah tanpa kehilangan data.
3. **Gugurkan `idx_accounts_one_per_owner`.** Andaian "satu account satu owner" inilah yang
   kita buang secara sengaja — HQ perlu memiliki empat zone.
4. Tulis semula `is_account_member()` — peranan dari `account_members`, syarat zone aktif
   (`p.account_id = target_account_id`) **kekal**. Tandatangan tidak berubah, jadi 119 polisi
   terus berfungsi.
5. `is_account_member_any(target, min_role)` — versi rentas-zone. **Hanya** untuk RPC agregat
   HQ dan senarai zone switcher. Jangan sekali-kali guna dalam polisi jadual biasa.
6. RLS untuk `account_members`: user baca baris sendiri; admin+ zone baca/tulis baris zone itu
7. `set_active_account(p_account_id UUID)` — `SECURITY DEFINER`, sahkan keahlian, kemas kini
   `profiles.account_id` + `account_role` secara atomik, pulangkan ringkasan zone. Melepasi
   guard 034 kerana berjalan sebagai `postgres`.
8. `my_accounts()` — senarai zone yang caller ahli, dengan peranan setiap satu
9. Kemas kini `handle_new_user()` (017) — masukkan baris `account_members` bersama account
10. Kemas kini RPC 018/019 — `set_member_role`, `remove_account_member`,
    `transfer_account_ownership`, `redeem_invitation` mesti menulis `account_members`,
    bukan `profiles.account_role`

`profiles.account_id` / `account_role` kekal sebagai **penunjuk zone aktif**, bukan dibuang.
Tiada kod sedia ada perlu berubah.

### Fasa 2 — Konteks server + guard zone
| Fail | Perubahan |
|---|---|
| `src/lib/auth/account.ts` | `getCurrentAccount()` kekal seperti sedia ada (ia sudah membaca zone aktif). Tambah `listMyZones()` dan `assertZone(request, ctx)` |
| `src/lib/auth/zones.ts` **(baru)** | `ZoneSummary`, `ZoneMismatchError` (409), pembantu tulen + ujian |
| `src/app/api/account/zones/route.ts` **(baru)** | `GET` senarai zone, `POST` tukar zone aktif via `set_active_account` |

`assertZone()` membandingkan header `X-Zone-Id` dengan `ctx.accountId`; tak sepadan → 409.

### Fasa 3 — Zone switcher di header
| Fail | Perubahan |
|---|---|
| `src/hooks/use-auth.tsx` | Dedah `zones`, `activeZone`, `switchZone()`. Ini satu-satunya penyedia auth sisi client — semua yang lain ikut |
| `src/components/layout/header.tsx` | Pemilih zone; sembunyi sepenuhnya bila user ahli satu zone sahaja (staf zone tak nampak apa-apa perubahan) |
| `src/components/layout/zone-switcher.tsx` **(baru)** | Dropdown + pengesahan bila ada draf belum hantar |

`switchZone()` mesti: panggil RPC → **batal semua langganan realtime** → kosongkan cache
client → muat semula laluan. Langganan basi ialah punca kebocoran paling mungkin di lapisan UI.

### Fasa 4 — Laluan tulis diperketat
Tambah `assertZone()` pada laluan yang kesilapan zone paling mahal:
- `src/app/api/whatsapp/send/route.ts` — balas ke zone salah
- `src/app/api/whatsapp/broadcast/route.ts` — siaran pukal ke zone salah
- `src/app/api/whatsapp/media/[mediaId]/route.ts` — muat naik/proksi media
- `src/app/api/whatsapp/react/route.ts`

Client menghantar `X-Zone-Id` dari `use-auth`. Laluan lain kekal dilindungi RLS sahaja
(fail-closed, jadi memadai).

**Tidak terjejas dan tak perlu diubah** — disahkan dalam audit: webhook masuk (selesaikan
account dari `phone_number_id`, bukan zone aktif), `/api/v1` (kunci API sudah terikat pada
satu account), enjin automation/flow (service-role dengan `account_id` eksplisit).

### Fasa 5 — Presence merentas zone
- `touch_presence()` tak berubah — ia ikut `profiles.account_id` secara automatik
- `src/hooks/use-presence.ts` — topik realtime sudah berkunci pada `accountId`; pastikan ia
  melanggan semula bila zone berubah
- Baris presence basi dalam zone lama luput sendiri melalui `last_seen_at`. Tiada pembersihan
  diperlukan, tetapi HQ akan kelihatan "offline" di zone lama selepas ~30s — betul dan dikehendaki.

### Fasa 6 — Dashboard gabungan HQ
Migration `043_hq_zone_rollup.sql`: RPC `SECURITY DEFINER` (cth `hq_zone_summary(p_from, p_to)`)
yang gelung atas zone di mana `is_account_member_any(...)` benar dan memulangkan **agregat
per zone sahaja** — kiraan belum dibalas, purata FRT, mesej gagal. Tiada baris perbualan,
tiada kandungan mesej.

Halaman `src/app/(dashboard)/hq/page.tsx` menggunakan semula logik tulen sedia ada dalam
`src/lib/ops/` (`sla.ts`, `unanswered.ts`, `response-time.ts`) — jangan tulis semula.

**Nota:** ambang SLA dalam `src/lib/ops/sla.ts` masih pemalar keras (syif PTMO,
`Asia/Kuala_Lumpur`). Jika zone berbeza syif, ini perlu jadi konfigurasi per-account —
kerja berasingan, bukan sebahagian fasa ni.

---

## Strategi migration

- **Tambah, jangan ubah.** Migration baru `042`/`043` sahaja. Repo ini pernah menyunting tujuh
  migration yang sudah dikeluarkan (`001`, `006`, `009`, `010`, `017`, `027`, `035` — commit
  `fbd0101`); CI membina dari kosong jadi ia hijau selamanya walaupun prod menyimpang. Jangan
  ulang corak itu.
- Setiap penyataan idempotent (`IF NOT EXISTS`, `DROP … IF EXISTS` sebelum cipta) — ikut
  konvensyen 041.
- Blok rollback bertulis dalam komen, seperti 040.
- **Lanjutkan `supabase/ci/verify-schema.sql`** untuk menegaskan objek 042 benar-benar wujud.
  Ini penting: semua DDL dijaga `IF NOT EXISTS`, jadi nama tersalah taip lulus CI dengan senyap.
  Fail ini mesti kekal **satu penyataan** — tambah dalam blok `DO $$` sedia ada.
- Urutan guna pakai: `042` dahulu (backfill menjadikan keadaan sedia ada sah), sahkan, barulah
  hantar kod Fasa 2+.

---

## Risiko

| Risiko | Kesan | Mitigasi |
|---|---|---|
| Tab basi membalas ke zone salah | Ibu bapa zone A terima jawapan zone B | Guard `X-Zone-Id` → 409, Fasa 4 |
| Langganan realtime tak dibatal selepas tukar zone | Mesej zone lama masuk ke UI zone baru | `switchZone()` batal + langgan semula secara eksplisit; ujian manual QA-4 |
| RLS tersilap longgar semasa menulis semula `is_account_member` | Kebocoran merentas zone menyeluruh | Ujian isolasi RLS sebenar (lihat QA) sebelum apa-apa kod UI |
| 040/041 tidak dalam ledger CLI | `db push` seterusnya berlanggar atau ulang jalan | Fasa 0 butir 3 |
| `UNIQUE(owner_user_id)` digugurkan | Andaian upstream dilanggar; merge masa depan berkonflik | Didokumen dalam komen migration; `upstream` remote ditambah supaya konflik kelihatan awal |
| Broadcast sudah rosak dengan ≥2 nombor | Zone ada banyak nombor → `resolveConfig` pulang `ambiguous`, broadcast gagal | **Sudah rosak hari ini, bukan disebabkan kerja ni.** Perlu pemilih cawangan dalam wizard. Aku syorkan baiki sebelum HQ guna broadcast — kerja berasingan |
| `is_primary` hanya boleh ditetapkan sekali | Laluan `allowPrimary` (sync template, proksi media) rosak jika baris primary dipadam | Sedia ada; patut dibaiki bersama gap broadcast |
| Tiada ujian isolasi merentas account pada `/api/v1` | Satu `.eq("account_id")` tertinggal = kebocoran penuh | Gap sedia ada paling tinggi nilainya dalam audit. Disyorkan ditutup dalam QA-2 |

---

## Pelan QA

Tiada harness ujian RLS wujud hari ini (85 fail ujian, **sifar** menyentuh polisi). Ini
perkara pertama yang perlu dibina, sebab ia satu-satunya cara membuktikan reka bentuk ni selamat.

**QA-1 — Isolasi RLS (mesti lulus sebelum apa-apa kerja UI).**
Guna `supabase db start` + skrip SQL seperti `.github/workflows/migrations.yml`. Untuk setiap
jadual berskop account, dengan HQ ahli Zone A **dan** Zone B tetapi aktif di Zone A:
- `SELECT` baris Zone B → **0 baris**
- `INSERT`/`UPDATE` ke Zone B → **ditolak**
- Staf zone (ahli satu zone) → tiada perubahan tingkah laku langsung

**QA-2 — Isolasi merentas account pada `/api/v1`.** Kunci API terikat pada satu account; sahkan
tiada laluan dari 11 laluan itu memulangkan data account lain. Ini menutup gap tertinggi audit
dan bukan khusus zone.

**QA-3 — Pertukaran zone hujung-ke-hujung.** Log masuk HQ → Zone A → hantar mesej → tukar ke
Zone B → sahkan inbox, kenalan, pipeline, dan papan ops **semuanya** bertukar; hantar mesej dan
sahkan ia keluar dari nombor Zone B.

**QA-4 — Tab basi.** Buka dua tab, tukar zone di tab 1, cuba hantar dari tab 2 → jangkakan 409
dan gesaan muat semula. Ini mengesahkan mitigasi risiko utama.

**QA-5 — Presence.** HQ dan staf zone dalam thread yang sama → ikon mata muncul. HQ tukar zone
→ hilang dari zone lama dalam ~30s.

**QA-6 — Regresi.** `npm run lint && npm run typecheck && npm test && npm run build`.
Tambah `npm run format:check` ke CI sekali gus (ia wujud sebagai skrip tetapi tiada dalam CI).

**QA-7 — Agregat HQ.** Sahkan RPC rollup memulangkan agregat sahaja dan tidak pernah
memulangkan baris mentah merentas zone.

---

## Keputusan — sudah dimuktamadkan

1. **Peranan HQ setiap zone: `agent`.** HQ boleh baca dan balas inbox semua zone, tetapi tidak
   boleh mengubah tetapan zone. Yusuf kekal `owner`. Kesan pada Fasa 1: baris `account_members`
   untuk user HQ ditulis dengan `role = 'agent'` bagi setiap zone.
2. **Yusuf owner keempat-empat zone.** Maka `idx_accounts_one_per_owner` **mesti** digugurkan
   dalam migration 042, seperti dirancang.
3. **Gap broadcast ditangguh** sehingga multi-zone mendarat. Broadcast kekal tidak boleh
   digunakan dengan ≥2 nombor sehingga itu — diketahui dan diterima, bukan regresi baru.

---

## Lampiran — hosting (kau minta perbandingan)

Skop sekarang reka bentuk, belum deploy, jadi ini ringkas sahaja untuk kau timbang kemudian.

| Pilihan | Kos sebulan (anggaran) | Baik | Buruk |
|---|---|---|---|
| **VPS + Docker** (Hostinger/DO) | ~USD 6–12 VPS + Supabase Pro USD 25 | Repo sudah ada `Dockerfile` + compose yang betul; satu container = rate limiter dalam-memori berfungsi; kos tetap | Kau urus domain, SSL, cron, kemas kini, backup |
| **Vercel + Supabase** | USD 0–20 + Supabase USD 25 | Paling laju naik, webhook HTTPS percuma, tiada kerja ops | **Serverless berbilang instance mematikan rate limiter dalam-memori** (`src/lib/rate-limit.ts`) — had API awam dan had brute-force token jemputan jadi hiasan. Perlu tukar ke Redis/Upstash dahulu |

Syorku: **VPS + Docker** untuk PTMO. Bukan sebab lebih murah, tetapi sebab andaian
satu-proses dalam pangkalan kod ini (rate limiting) betul-betul dipenuhi, dan tiada kerja
tambahan diperlukan sebelum go-live.

Dua hal yang mudah terlepas, tanpa mengira pilihan:
- `ENCRYPTION_KEY` **mesti sama** merentas semua persekitaran. Kehilangan atau menukarnya
  menjadikan setiap token WhatsApp dan kunci AI tersimpan tidak boleh dinyahsulit selamanya.
- `AUTOMATION_CRON_SECRET` tiada dalam `.env.local` sekarang → kedua-dua laluan cron pulang
  503, jadi **langkah Wait automation dan pemasa Flow tidak berjalan langsung**, tanpa
  sebarang tanda dalam UI.
