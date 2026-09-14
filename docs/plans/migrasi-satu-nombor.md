# Runbook — migrasi 16 handset WhatsApp ke satu nombor CRM

Ditulis 14 Sep 2026. Dokumen **operasi**, bukan kod.

---

## Bentuk masalah

PTMO menjawab ibu bapa melalui 16 handset cawangan hari ini. CRM akan
menjawab pada **satu** nombor. Peralihan itu mencipta satu masalah baharu:

> Bila semua ibu bapa mesej masuk pada satu nombor, CRM hanya tahu
> **nombor telefon**. Tiada cawangan. Tiada anak.

WhatsApp tidak memberi apa-apa lagi. Tiada "auto-detect" dalam erti kata
WhatsApp memberitahu kita — ia tidak wujud, dan mana-mana rancangan yang
menganggapnya wujud akan gagal.

Tetapi maklumat itu **sudah ada pada PTMO**, cuma bukan dalam CRM.

---

## Pintu migrasi

Setiap cawangan menghantar **linknya sendiri** ke group WhatsApp sedia ada:

```
https://wa.me/<nombor CRM>?text=<kod cawangan>
```

Ibu bapa menekan. Mesej pertama tiba **berlabel cawangan**.

Kenapa ini yang dipilih berbanding bertanya atau meneka:

- **Ibu bapa tidak menaip dan tidak memilih.** Link yang menentukan.
  Benda yang tidak dipilih manusia tidak boleh dipilih salah.
- **Ibu bapa yang memulakan** perbualan membuka tetingkap 24 jam, jadi
  balasan bebas dibenarkan — tiada template Meta diperlukan.
- **Tiada blast kepada nombor sejuk**, jadi tiada risiko rating jatuh
  sebelum nombor sempat membina reputasi.

---

## Langkah 0 — import dahulu, sebelum satu mesej pun dihantar

**Ini mendahului segala-galanya, dan melangkaunya mahal.**

Setiap cawangan sudah ada nombor ibu bapa dalam handsetnya. Export jadi
CSV dan import melalui Contacts:

```
phone,name,tags
60123456789,Puan Siti,Rawang
60198765432,Encik Ahmad,Batu Caves
```

Lajur `tags` diterima oleh import sedia ada
(`src/lib/contacts/parse-contact-csv.ts`). Tag = nama cawangan.

Kenapa ini dahulu: **ibu bapa yang membalas terus tanpa menekan link
tidak akan bertag.** Kalau senarai sudah diimport, mereka sudah bertag
sebelum mesej pertama tiba. Import menutup semua orang yang kau sudah
ada; link menutup orang yang kau tiada.

Guna **tag**, bukan `contacts.centre_id`. Lajur itu wujud tetapi tiada
penulis dalam aplikasi. Tag berfungsi hari ini, boleh ditapis dalam
inbox, dan boleh dipindahkan ke `centre_id` kemudian dengan satu skrip.

---

## Langkah 1 — sediakan cawangan dalam CRM

Untuk setiap cawangan, dalam Settings → Centres & zones:

1. Isi **kod** cawangan — pendek, satu perkataan, tiada ruang. Ini kata
   kunci link dan ia akan dicetak pada poster.
2. Tekan **"Sediakan untuk WhatsApp"** — ia mencipta tag dan automasi
   auto-tag. Selamat ditekan dua kali.
3. Salin link, atau muat turun QR untuk bahan bercetak.

---

## Langkah 2 — gelombang pertama: SATU cawangan

Bukan dua. Bukan lima. Satu.

Pilih cawangan yang paling mungkin bertolak ansur kalau ada yang tidak
kena — biasanya yang terdekat, atau yang penyelianya boleh dihubungi
terus.

Hantar pengumuman melalui **handset cawangan itu sendiri**, ke group
sedia ada. Bukan melalui CRM.

### Template pengumuman

```
Assalamualaikum dan salam sejahtera.

Mulai sekarang, semua pertanyaan untuk [CAWANGAN] boleh terus ke
nombor rasmi kami:

[LINK]

Tekan link di atas untuk mula. Simpan nombor ini supaya mudah
dihubungi kemudian.

Nombor lama masih aktif buat sementara waktu.
```

