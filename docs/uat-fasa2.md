# UAT Fasa 2 — WhatsApp Pilot

Senarai semak penerimaan untuk pilot **satu Centre, satu nombor, dua staf**:
sambung nombor, terima mesej, balas, hantar dan terima media, dan rekod
panggilan telefon.

Ia bukan ringkasan runbook. Dokumen ini memiliki satu perkara sahaja:
**bukti bahawa ia berfungsi untuk staf sebenar selepas ia mendarat.**

| | |
|---|---|
| Sasaran | `crm.ptmostaff.com` |
| Skema selepas apply | baseline Fasa 1 (041 + 045 + 046 + 047 + 049 + 050) **+ 051** |
| Migration baharu | `051_call_logs.sql` — satu sahaja |
| Masih diparkir | `042`, `043`, `044`, `048` — tiada pangkalan data pernah menjalankannya |
| Penguji | Coordinator + dua staf pilot |
| Tarikh | — |

Tanda: `LULUS` · `GAGAL` · `TIDAK DIUJI` · `TIDAK BOLEH DIUJI`
Setiap `GAGAL` mesti bawa: langkah ulang, screenshot, masa, akaun yang guna.

---

## Prasyarat

Lapan daripada sembilan bahagian di bawah **tidak boleh diuji langsung**
sebelum nombor disambung. Itu bukan alasan untuk menangguh dokumen ini —
ia sebab untuk menamakan dengan tepat apa yang tersekat pada apa.

| # | Prasyarat | Pemilik | Status |
|---|---|---|---|
| P1 | Nombor WhatsApp pilot disambung pada Meta. Callback `https://crm.ptmostaff.com/api/whatsapp/webhook`, verify token yang Yusuf reka, PIN 6-digit | Yusuf | [ ] **menghalang 8 daripada 9 bahagian** |
| P2 | `META_APP_SECRET` pada Vercel ialah App Secret sebenar. Tanpanya **setiap** mesej ibu bapa ditolak oleh semakan tandatangan — gagal tertutup, betul, tetapi kelihatan seperti WhatsApp senyap | Yusuf | [ ] |
| P3 | `WHATSAPP_TEMPLATES_DRY_RUN` **tiada** pada Vercel. Kalau `true`, templat dapat ID rekaan dan tidak pernah sampai ke Meta — UI kata "menunggu kelulusan" selama-lamanya | Yusuf | [ ] |
| P4 | Dua akaun ujian pada `crm.ptmostaff.com` — satu admin, satu agent | Yusuf | [ ] **halangan yang sama seperti UAT Fasa 1** |
| P5 | `051_call_logs.sql` diapply pada production | Yusuf + Coordinator | [ ] |
| P6 | Satu Centre pilot wujud dalam Settings → Centre & Zone, dengan `code` | Coordinator | [ ] |

Nota P5: 051 disahkan secara tempatan atas baseline dengan
`042/043/044/048` **dibuang** — arah itu sahaja yang menunjukkan
kebergantungan yang akan lulus CI dan pecah production. Diapply dua kali;
kali kedua tiada kesan.

---

## Urutan — dua tingkap, dan satu tutup lebih awal

Dokumen ini pernah mencadangkan "merge dahulu". Itu salah, dan ia akan
memusnahkan sesuatu yang tidak boleh dijadualkan semula.

Ada **dua** tingkap yang hanya wujud sekali, dan ia tutup pada peristiwa
berbeza:

| Tingkap | Tutup bila | Mengesahkan | Di mana |
|---|---|---|---|
| Bahagian 0 **`uat-fasa1.md`** | **merge #66** | kerosakan `043`/`048` benar-benar **wujud** | dokumen Fasa 1 |
| Bahagian 0.7 / 0.8 di bawah | **apply 051** | pagar jadual-hilang benar-benar **berfungsi** | dokumen ini |

Yang Fasa 1 tutup dahulu. Empat kerosakan `043`/`048` dijumpai secara
statik — dari ledger migration dan kod, bukan daripada satu permintaan
yang benar-benar gagal — dan ia masih hidup pada `crm.ptmostaff.com`
sekarang kerana pembetulannya duduk pada branch ini. Detik #66 mendarat,
ia hilang, dan bersamanya satu-satunya peluang mengesahkan diagnosis itu
terhadap mesin sebenar. Pagar yang tidak diperlukan cuma kod berlebihan;
kerosakan yang tidak pernah wujud bermakna empat pembetulan menyelesaikan
masalah yang direka.

