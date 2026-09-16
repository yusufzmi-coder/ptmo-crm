# Connect WhatsApp & webhook — guide Fasa 2

Status: **menunggu nombor pilot.** Dokumen ini ialah persediaan, bukan kebenaran
untuk menyambung. Sambungan sebenar hanya berlaku selepas Yusuf pilih nombor dan
Centre pilot, dan selepas keputusan dalam seksyen F diambil.

Skop: satu nombor baharu, satu Centre, dua staf. Bukan enam belas.

> **Baca `docs/fasa2-sambung-dari-sini.md` dahulu.** Fail itu memiliki
> *urutan* Fasa 2, dan dokumen ini hanya memiliki *cara*. Menyambung nombor
> ialah langkah 6 di sana — selepas Bahagian 0 UAT dan selepas `051`
> diapply. Dua daripada langkah sebelumnya hanya wujud sekali; menyambung
> lebih awal memusnahkan buktinya secara kekal.

Tiada token, PIN atau ID sebenar dalam fail ini. Semuanya placeholder.

---

## Perkara pertama: tiada kod perlu ditulis

Laluan sambungan sudah lengkap dalam repo. Yang tinggal hanyalah menaip nilai
yang betul pada tempat yang betul, mengikut urutan yang betul.

| Langkah | Kod yang sudah ada |
|---|---|
| Simpan credential + validasi PIN 6 digit | `src/app/api/whatsapp/config/route.ts:227` |
| Tolak nombor yang sudah dituntut akaun lain (409) | `config/route.ts:243` |
| Sahkan credential dengan Meta **sebelum** simpan | `config/route.ts:271` → `src/lib/whatsapp/meta-api.ts` |
| Enkrip token sebelum simpan | `config/route.ts:288` |
| Webhook verification (`hub.challenge`) | `src/app/api/whatsapp/webhook/route.ts:101` |
| Webhook inbound + semak signature | `webhook/route.ts:183` |
| Semak semula pendaftaran | `src/app/api/whatsapp/config/verify-registration/route.ts` |
| UI + guide dalam app (sudah ada BM) | `src/components/settings/whatsapp-config.tsx`, `messages/ms.json` → `Settings.whatsapp.step1`–`step4_5` |

Risiko Fasa 2 bukan kod. Ia **urutan** dan **tiga env var pada Vercel**.

---

## A. Prasyarat — mesti hijau sebelum mula

Empat baris ini pada Vercel (Production). Tiga daripadanya senyap bila salah —
tiada ralat merah, cuma WhatsApp nampak macam mati.

| Var | Nilai betul | Kalau salah |
|---|---|---|
| `META_APP_SECRET` | App Secret sebenar (Meta → App Settings → Basic) | **Setiap** mesej ibu bapa ditolak 401. Kod sengaja *fail closed* — `src/lib/whatsapp/webhook-signature.ts:26`. Nampak macam WhatsApp senyap, sebenarnya kita yang tolak. |
| `ENCRYPTION_KEY` | 64 aksara hex | Simpan credential gagal dengan mesej jelas (`config/route.ts:296`). Kalau ditukar kemudian, semua nombor kena simpan semula. |
| `NEXT_PUBLIC_SITE_URL` | `https://crm.ptmostaff.com` | Pautan jemputan/cron tersasar. Tidak menjejaskan webhook. |
| `WHATSAPP_TEMPLATES_DRY_RUN` | **Tiada**, atau `false` | Hanya `true` atau `1` yang mencetuskan dry-run (`templates/submit/route.ts:132`). Kalau aktif, template dapat ID rekaan `dry-run-<uuid>` dan tidak pernah sampai Meta — UI kata "menunggu kelulusan" selama-lamanya. |

> Nota pembetulan: board menulis var ini mesti **tiada langsung**. Kod sebenarnya
> menerima `false` dengan selamat. Membiarkannya tiada tetap paling bersih, tapi
> `false` bukan perangkap.

Callback URL: `https://crm.ptmostaff.com/api/whatsapp/webhook`

URL ini dijana dari `window.location.origin` (`whatsapp-config.tsx:162`). Maka:
**buka Settings dari domain live, bukan localhost**, sebelum tekan salin — kalau
tidak kau akan menampal `http://localhost:3000/...` ke dalam Meta.

---

## B. Semak eligibility nombor

Buat semakan ini **sebelum** beli atau komit nombor.

- [ ] Nombor **baharu**, belum pernah didaftarkan pada WhatsApp peribadi atau
      WhatsApp Business App. Kalau pernah, akaun lama mesti dipadam dahulu dari
      telefon itu dan tunggu ia betul-betul hilang.
- [ ] Boleh terima SMS **dan** panggilan suara untuk OTP. Sesetengah nombor
      korporat menyekat salah satu.
- [ ] Bukan nombor cawangan sedia ada. Keputusan board 12 Sep dan 14 Sep: 16
      handset cawangan **kekal di luar API**; pilot guna satu nombor Ops baharu.
