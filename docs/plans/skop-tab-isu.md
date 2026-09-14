# Skop — tab Isu / Aduan (Fasa 3)

Ditulis 14 Sep 2026 supaya saiznya kelihatan sebelum sesiapa bersetuju
membinanya. **Ini skop, bukan pelan pelaksanaan.** Ia belum diluluskan.

---

## Kenapa ia belum wujud

`grep -rli "issue_case\|issueCase\|/issues" src/` → **sifar padanan**. Ia
tidak pernah dibina, dan board meletakkannya dalam Fasa 3, bukan Fasa 1.

Ia memerlukan **jadual baharu dalam pangkalan data**, dan semua kerja
skema diparkir sepanjang Fasa 1. Itu sebab tab itu tiada, bukan terlepas.

---

## Apa yang sudah ada untuk dibina di atasnya

Ini penting: kes bukan bermula dari kosong.

| Sudah wujud | Guna untuk kes |
| --- | --- |
| `contacts` | siapa ibu bapa itu |
| `conversations` (`assigned_agent_id`, `status`) | chat asal punca kes |
| `centres`, `regions` (049, **sudah live**) | cawangan dan zon kes |
| `accounts` + `is_account_member()` | RLS — 87 penggunaan dalam 017 |
| `notifications` | pemberitahuan dalam produk |
| `tags` + `contact_tags` | tag pengecualian, **bukan** kategori kes |
| `profiles` | siapa memegang kes |

Jadi yang benar-benar baharu ialah kes itu sendiri dan kitaran hayatnya.

---

## Yang perlu dibina

### 1. Skema — satu migration

```
issues
  id, account_id, centre_id, contact_id, conversation_id
  category      enum, 9 nilai (bawah)
  severity      biasa | penting | kritikal
  status        enum, 7 nilai (bawah)
  assigned_to   profiles.user_id
  opened_by, opened_at, resolved_at, due_at
  summary, resolution

issue_events      jejak audit — setiap perubahan status, siapa, bila, nota
```

**Kategori** (dari board): progress anak, keselamatan/insiden, guru/staf,
servis, yuran/refund, jadual/kelas, pendaftaran, fasiliti, lain-lain.

**Aliran** (dari board): New → Acknowledged → Investigating → Waiting →
Resolution proposed → Resolved → Reopened.

RLS: ikut corak `is_account_member()` sedia ada. Jangan reka yang baharu.

**Perhatian:** `contacts.centre_id` wujud tetapi **tiada penulis** —
tiada apa dalam `src/` menulisnya. Jadi kes tidak boleh mewarisi cawangan
daripada Parent sehingga itu dibina. Sama ada kes membawa `centre_id`
sendiri, atau pengikatan Parent→Centre dibina dahulu. **Ini keputusan
pertama yang perlu dibuat.**

### 2. UI — anggaran kasar

| Skrin | Nota |
| --- | --- |
| `/issues` senarai | penapis: status, kategori, severity, cawangan, pemegang |
| `/issues/[id]` butiran | garis masa, tukar status, nota, pautan ke chat |
| Cipta kes dari chat | butang dalam inbox — ini yang menjadikannya berguna |
| Lencana pada baris inbox | perbualan yang ada kes terbuka |
| Kad dashboard | kes terbuka, tertunggak, kritikal |
| Entri nav baharu | kumpulan Conversations, bawah "Belum Dibalas" |

### 3. Pemberitahuan

`notifications.type` kini `CHECK (type IN ('conversation_assigned'))` —
**satu nilai sahaja**. Menambah jenis kes bermakna mengubah constraint itu,
jadi ia sebahagian daripada migration yang sama.

Board menetapkan: kes keselamatan/kritikal notify Zone Head + HQ; kes biasa
guna reminder longgar dahulu.

**Tetapi "Zone Head + HQ" memerlukan 044** — akses multi-zon, yang
dikeluarkan daripada release dan tidak diapply. Tanpa 044 tiada konsep
Zone Head untuk dinotify. Jadi bahagian eskalasi tidak boleh dibina
sepenuhnya sekarang.

### 4. i18n

Setiap rentetan dalam tiga locale (en, ko, ms). Anggaran 80–120 kunci
baharu. Ujian pariti dan ICU sedia ada akan menguatkuasakannya.

---

## Tiga keputusan sebelum sesiapa menulis kod

1. **Cawangan kes** — kes membawa `centre_id` sendiri, atau bina
   pengikatan Parent→Centre dahulu? Yang kedua lebih betul dan lebih besar.
2. **Eskalasi** — terima versi tanpa Zone Head (044 tiada), atau masukkan
   semula 044 dahulu? 044 ialah migration berisiko tertinggi dalam set
   asal: ia menulis semula `is_account_member()` di belakang ~119 polisi RLS.
3. **Kategori sebagai enum atau jadual** — enum lebih mudah dan
   menguatkuasakan senarai; jadual membenarkan admin menambah kategori
   tanpa migration. Board kata hanya admin boleh cipta tag baharu, yang
   mencadangkan ia mahu kawalan, bukan kebebasan.

---

## Saiz jujur

Ini **bukan** kerja sehari. Anggaran kasar, dengan gate yang sama seperti
Fasa 1:

- 1 migration (jadual, enum, RLS, constraint notifications)
- 6 skrin/komponen UI
- 80–120 kunci i18n × 3 locale
- ujian untuk peralihan status dan RLS

Bandingan yang berguna: keseluruhan batch UI/UX Fasa 1 — 16 batch, 113
commit — tidak menyentuh skema langsung. Ini bermula dengan menyentuhnya.

**Prasyarat yang mesti selesai dahulu:** release 045/046/047, kerana
menambah migration di atas set yang belum diapply menjadikan urutan lebih
sukar, bukan lebih senang.
