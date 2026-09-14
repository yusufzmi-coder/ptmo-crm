# PTMO CRM — akses multi-zone HQ

**Status:** SIAP. 18 commit di-push, origin selaras. Enam sesi Claude semuanya tutup skop.
Suite: 92 fail ujian / 1043 ujian hijau, tsc bersih, 48 migration tanpa nombor pendua.
**Dicipta:** 2026-09-12

## Keadaan sekarang

Repo `~/Projects/ptmo-crm`, branch `feat/multi-number`, fork `ArnasDon/wacrm`
(Next.js 16 + Supabase). Sudah di-push ke `yusufzmi-coder/ptmo-crm`.

18 commit mendarat pada 2026-09-12, hasil **enam sesi Claude berjalan serentak**
atas repo yang sama. Semuanya sudah di GitHub kecuali satu fail.

Yang dibina hari ni:

| Migration | Apa |
|---|---|
| 042 | satu thread per (akaun, kenalan, NOMBOR) — sebelum ni ibu bapa yang mesej dua cawangan dapat balasan dari nombor salah |
| 043 | quick reply sedar cawangan — snippet tak boleh sebut nama centre lain |
| 044 | **keahlian multi-zone** — kerja utama sesi ni |
| 045 | presence satu baris per tab |
| 046 | kunci 4 fungsi SECURITY DEFINER yang sesiapa boleh panggil |
| 048 | `broadcasts.whatsapp_config_id` supaya broadcast boleh disambung |
| 047 | bucket storage jadi private — tutup 3 bucket yang `anon` boleh baca tanpa auth |

## Keputusan yang dah dibuat

**Zone = account berasingan.** Zone A/B/C/D setiap satu satu akaun Supabase.
Satu zone boleh ada banyak centre (satu `whatsapp_config` = satu nombor WhatsApp).

**Peranan HQ = `agent`** dalam setiap zone — boleh balas, tak boleh ubah tetapan.
Yusuf kekal `owner`.

**Yusuf miliki keempat-empat zone.** Sebab tu `idx_accounts_one_per_owner`
digugurkan. Kalau ketua zone hilang akses, owner satu-satunya yang boleh pulihkan.

**RLS kekal fail-closed** — ini keputusan paling penting dan paling senang dirosakkan
kemudian. Penjelasan penuh dalam `plans/reka-bentuk-multi-zone.md` dan
`docs/zones.md` dalam repo. Ringkasnya: ada ~41 tempat dalam app yang query tanpa
tapis `account_id` langsung, bergantung RLS semata-mata. Kalau sesiapa longgarkan
`is_account_member()` supaya terima "mana-mana zone aku ahli", semua tempat tu
bocor serentak — tanpa satu ujian pun jadi merah.

**Broadcast branch picker ditangguh** sampai lepas multi-zone. Masih tak boleh guna
dengan ≥2 nombor (`resolveConfig` pulang `ambiguous`).

## Soalan terbuka

- **Migration 041 dalam Supabase belum disahkan.** 040/041 nampaknya di-apply manual
  di luar ledger Supabase CLI. Sekarang ada sembilan migration (040–048) menunggu,
  jadi ledger tak selaras akan jadi masalah bila `db push`. Paste query semak dalam
  Supabase SQL editor untuk sahkan.
- **P1-4 belum ada pemilik:** `whatsapp_config.status = 'disconnected'` tak pernah
  disemak pada mana-mana laluan hantar. Nombor yang ditanda putus masih boleh hantar.
- **Hosting belum putus.** Syor: VPS + Docker (~USD 6-12 + Supabase Pro USD 25),
  bukan sebab murah tapi sebab rate limiter dalam-memori repo ni hanya betul pada
  satu container. Vercel serverless akan mematikannya senyap.
- **`AUTOMATION_CRON_SECRET` tiada dalam `.env.local`** → laluan cron pulang 503,
  jadi langkah Wait automation dan pemasa Flow memang tak berjalan langsung sekarang.
- **`ENCRYPTION_KEY` mesti sama** merentas semua persekitaran. Tukar atau hilang =
  setiap token WhatsApp dan kunci AI tersimpan tak boleh dinyahsulit selamanya.

## Langkah seterusnya

1. Sahkan ledger migration dalam Supabase sebelum `db push`.
2. Fasa seterusnya multi-zone yang belum dibina: zone switcher di header
   (`use-auth.tsx` + komponen baru), guard `X-Zone-Id` pada laluan tulis,
   dan dashboard gabungan HQ (RPC agregat, bukan RLS biasa).
3. Baiki broadcast branch picker.

## Siapa buat apa (2026-09-12)

Setiap commit membawa nama "Yusuf Azmi" sebab keenam-enam sesi Claude berkongsi
`git config` mesin. **Author dalam git TIDAK membezakan pemilik.** Rekod ni satu-satunya
tempat pengarangan sebenar disimpan.

| Commit | Sesi |
|---|---|
| `0516a92` abaikan `_scratch/` | hq-multi-zone-access-switcher |
| `5420f97` optimistic bubble | audit-inbox-duplicate-reply-presence |
| `4592298` 042 satu thread per cawangan | audit-whatsapp-multi-number |
| `4db8c79` 21 fail multi-number + 048 | CRM system PTMO |
| `ef8eb2e` 044 keahlian multi-zone | hq-multi-zone-access-switcher |
| `f9bbaf0` tutup kebocoran status webhook keluar | audit-whatsapp-multi-number |
| `e9cc2d8` ujian tenancy webhook | CRM system PTMO |
| `2143506` 045 presence per tab | audit-inbox-duplicate-reply-presence |
| `ee045b8` 043 quick reply ikut cawangan | audit-ptmo-crm-multi-zone |
| `db4b717` 046 kunci fungsi SECURITY DEFINER | ptmo-crm-zone-isolation |
| `62a8263` Google sign-in | ptmo-crm-zone-isolation |
| `667b905` ujian RLS pgTAP + paip media | ptmo-crm-zone-isolation |
| `2b6de7c` penegasan CI migration fork | hq-multi-zone-access-switcher |
| `763ea70` + `9b78bad` dokumen zones | hq-multi-zone-access-switcher |
| `625caf8` jam 'away' tunggal | audit-inbox-duplicate-reply-presence |
| `b05ca0c` 047 bucket storage private | ptmo-crm-zone-isolation |
| `78a71ef` UI cawangan dalam composer | audit-ptmo-crm-multi-zone |

## Pengajaran yang berbaloi disimpan

**Skop yang berubah bukan ujian punca sebenar.** Aku mula cadang "pembaikan yang runtuh
kepada lebih sedikit fail bermakna kau jumpa punca". Sesi presence tolak dengan contoh
tandingan: 045 mereka bermula "tukar kunci utama" dan berkembang jadi tujuh fail, sebab
per-tab memecahkan sifat "satu baris per orang" yang menjadikan jadual tu tak perlu
dibersihkan — pruner tu akibat langsung, bukan gejala. Ujian sebenar: **boleh tak kau
nyatakan kenapa setiap bahagian tambahan itu wajib?**

**Uji dakwaan sebelum jadikan peraturan.** Dua kali dakwaan yang munasabah ternyata salah
bila diuji dalam repo buangan — sekali punca dituding pada fail yang tak boleh jadi
puncanya, sekali mekanisme git yang tak wujud. Tiada satu pun daripada enam pembetulan
hari tu diterima tanpa seseorang periksa rekod sebenar dahulu.
