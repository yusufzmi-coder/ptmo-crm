# Fasa 2 — sambung dari sini

**Ditulis 17 Sep 2026.** Kod Fasa 2 siap dan dipush. Semua yang tinggal
menunggu Yusuf. Fail ini supaya sesi seterusnya tak perlu membaca semula
seluruh sejarah.

---

> ## JANGAN JALANKAN `supabase db push`
>
> Ledger `schema_migrations` pada production merekodkan **001–040 sahaja**.
> `041` hingga `050` diapply **dengan tangan** melalui SQL editor, jadi
> ledger tidak tahu ia wujud walaupun objeknya ada (disahkan dengan probe).
>
> Maknanya `supabase db push --linked` akan menganggap **sebelas**
> migration belum dijalankan dan memainkan semuanya — termasuk `042`,
> `043`, `044`, `048` yang diparkir. `044` menulis semula
> `is_account_member()`, fungsi yang menjadi sandaran pengasingan zon bagi
> lebih 40 query tanpa penapis `account_id`. Itu butang paling berbahaya
> dalam projek ini sekarang dan tiada apa yang memberi amaran.
>
> **Apply `051` dengan menampal failnya ke dalam SQL editor**, cara sama
> `050` diapply. Bukan CLI.

---

> **Status bukti, dikemas 17 Sep selepas probe production.**
>
> Empat kerosakan yang dibaiki 16–17 Sep asalnya dijumpai secara **statik**.
> Dua daripadanya kini **disahkan pada mesin hidup** dengan probe REST
> baca-sahaja — tanpa akaun ujian, kerana ketiadaan lajur tidak perlukan
> sesi:
>
> | Dakwaan | Bukti |
> |---|---|
> | `quick_replies.whatsapp_config_id` tiada (043) | `42703` dari production ✅ |
> | `broadcasts.whatsapp_config_id` tiada (048) | `42703` dari production ✅ |
> | `account_members` tiada (044) | `PGRST205` ✅ — 044 memang tak diapply |
> | `call_logs` tiada (051) | `PGRST205` ✅ |
> | `conversations.whatsapp_config_id`, `centres`, `issues` ada | `200` ✅ |
>
> Premis kepada empat pembetulan itu **bukan lagi andaian**. Yang masih
> belum diperhatikan ialah tingkah laku laluan — 500 sebenar dalam aplikasi
> — dan itu perlukan sesi. Kod lama masih disajikan sehingga Vercel deploy
> `main`, jadi tingkap itu **masih terbuka sekarang** dan tutup pada deploy,
> bukan pada merge.

## Satu ayat

Kod siap, gate hijau, semuanya ada pada `origin/feat/multi-number`.
**Tiada apa boleh bergerak sehingga nombor WhatsApp disambung** —
dan dua perkara lain mesti berlaku dalam susunan yang betul sebelum itu,
kalau tidak bukti hilang kekal.

## Keadaan

| | |
|---|---|
| Branch | `feat/multi-number`, dipush |
| Gate terakhir pada kod | lint 0 ralat / 32 amaran · tsc 0 · **1403 ujian lulus** · build berjaya |
| `main` | belum ada kerja Fasa 2 — PR **#66** belum dimerge |
| Production | `crm.ptmostaff.com` — `/calls` dan `/api/calls` pulang **404**, sebab belum deploy |
| Migration baharu | `051_call_logs.sql` — **belum diapply** pada mana-mana pangkalan data |
| Masih diparkir | `042`, `043`, `044`, `048` |

## Apa yang dibina

| Kerja | Commit | Nota |
|---|---|---|
| Call log — `call_logs`, `/calls`, `GET/POST /api/calls`, dialog rekod | `4c35077`, `f7bcc93` | **Bukan** WhatsApp Calling API. Itu pilot kemudian |
| Migration `051_call_logs.sql` | `5b02395` | Disahkan atas baseline **tanpa** 042/043/044/048, dalam DB buangan. Idempotent |
| Pemilih Centre per nombor WhatsApp | `e4e139b` | `whatsapp_config.centre_id` (049) tak pernah ditulis sesiapa sebelum ni |
| Pagar jadual-hilang untuk `call_logs` | `227e38b` | `isMissingTable` dalam `src/lib/db/schema-drift.ts` |
| `docs/uat-fasa2.md` | `5b02395` + 3 pembetulan | Senarai semak UAT Fasa 2 |

Yang **tidak** dimerge: `board/f2-qr-fence` (`c1c9b3a`). Ia pembetulan
bertindih untuk P0 quick-replies; `a834ba2` mendarat dahulu dan lebih
baik. Branch kekal sebagai rujukan sahaja, **jangan merge**.

## Yang Yusuf kena buat — dan susunannya penting

### Keputusan yang mudah terlepas

