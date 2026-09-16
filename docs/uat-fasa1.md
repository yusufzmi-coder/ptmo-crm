# UAT Fasa 1

Senarai semak penerimaan untuk release **045 · 046 · 047**.

> **Dibetulkan 14 Sep 2026.** Dokumen ini menamakan `049` sebagai
> sebahagian daripada release. Ia bukan — `049` sudah diapply pada
> production dengan tangan, disahkan oleh probe baca-sahaja. Ia ada
> dalam **baseline**, bukan dalam set yang akan dijalankan.

Ia bukan ringkasan `docs/release-phase1-migrations.md` — runbook itu
memiliki urutan, rollback dan preflight. Dokumen ini memiliki satu perkara
sahaja: **bukti bahawa ia berfungsi untuk staf sebenar selepas ia mendarat.**

> **Status: prasyarat SEMUA hijau sejak 15 Sep.** P1–P7 selesai, kedua-dua
> job CI hijau, dan release diapply. UAT boleh bermula.
>
> Satu perkara masih menunggu dan ia bukan prasyarat: nombor WhatsApp
> belum disambung, jadi Bahagian WhatsApp tidak boleh diuji. Segala yang
> lain boleh.

| | |
|---|---|
| Sasaran | `crm.ptmostaff.com` — hidup, 200, menyajikan build semasa |
| Environment | production / staging |
| Skema selepas apply | asas 041 + 049, kemudian 045, 046, 047 |
| Build/commit diuji | `405ba94` (`feat/multi-number` = `origin/main`) |
| Penguji | Coordinator (Terminal 1) — separa; baki menunggu akaun ujian |
| Tarikh | 16 Sep 2026 — pusingan tanpa-kelayakan |

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
| P4 | Preflight akaun | Boss | [x] **LULUS 14 Sep** |
| P5 | Preflight storage | Boss | [x] **LULUS 14 Sep** |
| P6 | Preflight storage Seksyen 5 — baris yang ditolak semakan host direkod | Boss | [x] **LULUS 14 Sep** |
| P7 | Apply `045`, `046`, `047` | Boss | [x] **SIAP 15 Sep** — ketiga-tiganya dalam **satu transaksi**. Urutan tiga langkah runtuh kepada satu kerana deploy kod sudah berlaku sebelum itu. Tiga penegasan dalam transaksi: `t` `t` `t`. Probe bebas dari luar mengesahkannya. |

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

## 0. Tingkap sebelum-merge — ia tutup pada merge, bukan pada apply

Empat kerosakan `043`/`048` dijumpai secara statik dan **tidak pernah
diperhatikan berlaku**. Ramalannya ialah 500. Bukti setakat ini ialah ledger
migration dan kod, bukan satu permintaan yang gagal.

Kerosakan itu **masih hidup pada `crm.ptmostaff.com` ketika ini**, kerana
pembetulannya ada pada `feat/multi-number` dan PR #66 belum dimerge. Detik
merge itu mendarat, ia hilang — dan bersamanya satu-satunya peluang untuk
mengesahkan diagnosis ini terhadap mesin sebenar dan bukan terhadap mock.

Ini berbeza daripada tingkap sebelum-051 dalam `docs/uat-fasa2.md`: tingkap itu
tutup bila seseorang **apply** migration, dan ia mengesahkan pagar **berfungsi**.
Tingkap ini tutup lebih awal — pada **merge** — dan ia mengesahkan kerosakan itu
**wujud**. Kalau hanya satu sempat dijalankan, jalankan yang ini: pagar yang
tidak diperlukan hanyalah kod berlebihan, tetapi kerosakan yang tidak wujud
bermakna empat pembetulan ini menyelesaikan masalah yang direka.

Perlukan sesi log masuk. Empat permintaan, tiada satu pun menulis data kekal
yang bermakna.

| # | Langkah | Ramalan | Keputusan |
|---|---|---|---|
| 0.1 | Buka picker quick reply **dari thread inbox** | 500 — `quick_replies.whatsapp_config_id` tiada | |
| 0.2 | Cipta satu quick reply, dari mana-mana skrin, tanpa pin cawangan | 500 — lajur dibawa tanpa syarat | |
| 0.3 | Cipta satu broadcast kepada **satu** kontak ujian | Gagal — RPC 9-hujah tak padan versi 8-hujah `038` | |
| 0.4 | Resume broadcast sedia ada | `404 Broadcast not found` untuk kempen yang wujud | |

Kalau mana-mana satu **berjaya** dan bukan gagal, pembetulan yang sepadan
menyelesaikan sesuatu yang bukan masalahnya. Rekod itu — ia lebih bernilai
daripada empat kelulusan.