**Urutan:**

```
1. jalankan Bahagian 0 uat-fasa1.md   <- hanya SEBELUM merge
2. merge #66
3. sahkan 0.4 / 0.5 / 0.6 di bawah
4. jalankan 0.7 / 0.8                 <- hanya SEBELUM apply 051
5. apply 051
6. Bahagian 1-6
```

Langkah 1 dan langkah 4 kedua-duanya perlukan akaun ujian (P4). Jadi
susunan **dua sekatan Yusuf** itu sendiri penting: kalau kelayakan
diberi sebelum sekatan merge dibuka, kedua-dua tingkap dapat. Kalau
merge dibuka dahulu, tingkap Fasa 1 hilang dan keempat-empat kesnya
ditandakan TIDAK BOLEH DIUJI — bukan diteka sebagai lulus.

---

## Bahagian 0 — yang boleh diuji tanpa kelayakan

Dua kumpulan, dan perbezaannya penting. 0.1–0.3 menguji webhook yang
**sudah** hidup pada production sejak Fasa 1; jalankan sekarang.
0.4–0.6 menguji kod Fasa 2 yang **belum di-deploy**; ia tidak boleh
dijalankan lagi, dan menandakannya GAGAL adalah salah baca.

### Sudah boleh dijalankan

| # | Kes | Jangkaan | Status |
|---|---|---|---|
| 0.1 | `GET /api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=salah&hub.challenge=123` | 403. Token salah tidak boleh melepasi | |
| 0.2 | `GET` yang sama tanpa sebarang parameter | 400 atau 403 — bukan 200, dan bukan 500 | |
| 0.3 | `POST /api/whatsapp/webhook` dengan badan sah tetapi **tanpa** header `x-hub-signature-256` | Ditolak. Ini yang menghalang sesiapa sahaja daripada menyuntik mesej ke dalam inbox | |

### Disekat pada deploy, bukan pada kelayakan

**Diselesaikan 17 Sep.** PR #66 dimerge (`049352c`) dan Vercel deploy
mendarat, jadi 0.4 dan 0.5 kini **LULUS pada domain hidup** — bukan
dibaca dari `middleware.ts`, tetapi diukur dengan `curl` terhadap
`crm.ptmostaff.com`.

Bacaan `404` sebelum itu dikekalkan dalam sejarah fail ini kerana ia
mengukur jurang deploy, bukan gate auth, dan menandakannya GAGAL akan
merekod gate yang berfungsi sebagai rosak.

Semakan kod (bukan pengganti untuk mengujinya hidup): `/calls` ada dalam
`protectedPaths` dalam `src/middleware.ts`, `GET /api/calls` dipagar
`requireUser()`, `POST` dipagar `requireRole('agent')`.

| # | Kes | Jangkaan selepas deploy | Status |
|---|---|---|---|
| 0.4 | `GET /calls` tanpa sesi | 307 → `/login` | **LULUS 17 Sep** — `307`, `location: https://crm.ptmostaff.com/login`, sama persis dengan `/issues` |
| 0.5 | `GET /api/calls` tanpa sesi | 401, bukan senarai kosong | **LULUS 17 Sep** — `401 {"error":"unauthorized"}`. Bukan senarai kosong, bukan 500 |
| 0.6 | Sidebar memaparkan **Panggilan**, domain menyajikan `lang="ms"` | | perlukan sesi |
| 0.7 | `GET /calls` dengan sesi, **sebelum** 051 diapply | Halaman memuat dan berkata rekod panggilan belum tersedia; butang rekod dimati. **Bukan 500** | |
| 0.8 | `POST /api/calls` dengan sesi, **sebelum** 051 diapply | 503 `table_missing`. **Bukan 201** — panggilan yang dikatakan tersimpan sedangkan tiada jadual menerimanya hilang dua kali | |

## Prasyarat data — kes yang boleh lulus atas sebab salah

