# Release Fasa 1 — 045, 046, 047

> # ✅ SELESAI — diapply 15 Sep 2026
>
> Ketiga-tiganya mendarat dalam **satu transaksi**, ditampal daripada
> `supabase/release/APPLY-045-046-047.sql`. Urutan tiga langkah runtuh
> kepada satu kerana deploy kod sudah berlaku sebelum itu, yang merupakan
> satu-satunya sebab 047 perlu menunggu.
>
> Tiga penegasan dalam transaksi kesemuanya `t`, dan probe baca-sahaja
> berasingan mengesahkannya dari **luar** pangkalan data:
> `member_presence.tab_id` 200, ketiga-tiga bucket awam 400,
> domain 200.
>
> **Dokumen ini kini sejarah, bukan pelan.** Ia menerangkan apa yang
> ketiga-tiga migration itu buat dan kenapa, yang kekal berguna. Jangan
> baca bahagian di bawah sebagai kerja tertunggak — tiada satu pun
> daripadanya tertunggak.
>
> Keadaan production semasa ada dalam `supabase/migrations/README.md`.

> **Pembetulan kedua, 14 Sep 2026.** 049 **sudah diapply pada production**
> — disahkan dengan probe REST read-only, bukan dengan membaca ledger.
> Set yang tinggal ialah **045, 046, 047**. Lihat "049 sudah live" di bawah.
>
> Pembetulan pertama (mengeluarkan 049, kemudian memasukkannya semula)
> kekal direkod di bawah kerana sebabnya masih sah: kod yang dihantar
> membaca jadual yang 049 cipta. Perbezaannya ialah jadual itu sudah ada.

Release Fasa 1 diskop semula. Dokumen ini menggantikan
`docs/release-042-049.md` sebagai pelan aktif; runbook lapan-migration itu
kekal dalam repo sebagai rujukan untuk bila multi-number benar-benar
di-scale, tetapi ia **bukan** pelan semasa.

**Sebab:** keputusan produk 14 Sep 2026 — CRM menjawab pada **satu** nombor,
16 handset cawangan kekal di luar API. Tiga daripada lapan migration dalam
set asal wujud semata-mata untuk menyelesaikan masalah 16 nombor. Masalah
itu tidak lagi wujud, jadi migrationnya tidak perlu dijalankan sekarang.

Yang tinggal bukan kerja multi-number langsung. Ia **kerja keselamatan**,
dan dua daripadanya menutup pendedahan yang hidup pada production hari ini.

---

## Apa yang masuk

### 047 — bucket storage terbuka kepada internet

Keutamaan tertinggi, dan ia tiada kaitan dengan model nombor.

Ketiga-tiga bucket dicipta `public = TRUE` dengan polisi baca tanpa syarat
`USING (bucket_id = '<name>')` — benar untuk `anon`:

| Bucket | Dicipta | Polisi |
| --- | --- | --- |
| `avatars` | `008:15-19` | `008:33-35` |
| `flow-media` | `016:57-61` | `016:88-90` |
| `chat-media` | `023:38-42` | `023:84-86` |

Migration **039** (sudah live) menukar ini daripada masalah terpendam
kepada masalah aktif: ia mencerminkan **setiap** lampiran masuk ke
`chat-media`, dan `mirror_inbound_media` default `TRUE`. Setiap gambar,
dokumen dan voice note yang ibu bapa hantar tentang anak mereka berada
dalam bucket yang boleh dibaca internet terbuka — sekarang.

Tulisan diskop dengan betul mengikut segmen pertama laluan (`020:80-89`,
`023:89-98`). Jadi asimetrinya nampak disengajakan tetapi sebenarnya
separuh-difikirkan: sesiapa tanpa log masuk boleh senarai dan ambil fail
setiap akaun.

**Apa 047 buat:** `UPDATE storage.buckets SET public = FALSE` untuk
ketiga-tiganya, ganti tiga polisi baca terbuka dengan polisi berasaskan
keahlian, dan tegaskan project-wide bahawa **tiada** bucket tinggal public.

### 046 — empat fungsi SECURITY DEFINER terbuka

Postgres memberi EXECUTE kepada PUBLIC secara default. Fungsi
`SECURITY DEFINER` yang tidak di-REVOKE secara eksplisit bermakna "sesiapa
boleh panggil, dan ia berjalan sebagai pemilik" — dengan pemilik
`postgres`, ia melepasi setiap polisi RLS dalam skema.

Repo ini sudah tahu perkara itu. Migration 007, 012, 018, 019, 022, 025,
030, 036, 037 dan 038 semuanya REVOKE sebelum GRANT. Empat fungsi
terlepas:

```
record_webhook_failure(uuid, int)      028:91-103
_bcast_bump(uuid, text, int)           005:36-44
recompute_broadcast_counts(uuid)       005
claim_ai_reply_slot(uuid, integer)     031
```

