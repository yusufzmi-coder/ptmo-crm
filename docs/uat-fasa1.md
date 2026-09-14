# UAT Fasa 1

Senarai semak penerimaan untuk release **045 · 046 · 047**.

> **Dibetulkan 14 Sep 2026.** Dokumen ini menamakan `049` sebagai
> sebahagian daripada release. Ia bukan — `049` sudah diapply pada
> production dengan tangan, disahkan oleh probe baca-sahaja. Ia ada
> dalam **baseline**, bukan dalam set yang akan dijalankan.

Ia bukan ringkasan `docs/release-phase1-migrations.md` — runbook itu
memiliki urutan, rollback dan preflight. Dokumen ini memiliki satu perkara
sahaja: **bukti bahawa ia berfungsi untuk staf sebenar selepas ia mendarat.**

> **Status: belum dijalankan.** Ini template bukti. Jangan isi sehingga
> setiap prasyarat di bawah hijau.

| | |
|---|---|
| Sasaran | `crm.ptmostaff.com` — hidup, 200, menyajikan build semasa |
| Environment | production / staging |
| Skema selepas apply | asas 041 + 049, kemudian 045, 046, 047 |
| Build/commit diuji | `____________` |
| Penguji | `____________` |
| Tarikh | `____________` |

Tanda: `LULUS` · `GAGAL` · `TIDAK DIUJI` · `TIDAK BOLEH DIUJI`
Setiap `GAGAL` mesti bawa: langkah ulang, screenshot, masa, akaun yang guna.

---

## Prasyarat — UAT tidak bermula sebelum kesemuanya hijau

Tiada satu pun daripada ini kerja QA. Kesemuanya menghalang UAT.

| # | Prasyarat | Pemilik | Status |
|---|---|---|---|
| P1 | Job *upgrade path* main semula set yang **sebenarnya** dijalankan | coordinator | [x] **SIAP** — baseline kini 001–041 + 049; release 045, 046, 047; 042/043/044/048 diparkir dan tidak pernah diapply |
| P2 | `supabase/migrations/README.md` dikemas kini dalam commit yang sama dengan P1 | coordinator | [x] **SIAP** |
| P3 | Kedua-dua job migration hijau | coordinator | [x] **SIAP 14 Sep** — `Apply to a clean database` **success**, `Apply to a database that is already at 041` **success**. Kali pertama kedua-duanya berjalan sepenuhnya dalam hayat repo ini. |
| P4 | Preflight akaun **Seksyen 1** — baseline benar-benar di 041 | Boss | [ ] |
| P5 | Preflight storage **Seksyen 1** — tiada bucket public di seluruh projek | Boss | [ ] |
| P6 | Preflight storage **Seksyen 5** — senarai baris yang **ditolak** semakan host direkod (lihat kes 5.9) | Boss | [ ] |
| P7 | Apply mengikut urutan `045 → 046 → deploy kod → 047` | Boss | [ ] |

Nota P4: Seksyen 3 preflight akaun (role NULL) **tidak lagi menghalang** —
ia ditulis untuk 044, yang dikeluarkan. Seksyen 1 kekal wajib.

Nota P7: 049 tiada dalam urutan kerana ia **sudah diapply**. 047 mesti
**selepas** deploy kerana ia memecahkan setiap URL lampiran tersimpan dan
hanya kod yang menampungnya.

---

## Blocker

| # | Blocker | Status |
|---|---|---|
| B1 | ~~Hostname sasaran tiada konfigurasi dalam repo~~ | [x] **DITUTUP** |

B1 ditutup dengan bukti dan bukan dengan pengesahan: `crm.ptmostaff.com`
memulangkan 200 dan menyajikan build semasa. Ketiadaan hostname dalam
repo ialah fakta yang betul dan kesimpulan yang salah — domain itu
dikonfigurasi dalam Vercel, bukan dalam kod, jadi tiada carian repo akan
pernah menemuinya. **Sasaran ialah `crm.ptmostaff.com`.**

B2 (Centres) **ditutup**: 049 sudah live, jadi CRUD Centre wujud untuk
diuji. Lihat Bahagian 3.

---

## 1. Login

| # | Kes | Jangkaan | Keputusan | Bukti |
|---|---|---|---|---|
| 1.1 | Kelayakan sah | Mendarat `/dashboard` | | |
| 1.2 | Kata laluan salah | Ralat generik — tidak mendedahkan sama ada e-mel wujud | | |
| 1.3 | Akaun tidak wujud | Mesej sama persis dengan 1.2 | | |
| 1.4 | Logout | Sesi lupus | | |
| 1.5 | Butang back selepas logout | Tidak masuk semula | | |