- [ ] Display name akan melalui semakan Meta dan boleh mengambil masa. **Jangan
      jadualkan pilot pada hari yang sama** nombor didaftarkan.
- [ ] Faham had permulaan: nombor baharu bermula pada tier rendah, lebih kurang
      250 pelanggan unik / 24 jam. Panel kesihatan dalam Settings → WhatsApp
      menunjukkan `quality_rating`. **Kuning = perlahan. Merah = berhenti.**
      Rujuk `docs/plans/migrasi-satu-nombor.md`.

---

## C. Semak eligibility Meta

- [ ] Business Manager wujud dan verified.
- [ ] WABA (WhatsApp Business Account) wujud, dan nombor pilot dilekatkan padanya.
- [ ] Meta App jenis **Business**, dengan produk **WhatsApp** ditambah.
- [ ] **Two-step verification PIN 6 digit sudah diset di Meta WhatsApp Manager
      dahulu.** Ini selalu terlepas. Tanpanya pendaftaran inbound gagal, dan kita
      paparkan ralat Meta itu verbatim: *"Two-step verification PIN required. Set
      one in Meta WhatsApp Manager → Two-step verification."*
- [ ] `phone_number_id` dan `waba_id` diambil dari **WhatsApp → API Setup** dalam
      App Dashboard — jangan taip semula dari tempat lain.
- [ ] Permanent Access Token dijana dari **Business Settings → System Users**,
      bukan token sementara 24 jam yang dipaparkan pada halaman API Setup.

---

## D. Langkah sambung

App sudah ada guide empat langkah dalam BM (Settings → WhatsApp, `step1`–`step4_5`).
Yang di bawah ialah urutan PTMO yang betul, termasuk perkara yang guide generik
itu tidak tahu.

**1. Di Meta, dahulu.**
Set two-step PIN 6 digit. Salin `phone_number_id`, `waba_id`, dan jana Permanent
Access Token dari System Users.

**2. Buka `https://crm.ptmostaff.com` → Settings → WhatsApp.**
Bukan localhost. Lihat seksyen A.

**3. Isi borang.**
Phone Number ID · WhatsApp Business Account ID · Permanent Access Token ·
Webhook Verify Token (**kau reka sendiri**, apa-apa rentetan rawak panjang) ·
Two-step verification PIN.

**4. Tekan Simpan.**
Kod akan verify dengan Meta dahulu (`config/route.ts:271`). Kalau credential
salah, ia gagal di sini dan **tiada apa disimpan** — itu memang disengajakan.
Lulus verify → token dienkrip AES-256-GCM → register nombor → subscribe app ke
WABA, automatik.

**5. Salin Webhook Callback URL** dari panel yang sama.

**6. Kembali ke Meta → WhatsApp → Configuration → Edit pada bahagian Webhook.**
Tampal Callback URL. Masukkan **verify token yang sama** seperti langkah 3.
Tekan Verify and Save.

Di sini Meta hantar GET ke webhook kita. `webhook/route.ts:101` akan nyahsulit
verify token setiap config dan cari padanan; jumpa → jawab `hub.challenge`.
Kalau gagal: verify token tak sama, atau credential belum disimpan pada langkah 4.

**7. Langgan medan `messages`.** Tanpa ini webhook tersambung tapi kosong.

**8. Kembali ke CRM. Tekan *Uji Sambungan API*.**

**9. Tekan *Verify registration*.** Ini yang mengesahkan inbound benar-benar
berwayar, bukan sekadar token yang sah.

---

## E. Ujian asap

Bukan ujian penuh — itu tugas `chat-test` (Fasa 2 · T3). Ini sekadar bukti
sambungan hidup.

Ikut `docs/release-run-tomorrow.md` seksyen E:

> Tekan pautan `wa.me` satu cawangan dari telefon. Mesej sepatutnya tiba dengan
> kata kunci dalam pratonton inbox, dan kenalan sepatutnya bertag cawangan itu
> dalam beberapa saat.

Kalau mesej **tidak** sampai langsung, semak ikut urutan ini:

1. Meta → Webhooks → lihat status penghantaran. 401 di sana = `META_APP_SECRET`
   salah. Ini sebab nombor satu, dan ia kelihatan persis seperti WhatsApp senyap.
2. Medan `messages` belum dilanggan (langkah 7).
3. Log Vercel — cari `[webhook] rejected request with invalid signature`.

---

## F. Keputusan yang mesti diambil SEBELUM sambung

Ini bahagian penting dokumen ini. Setiap satu perlu jawapan Yusuf.

### F1 — Auto-reply Inggeris: bukan blocker automatik, tapi jangan tekan butang itu

Board dan `docs/open-findings.md:421` menulis ini menyekat Fasa 2. Semakan kod
menunjukkan gambaran lebih longgar, dan patut direkodkan:

