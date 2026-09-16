# PTMO CRM - Project Command Board

> **Cara guna:** Ini ialah satu-satunya papan ringkas untuk status projek. Bila sesuatu siap, ada idea baharu, atau ada keputusan baharu, kemas kini bahagian berkaitan bersama tarikh dan pautan bukti/commit. Jangan masukkan token, password, atau data parent sebenar di sini.

**Pemilik:** Yusuf Azmi  
**Produk:** CRM PTMO Operation Dept  
**Status keseluruhan:** Fasa 1 kod **SELESAI** · Isu & Tindakan **hidup pada production** · **UAT 2/41 kes** — lihat `docs/uat-fasa1.md`
**Dikemas kini:** 16 Sep 2026
**Branch kerja bersepadu:** `feat/multi-number` = `origin/main` = `6928678` — semua diserap
**Gate:** lint 0 error / 32 warning · typecheck 0 · **1285 ujian lulus** · build berjaya
**Katalog:** en/ko/ms **1905 kunci** setiap satu. Bahasa Melayu **aktif** — domain menyajikan `lang="ms"`
**Live:** `crm.ptmostaff.com` 200, melalui Vercel projek `crmfinal_ptmo`
**Baseline production:** skema **041 + 045 + 046 + 047 + 049 + 050**. `050` (Isu & Tindakan) diapply 15 Sep, enam penegasan `t`, disahkan bebas melalui REST. Release Fasa 1 diapply 15 Sep dalam satu transaksi; tiga penegasan `t`, disahkan bebas dengan probe baca-sahaja dari luar pangkalan data.
**CI:** kedua-dua job Migrations **hijau** — kali pertama dalam hayat repo ini. Ia masih **tidak tercetus sendiri**; sembilan push ke `main` menghasilkan sifar larian sementara events API menunjukkan push itu mendarat. Lihat `docs/open-findings.md`.
**Belum diapply, dan tiada pangkalan data pernah menjalankannya:** `042`, `043`, `044`, `048`. Jurang itu melebar dengan setiap migration baharu.

---

## Sekarang - tindakan Boss

| Keutamaan | Tindakan | Siapa | Bila selesai |
|---|---|---|---|
| P0 | Sambung nombor WhatsApp — Callback `https://crm.ptmostaff.com/api/whatsapp/webhook`, verify token yang kau reka, PIN 6-digit | Yusuf | [ ] **satu-satunya yang menghalang Fasa 2** |
| P1 | **Dua akaun ujian UAT** pada `crm.ptmostaff.com` — satu admin, satu viewer. 39 daripada 41 kes UAT mati tanpanya | Yusuf | [ ] **halangan tunggal UAT** |
| P1 | Tab Actions GitHub — sepanduk fork. Sembilan push, sifar larian; setiap gate setakat ini dicetuskan dengan tangan | Yusuf | [ ] |
| P1 | Vercel: pastikan `WHATSAPP_TEMPLATES_DRY_RUN` **tiada**. Kalau `true`, templat dapat ID rekaan dan tidak pernah sampai ke Meta — UI kata "menunggu kelulusan" selama-lamanya | Yusuf | [ ] |
| P1 | Vercel: sahkan `META_APP_SECRET` ialah App Secret sebenar. Tanpanya **setiap mesej ibu bapa ditolak** — gagal tertutup, betul, tetapi kelihatan seperti WhatsApp senyap | Yusuf | [ ] |
| P1 | Supabase Auth → URL Configuration mesti termasuk domain live, kalau tidak reset kata laluan mendarat di `localhost` | Yusuf | [ ] |
| P2 | Vercel: putuskan projek pendua kalau `ptmo-crm` masih bersambung — env var mungkin hanya ada pada satu | Yusuf | [ ] |
| P2 | Putuskan nasib `042`, `043`, `044`, `048` — empat migration yang tiada pangkalan data pernah jalankan. Jurang melebar dengan setiap migration baharu | Yusuf + Coordinator | [ ] |
| P2 | Jadual cron — automasi dengan langkah `wait` berhenti kekal tanpanya. Halangan kod sudah dibuang; tinggal jadual, dan Hobby hadkan sekali sehari | Yusuf | [ ] |
| — | ~~Preflight akaun + storage~~ | Yusuf | [x] **15 Sep** lulus |
| — | ~~Apply 045, 046, 047~~ | Yusuf | [x] **15 Sep** satu transaksi, tiga penegasan `t` |
| — | ~~Locale Melayu pada Vercel~~ | Yusuf | [x] **15 Sep** domain menyajikan `lang="ms"` |
| — | ~~Kunci service-role~~ | Yusuf | [x] **15 Sep** ditukar kepada `sb_secret_` — sebelum ini salinan kunci anon, cap SHA-256 identik |
| — | ~~Kedua-dua job CI hijau~~ | Coordinator | [x] **14 Sep** tujuh sekatan berturut-turut, setiap satu menyembunyikan yang berikutnya |