Nada **perkhidmatan**, bukan promosi. Jangan campur tawaran, diskaun
atau pendaftaran dalam mesej yang sama.

Ayat terakhir itu penting: ia menghilangkan rasa terdesak. Ibu bapa yang
tidak rasa dipaksa tidak block.

---

## Langkah 3 — perhatikan seminggu

| Apa | Di mana | Bermakna |
| --- | --- | --- |
| `quality_rating` | Settings → WhatsApp | **Kuning = perlahankan. Merah = berhenti.** |
| Mesej masuk | Inbox | ibu bapa memang berpindah? |
| Bertag lawan tidak | tapis inbox ikut tag | berapa menekan link vs mesej terus |
| Gagal hantar | butiran broadcast | kalau kau sempat hantar apa-apa |

`quality_rating` ialah isyarat **awal**. Meta menurunkannya berdasarkan
kadar Block dan Report dalam tetingkap bergerak. Bila ia jatuh, had
mesej dipotong dan nombor boleh masuk status *Flagged* selama 7 hari.

Nombor baharu bermula pada tier rendah — lazimnya **250 pelanggan unik
per 24 jam**. Kau naik tier automatik dengan menghantar lebih banyak
**sambil kekal berkualiti**. Melawan had itu pada minggu pertama ialah
cara paling cepat untuk jatuh.

---

## Langkah 4 — gelombang seterusnya ikut keputusan, bukan jadual

Kalau gelombang 1 bersih: tambah dua cawangan. Kemudian empat. Jangan
lompat ke enam belas kerana tiga yang pertama berjalan lancar.

Kalau rating jatuh ke Kuning pada bila-bila masa: **berhenti menambah
cawangan** sehingga ia pulih ke Hijau. Rating pulih dengan masa dan
perbualan yang sihat, bukan dengan menghantar lebih banyak.

---

## Langkah 5 — bila matikan handset lama

Hanya selepas cawangan itu **stabil** pada nombor baharu. Tanda stabil:
majoriti perbualan aktif cawangan itu sudah berlaku dalam CRM, dan
handset lama sunyi selama beberapa hari.

**Jangan matikan serentak.** Biarkan bertindih. Handset lama yang masih
hidup ialah jaring keselamatan kalau ada yang tidak kena dengan CRM —
dan ia juga saluran untuk menghantar peringatan kepada yang belum
berpindah.

Matikan satu, perhatikan, baru yang seterusnya.

---

## Tentang broadcast — baca sebelum tergoda

Blast melalui CRM **memerlukan template yang diluluskan Meta**. Kau tidak
boleh menaip mesej dan menekan hantar; kod mewajibkan `template_name` dan
`template_language`, dan status template dijejak (Pending → Approved).

Dan blast kepada nombor sejuk ialah cara paling biasa untuk kehilangan
nombor. Migrasi ini **sengaja mengelaknya** dengan menggunakan group
sedia ada sebagai saluran pengumuman.

Bila kau memang mahu broadcast nanti:

1. **Audience pertama = orang yang sudah mesej kau.** Mereka tidak akan
   block.
2. **Satu cawangan dahulu**, tapis ikut tag.
3. **Kategori UTILITY**, bukan MARKETING, kalau mesej itu memang notis
   perkhidmatan. CRM tidak menjejak kategori template — semak sendiri
   dalam Meta Business Manager.
4. **Beri jalan keluar** — satu baris "Balas BERHENTI untuk tidak
   menerima notis ini". Orang yang senang berhenti akan berhenti. Orang
   yang tidak boleh berhenti akan **block**, dan block yang membunuh
   nombor.

---

## Yang runbook ini tidak selesaikan

**Pelajar.** Nombor WhatsApp mengenal **ibu bapa**, bukan anak. Satu ibu
boleh ada tiga anak, mungkin di cawangan berbeza. Tiada apa dalam mesej
yang memberitahu yang mana satu.

Sehingga School Management System siap: **cawangan boleh diketahui dengan
yakin, pelajar tidak.** Catat bila staf mengetahuinya — jangan bina
tekaan. Data yang nampak betul tetapi salah lebih teruk daripada kosong.
