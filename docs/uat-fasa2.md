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

Diukur 17 Sep pada `crm.ptmostaff.com`: `/calls` **404**, `/api/calls`
**404**. Itu bukan gate auth yang gagal — ia jurang deploy. PR #66 belum
dimerge, jadi `main` tiada laluan itu langsung. 404 ialah bacaan yang
betul untuk keadaan sekarang, dan ia bukti berguna: ia mengukur jarak
antara branch dan yang disajikan.

Semakan kod (bukan pengganti untuk mengujinya hidup): `/calls` ada dalam
`protectedPaths` dalam `src/middleware.ts`, `GET /api/calls` dipagar
`requireUser()`, `POST` dipagar `requireRole('agent')`.

| # | Kes | Jangkaan selepas deploy | Status |
|---|---|---|---|
| 0.4 | `GET /calls` tanpa sesi | 307 → `/login` | **404 — belum di-deploy** |
| 0.5 | `GET /api/calls` tanpa sesi | 401, bukan senarai kosong | **404 — belum di-deploy** |
| 0.6 | Sidebar memaparkan **Panggilan**, domain menyajikan `lang="ms"` | | **belum di-deploy** |
| 0.7 | `GET /calls` dengan sesi, **sebelum** 051 diapply | Halaman memuat dan berkata rekod panggilan belum tersedia; butang rekod dimati. **Bukan 500** | |
| 0.8 | `POST /api/calls` dengan sesi, **sebelum** 051 diapply | 503 `table_missing`. **Bukan 201** — panggilan yang dikatakan tersimpan sedangkan tiada jadual menerimanya hilang dua kali | |

## Bahagian 1 — sambung nombor

| # | Kes | Jangkaan | Status |
|---|---|---|---|
| 1.1 | Settings → WhatsApp: simpan phone number id, WABA id, access token, verify token, PIN | Disimpan; token disulitkan, tidak pernah dipaparkan semula | |
| 1.2 | Butang **Verify with Meta** | `registered_at` dan `subscribed_apps_at` diisi. Kalau tidak, inbound **hilang senyap** — ini pepijat yang mencetuskan kerja multi-number | |
| 1.3 | Test API Connection | `connected: true` dengan `phone_info` sebenar (nama disahkan, rating kualiti) | |
| 1.4 | Baris nombor memaparkan pemilih **Centre** | Pilih Centre pilot; muat semula halaman — pilihan kekal | |
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
| 3.2 | Buka pemilih quick reply dari thread | Senarai muncul — **bukan 500**. Ini kes yang memecah sebelum pagar 043 | |
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
| 4.5 | Buka URL media **tanpa sesi** | 401, `cache-control: no-store` (047). Sudah LULUS 16 Sep pada Fasa 1 — ulang selepas media sebenar wujud | |
| 4.6 | Staf akaun lain cuba URL media yang sama | Ditolak | |

## Bahagian 5 — call log

| # | Kes | Jangkaan | Status |
|---|---|---|---|
| 5.1 | `/calls` → **Rekod panggilan**, isi arah, hasil, masa, ringkasan | Disimpan; muncul di puncak senarai serta-merta | |
| 5.2 | Simpan tanpa ringkasan | Ditolak dengan sebab. Ringkasan ialah satu-satunya medan yang membawa handover | |
| 5.3 | Tempoh ditaip `abc` | Ditolak — **bukan** disimpan sebagai "tiada tempoh" | |
| 5.4 | Hasil **Tidak dijawab** dipilih | Medan *call balik* muncul | |
| 5.5 | Pilih **Tidak dijawab**, isi masa call balik, tukar kepada **Dijawab** | Masa call balik dikosongkan — tiada janji yang tiada siapa berniat tunaikan | |
| 5.6 | Tapis **Perlu call balik** | Hanya panggilan dengan `follow_up_at` | |
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