## Peta fasa

| Fasa | Hasil yang hendak dicapai | Status |
|---|---|---|
| 0 - Foundation | Reka bentuk multi-zone, nombor balasan betul, migration 041 co-viewer | Done |
| 1 - Shared Inbox Foundation | Multi-number, zone/HQ, security, centres, release safety | **Done** 15 Sep |
| 2 - WhatsApp Pilot | 1 Centre, 1 nombor baharu, 2 staf, chat/media/call log asas | **Next** — tinggal sambung nombor |
| 3 - Operations Workflow | Claim chat, issue case, lifecycle, follow-up, escalation longgar | **Teras hidup** — kes, kitaran hayat, garis masa. Eskalasi Zone Head masih perlukan 044 |
| 4 - Scale & HQ | Rollout ikut gelombang, zone health, HQ report, BSC | Planned |
| 5 - SMS & Automation | Sambung SMS sebagai source of truth, AI/automation terkawal | Later |

## Bukti keadaan semasa

### Sedia dalam kod / branch

- Multi-number WhatsApp, routing nombor untuk conversation dan balasan.
- Zone / HQ access, account memberships, per-tab co-viewer presence.
- Guard akses, realtime inbox, private media hardening, broadcast safety dan ops SLA asas.
- Settings `Centres & zones` serta migration 049.
- Preflight akaun dan storage yang read-only untuk release.
- `feat/centres` telah dipush dan diintegrasi ke `feat/multi-number` melalui `0842f58`; ia bukan lagi kerja lokal yang berasingan.
- Hardening release ada pada `57e4437`; migration 050 kemudian ditarik balik dengan sengaja pada `5f91f70`, dan preflight SQL Editor dibaiki pada `bd4366b`.

### Sudah live

- Ledger repo menyatakan migration 001–041 sahaja live; 040 dan 041 dibuat secara manual.
- Nota luar yang diterima pada 14 Sep mendakwa 049 sudah live, tetapi ini bercanggah dengan ledger dan preflight. Jangan anggap 049 live sehingga probe read-only mengesahkannya.

### Belum live - jangan anggap siap

- Migration 042-049 belum dijalankan pada production.
- Branch batch belum di-merge dan deploy ke `main`/domain `crm.ptmostaff.com`.
- WhatsApp Cloud API, webhook HTTPS dan nombor pilot belum connected.
- Contact/Parent belum boleh ditetapkan ke Centre melalui UI; wajib sebelum scale banyak Centre.

## Backlog idea yang diluluskan secara arah

### Fasa 2-3: Inbox operasi

- **Assignment hybrid:** chat baru masuk `Unassigned`; staf tekan **Ambil & Balas** / reply pertama claim chat. Zone Head boleh reassign.
- Paparan utama: All, Mine, Unassigned, Unreplied, Waiting, Closed.
- Internal note, @mention, collaborator, ringkasan sebelum close dan next action.
- Call log asas: siapa call, masa, outcome, summary, follow-up dan pautan kepada issue. WhatsApp Calling API hanya pilot selepas chat stabil.

### Fasa 3: Issue Case - bukan sekadar tag