Ada **dua sekatan** yang kelihatan sama dari luar (dua-duanya nampak
macam "benarkan Claude teruskan") tetapi susunannya menentukan sama ada
satu set bukti wujud langsung:

1. **Beri akaun ujian** (satu admin, satu agent) pada `crm.ptmostaff.com`
2. **Buka sekatan merge PR #66**

Kalau **(1) dahulu** — dua tingkap bukti hidup.
Kalau **(2) dahulu** — tingkap Fasa 1 hilang kekal.

Sebabnya: empat kerosakan `043`/`048` dijumpai secara **statik**, dari
ledger migration dan kod, dan **tidak pernah diperhatikan berlaku**. Ia
masih hidup pada production sekarang kerana pembetulannya duduk pada
branch. Detik #66 mendarat, kerosakan itu hilang — bersama satu-satunya
peluang mengesahkan diagnosis itu benar. Kerosakan yang tak pernah wujud
bermakna empat pembetulan menyelesaikan masalah yang direka.

### Urutan penuh

```
1. jalankan Bahagian 0 docs/uat-fasa1.md   <- hanya SEBELUM merge #66
2. merge PR #66
3. sahkan 0.4 / 0.5 / 0.6 uat-fasa2.md     (307 / 401 / sidebar)
4. jalankan 0.7 / 0.8 uat-fasa2.md         <- hanya SEBELUM apply 051
5. apply 051_call_logs.sql
6. sambung nombor WhatsApp pilot
7. Bahagian 1-6 uat-fasa2.md
```

Langkah 1 dan 4 masing-masing hanya wujud sekali. Selepas peristiwa yang
menutupnya, tandakan **TIDAK BOLEH DIUJI** — jangan teka apa yang
sepatutnya berlaku.

### Kelayakan (aku tiada aksesnya)

- Nombor WhatsApp pilot pada Meta: callback
  `https://crm.ptmostaff.com/api/whatsapp/webhook`, verify token yang
  Yusuf reka, PIN 6-digit
- Vercel: `META_APP_SECRET` mesti App Secret **sebenar**. Tanpanya
  **setiap** mesej ibu bapa ditolak — gagal tertutup, betul, tetapi
  kelihatan seperti WhatsApp senyap
- Vercel: `WHATSAPP_TEMPLATES_DRY_RUN` mesti **tiada, `false`, atau apa-apa
  selain `true`/`1`**. Dokumen ini pernah kata "mesti tiada" — itu terlalu
  ketat; `templates/submit/route.ts:132` hanya mencetuskan dry-run pada
  `'true'` atau `'1'`
- Supabase Auth → URL Configuration mesti termasuk domain live

## Yang termurah kalau ada lima minit

Login, buka satu thread sebenar, tekan picker quick reply. Kemudian cuba
cipta satu quick reply. Dua permintaan itu sahaja mengesahkan sama ada
empat pembetulan 16-17 Sep betul-betul membaiki sesuatu.

**Kalau ia berjaya dan bukan gagal, itu penemuan yang lebih bernilai
daripada empat kelulusan.** Rekod, jangan diam-diam anggap lulus.

## Risiko terbuka

- `broadcast-core.ts` dan `broadcast-resume.ts` sudah dipagar
  (`3aaa62e`) tetapi pembetulan itu **belum di-deploy**. Broadcast masih
  rosak pada production sekarang.
- Tiada satu pun daripada empat pembetulan drift skema disahkan
  terhadap production. Semuanya diagnosis statik.
- `docs/uat-fasa1.md` kes **4.4** kini bertanda **RAMALAN: GAGAL**
  (`467e401`), bukan keputusan — ia ditulis daripada membaca kod. Ia
  jadi keputusan sebenar hanya selepas langkah 1 dijalankan. Selepas #66
  mendarat, ramalan itu tidak lagi terpakai langsung.
- Empat migration diparkir (`042`, `043`, `044`, `048`) masih tiada
  keputusan. Jurang melebar dengan setiap migration baharu — 051
  menjadikannya lima nombor antara repo dan production.

## Pelajaran yang patut kekal

**Repo bukan sasaran.** Tiga permukaan, satu punca:

- Kod percaya repo tentang pangkalan data → drift skema (043, 048, 051)
- Dokumen percaya repo tentang deploy → sebelas laluan yang tak pernah
  diuji pada mesin hidup (`b068453`)
- Kes ujian percaya kod tentang keadaan runtime → kes yang lulus, atau
  gagal, tanpa keadaan sebenar pernah dicapai (`ad3d81e`, `81bb690`)

**Dua sesi menulis repo yang sama perlu bertukar skop sebelum menulis,
bukan selepas.** 16 Sep: dua sesi membaiki P0 yang sama serentak, satu
branch terbuang, dan `git add -A` satu sesi menarik masuk kerja sesi
lain yang belum dicommit. `ListAgents` sahaja tidak cukup — hantar
`SendMessage` dan petakan pemilikan fail dahulu.