Yang paling jelas: `record_webhook_failure` menerima `max_failures`
daripada pemanggil dan melumpuhkan endpoint sebaik `failure_count >=
max_failures`. Panggilan tunggal dengan `max_failures => 1` mematikan
webhook endpoint zon lain.

046 juga menyempitkan UPDATE pada `profiles` daripada seluruh baris kepada
`(full_name, avatar_url)` sahaja.

**Disahkan tidak memecahkan apa-apa:** satu-satunya pemanggil
`record_webhook_failure` dalam kod ialah `src/lib/webhooks/deliver.ts:151`,
dipanggil dari route API server-side yang menggunakan `service_role` —
dan 046 memberi GRANT kepada `service_role`. Tiada komponen klien memanggil
mana-mana daripada empat fungsi itu.

### 045 — presence per tab

Bukan isu keselamatan; bug sebenar yang inbox dua-staf akan kena serta-merta.

Migration 024 mengunci `member_presence` pada `user_id` sahaja: satu baris
per orang. Migration 041 kemudian meletakkan conversation yang sedang dibuka
pada baris yang sama. Tetapi `PresenceHeartbeat` mount dalam dashboard
shell, jadi **setiap** tab menulis ke baris yang satu itu setiap ~30s:

```
Tab 1  Inbox, thread X dibuka, fokus  -> ('online', X)
Tab 2  /dashboard, di belakang        -> ('away',   NULL)
```

Mereka saling menindih bergilir. `coViewers()` memerlukan 'online' DAN
penunjuk thread yang sepadan, jadi lebih kurang separuh daripada setiap
minit, agent yang sedang membaca thread X **tidak kelihatan** kepada rakan
sekerja — tanpa ralat, tanpa log, tanpa apa-apa dalam UI yang menunjukkan
ia berhenti berfungsi.

Dengan 2 staf dalam satu inbox kongsi, kegagalan itu ialah ibu bapa
menerima dua jawapan untuk satu soalan.

---

## Apa yang dikeluarkan, dan kenapa

| # | Sebab dikeluarkan |
| --- | --- |
| **042** | Ia membaiki dua cawangan berkongsi satu thread, punca `UNIQUE(account_id, contact_id)` daripada 036. Dengan satu nombor keadaan itu **tidak boleh berlaku** — setiap conversation membawa `whatsapp_config_id` yang sama. Ia juga satu-satunya yang **memadam baris**, dan bloknya sendiri mengaku rollback hanya praktikal semasa satu nombor bersambung. Risiko tertinggi, nilai sifar sekarang. |
| **043** | Mengunci quick reply pada nombor. Satu nombor bermakna semua quick reply pada config yang sama. Tiada kesan. |
| **044** | Menulis semula `is_account_member()` di belakang ~119 polisi RLS. Pilot ialah 1 Centre, 2 staf, tiada zon. Risiko tertinggi kedua, nilai pilot sifar. |
| **048** | Dijejak dalam kod, bukan diandaikan: `resolveConfig` jatuh ke `onlyConfig()` (`src/lib/whatsapp/resolve-config.ts:136,154-169`), yang pulangkan `ok` bila akaun ada **tepat satu** config. Resume broadcast berfungsi tanpa 048. |
Keempat-empatnya tidak reput. Ia dijalankan bila scale ke banyak nombor dan
banyak zon benar-benar berlaku.

---

## 049 sudah live — pembetulan kedua

Probe REST read-only terhadap production, 14 Sep:

```
/rest/v1/centres        200        /rest/v1/account_members   404
/rest/v1/regions        200        /rest/v1/rpc/my_accounts   404
contacts.centre_id      ada        quick_replies…config_id    tiada
                                   member_presence.tab_id     tiada
                                   broadcasts…config_id       tiada
```

Jadi production ialah **041 + 049**, dan ledger yang menyatakan 042–049
semuanya belum diapply adalah salah. Board sudah menandakan percanggahan
ini dan menetapkan peraturan yang betul — jangan percaya mana-mana pihak
sehingga probe read-only menjawab. Probe sudah jalan; nota luar betul.

046 dan 047 **tidak boleh dibezakan begini** — satu set `REVOKE`, satu
lagi menukar `storage.buckets.public`, dan kedua-duanya tidak menampakkan
diri melalui PostgREST dengan kunci anon. Keadaannya kekal tidak diketahui
sehingga preflight dijalankan.

### Masalah yang sama bentuk, masih terbuka: `my_accounts`

`src/lib/auth/zones.ts:125` memanggil RPC `my_accounts`, dan **hanya 044**
menciptanya. 044 dikeluarkan daripada release.

Laluannya hidup: header → `zone-switcher.tsx` → `useZones()` →
`fetchZones()` → 404, pada setiap page load, selama-lamanya.

