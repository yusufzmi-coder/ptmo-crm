# Prompt sambung — paste dalam terminal baharu

Buka terminal dalam `~/Projects/ptmo-crm`, jalankan `claude`, paste blok
di bawah. Tak perlu cerita apa-apa lagi; semua konteks ada dalam repo.

---

```
Kita sambung PTMO CRM Fasa 2. Repo ~/Projects/ptmo-crm, branch feat/multi-number.

Baca dulu, ikut susunan ini:
1. docs/fasa2-sambung-dari-sini.md  — baca amaran di kepala fail SEBELUM sentuh apa-apa
2. docs/uat-fasa2.md
3. docs/plans/connect-whatsapp-webhook.md

JANGAN jalankan `supabase db push`. Ledger schema_migrations pada production
hanya rekod 001-040; migration 041-050 diapply dengan tangan melalui SQL editor.
db push akan main semula sebelas migration termasuk 042/043/044/048 yang diparkir,
dan 044 tulis semula is_account_member() yang jaga pengasingan zon.

Keadaan setakat 17 Sep:
- PR #66 sudah merge (049352c) dan Vercel sudah deploy. /calls hidup.
- UAT kes 0.4 dan 0.5 LULUS, diukur pada domain hidup.
- Kerosakan 043 dan 048 disahkan wujud pada production dengan probe REST (42703).
- Migration 051_call_logs.sql BELUM diapply. call_logs tiada pada production.
- Nombor WhatsApp BELUM disambung.
- Akaun ujian BELUM wujud.

Aku dah buat/akan buat bahagian aku. Tanya aku SATU soalan pendek: yang mana
sudah siap antara tiga ni — (a) 051 diapply, (b) kunci service-role sebenar
diberi, (c) nombor WhatsApp disambung. Lepas tu terus kerja ikut apa yang ada,
jangan tunggu yang lain.

Peraturan: worktree sibling di luar repo. Commit path-scoped fail sendiri.
Jangan prettier merentas repo. Jangan supabase db reset --local (container
dikongsi). Kalau ada sesi Claude lain pada repo ni, SendMessage petakan
pemilikan fail DULU sebelum tulis apa-apa — 16 Sep dua sesi baiki P0 sama
serentak dan satu branch terbuang.
```

---

## Bahagian Yusuf — tiga perkara, boleh buat ikut mana-mana susunan

### 1. Apply migration 051 (5 minit)

Supabase dashboard → projek `ptmo-crm` → **SQL Editor** → tampal seluruh
kandungan `supabase/migrations/051_call_logs.sql` → Run.

**Bukan CLI.** Lihat amaran ledger di atas.

Selepas jalan, sahkan dengan satu query:

```sql
SELECT to_regclass('public.call_logs') IS NOT NULL AS ada,
       (SELECT count(*) FROM pg_policies WHERE tablename='call_logs') AS polisi;
```

Jangkaan: `ada = t`, `polisi = 4`.

Sebelum tekan Run, kalau sempat: buka `/calls` dalam pelayar semasa sudah
log masuk. Halaman patut memuat dan berkata rekod panggilan belum
tersedia — **bukan** skrin ralat. Itu kes 0.7, dan ia hanya boleh diuji
sekali, sebelum 051 masuk.

### 2. Kunci service-role sebenar

`.env.local` tempatan membawa kunci **anon** dalam
`SUPABASE_SERVICE_ROLE_KEY` — cap SHA-256 kedua-duanya identik. Pepijat
sama yang dibetulkan pada Vercel 15 Sep, tak pernah dibetulkan pada mesin
ini. Setiap laluan service-role dalam dev tempatan berjalan sebagai anon.

Supabase dashboard → Settings → API → salin **service_role** / secret key,
ganti nilai dalam `.env.local`.

Selepas itu Claude boleh cipta dua akaun ujian sendiri (satu owner/admin,
satu viewer dalam akaun yang sama) dan buka 39 kes UAT yang tersekat.

### 3. Sambung nombor WhatsApp

Meta Business → WhatsApp → konfigurasi:

| Medan | Nilai |
|---|---|
| Callback URL | `https://crm.ptmostaff.com/api/whatsapp/webhook` |
| Verify token | apa-apa rentetan yang kau reka — masukkan nilai **sama** dalam Settings → WhatsApp pada CRM |
| PIN | 6 digit |

Kemudian dalam CRM: Settings → WhatsApp → isi phone number id, WABA id,
access token, verify token, PIN → Simpan → tekan **Verify with Meta**.

Butang Verify itu bukan hiasan. Tanpa `registered_at` dan
`subscribed_apps_at` terisi, Meta **menggugurkan setiap mesej masuk secara
senyap** — itu pepijat asal yang mencetuskan seluruh kerja multi-number.

Sekali lagi pada Vercel, sahkan:
- `META_APP_SECRET` ialah App Secret **sebenar**. Kalau salah, setiap mesej
  ibu bapa ditolak oleh semakan tandatangan. Gagal tertutup, betul, tetapi
  kelihatan seperti WhatsApp senyap.
- `WHATSAPP_TEMPLATES_DRY_RUN` bukan `true` dan bukan `1`.

---

## Kalau ada lima minit sahaja

Log masuk, buka satu thread sebenar, tekan picker quick reply. Kemudian
cuba cipta satu quick reply.

Kerosakan 043 sudah disahkan wujud pada production, tetapi tingkah laku
laluan — 500 sebenar dalam aplikasi — tidak pernah diperhatikan, dan
pembetulannya kini sudah live. Jadi yang diuji sekarang ialah **pembetulan
itu berfungsi**, bukan kerosakan itu wujud.

Kalau ia gagal dan bukan berjaya, itu penemuan. Rekod, jangan diam.
