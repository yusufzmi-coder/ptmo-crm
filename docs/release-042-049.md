# Runbook release 042–049

> **TIDAK AKTIF sejak 14 Sep 2026.** Release diskop semula kepada tiga
> migration keselamatan — lihat `docs/release-phase1-migrations.md`, yang
> merupakan pelan semasa. Dokumen ini kekal sebagai rujukan untuk bila
> multi-number benar-benar di-scale. Jangan ikut urutan di bawah.

Dokumen operasi untuk menutup Fasa 1. Sumber kebenaran keadaan skema ialah
`supabase/migrations/README.md` (ledger). Runbook ini tidak mengulang
kandungannya — ia menyusun **urutan**, **titik henti** dan **bukti** yang
diperlukan.

**Baseline yang diandaikan:** production pada skema **041**. Andaian ini
batal jika Seksyen 1 preflight akaun tidak menepatinya. Nota luar yang
mendakwa 049 sudah live **tidak** diterima sebagai bukti.

Tiada langkah di bawah dijalankan tanpa arahan khusus daripada Boss.

---

## Peraturan yang tidak boleh dilanggar

1. **Merge ke `main` dahulu, apply kemudian.** 040 dan 041 sudah live
   tetapi hanya wujud pada `feat/multi-number`. Sehingga branch itu
   masuk `main`, `main` tidak boleh membina semula skema production.
2. **Seorang pemilik laluan merah.** Migration, RLS, auth, webhook, env —
   coordinator sahaja, sepanjang release.
3. **Dua job `.github/workflows/migrations.yml` mesti hijau**: *Apply to a
   clean database* dan *Apply to a database that is already at 041*. Job
   kedua yang benar-benar menguji backfill; job pertama bermula dari
   kosong dan tidak ada apa-apa untuk di-backfill.
4. **Setiap migration ada blok ROLLBACK sendiri** di hujung failnya. Guna
   yang itu; jangan karang rollback baharu semasa insiden.

---

## Gate 0 — bukti QA (SIAP)

Dijalankan pada checkout bersih `841db55` (tiruan `actions/checkout`,
kerana folder untracked tempatan mencemarkan gate — lihat *Isu diketahui*).

| Gate | Keputusan |
|---|---|
| `lint` | 0 error, 37 warning |
| `typecheck` | 0 error |
| `test` | 98 fail ujian, 1131 ujian, semua lulus |
| `build` | berjaya, 19 route dibina |

## Gate 1 — preflight production (Boss)

Kedua-dua fail 100% `SELECT`. Selamat waktu operasi. Dalam SQL Editor,
paste banyak statement hanya papar hasil **statement terakhir** — highlight
setiap seksyen dan run satu-satu.

### `supabase/preflight/release-preflight-accounts.sql`

- **Seksyen 1** — sahkan baseline betul-betul di 041. Jika mana-mana lajur
  tidak seperti dijangka: **BERHENTI**, semua penilaian risiko batal.
- **Seksyen 3 — ini yang boleh henti release.** 044 membina semula
  `account_members` daripada `profiles`. Baris dengan role NULL bermakna
  backfill akan salah, dan `is_account_member()` berada di belakang ~119
  RLS policy. Betulkan data dahulu, bukan migration.

### `supabase/preflight/release-preflight-storage.sql`

- **Seksyen 1 — blocker.** 047 menegaskan **tiada** bucket public di
  seluruh projek, bukan sekadar tiga yang ia tukar. Mana-mana bucket lain
  dengan `public = true` (biasanya dibuat melalui dashboard, jadi tiada
  jejak dalam repo) akan mematikan migration. Putuskan dahulu: jadikan ia
  private secara manual, atau padam jika ia eksperimen. **Jangan luaskan
  assertion 047.**
- **Seksyen 4 & 5** — berapa banyak baris bergantung pada
  `resolveStoredMediaUrl()`, dan mana yang **ditolak** host-check. Apa yang
  ditolak menjadi attachment yang kekal tidak boleh dibaca selepas 047.
  Baca sebelum setuju, bukan selepas.

### Tampal hasil di sini

```text
PREFLIGHT AKAUN — tarikh:
  S1 baseline 041:
  S2 taburan role:
  S3 role NULL (kiraan):
  Keputusan: TERUSKAN / BERHENTI

PREFLIGHT STORAGE — tarikh:
  S1 bucket public selain avatars/flow-media/chat-media:
  S4 baris bergantung pada proxy:
  S5 ditolak host-check (kiraan):
  Keputusan: TERUSKAN / BERHENTI
```

---

## Gate 2 — merge ke `main`

`feat/multi-number` kini 36 commit ahead, **0 behind** `origin/main`.
Push commit tertunggak, buka PR, tunggu CI + Migrations hijau, merge, tag.
Coordinator sahaja. Belum ada deploy pada peringkat ini.

## Gate 3 — apply 042–049

Ikut urutan nama fail. **Berhenti selepas setiap satu**, sahkan, baru
teruskan.