Empat kes di bawah menghasilkan keputusan hijau apabila keadaan yang
sepatutnya diuji **tidak pernah dicapai**. Itu lebih buruk daripada
gagal: gagal menyuruh seseorang siasat, manakala lulus palsu menutup
kes itu selama-lamanya.

Semak lajur kanan **sebelum** menandakan mana-mana daripada empat ini.

| Kes | Perlu wujud dahulu | Kalau tidak, ia lulus kerana |
|---|---|---|
| 1.4 pemilih Centre | Sekurang-kurangnya satu Centre aktif dalam Settings → Centre & Zone | Pemilih **sengaja disembunyikan** bila tiada Centre. Ketiadaannya akan terbaca sebagai pepijat, dan kehadirannya tak pernah diuji |
| 3.2 picker quick reply | Satu conversation sebenar, dan picker dibuka **dari dalam thread** | Tanpa thread, permintaan tak bawa `conversationId` dan yang diuji ialah senarai akaun biasa — satu-satunya laluan yang memang tak pernah rosak |
| 5.6 tapis call balik | Sekurang-kurangnya satu panggilan **dengan** `follow_up_at` dan satu **tanpa** | Penapis atas senarai yang semuanya sepadan, atau semuanya tidak, tak membezakan apa-apa |
| 4.5 media tanpa sesi | Satu fail media sebenar yang sudah masuk melalui thread | URL yang tak menunjuk apa-apa juga pulang bukan-200, atas sebab yang sama sekali berbeza |

Kes 3.2 khususnya: kedua-dua cabang laluan lama menamakan lajur 043 —
`.or(...)` bila cawangan diketahui, `.is('whatsapp_config_id', null)`
bila tidak. Jadi "thread tak resolve" **bukan** penjelasan untuk kes
lulus. Kalau ia lulus, ia bermaksud tepat satu daripada dua perkara:
permintaan tak pernah bawa `conversationId`, atau diagnosis asal salah.
Asingkan kedua-duanya sebelum menulis keputusan.

---

## Bahagian 1 — sambung nombor

| # | Kes | Jangkaan | Status |
|---|---|---|---|
| 1.1 | Settings → WhatsApp: simpan phone number id, WABA id, access token, verify token, PIN | Disimpan; token disulitkan, tidak pernah dipaparkan semula | |
| 1.2 | Butang **Verify with Meta** | `registered_at` dan `subscribed_apps_at` diisi. Kalau tidak, inbound **hilang senyap** — ini pepijat yang mencetuskan kerja multi-number | |
| 1.3 | Test API Connection | `connected: true` dengan `phone_info` sebenar (nama disahkan, rating kualiti) | |
| 1.4 | Baris nombor memaparkan pemilih **Centre** | Pilih Centre pilot; muat semula halaman — pilihan kekal. **Perlu satu Centre aktif** — lihat prasyarat data. | |
| 1.5 | Viewer membuka Settings → WhatsApp | Tiada pemilih Centre, tiada simpan. RLS 017 hadkan tulis kepada admin | |

## Bahagian 2 — inbound

| # | Kes | Jangkaan | Status |
|---|---|---|---|
| 2.1 | Ibu bapa hantar teks ke nombor pilot | Muncul dalam Inbox dalam beberapa saat, kontak dicipta, thread pada nombor betul | |
| 2.2 | Ibu bapa yang sama hantar sekali lagi | Thread **sama**, bukan kontak kedua (dedupe 036) | |
| 2.3 | Ibu bapa hantar pautan `wa.me` cawangan dengan keyword Centre | Thread ditag dengan Centre itu melalui automation keyword | |
| 2.4 | Tutup thread, ibu bapa hantar lagi | Thread dibuka semula, bukan thread baharu | |
| 2.5 | Mesej masuk semasa dua staf membuka inbox | Kedua-dua skrin dikemas kini tanpa muat semula (realtime) | |

## Bahagian 3 — balas

| # | Kes | Jangkaan | Status |
|---|---|---|---|
| 3.1 | Balas dari thread | Sampai ke telefon ibu bapa **dari nombor yang sama** yang mereka hubungi | |
| 3.2 | Buka pemilih quick reply dari thread | Senarai muncul — **bukan 500**. Ini kes yang memecah sebelum pagar 043. **Perlu satu conversation sebenar** — lihat prasyarat data. | |
| 3.3 | Cipta quick reply dalam Settings | Disimpan — **bukan 500** | |
| 3.4 | Quick reply mengandungi `{{cawangan}}` | Dikembangkan kepada nama cawangan thread | |
| 3.5 | Balas selepas 24 jam tanpa templat | Ditolak dengan sebab yang boleh dibaca, bukan kegagalan senyap | |