- Kes dihubungkan kepada Parent/Child, Centre, Zone dan chat asal.
- Kategori: progress anak, keselamatan/insiden, guru/staf, servis, yuran/refund, jadual/kelas, pendaftaran, fasiliti, lain-lain.
- Aliran: New -> Acknowledged -> Investigating -> Waiting -> Resolution proposed -> Resolved -> Reopened.
- Kes keselamatan/critical notify Zone Head + HQ; kes biasa guna reminder longgar dahulu.

### Data dan tag - minimum yang berguna

- Struktur (Centre, Zone, nombor, assignee, status, follow-up) ialah **field**, bukan tag.
- Reason chips terkawal: jadual/kelas, yuran, pendaftaran, trial, lokasi/centre, progress anak, complaint/issue, lain-lain.
- Exception tags kekal: VIP/management attention, sensitive, opt-out, spam. Hanya admin boleh cipta tag baharu.
- Parent Journey untuk operasi: Enquiry -> Trial/Registration -> Active Parent -> Paused/Follow-up -> Exited/Alumni. Ini berasingan daripada issue dan status chat.

## Cara kerja terminal - standard yang lebih selamat

### Konfigurasi normal: maksimum 5 terminal aktif

| Terminal | Peranan | Boleh ubah kod? | Lokasi kerja |
|---|---|---:|---|
| 1 | Coordinator / integrator | Ya - branch utama sahaja | `~/Projects/ptmo-crm` |
| 2 | Builder A - satu skop UI/API | Ya | Worktree sendiri |
| 3 | Builder B - satu skop UI/API berbeza | Ya | Worktree sendiri |
| 4 | QA / security / migration audit | Tidak, kecuali diminta baiki | Worktree sendiri atau detached |
| 5 | Research / docs / product decisions | Tidak | Mana-mana folder bukan branch utama |

### Agihan aktif - batch UI/UX Fasa 1 (14 Sep 2026)

Semua kerja release diparkir. Fasa semasa UI/UX sahaja. Pembahagian ikut
POKOK FAIL, bukan tema, supaya tiada dua terminal menulis fail sama.

| Terminal | Sesi | Worktree | Fail milik | Namespace i18n |
|---|---|---|---|---|
| 1 Coordinator | ptmo-crm-fasa1-release-gate | `~/Projects/ptmo-crm` | `docs/**`, integrasi | - (pengadil) |
| 2 Builder | create-worktree-gitignore | `.worktrees/f1-t2-mu0nanxd` | `src/components/inbox/**`, `src/lib/inbox/**` | `Inbox.*` |
| 3 Builder | create-worktree-audit-workflow | `~/Projects/ptmo-crm-issues-ui` | migrasi WhatsApp: `settings/**` | kesihatan nombor, link cawangan |
| 4 Builder | notifications-page-i18n | worktree sendiri | `src/app/(dashboard)/notifications/**` | `Notifications.*` (baharu) |
| 5 QA | uat-crm-phase-1-qa | `~/Projects/ptmo-crm-f1-t3-nav` | `src/components/layout/**` (nav siap) | `Sidebar.*`, `Header.*` |

**Pengesahan visual:** dipegang `uat-crm-phase-1-qa`, bermula pada `b21bbeb`
selepas enam batch UI diintegrasi — satu pusingan meliputi kesemuanya.

**Konvensyen worktree:** adik-beradik di luar repo. `.worktrees/` bersarang
menyebabkan eslint dan tsc mengimbas salinan projek penuh (15 error lint,
145 error TS, tiada satu pun dari `src/`), jadi gate terpaksa dijalankan
atas arkib bersih. Arahan coordinator awal yang menetapkan `.worktrees/`
adalah silap dan sudah ditarik balik.

**Kerja berasingan yang direkod, belum ditugaskan:**
`header.tsx` `pageTitles` dan `sidebar.tsx` `navGroups` ialah dua senarai nav
yang akan terus terpesong — satu sumber kebenaran ialah pembetulan sebenar.
~110 spinner dalam tiga bentuk berbeza di seluruh repo tanpa
`src/components/ui/spinner.tsx` wujud; penyatuan menyentuh `ui/` dan puluhan
fail merentas pemilikan.