Ia merosot dengan elok — `fetchZones` menangkap ralat dan memulangkan
`{ok:false,reason:'failed'}`, switcher tidak render, tiada skrin pecah.
Jadi **bukan blocker deploy**. Tetapi kod zon dihantar dalam keadaan mati
dan konsol dipenuhi ralat berulang yang akan menyembunyikan ralat sebenar
kemudian.

Ini bentuk yang **sama persis** dengan blocker 049, dan ia terlepas atas
sebab yang boleh dinamakan: semakan menyemak **jadual** yang setiap
migration cipta, bukan **fungsi**.

**Peraturan untuk semakan seterusnya:** semak setiap FUNGSI dan setiap
JADUAL yang migration cipta terhadap `.rpc(` dan `.from(` dalam `src/`.
Jadual sahaja tidak mencukupi.

Dua pilihan, kedua-duanya keputusan Boss: masukkan semula 044, atau pagar
panggilan itu supaya ia tidak dibuat bila ciri zon tiada. 044 membawa
risiko tertinggi dalam set asal dan tiada nilai pilot, jadi memagarnya
lebih murah.

---

## 049 dimasukkan semula — pembetulan pertama (kekal untuk rekod)

Versi pertama dokumen ini mengeluarkan 049 atas alasan ia "additive dan
selamat, tetapi tiada penulis, jadi ia akan masuk tanpa membuat apa-apa".

Alasan itu menilai perkara yang salah. Benar bahawa `contacts.centre_id`
tiada penulis — `grep -rn "centre_id" src/` masih pulangkan 0 padanan, dan
Parent masih tidak boleh ditetapkan kepada Centre. Tetapi 049 tidak hanya
menambah lajur itu. Ia **mencipta dua jadual**, dan UI yang sudah dihantar
membacanya:

```
src/app/(dashboard)/settings/page.tsx:79   <CentresPanel /> dipasang
src/components/settings/centres-panel.tsx:88   .from('regions')
src/components/settings/centres-panel.tsx:94   .from('centres')
                                        :141   .from('regions')
                                        :163   .from('centres').insert(...)
                                        :188   .from(table).delete(...)

CREATE TABLE IF NOT EXISTS regions   049_centres_and_regions.sql:72
CREATE TABLE IF NOT EXISTS centres   049_centres_and_regions.sql:104
```

Tiada migration lain mencipta salah satu daripadanya — disahkan dengan grep
merentas kesemua 49 fail.

Jadi men-deploy kod tanpa 049 bermakna tab Settings -> "Centres & zones"
menanyakan jadual yang tidak wujud. `load()` membungkusnya dalam try/catch
dan memaparkan toast `loadFailed` (baris 103), jadi ia gagal dengan anggun —
tetapi tab itu mati, kosong, dengan ralat, setiap kali dibuka.

**049 kekal dalam release.** Ia masih bukan ciri siap: Centre boleh dicipta,
disenarai dan dipadam, tetapi Parent tidak boleh ditetapkan kepada satu.
Perbezaannya ialah antara *tidak lengkap* dan *rosak*, dan tanpa 049 ia
yang kedua.

**Pengajaran untuk skop semula seterusnya:** "tiada penulis untuk lajur"
bukan sama dengan "tiada kod bergantung padanya". Semak setiap jadual yang
migration cipta terhadap `.from(` dalam `src/`, bukan hanya lajur yang
menjadi tajuk migration itu.

---

## Kebergantungan — set ini boleh berdiri sendiri

Disahkan dengan memeriksa rujukan silang, bukan diandaikan:

- 045 tidak menyebut `account_members`, fungsi 044, atau artifak 042 langsung.
- 049 additive dan berdiri sendiri: ia mencipta `regions`, `centres` dan
  `contacts.centre_id`, dan tidak merujuk apa-apa daripada 042, 044 atau 048.
- 046 dan 047 menyebut 044 **hanya dalam komen** (`046:92`, `047:55`) —
  prosa yang menjelaskan kenapa mereka TIDAK menggunakan
  `is_account_member_any()`. Tiada rujukan dalam kod.
- 047 menyebut "centres" hanya dalam ayat penerangan (`047:22`).

Jadi 045, 046 dan 047 tidak memerlukan 042, 044 atau 049.

---

## Susunan dan kopling kod

```
merge ke main  ->  045  ->  046  ->  deploy kod  ->  047
```

049 tiada dalam urutan kerana ia sudah diapply.

**045 — susunan bebas.** Ia menggugurkan tandatangan lama
`touch_presence(TEXT)` dan `touch_presence(TEXT, UUID)`, dan mencipta
`touch_presence(p_status, p_viewing_conversation_id, p_tab_id)` dengan
`p_tab_id TEXT DEFAULT NULL`. Build yang belum di-deploy menghantar dua
argumen bernama dan tetap selesai melalui default. Header migration
menyatakannya sendiri pada baris 127-129: "That makes the deploy order
free: migrate first."