## Bahagian 4 — media

| # | Kes | Jangkaan | Status |
|---|---|---|---|
| 4.1 | Ibu bapa hantar gambar | Dipaparkan dalam thread; fail dicerminkan ke storage (039) | |
| 4.2 | Ibu bapa hantar dokumen (PDF resit yuran) | Boleh dimuat turun dengan nama fail asal | |
| 4.3 | Ibu bapa hantar audio / nota suara | Boleh dimainkan | |
| 4.4 | Staf hantar gambar keluar | Sampai ke telefon ibu bapa | |
| 4.5 | Buka URL media **tanpa sesi** | 401, `cache-control: no-store` (047). Sudah LULUS 16 Sep pada Fasa 1 — ulang selepas media sebenar wujud. **Perlu media sebenar** — lihat prasyarat data. | |
| 4.6 | Staf akaun lain cuba URL media yang sama | Ditolak | |

## Bahagian 5 — call log

| # | Kes | Jangkaan | Status |
|---|---|---|---|
| 5.1 | `/calls` → **Rekod panggilan**, isi arah, hasil, masa, ringkasan | Disimpan; muncul di puncak senarai serta-merta | |
| 5.2 | Simpan tanpa ringkasan | Ditolak dengan sebab. Ringkasan ialah satu-satunya medan yang membawa handover | |
| 5.3 | Tempoh ditaip `abc` | Ditolak — **bukan** disimpan sebagai "tiada tempoh" | |
| 5.4 | Hasil **Tidak dijawab** dipilih | Medan *call balik* muncul | |
| 5.5 | Pilih **Tidak dijawab**, isi masa call balik, tukar kepada **Dijawab** | Masa call balik dikosongkan — tiada janji yang tiada siapa berniat tunaikan | |
| 5.6 | Tapis **Perlu call balik** | Hanya panggilan dengan `follow_up_at`. **Perlu satu panggilan dengan dan satu tanpa `follow_up_at`** — lihat prasyarat data. | |
| 5.7 | Akaun viewer cuba merekod panggilan | Ditolak (RLS `agent`) | |
| 5.8 | Staf A merekod, staf B muat `/calls` | Staf B nampak baris itu, dengan nama staf A | |

## Bahagian 6 — dua staf, satu nombor

| # | Kes | Jangkaan | Status |
|---|---|---|---|
| 6.1 | Kedua-dua staf membuka thread sama | Kedua-duanya nampak penunjuk co-viewer (041/045) | |
| 6.2 | Staf A balas semasa staf B menaip | Mesej staf A muncul pada skrin staf B | |
| 6.3 | Staf A tutup thread | Ia hilang dari paparan terbuka staf B | |

## Bahagian 7 — yang sengaja TIDAK diuji

Menamakannya supaya tiada siapa menganggap ia diliputi.

| Perkara | Sebab |
|---|---|
| WhatsApp Calling API | Pilot berasingan, selepas chat stabil. Fasa 2 merekod panggilan **manual** sahaja |
| Broadcast per-cawangan | `broadcast-core.ts` menghantar `p_whatsapp_config_id`, yang hanya wujud dalam `048` — diparkir. Broadcast mesti diuji **sebelum** ia digunakan pada pilot |
| Quick reply per-cawangan | Dipagar dengan 043. Satu nombor, jadi tiada apa untuk dibezakan |
| Eskalasi Zone Head | Perlukan `044` |
| 16 nombor | Keputusan 14 Sep: pilot kekal satu nombor |

## Bahagian 8 — rollback

| # | Kes | Jangkaan | Status |
|---|---|---|---|
| 8.1 | Putuskan nombor pilot dari Settings | Inbound berhenti; tiada thread hilang | |
| 8.2 | `DROP TABLE call_logs` pada salinan | Tiada apa lagi yang pecah — tiada FK menunjuk kepadanya | |