Gate tempatan masih tercemar oleh `project-command-board/` dan `tools/` —
dua salinan aplikasi board untracked dengan `dist/` dan `.next/` dibundel.
Lint kini bersih (0 error) selepas `.worktrees/` dibuang, tetapi `tsc`
masih melaporkan 145 ralat, tiada satu pun dari `src/`. Perlu diputuskan:
abaikan dalam `.gitignore` + `tsconfig` + `eslint.config.mjs`, atau commit
sebagai projek berasingan dengan konfigurasinya sendiri.

`messages/en.json` + `ko.json` ialah satu-satunya fail yang dikongsi. Peraturan:
tambah kunci baharu sahaja, dalam namespace sendiri sahaja. Kunci dalam objek
berbeza mendarat pada baris berbeza, jadi merge kekal bersih. Coordinator
mengesahkan dengan perbandingan kunci rata, bukan diff teks.

`src/components/dashboard/skeleton.tsx` dan `empty-state.tsx` ialah komponen
kongsi: guna, jangan ubah.

### Peraturan trafik

1. Terminal 1 satu-satunya yang merge, rebase, push branch integrasi, atau susun release.
2. Builder dapat **satu skop + satu set fail**; tidak sentuh migration yang dimiliki orang lain.
3. Migration, RLS, auth, webhook dan env adalah laluan merah: seorang pemilik sahaja pada satu masa.
4. Setiap builder wajib beri: commit hash, fail berubah, test dijalankan, risiko dan perkara belum siap.
5. Coordinator audit diff dan jalankan gate sebelum merge. Jangan percaya “siap” tanpa bukti.
6. Guna 6-7 terminal hanya bila ada audit/research selari. Untuk build biasa, 4-5 lebih laju dan kurang konflik.

## Log keputusan

| Tarikh | Keputusan | Sebab | Status |
|---|---|---|---|
| 2026-09-12 | Satu CRM boleh ada banyak Zone; HQ boleh switch dan reply semua Zone | Kekalkan ownership setiap Centre sambil HQ nampak keseluruhan | Active |
| 2026-09-12 | Jangan migrate 16 nombor sekaligus | Pilot nombor baru dahulu kurangkan risiko operasi dan Meta | Active |
| 2026-09-13 | Fasa 1 ditutup hanya selepas preflight + release + UAT | Kod yang push bukan bukti production ready | Active |
| 2026-09-13 | Issue Case diasingkan daripada tag | Aduan tidak boleh hilang sebab staf terlupa tag | Planned |
| 2026-09-14 | Pilot kekal satu nombor Ops baharu; seni bina multi-number tidak dibuang | Kurangkan risiko cutover sekarang sambil kekalkan ruang scale kemudian | Active |
| 2026-09-14 | Worktree sesi serentak kekal di luar repo (`~/Projects/ptmo-crm-*`); `.worktrees/` dalam repo diabaikan Git | Elak folder kerja tersilap commit | Active |
| 2026-09-14 | UI guna **Bahasa Melayu**. `ms.json` ditulis penuh; pengaktifan (`NEXT_PUBLIC_APP_LOCALE`) belum dibuat — ia perubahan env | Staf PTMO membacanya setiap hari | Active |
| 2026-09-14 | Bahasa Korea tidak akan digunakan. `ko.json` dikekalkan buat sementara supaya ujian pariti locale tidak pecah; pembuangan dijadual sebagai P2 berasingan | Semakan penutur asli bukan blocker untuk kerja UI | Active |
| 2026-09-14 | Release diskop semula daripada 042-049 kepada **045, 046, 047, 049**. 042/043/048 menyelesaikan masalah 16-nombor yang keputusan satu-nombor sudah buang; 044 risiko tertinggi tanpa nilai pilot | 046+047 tutup pendedahan yang hidup pada production. 049 dimasukkan semula selepas QA tunjuk `centres-panel.tsx` query jadual yang hanya 049 cipta — mengeluarkannya bermakna tab Settings rosak, bukan sekadar tidak lengkap | Active |