Selepas merge, tandakan keempat-empatnya **TIDAK BOLEH DIUJI — tingkap tertutup**
dan jangan tulis semula sejarah dengan meneka apa yang akan berlaku.

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
| `/dashboard` | LULUS | | `/broadcasts` | LULUS |
| `/inbox` | LULUS | | `/automations` | LULUS |
| `/ops/unanswered` | LULUS | | `/flows` | LULUS |
| `/notifications` | LULUS | | `/agents` | LULUS |
| `/contacts` | LULUS | | `/settings` | LULUS |
| `/pipelines` | LULUS | | `/issues` | LULUS |

**Kesemuanya LULUS pada `crm.ptmostaff.com`, 16–17 Sep 2026**, disahkan
dengan larian berasingan. Setiap satu memulangkan `307` dengan
`Location: https://crm.ptmostaff.com/login`. `/` juga betul: `307` →
`/dashboard` → `307` → `/login`.

> **Pembetulan 17 Sep.** Pusingan pertama menguji sebelas laluan dan
> menyatakan ia "sepadan tepat dengan `protectedPaths`, tiada yang
> tertinggal". Sebelas itu sepadan dengan `middleware.ts` dalam pokok kerja
> pada masa itu — bukan dengan apa yang sedang hidup. `/issues` sudah
> dilindungi pada production dan tidak diuji. Ia diuji kemudian dan **LULUS**.
>
> Pengajaran, dan ia terpakai pada setiap kes dalam dokumen ini: senarai
> dalam branch bukan senarai yang sedang disajikan. Kira daripada sasaran,
> bukan daripada checkout.

**Akan menjadi 13 selepas deploy seterusnya.** `/calls` (Fasa 2) sudah ada
dalam `protectedPaths` pada branch tetapi belum disajikan — `/calls` dan
`/api/calls` kedua-duanya memulangkan **404** pada domain live, iaitu bukti
bahawa kerja Fasa 2 belum di-deploy. Uji semula 1.6 dengan tiga belas laluan
selepas ia mendarat; sehingga itu jangan tandakan apa-apa untuk `/calls`.

Boleh diulang sesiapa, tanpa kelayakan:

```bash
for p in /dashboard /inbox /ops/unanswered /notifications /contacts \
         /pipelines /broadcasts /automations /flows /agents /settings; do
  printf '%-18s %s -> %s\n' "$p" \
    "$(curl -s -o /dev/null -w '%{http_code}' https://crm.ptmostaff.com$p)" \
    "$(curl -s -o /dev/null -w '%{redirect_url}' https://crm.ptmostaff.com$p)"
done
```

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
penulis, jadi Parent tidak boleh ditetapkan kepada Centre.

> **Bukti dikemas kini 16 Sep.** Dokumen ini asalnya menulis
> `grep -rn "centre_id" src/` = 0. Kiraan itu kini **11**, dan salah satunya
> ialah tulisan (`open-case-dialog.tsx:148`). Kesimpulannya tetap sama —
> setiap satu daripada sebelas rujukan itu ialah `issues.centre_id`, yang
> datang dengan migration 050 selepas dokumen ini ditulis. `contacts.centre_id`
> masih tiada penulis. Kesimpulan betul, bukti sudah basi; jangan ulang
> grep lama itu dan sangka ia menafikan kes 3.7.

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
| 4.4 | Quick replies | Semua muncul; tiada penapis cawangan (043 dikeluarkan) | **GAGAL (statik) — lihat di bawah** | `docs/open-findings.md` P0 16 Sep |
| 4.5 | Belum Dibalas (`/ops/unanswered`) | Antrian tepat | | |

**4.4 tidak boleh ditanda LULUS.** Jangkaan dalam baris itu — "tiada penapis
cawangan sebab 043 dikeluarkan" — bercanggah dengan kod yang sedang hidup.
`src/app/api/quick-replies/route.ts` **memang** menapis mengikut cawangan:
baris 63-65 menapis `quick_replies.whatsapp_config_id`, dan baris 176
memasukkannya pada setiap `insert`. Lajur itu dicipta di satu tempat sahaja
dalam repo, `043_quick_replies_branch.sql:53-55`, dan 043 tidak pernah
diapply pada mana-mana pangkalan data.

Ramalan: membuka picker quick reply dari thread inbox memulangkan 500, dan
mencipta quick reply memulangkan 500 tanpa syarat. Belum disahkan terhadap
production — kedua-duanya perlukan sesi. Sahkan sebaik sahaja D1 selesai;
kalau ramalan ini betul ia **P0 hidup pada production**, bukan penemuan UAT.