### 1.6 Laluan dilindungi tanpa sesi

Sumber kebenaran: `protectedPaths` dalam `src/middleware.ts`.

Sudah **diperhatikan berfungsi** pada dev tempatan — lima laluan
(`/inbox` `/contacts` `/flows` `/agents` `/dashboard`) memulangkan 307 ke
`/login`. Ulang pada sasaran sebenar untuk kesebelas.

| Laluan | 307 → /login? | | Laluan | 307 → /login? |
|---|---|---|---|---|
| `/dashboard` | | | `/broadcasts` | |
| `/inbox` | | | `/automations` | |
| `/ops/unanswered` | | | `/flows` | |
| `/notifications` | | | `/agents` | |
| `/contacts` | | | `/settings` | |
| `/pipelines` | | | | |

### 1.7 Forgot-password hujung ke hujung

**Belum pernah dijalankan terhadap Supabase live.** Halaman disahkan wujud,
bukan disahkan berfungsi. Layan sebagai risiko tinggi, bukan formaliti.

| Langkah | Jangkaan | Keputusan |
|---|---|---|
| Hantar borang forgot-password | E-mel sampai | |
| Klik pautan | `/auth/callback?next=/reset-password` → halaman sebenar, bukan 404 | |
| Set kata laluan baharu | Berjaya | |
| Login kata laluan baharu | Berjaya | |
| Login kata laluan lama | Ditolak | |
| Guna semula pautan reset | Ditolak / luput | |

---

## 2. Akses akaun — pengesahan NEGATIF

044 dikeluarkan. Akses HQ multi-zon **tidak wujud**: satu login kekal milik
satu akaun, dan pilot ialah 1 Centre, 2 staf, tiada zon.

Jadi bahagian ini tidak lagi mengesahkan penukaran zon berfungsi. Ia
mengesahkan **tiada permukaan zon terdedah separuh jalan** — separuh ciri
yang kelihatan boleh diklik tetapi tidak disokong oleh skema.

| # | Kes | Jangkaan | Keputusan |
|---|---|---|---|
| 2.1 | Zone switcher dalam header | Tidak dipapar — `shouldShowSwitcher()` palsu dengan satu akaun | |
| 2.2 | Cara lain tukar akaun dalam UI | Tiada | |
| 2.3 | Viewer vs admin | Tindakan admin tersembunyi untuk viewer | |
| 2.4 | Viewer paksa tindakan admin | Ditolak di **server**, bukan hanya disembunyikan di UI | |

---

## 3. Centres — CRUD sahaja (049)

049 mencipta `regions` dan `centres`. Tab Settings membacanya, jadi ia
berfungsi setakat CRUD. Ia **bukan** ciri siap: `contacts.centre_id` tiada
penulis (`grep -rn "centre_id" src/` = 0), jadi Parent tidak boleh
ditetapkan kepada Centre.

Lokasi: Settings → *Centres & zones* (`/settings?tab=centres`)

| # | Kes | Jangkaan | Keputusan |
|---|---|---|---|
| 3.1 | Tab memuat | Tiada toast `loadFailed` | |
| 3.2 | Cipta Centre **[tulis]** | Berjaya, muncul dalam senarai | |
| 3.3 | Cipta Zone/Region **[tulis]** | Berjaya | |
| 3.4 | Centre tanpa zon | Dikumpul sebagai unassigned, di hujung | |
| 3.5 | Padam Zone **[tulis]** | **Centrenya kekal** dan berpindah ke kumpulan unassigned — `centres.region_id` ialah `ON DELETE SET NULL` (049:109), bukan CASCADE | |
| 3.6 | Padam Centre ujian **[tulis]** | Berjaya | |
| 3.7 | Tetapkan Parent kepada Centre | — | **TIDAK BOLEH DIUJI — tiada penulis** |

Kes 3.1 penting: toast `loadFailed` di sini bermakna 049 tidak di-apply
atau di-apply selepas deploy. Itu kegagalan urutan, bukan kegagalan UI.

---

## 4. Inbox

| # | Kes | Jangkaan | Keputusan | Bukti |
|---|---|---|---|---|
| 4.1 | Senarai perbualan dimuat | Tiada ralat | | |
| 4.2 | Buka thread, baca sejarah | Tertib, lengkap | | |
| 4.3 | Hantar mesej keluar **[tulis]** | Terhantar — kontak ujian, bukan parent sebenar | | |
| 4.4 | Quick replies | Semua muncul; tiada penapis cawangan (043 dikeluarkan) | | |
| 4.5 | Belum Dibalas (`/ops/unanswered`) | Antrian tepat | | |