## Update log

| Tarikh | Apa berubah | Bukti / pautan | Dikemas kini oleh |
|---|---|---|---|
| 2026-09-13 | Board dicipta; status batch `feat/multi-number` direkod | `bd4366b` | Codex |
| 2026-09-14 | Cross-check brief baharu dengan repo: betulkan status Centres, hardening, 050 dan konflik status 049 | `0842f58`, `57e4437`, `5f91f70`, `bd4366b`, ledger migration | Codex |
| 2026-09-14 | Gate QA dikunci pada `841db55`: lint 0 error, typecheck 0 error, 1131/1131 ujian lulus, build berjaya (checkout bersih) | `841db55` | Coordinator |
| 2026-09-14 | Runbook release ditulis; 5 branch worker disahkan sudah diserap penuh, tiada kerja tergantung | `docs/release-042-049.md` | Coordinator |
| 2026-09-14 | UI batch 1 diintegrasi: skeleton/EmptyState inbox, aria-current, label status i18n, prefers-reduced-motion | `c9fca23` | Coordinator |
| 2026-09-14 | UI batch 2 diintegrasi: penapis pemilikan Anyone/Mine/Unassigned/Others + chip pemilik; 1148 ujian lulus | `9c113b8` | Coordinator |
| 2026-09-14 | UI batch 3: skeleton senarai inbox + sasaran sentuh mobile lebih besar | `838412c` | Coordinator |
| 2026-09-14 | UI batch 4: drag-drop dan paste lampiran dalam composer; konflik i18n diselesaikan sebagai kesatuan; 1160 ujian lulus | `843795d` | Coordinator |
| 2026-09-14 | UI batch 5: 9 spinner contacts/broadcasts jadi skeleton, 12 dikekalkan dengan sebab (animate-spin 21 -> 12) | `6bef51f` | Coordinator |
| 2026-09-14 | UI batch 6: nav 10 baris rata jadi 4 kluster, setiap tajuk melabel `<ul>` sendiri via aria-labelledby | `b21bbeb` | Coordinator |
| 2026-09-14 | `.worktrees/` berhenti diabaikan dan folder dibuang; ketiga-tiga worktree bersarang pindah ke konvensyen adik-beradik. Lint tempatan 15 error -> 0 | `7ec777e` | Coordinator |
| 2026-09-14 | UI batch 7: 10 panel settings jadi skeleton (39 -> 29), **plus pepijat menghadap pengguna**: panel AI papar "Failed to load AI configuration" setiap kali dibuka semasa memuat biasa | `78f06ff` | Coordinator |
| 2026-09-14 | UI batch 8-11: quick replies i18n (20 rentetan), tajuk `/flows` + `/agents`, notifications i18n (9 rentetan), kontras tajuk sidebar ke WCAG AA | `288051f`, `954f45e`, `2b0ab3c`, `5839836` | Coordinator |
| 2026-09-14 | Gate tempatan dibersihkan: `project-command-board/` + `tools/` dikecualikan dari tsc dan eslint. Lint 0 error, tsc 0 ralat terus dari checkout kerja — tiada lagi perlu arkib bersih | `aeb7f2e` | Coordinator |
| 2026-09-14 | **049 dimasukkan semula** ke release selepas QA jumpa kod bergantung padanya; dokumen release dinamakan semula | `docs/release-phase1-migrations.md` | Coordinator |
| 2026-09-14 | Senarai semak UAT ditulis semula untuk set 045/046/049/047 — zone/HQ susut kepada 4 kes negatif, bahagian 046 baharu untuk eskalasi keistimewaan viewer | `docs/uat-fasa1.md` | Coordinator |
| 2026-09-14 | UI batch 12-13: 9 shell halaman jadi skeleton berbentuk; sentinel pratonton interaktif diterjemah pada masa render, bukan pada sumber | `d683ffa`, `33af54d` | Coordinator |
| 2026-09-14 | UI batch 14-16: `dashboard-shell` i18n, pratonton langkah automation siap (unit wait dulu baca "5 hours" dalam SETIAP bahasa) | `521ea2e`, `92fc1e5` | Coordinator |
| 2026-09-14 | **`messages/ms.json` diintegrasi — 1679 kunci, pariti en/ko/ms sempurna, 1170 ujian lulus. BELUM DIAKTIFKAN**: `request.ts` dan `NEXT_PUBLIC_APP_LOCALE` tidak disentuh | `2949ab7`, `d0487da`, `0dd39b9` | Coordinator |
| 2026-09-14 | Lebar sidebar Melayu diukur dengan fon sebenar: lega 17px (9%) -> 56px (29%). Kaedah kiraan aksara dibuktikan tidak selamat | QA harness | Coordinator |
| 2026-09-14 | **Katalog Melayu dipandang buat kali pertama.** `/login` render sempurna dalam `ms` pada 500px dan 1280px — tiada limpahan, tiada pengeratan | screenshot, `NEXT_PUBLIC_APP_LOCALE=ms` inline | Coordinator |
| 2026-09-14 | Penemuan: `signup`, `forgot-password`, `reset-password` tiada `useTranslations` langsung — staf jatuh dari skrin Melayu terus ke Inggeris | `docs/open-findings.md` | Coordinator |
| 2026-09-14 | Ujian ICU tiga-locale: 1679 kunci x 3 locale x 4 semakan, disahkan dengan suntikan kerosakan bukan dengan lulus | `5dd2d38` | Coordinator |
| 2026-09-14 | Keempat-empat halaman auth kini diterjemah — 47 rentetan, 3 namespace baharu. `signup` dan `forgot-password` disahkan render bersih dalam Melayu dengan screenshot | `9218ba7` | Coordinator |
| 2026-09-14 | Katalog: 1726 kunci x 3 locale, pariti bersih | `2d34b04` | Coordinator |
| 2026-09-14 | **PR #2 di-merge dan di-deploy.** `main` `4b04cff` -> `1b3247d`. Domain `crm.ptmostaff.com` disahkan hidup dan menyajikan kod baharu (`/reset-password` = 200) | `1b3247d` | Coordinator |
| 2026-09-14 | **Ledger dibetulkan: 049 SUDAH diapply.** Probe REST menunjukkan `centres`/`regions`/`contacts.centre_id` wujud. Set release susut kepada 045/046/047 | `93edf3e` | Coordinator |
| 2026-09-14 | `my_accounts` dipagar - 044 tiada, jadi RPC 404 pada setiap page load. Kini `unavailable` dan diam; kegagalan sebenar masih log | `583d501` | Coordinator |
| 2026-09-14 | **Template seed tidak lagi mereka fakta** - harga `$9/mo` dan dasar refund palsu dikeluarkan. Sifar fakta dicipta sebagai ganti | `b83dafa` | Coordinator |
| 2026-09-14 | **Locale tidak lagi gagal senyap** - `.env.local` membawa `"en "` dengan ruang sejak 10 Sep; hari `ms ` ditulis, pengaktifan akan gagal tanpa sebarang isyarat | `b19fa2a` | Coordinator |
| 2026-09-14 | PR #3 di-merge dan di-deploy | `019e722` | Coordinator |
| 2026-09-16 | **UAT dimulakan pada domain live.** Kes 1.6 LULUS penuh — kesebelas laluan dilindungi pulang 307 → `/login`, sepadan tepat dengan `protectedPaths`. Kes 5.6 LULUS — media tanpa sesi pulang 401, `cache-control: no-store`. Domain menyajikan `lang="ms"`. Baki 39 kes disekat pada akaun ujian | `405ba94`, `docs/uat-fasa1.md` | Coordinator |

---

## Template update pantas

```text
UPDATE CRM
- Siap / berubah:
- Bukti (commit, screenshot, hasil test):
- Blocker:
- Idea baharu / keputusan:
- Perlu terminal untuk kerja ini? Ya/Tidak:
```

Hantar template ini dalam chat bila-bila masa. Coordinator kemas kini board, tentukan fasa, dan jika perlu beri susunan terminal yang tidak bertembung.