Butiran penuh, dan tiga jalan keluar yang perlu diputuskan, ada dalam
`docs/open-findings.md`.

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
| 5.6 | Media tanpa sesi | Ditolak | **LULUS** | `/api/media/attachments/<x>` → `401`, `cache-control: no-store`. 16 Sep, tanpa kelayakan |
| 5.6b | `/api/issues` tanpa sesi | Ditolak | **LULUS** | `401`. 17 Sep |
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

Kiraan mengikut **kes bernama**, setakat pusingan 16 Sep (tanpa kelayakan).

| Bahagian | Lulus | Gagal | Tidak diuji |
|---|---|---|---|
| 1. Login | 1 (1.6, kini 12 laluan) | 0 | 6 |
| 2. Akses akaun | 0 | 0 | 4 |
| 3. Centres | 0 | 0 | 6 (+1 tidak boleh diuji: 3.7) |
| 4. Inbox | 0 | 1 (4.4, statik) | 5 |
| 5. Media | 2 (5.6, 5.6b) | 0 | 8 |
| 6. Keselamatan | 0 | 0 | 9 |

**Keputusan UAT:** **BELUM SELESAI** — bukan LULUS, bukan GAGAL. Tiga kes
lulus dengan bukti, satu gagal secara statik (4.4), 37 lagi belum
dijalankan kerana ia memerlukan sesi log masuk sebenar.

Jangan baca kiraan ini sebagai hijau. Satu-satunya kegagalan setakat ini
ditemui tanpa menjalankan apa-apa — ia ditemui dengan membaca kod terhadap
ledger migration. Itu mencadangkan pusingan berkelayakan akan menemui lebih
banyak, bukan kurang.

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

Prasyarat P1–P7 semuanya hijau — release sudah mendarat. Yang menghalang
sekarang ialah **akses ujian**, bukan keadaan sistem. Tujuh keputusan, dan
kesemuanya milik Yusuf, bukan mana-mana worker:

| # | Menghalang | Kenapa ia berhenti di sini | Keputusan yang diperlukan |
|---|---|---|---|
| D1 | Bahagian 1 (kecuali 1.6), 2, 3, 4, 5 | credential + data production | **Dua akaun ujian** pada domain live: satu admin, satu viewer. Siapa cipta, dalam akaun mana. Tanpa ini 39 kes mati. |
| D2 | 3.2, 3.3, 3.5, 3.6, 4.3 — kes **[tulis]** | menulis ke pangkalan data production | Lulus menulis pada production dengan awalan `UAT-` dan tanggungjawab membersih, atau tangguh kes tulis. |
| D3 | 6.1, 6.2, 6.7, 6.8 | auth/security dengan JWT sebenar | Siapa menjalankannya. **6.2 mematikan webhook endpoint** kalau tersilap jalan (`max_failures => 1`) — perlu pemilik bernama dan rancangan pulih. |
| D4 | 5.9a, dan dengan itu 5.9b/5.9c | data production | Senarai baris ditolak preflight storage Seksyen 5 mesti disalin ke sini. Ia sepatutnya dirakam **sebelum** 047 diapply; 047 sudah diapply 15 Sep. Kalau senarai itu tidak wujud, 5.9c tidak boleh membezakan regresi 047 daripada kerosakan lama — nyatakan begitu dan jangan reka. |
| D5 | 1.7 hujung ke hujung | menghantar e-mel sebenar, menukar kata laluan | Bergantung pada D1, dan pada P1 board (Supabase Auth → URL Configuration mesti termasuk domain live, kalau tidak pautan reset mendarat di `localhost`). |
| D6 | Bahagian WhatsApp | nombor belum disambung | Sudah dikenal pasti; kekal TIDAK BOLEH DIUJI sehingga nombor pilot hidup. |
| D7 | — | migration | Nasib `042`/`043`/`044`/`048` kekal P2 pada board. Tidak dibuka semula oleh UAT ini. |

### Risiko tinggal

- **Fasa 1 ditanda SELESAI pada board sedangkan UAT baru 2/41.** Board
  2026-09-13 memutuskan Fasa 1 ditutup hanya selepas preflight + release +
  UAT. Dua daripada tiga sudah; yang ketiga belum. Jurangnya jurang bukti,
  bukan jurang kod.
- **D4 mungkin sudah lewat.** 5.9a meminta rakaman sebelum 047. 047 diapply
  15 Sep. Kalau preflight storage Seksyen 5 tidak disimpan, tiada cara
  membina semulanya selepas fakta.
- **6.7/6.8 ialah kes bernilai tertinggi dan ia belum disentuh.** Kalau viewer
  boleh menaikkan `account_role` sendiri, itu eskalasi keistimewaan dan
  release berhenti. Sehingga ia diuji, 046 ialah andaian, bukan bukti.
