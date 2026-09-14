# Release 045 · 046 · 047 — apa yang Boss jalankan

Satu dokumen, satu urutan. Semua yang lain sudah siap dan di `main`.

**Tiga perkara hanya boleh dilakukan oleh Boss**, kerana sesi ini tiada
kelayakan untuk melakukannya: tiada kata laluan pangkalan data, `psql`
tiada pada PATH, Vercel CLI tidak log masuk, dan
`SUPABASE_SERVICE_ROLE_KEY` memegang kunci *publishable* dan bukan JWT —
jadi ia tidak boleh mengapply apa-apa.

Ini bukan pilihan berhati-hati. Ia had keupayaan, dinyatakan supaya tiada
siapa menunggu sesi ini melakukannya.

---

## A. Dua saklar, 2 minit, boleh dibuat sekarang

### A1 — GitHub Actions

`Settings → Actions → General`. Merge ke `main` tidak mencetuskan
apa-apa; setiap larian setakat ini dicetuskan dengan tangan melalui
`workflow_dispatch`. Pencetus dalam fail betul, fail hadir pada `main`,
dan API kebenaran berkata Actions **didayakan** — jadi saklarnya bukan
di tempat yang boleh dibaca melalui API.

Repo ini **fork**. Itu petunjuk terkuat yang ada.

### A2 — Locale Vercel

`Project → Settings → Environment Variables`:

```
NEXT_PUBLIC_APP_LOCALE = ms
```

Kemudian **redeploy**. `NEXT_PUBLIC_*` dibakar pada masa **build**, jadi
menetapkannya sahaja tidak mengubah apa-apa sehingga build seterusnya.

Katalog `ms` lengkap — 1905 kunci, pariti bersih merentas tiga locale.
Domain masih menyajikan Inggeris semata-mata kerana pembolehubah ini.

Nilai yang salah kini **memberi amaran dalam log build** dan jatuh ke
`en` dengan nyata. Sebelum ini `try/catch` menyajikan `en.json` secara
senyap, dan `.env.local` tempatan memegang `"en "` — dengan ruang di
hujung — sejak 10 Sep. Fail tempatan itu sudah dibetulkan kepada `ms`.

---

## B. Preflight — READ ONLY, selamat bila-bila masa

Setiap pernyataan ialah `SELECT`. Ia tidak mencipta apa-apa dan tidak
mengubah apa-apa. Boleh dijalankan waktu kerja.

Buka **Supabase SQL Editor**, tampal fail, dan **pilih satu seksyen
pada satu masa** sebelum tekan Run — SQL Editor hanya menunjukkan
keputusan pernyataan **terakhir** dalam tampalan berbilang.

### B1 — `supabase/preflight/release-preflight-accounts.sql`

Baca **seksyen 1, 2, 9, 10** sahaja. Seksyen 3–8 mengawal 044, 042 dan
048, yang kesemuanya **tidak dalam release ini**; setiap satu berlabel
sedemikian dalam fail.

| Seksyen | Jangkaan | Kalau berbeza |
|---|---|---|
| **1** | `044 not applied` = **t**, `049 IS applied` = **t**, `040`/`041 applied` = **t** | **BERHENTI.** Baseline bukan apa yang pelan andaikan |
| **2** | taburan peranan kelihatan munasabah | tiada tindakan, konteks sahaja |
| **9** | **tepat satu baris setiap nama fungsi** | **BERHENTI** — lihat di bawah |
| **10** | siapa boleh tulis `profiles` hari ini | rekod sebelum, banding selepas |

**Seksyen 9 ialah satu-satunya yang boleh menghentikan release ini.**

046 `REVOKE` mengikut **tanda tangan tepat**. Tanda tangan yang tidak
sepadan dengan apa-apa **tidak** menyelinap lalu — Postgres membangkitkan
ralat dan migration gugur. Bahaya sebenar ialah bentuk bertentangan:
**overload tambahan** yang berkongsi nama. REVOKE menamakan satu tanda
tangan, berjaya, melaporkan sukses — dan overload kekal boleh dipanggil
oleh `anon` dengan keistimewaan definer.

