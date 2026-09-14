# PTMO CRM - Project Command Board

> **Cara guna:** Ini ialah satu-satunya papan ringkas untuk status projek. Bila sesuatu siap, ada idea baharu, atau ada keputusan baharu, kemas kini bahagian berkaitan bersama tarikh dan pautan bukti/commit. Jangan masukkan token, password, atau data parent sebenar di sini.

**Pemilik:** Yusuf Azmi  
**Produk:** CRM PTMO Operation Dept  
**Status keseluruhan:** Fasa 1 - release gate  
**Dikemas kini:** 14 Sep 2026
**Branch kerja bersepadu:** `feat/multi-number` @ `841db55` lokal / `bd4366b` origin (3 commit belum push)

---

## Sekarang - tindakan Boss

| Keutamaan | Tindakan | Siapa | Bila selesai |
|---|---|---|---|
| P0 | Jalankan `release-preflight-accounts.sql` dalam Supabase SQL Editor dan kongsi hasil | Yusuf | [ ] |
| P0 | Jalankan `release-preflight-storage.sql` dan kongsi hasil | Yusuf | [ ] |
| P1 | Susun release migration 042-049 | Coordinator | [x] 14 Sep - `docs/release-042-049.md` |
| P1 | Semak hasil preflight, betulkan blocker jika ada | Coordinator | [ ] tunggu P0 |
| P1 | Final QA branch: tests, type-check, lint | Coordinator + QA | [x] 14 Sep - 4 gate hijau pada `841db55` |
| P1 | PR/merge ke `main` | Coordinator | [ ] tunggu arahan |
| P1 | Deploy dan UAT aplikasi tanpa WhatsApp sebenar dahulu | Yusuf + Coordinator | [ ] |
| P2 | Pilih satu nombor WhatsApp **baharu** dan satu Centre untuk pilot | Yusuf | [ ] |
| P2 | Cleanup locale Korea: sahkan `NEXT_PUBLIC_APP_LOCALE` production bukan `ko`, kemudian buang `messages/ko.json` dan `TRANSLATED_LOCALES` dalam `src/i18n/messages.test.ts` | Coordinator | [ ] |

## Peta fasa

| Fasa | Hasil yang hendak dicapai | Status |
|---|---|---|
| 0 - Foundation | Reka bentuk multi-zone, nombor balasan betul, migration 041 co-viewer | Done |
| 1 - Shared Inbox Foundation | Multi-number, zone/HQ, security, centres, release safety | Release gate |
| 2 - WhatsApp Pilot | 1 Centre, 1 nombor baharu, 2 staf, chat/media/call log asas | Next |
| 3 - Operations Workflow | Claim chat, issue case, lifecycle, follow-up, escalation longgar | Planned |
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
| 3 Builder | yusufazmi-07 | `.worktrees/f1-t3-nav` | `src/components/layout/**` | `Sidebar.*`, `Header.*` |
| 4 Builder | yusufazmi-2b | `.worktrees/f1-t4-notif` | `src/app/(dashboard)/notifications/**` | `Notifications.*` (baharu) |
| 5 QA/audit | create-worktree-audit-workflow | read-only | tiada | - |
| 6 Builder | yusufazmi-91 | `.worktrees/f1-t6-settings` | `src/components/settings/**` | `Settings.*` |

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
| 2026-09-14 | Bahasa Korea tidak akan digunakan. `ko.json` dikekalkan buat sementara supaya ujian pariti locale tidak pecah; pembuangan dijadual sebagai P2 berasingan | Semakan penutur asli bukan blocker untuk kerja UI | Active |
| 2026-09-14 | Release diskop semula daripada 042-049 kepada **045, 046, 047 sahaja**. 042/043/048 menyelesaikan masalah 16-nombor yang keputusan satu-nombor sudah buang; 044 risiko tertinggi tanpa nilai pilot; 049 tiada penulis | 046+047 tutup pendedahan yang hidup pada production dan tiada kaitan dengan model nombor | Active |

## Update log

| Tarikh | Apa berubah | Bukti / pautan | Dikemas kini oleh |
|---|---|---|---|
| 2026-09-13 | Board dicipta; status batch `feat/multi-number` direkod | `bd4366b` | Codex |
| 2026-09-14 | Cross-check brief baharu dengan repo: betulkan status Centres, hardening, 050 dan konflik status 049 | `0842f58`, `57e4437`, `5f91f70`, `bd4366b`, ledger migration | Codex |
| 2026-09-14 | Gate QA dikunci pada `841db55`: lint 0 error, typecheck 0 error, 1131/1131 ujian lulus, build berjaya (checkout bersih) | `841db55` | Coordinator |
| 2026-09-14 | Runbook release ditulis; 5 branch worker disahkan sudah diserap penuh, tiada kerja tergantung | `docs/release-042-049.md` | Coordinator |
| 2026-09-14 | UI batch 1 diintegrasi: skeleton/EmptyState inbox, aria-current, label status i18n, prefers-reduced-motion | `c9fca23` | Coordinator |
| 2026-09-14 | UI batch 2 diintegrasi: penapis pemilikan Anyone/Mine/Unassigned/Others + chip pemilik; 1148 ujian lulus | `9c113b8` | Coordinator |

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