### 4.6 Presence per tab (045) — bug yang release ini sebenarnya baiki

Sebelum 045, setiap tab menulis ke satu baris `member_presence` yang sama
setiap ~30s dan saling menindih. Akibatnya seorang agent yang sedang
membaca thread **hilang** daripada pandangan rakan lebih kurang separuh
masa — tanpa ralat, tanpa log, tanpa apa-apa dalam UI.

Ujian mesti meniru keadaan itu, bukan sekadar membuka inbox.

| # | Langkah | Jangkaan | Keputusan |
|---|---|---|---|
| 4.6a | Staf A: Tab 1 buka thread X dan fokus. Tab 2 buka `/dashboard` di belakang. | — | |
| 4.6b | Staf B perhatikan thread X selama **sekurang-kurangnya 3 minit** | Staf A kekal kelihatan sebagai co-viewer **sepanjang masa**, tidak berkelip hilang-muncul | | |
| 4.6c | Staf A tutup Tab 2 | Kehadiran Tab 1 tidak terjejas | |
| 4.6d | Staf A tutup semua tab | Kehadiran hilang dalam masa munasabah | |

4.6b ialah kes sebenar. Tempoh 3 minit itu bukan sewenang-wenang — kitaran
heartbeat ~30s, jadi pemerhatian pendek boleh terlepas tindihan sepenuhnya.

**Jangan failkan sebagai bug:** unread ialah satu lajur dikongsi, bukan
per-pengguna. Dua staf membaca thread sama akan saling menjejaskan kiraan.
Itu keputusan produk yang direkod.

**UAT tanpa WhatsApp sebenar** (keputusan board 2026-09-13).

---

## 5. Media (047) — bahagian paling mudah pecah

| # | Kes | Jangkaan | Keputusan | Bukti |
|---|---|---|---|---|
| 5.1 | Attachment **baharu** (selepas deploy) | Render betul | | |
| 5.2 | Attachment **legasi** (sebelum 047) | **Render betul** — ini ujian sebenar 047 | | |
| 5.3 | Muat turun attachment legasi | Berjaya | | |
| 5.4 | Lightbox imej | Buka, tiada 400 | | |
| 5.5 | Media sebagai pengguna akaun lain | **404**, bukan 403 | | |
| 5.6 | Media tanpa sesi | Ditolak | | |
| 5.7 | Header cache | `private` | | |
| 5.8 | Tiada bucket public di seluruh projek | Sah | | |

Kes 5.5: 403 mengesahkan fail itu wujud di tempat lain. 404 tidak. Bezanya
penting — jangan terima 403 sebagai "cukup selamat".

### 5.9 Lampiran yang ditolak semakan host — rekod SEBELUM apply

Backfill yang sepatutnya membetulkan `messages.media_url` **ditarik balik
dengan sengaja**: SQL tidak boleh membezakan storage host kita daripada
mana-mana `*.supabase.co`, jadi ia berisiko menulis semula URL projek lain
menjadi penunjuk ke bucket kita. Pemetaan berlaku pada render time dalam
`resolveStoredMediaUrl()` (`src/lib/media/proxy-url.ts`), yang menyemak host
terhadap `NEXT_PUBLIC_SUPABASE_URL`.

Baris yang **ditolak** semakan itu menjadi lampiran yang kekal tidak boleh
dibaca selepas 047. Tiada backfill untuknya; ia belum ditulis.

| # | Langkah | Keputusan |
|---|---|---|
| 5.9a | **Sebelum** 047: salin senarai baris ditolak dari preflight storage Seksyen 5 ke sini | |
| 5.9b | Selepas 047: sahkan baris tersebut — dan **hanya** baris tersebut — tidak boleh dibaca | |
| 5.9c | Mana-mana lampiran rosak yang **tiada** dalam senarai 5.9a | **REGRESI 047 — eskalasi** | |

```text
Baris ditolak (isi sebelum apply):

```

Tanpa 5.9a, lampiran rosak selepas 047 akan kelihatan seperti regresi 047
padahal ia data yang sudah rosak sebelum ini. Perbezaan itu memakan sehari
semasa insiden. Rekod dahulu.

---

## 6. Keselamatan (046)