Jadi kalau mana-mana nama menunjukkan `overloads = 2` atau lebih, berhenti
dan tanya. CI kini juga menegaskan keadaan akhir ini setiap larian.

### B2 — `supabase/preflight/release-preflight-storage.sql`

Seksyen **1** dan **4** kedua-duanya BLOCKER.

| Seksyen | Jangkaan |
|---|---|
| **1** | senarai setiap bucket dan sama ada ia awam — ini yang 047 akan tutup |
| **4** | lampiran yang 047 akan pecahkan; **kesemuanya** mesti dilindungi oleh laluan proksi |
| 5, 5b | hos sebenar dalam URL tersimpan — sahkan tiada hos asing |

---

## C. Apply — urutan wajib

```
1.  045   presence per tab              additive
2.  046   REVOKE empat fungsi definer   keselamatan
3.  ——    kod sudah di-deploy           crm.ptmostaff.com hidup dengan main
4.  047   bucket storan jadi peribadi   keselamatan
```

### Kenapa 047 mesti terakhir

047 menjadikan tiga bucket **peribadi**. Saat ia mendarat, setiap URL
lampiran tersimpan berhenti berfungsi — ia URL bucket awam **mutlak**.

Yang menampungnya ialah `resolveStoredMediaUrl()` dalam
`src/lib/media/proxy-url.ts`, yang memetakan URL lama ke proksi media
pada masa render. Kod itu **sudah hidup** pada domain. Jadi 047 selamat
sekarang, dan hanya sekarang.

Backfill SQL yang akan menulis semula URL itu **ditarik balik** daripada
release: pangkalan data tidak boleh membezakan hos storan kita daripada
mana-mana `*.supabase.co`, jadi baris yang memegang URL projek lain akan
ditulis semula menunjuk ke bucket **kita**. Laluan TypeScript menyemak
hos terhadap `NEXT_PUBLIC_SUPABASE_URL` dahulu dan menolak selebihnya.

Akibatnya sengaja dan patut dinyatakan terus: selepas release, nilai
tersimpan kekal URL mati, dan **aplikasi yang menjadikannya berfungsi**.
Apa-apa yang membaca `messages.media_url` tanpa melalui
`resolveStoredMediaUrl()` akan melihat pautan yang 400.

### Selepas setiap satu

Jalankan semula preflight seksyen 10 (siapa boleh tulis `profiles`) dan
bandingkan dengan bacaan sebelum. 046 sepatutnya menyempitkannya kepada
dua lajur.

---

## D. Apa yang TIDAK diapply, dan kenapa ia penting

`042`, `043`, `044`, `048` ada dalam repo ini dan **tiada pangkalan data
pernah menjalankannya**. Job CI memarkirnya secara eksplisit.

Jurang itu **melebar** saat seseorang menulis `050`. Itu keputusan untuk
dibuat sebelum migration seterusnya ditulis, bukan fakta untuk diterima —
dan ia sebab tab Isu/Tindakan diparkir dan bukan dibina hari ini.

`049` **sudah** diapply, dengan tangan, dan ledger merekodnya salah
sehingga probe baca-sahaja menyelesaikannya pada 14 Sep.

---

## E. Selepas release — WhatsApp

Ini bahagian Boss yang sebenar, dan segala di atas wujud untuk
membolehkannya.

Yang sudah dibina dan menunggu nombor:

| Ada | Di mana |
|---|---|
| Panel kesihatan nombor — `quality_rating` Hijau/Kuning/Merah | Settings → WhatsApp |
| `centres.code` boleh disunting | Settings → Centres |
| Link `wa.me` per cawangan + QR untuk bahan bercetak | Settings → Centres |
| Butang *Sediakan untuk WhatsApp* — cipta tag + automasi `keyword_match`, idempoten | Settings → Centres |
| Runbook migrasi 16 handset → satu nombor | `docs/plans/migrasi-satu-nombor.md` |

Selepas nombor bersambung, ujian sebenar ialah: tekan link satu cawangan
dari telefon. Mesej sepatutnya tiba dengan kata kunci dalam pratonton
inbox, dan kenalan sepatutnya bertag cawangan itu dalam beberapa saat.