**046 — susunan bebas.** REVOKE/GRANT sahaja. Satu-satunya pemanggil
berjalan sebagai `service_role`, yang diberi GRANT.

**047 — mesti SELEPAS deploy kod.** Ia memecahkan setiap URL lampiran yang
disimpan sebelumnya. Tiada migration dalam release ini membaikinya:
backfill yang sepatutnya berbuat demikian **ditarik balik dengan sengaja**,
kerana SQL tidak boleh membezakan storage host kita daripada mana-mana
`*.supabase.co` dan berisiko menulis semula URL projek lain menjadi
penunjuk ke bucket kita. `resolveStoredMediaUrl()` dalam
`src/lib/media/proxy-url.ts` melakukan pemetaan pada render time dengan
semakan host terhadap `NEXT_PUBLIC_SUPABASE_URL`.

Akibatnya perlu dinyatakan terus terang: selepas release ini nilai
tersimpan kekal URL mati, dan aplikasi yang menjadikannya berfungsi.
Apa-apa yang membaca `messages.media_url` tanpa melalui
`resolveStoredMediaUrl()` akan dapat pautan yang 400.

---

## Preflight — bahagian mana yang masih penting

`supabase/preflight/release-preflight-accounts.sql` ditulis untuk 044.
Dengan 044 dikeluarkan, **Seksyen 3 (role NULL) tidak lagi menghalang** —
tiada backfill keahlian akan berlaku. **Seksyen 1 masih wajib**: ia
mengesahkan baseline benar-benar di 041. Jika tidak, setiap penilaian
risiko di sini batal.

`supabase/preflight/release-preflight-storage.sql` kekal **wajib sepenuhnya**:

- **Seksyen 1 — blocker.** 047 menegaskan tiada bucket public di seluruh
  projek, lebih luas daripada tiga yang ia betulkan. Bucket yang dicipta
  melalui dashboard tidak wujud di mana-mana dalam repo ini dan akan
  mematikan migration. Jadikan ia private secara manual atau padam jika ia
  eksperimen. **Jangan luaskan assertion 047** — ia satu-satunya yang
  menghalang projek ini daripada bucket terbuka seterusnya.
- **Seksyen 4 & 5** — berapa banyak baris kini bergantung pada laluan kod
  itu, dan mana yang **ditolak** semakan host. Apa yang ditolak menjadi
  lampiran yang kekal tidak boleh dibaca selepas 047. Baca sebelum setuju.

---

## Rollback

Setiap migration membawa bloknya sendiri di hujung fail. Guna yang itu;
jangan karang rollback baharu semasa insiden.

- `045:225`
- `046:102-108`
- `047:93-99` — dan perhatikan apa yang dinyatakan oleh blok itu sendiri:
  memulihkannya **membuka semula lampiran setiap zon kepada internet**.

---

## Pengesahan

Job *upgrade path* dalam `.github/workflows/migrations.yml` main semula
`001`–`041`, menyemai baris berbentuk production, kemudian menggunakan
`042`–`049` **sebagai satu set**.

Ini ialah kos sebenar bagi memecahkan set, dan ia perlu dinyatakan:
menjalankan 045/046/047 sahaja pada production bermakna CI tidak lagi
mencerminkan production — masalah yang sama persis yang dicipta oleh 040
dan 041 yang diapply dengan tangan. Sebelum apa-apa disentuh, job itu
mesti diubah supaya ia main semula set yang **sebenarnya** dijalankan, dan
`supabase/migrations/README.md` dikemas kini dalam commit yang sama.

Jangan apply apa-apa sehingga itu selesai dan kedua-dua job hijau.

---

## Apa yang release ini TIDAK baiki

- Tiada semakan Origin/Referer pada permintaan `/api` bukan-GET. Separuh
  penemuan itu tidak pernah ditangani — lihat `docs/open-findings.md`.
- Centres kekal **tidak lengkap**, walaupun 049 masuk: `contacts.centre_id`
  tiada penulis, jadi Parent tidak boleh ditetapkan kepada cawangan. Tab
  Settings berfungsi setakat CRUD — cipta, senarai, padam Centre, dan padam
  Zone mengekalkan Centrenya. UAT boleh mengesahkan setakat itu sahaja.
- Akses HQ multi-zon tidak wujud tanpa 044. Satu login kekal milik satu
  akaun.
- Lampiran yang ditolak semakan host dalam Seksyen 5 preflight menjadi
  kekal tidak boleh dibaca. Membetulkan data itu memerlukan backfill yang
  diberi semakan host tersendiri — belum ditulis.