046 me-REVOKE EXECUTE daripada PUBLIC pada empat fungsi `SECURITY DEFINER`
yang terlepas, dan menyempitkan UPDATE pada `profiles`.

| Fungsi | Sumber |
|---|---|
| `record_webhook_failure(uuid, int)` | `028:91-103` |
| `_bcast_bump(uuid, text, int)` | `005:36-44` |
| `recompute_broadcast_counts(uuid)` | `005` |
| `claim_ai_reply_slot(uuid, integer)` | `031` |

| # | Kes | Jangkaan | Keputusan |
|---|---|---|---|
| 6.1 | Panggil keempat-empat fungsi dengan JWT pengguna biasa | Ditolak — tiada EXECUTE | |
| 6.2 | `record_webhook_failure(..., max_failures => 1)` sebagai pengguna biasa | Ditolak. Sebelum 046 ini mematikan webhook endpoint. | |
| 6.3 | Penghantaran webhook sebenar (`src/lib/webhooks/deliver.ts:151`, `service_role`) | Masih berfungsi — 046 memberi GRANT kepada `service_role` | |
| 6.4 | Broadcast hujung ke hujung | Tiada regresi kiraan | |
| 6.5 | Kemas kini profil sendiri: nama, avatar | Berjaya — ini satu-satunya tulisan klien ke `profiles` dalam kod (`profile-form.tsx:144`) | |
| 6.6 | Tukar e-mel sendiri | Berjaya — ia melalui Supabase Auth (`profile-form.tsx:158-163`), bukan UPDATE pada `profiles` | |
| 6.7 | **Viewer tulis `profiles.account_role` sendiri** | **Ditolak** — ini serangan sebenar yang 046 tutup | |
| 6.8 | Viewer tulis `profiles.account_id` sendiri | Ditolak | |
| 6.9 | Tulis `profiles.beta_features` dari klien | Ditolak — read-only kepada klien (011) | |

Dua kes bernilai tertinggi:

**6.7 / 6.8.** `profiles.account_id` dan `account_role` memutuskan zon mana
anda berada dan apa yang anda boleh buat di situ. Sebelum 046, satu-satunya
penghalang ialah trigger 034 — SECURITY INVOKER yang menapis pada
perbandingan rentetan `current_user = 'authenticated'` (034:66), satu
deny-list sepanjang satu entri. RLS `profiles_update` (017:614-616) menapis
**baris**, bukan **lajur**. 046 menambah keengganan peringkat katalog yang
berlaku sebelum mana-mana trigger berjalan.

Uji sebagai viewer, bukan admin. Kalau viewer boleh menaikkan
`account_role` sendiri, itu eskalasi keistimewaan dan release berhenti.

**6.2.** Satu panggilan `record_webhook_failure(..., max_failures => 1)`
mematikan webhook endpoint. Sebelum 046 sesiapa dengan JWT boleh membuatnya.

Nota 6.3: 046 **tidak** menghalang `set_active_account()` walaupun ia menulis
`profiles.account_id` — ia SECURITY DEFINER milik `postgres`, jadi
keistimewaan lajur diuji terhadap `postgres`, bukan pemanggil. (Tidak
relevan dalam pilot ini kerana 044 dikeluarkan, tetapi ia sebab kes 6.8
menolak klien tanpa memecahkan apa-apa.)

---

## Ringkasan

| Bahagian | Lulus | Gagal | Tidak diuji |
|---|---|---|---|
| 1. Login | | | |
| 2. Akses akaun | | | |
| 3. Centres | | | |
| 4. Inbox | | | |
| 5. Media | | | |
| 6. Keselamatan | | | |

**Keputusan UAT:** LULUS / LULUS BERSYARAT / GAGAL

### Sengaja tidak diuji — dan kenapa

| Perkara | Sebab |
|---|---|
| Penetapan Parent → Centre | Tiada penulis `centre_id`. Belum dibina. |
| Akses HQ multi-zon, penukaran zon | 044 dikeluarkan. Ciri tidak wujud. |
| Perbualan per nombor | 042 dikeluarkan. Satu nombor = satu config. |
| Quick reply per cawangan | 043 dikeluarkan. |
| Broadcast per nombor | 048 dikeluarkan. `resolveConfig` jatuh ke `onlyConfig()`. |
| Penghantaran WhatsApp sebenar | Keputusan board 2026-09-13. |
| Semakan Origin/Referer pada `/api` bukan-GET | Tidak pernah ditangani. Lihat `docs/open-findings.md`. |

### Blocker tinggal

### Risiko tinggal