| # | Kelas | Nota operasi |
|---|---|---|
| 042 | data-changing | Menggabungkan thread pendua — **memadam baris**. Rollback hanya praktikal semasa satu nombor sahaja bersambung; dengan beberapa nombor, memulihkan index 036 bermakna memadam semua thread kecuali satu per contact. Backup sebelum ini. |
| 043 | additive | `whatsapp_config_id` pada `quick_replies`; NULL = semua branch. Risiko rendah. |
| 044 | security-critical + data-changing | Menulis semula `is_account_member()` di belakang ~119 policy. **Bergantung penuh pada preflight Seksyen 3.** Rollback selepas sesiapa join zone kedua akan menanggalkan akses itu. |
| 045 | additive | Presence per tab. Sengaja mengulang lajur/index 041 dengan `IF NOT EXISTS` supaya berdiri sendiri. |
| 046 | security-critical | REVOKE pada empat fungsi `SECURITY DEFINER` yang kini boleh dipanggil mana-mana JWT. Tiada perubahan data. |
| 047 | security-critical | **Apply SELEPAS deploy kod.** Sendirian ia memecahkan rendering media. Lihat blocker Seksyen 1 preflight. |
| 048 | data-changing | RPC 8-argumen digugurkan, diganti 9-argumen. **Tiada susunan tanpa tetingkap** — build lama pecah sebaik ia mendarat, build baharu pecah sehingga ia mendarat. Jadualkan tetingkap pendek dan umumkan. |
| 049 | additive | Selamat. **Bukan feature siap** — lihat bawah. |

### Susunan berbanding deploy kod

```
merge ke main  ->  042 043 044 045 046  ->  deploy kod  ->  [tetingkap] 048  ->  047  ->  049
```

048 dan 047 kedua-duanya berpasangan dengan kod. 047 mesti selepas deploy
kerana `resolveStoredMediaUrl()` dalam `src/lib/media/proxy-url.ts` yang
menampung URL legasi pada render time.

## Gate 4 — UAT

Tanpa WhatsApp sebenar dahulu (keputusan board 2026-09-13). Domain
`crm.ptmostaff.com` hanya disebut dalam board; tiada konfigurasi domain
dalam repo — sahkan dengan Boss sebelum sebarang deploy.

---

## 049 tidak boleh diisytihar siap

`grep -rn "centre_id" src/` memulangkan **0 padanan**. `contacts.centre_id`
tiada penulis: selepas 049 sebuah Centre boleh dicipta, disenarai dan
dipadam, tetapi seorang Parent **tidak boleh** ditetapkan kepada Centre.
049 boleh ship — ia tidak memecahkan apa-apa — tetapi UAT tidak boleh
mengesahkan model centre, kerana perkara yang menjadikannya berfungsi
belum dibina.

## Attachment legasi selepas 047

Migration backfill yang sepatutnya membetulkan `messages.media_url`
**ditarik balik dengan sengaja**: SQL tidak boleh membezakan storage host
kita daripada mana-mana `*.supabase.co`, jadi ia berisiko menulis semula
URL projek lain menjadi penunjuk ke bucket kita. Pemetaan dilakukan pada
render time oleh `resolveStoredMediaUrl()`, yang menyemak host terhadap
`NEXT_PUBLIC_SUPABASE_URL` dahulu.

Akibatnya perlu dinyatakan terus terang: nilai tersimpan kekal URL mati,
dan aplikasi yang menjadikannya berfungsi. Apa-apa yang membaca
`messages.media_url` tanpa melalui `resolveStoredMediaUrl()` akan dapat
pautan yang 400.

---

## Isu diketahui — gate tempatan tercemar

`npm run lint`, `npm run typecheck` dan `npm run build` **gagal secara
tempatan** pada checkout ini, dan kegagalan itu **bukan** datang dari kod
aplikasi:

- 15 error lint dan 145 error TypeScript, **kesemuanya** dari
  `project-command-board/`, `tools/command-board/` dan `.worktrees/` —
  folder untracked/ignored, termasuk `dist/` dan `.next/` yang dibundel.
- `src/` sendiri: **0 error lint, 0 error TypeScript.**
- `tsconfig.json` guna `include: ["**/*.ts", ...]` dengan
  `exclude: ["node_modules"]` sahaja, dan `eslint.config.mjs` tidak
  mengabaikan folder-folder itu — jadi kedua-dua alat melangkahinya.

CI tidak terjejas: `actions/checkout` memberi pokok bersih tanpa folder
tersebut. Tetapi coordinator tidak boleh menjalankan gate release secara
tempatan tanpa mengakalinya, dan jika folder itu pernah di-commit, CI akan
pecah juga. Perlu diputuskan: abaikan dalam `.gitignore` + `tsconfig` +
`eslint.config.mjs`, atau commit sebagai projek berasingan dengan
konfigurasinya sendiri. **Belum dilakukan — di luar skop batch ini.**