- `src/lib/automations/templates.ts` ialah **galeri template**, bukan benih.
  Tiada migration memasukkan automation, dan `AUTOMATION_TEMPLATES` hanya dibaca
  oleh dua halaman UI (`automations/page.tsx`, `automations/new/page.tsx`).
  Maknanya: **tiada mesej Inggeris dihantar kepada sesiapa melainkan seseorang
  masuk ke Automations dan cipta satu dari template.**
- Butang *Sediakan untuk WhatsApp* (Settings → Centres) yang akan digunakan untuk
  pilot **tidak menghantar mesej langsung** — ia hanya `add_tag`
  (`src/components/settings/branch-link.ts:71`).

Jadi risiko sebenar: hari seseorang tekan "Welcome Message" dalam galeri, ibu bapa
terima *"Hi! 👋 Thanks for getting in touch. Our team will reply shortly."*

**Keputusan Yusuf:** luluskan salinan BM untuk empat template
(`welcome_message`, `out_of_office`, `lead_qualifier`, `follow_up_reminder`),
**atau** arahkan staf jangan sentuh galeri Automations semasa pilot. Pilihan kedua
percuma dan cukup untuk pilot dua staf.

### F2 — Quick replies: SELESAI, tiada keputusan diperlukan

Ditutup oleh `a834ba2` (16 Sep, sudah merge ke `main` melalui PR #65). Direkod di
sini kerana dokumen ini pada asalnya menyenaraikannya sebagai keputusan terbuka.

Sebelum ini `quick_replies.whatsapp_config_id` dibaca dan ditulis walaupun lajur
itu hanya wujud dalam `043_quick_replies_branch.sql:54`, yang tidak pernah
dijalankan. Kesannya lebih luas daripada yang board catatkan: bukan sahaja picker
dalam thread 500, malah **setiap** cipta quick reply 500 dari mana-mana skrin,
kerana `insert()` membawa lajur itu tanpa syarat.

Kelakuan sekarang:

- GET cuba tapis; kalau lajur tiada, ia jatuh ke senarai penuh dan memulangkan
  `branch_pinning: 'unavailable'`. Bukan jawapan terdegradasi — tanpa lajur itu
  tiada snippet yang dipin untuk disembunyikan.
- POST hanya membawa lajur itu bila ada pin sebenar. Kalau pin diminta pada DB
  tanpa 043, ia pulang **503** dengan sebab yang jelas — bukan 201 senyap yang
  menjadikan snippet satu cawangan terpakai seluruh akaun.
- `{{cawangan}}` tidak terjejas: ia guna `conversations.whatsapp_config_id` dari
  040, yang memang hidup.

Kesan untuk pilot: quick replies boleh digunakan sepenuhnya kecuali pin
per-cawangan — yang memang tidak diperlukan pada pilot satu nombor.

### F3 — Empat migration belum dijalankan

`042`, `043`, `044`, `048` — tiada pangkalan data pernah menjalankannya.

Untuk pilot **satu nombor**, kesannya terhad: 042 (conversation per-nombor) dan
048 (broadcast per-nombor) tidak penting bila hanya ada satu nombor. 044 (zone
switch) tidak diperlukan untuk satu Centre. 043 (quick reply per-cawangan) dahulu
mendesak, tapi kodnya sudah dipagar — lihat F2 — jadi ia tidak lagi menghalang.

Cadangan: tangguh kesemua empat sehingga selepas pilot stabil. Tiada satu pun
diperlukan untuk satu nombor dan satu Centre. Jurang ini melebar dengan setiap
migration baharu, tapi membukanya sebelum pilot menambah risiko tanpa menambah
nilai.

### F4 — UAT Fasa 1 belum selesai

Tugas `connect` secara rasmi bergantung pada `uat`. UAT berada pada 2/41 kerana
dua akaun ujian pada `crm.ptmostaff.com` belum wujud (blocker D1), dan seksyen
WhatsApp dalam UAT ditanda `TIDAK BOLEH DIUJI` sehingga nombor hidup —
`docs/uat-fasa1.md:377`.

Ini pusingan: UAT tunggu nombor, nombor tunggu UAT.

**Keputusan Yusuf:** beri laluan khusus untuk sambung sebelum UAT selesai (masuk
akal, kerana seksyen WhatsApp UAT memang tidak boleh berjalan tanpa nombor), atau
cipta dua akaun ujian dahulu dan habiskan 39 kes yang tersekat.

---

## Ringkasan: apa yang menghalang hari ini

| Halangan | Siapa putus |
|---|---|
| Nombor pilot + Centre belum dipilih | Yusuf |
| F4 — laluan UAT (D1: dua akaun ujian) | Yusuf |
| Tiga env var Vercel disahkan | Yusuf |
| F1 — salinan BM auto-reply | Yusuf (boleh ditangguh dengan arahan staf) |

F2 sudah ditutup, F3 boleh ditangguh. Selepas empat baris di atas bersih,
sambungan itu sendiri ialah kerja lima belas minit mengikut seksyen D.
