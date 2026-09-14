# Open findings — handover

Six parallel audits ran against this repo on 2026-09-12 and landed 18
commits. What follows is what they found and did **not** fix. Every item
was re-verified against `78a71ef` before being written down, not recalled
from memory, and the headings were re-checked against `ab4b042` on
2026-09-13 — four of them had been fixed by the `f5064a8` integration
merge and are now marked as such. Items are open unless their heading
says otherwise, and even a fixed one is worth re-reading before you build
on it.

The audits themselves lived in scratch plan files that do not survive
their sessions. This file exists so the next person does not re-audit
from zero.

Findings are ordered by what would hurt most with real parent data in the
system.

---

## P1 — worth fixing before real parent data

### ~~Media download is an IDOR~~ — FIXED in `cf23bf4`

Kept here only so nobody re-reports it. The route now takes
`requireRole('viewer')`, proves ownership by looking the `media_url` up on
the caller's own RLS-scoped `messages` (so a row exists only if the
caller's active zone received it), answers **404** rather than 403 so the
status cannot confirm the media exists elsewhere, resolves the token from
that message's conversation, and serves `Cache-Control: private`.

`allowPrimary` survives only as the fallback for pre-040 threads with no
number, and by then ownership is already proven.

### ~~Middleware does not gate every authenticated route~~ — FIXED in `f5064a8`

`src/middleware.ts:107`

`protectedPaths` now lists all eleven paths alphabetically, `/agents`,
`/flows` and `/notifications` among them. The API gate is no longer a
substring match on `includes('/webhook')`: unauthenticated
`/api/whatsapp/*` requests are refused with a 401 unless the path is on an
explicit public allowlist (`isPublicWhatsAppPath`).

Still open in this file: there is **no Origin/Referer check on non-GET
`/api` requests**. That half of the finding was never addressed.

### ~~Password reset lands on a 404~~ — FIXED in `f5064a8`

`src/app/(auth)/reset-password/page.tsx` exists now, so
`/auth/callback?next=/reset-password` lands on a real page and the
forgot-password flow completes end to end. Neither half has been walked
through against a live Supabase project — it is verified as present, not
as working.

### ~~Realtime is never rebuilt when the active zone changes~~ — FIXED in `f5064a8`

`src/hooks/use-realtime.ts:62`, `src/app/(dashboard)/inbox/page.tsx:51,386`

`useRealtime` now takes `accountId` and derives its topic through
`realtimeTopic(channelName, accountId)` (`src/lib/realtime/channel.ts`,
unit-tested), and that `topic` is the effect's dep — so a zone switch
tears the channel down and builds a new one. Cached rows go with it:
`InboxPageInner` is keyed on `accountId`, so the whole subtree remounts
rather than being cleaned field by field.

This was UI correctness, not a data leak — RLS was refusing the other
zone's rows the whole time.

### ~~Broadcasts can still strand~~ — FIXED

`src/hooks/use-broadcast-sending.ts`

Fixed in `5bbe6d5`, as prescribed: the row is created as `'draft'` and
promoted to `'sending'` only by the first batch response that lands. A
new catch around the pass stamps a terminal status on every exit path —
`'failed'` once something has gone out, `'draft'` when nothing has — so
no failure leaves a campaign in `'sending'` with nothing left to move it.
The decisions live in `src/lib/broadcast-send-status.ts` with unit tests;
the hook itself is not testable here (vitest runs `node`, no
testing-library).

Two things turned up alongside it and are fixed in the same commit range:

- A batch whose contacts all lacked a phone was skipped, leaving those
  rows `'pending'` and uncounted — a wholly unsendable campaign
  finalized as `'sent'`. They are stamped `'failed'` now.
- The wizard never wrote `broadcasts.whatsapp_config_id`, though
  `broadcast-resume.ts` reads it (migration 048) to pick the number. With
  several branches connected a resume refused rather than guessing. The
  insert now freezes the named branch, and `/api/whatsapp/broadcast`
  returns the number it resolved so a single-number account freezes one
  too — before a second branch is connected.

---

## P1 — product decision, not a bug fix

### Unread is one shared column, not per-user

`conversations.unread_count` is a single column. There is no
`conversation_reads` table — verified absent.

Agent A opens a thread and the badge clears for **everyone**, including
B and C who have never seen it. In an inbox staffed by two or three
people, an opened-but-unanswered thread becomes indistinguishable from a
finished one.

This is inherited upstream single-user behaviour, not a regression. But
it contradicts the shared-inbox model this fork exists to serve.

Fixing it means a `conversation_reads (user_id, conversation_id,
last_read_at)` table and deriving unread per user — touching the schema,
the inbox list, the "Unread" filter, and the `/ops/unanswered` board.
**Decide before building.**

Related and best fixed together: a `viewer` cannot clear unread at all.
`conversations_update` requires `is_account_member(account_id, 'agent')`
(017:416), so the UPDATE matches zero rows, raises no error, and the
optimistic badge clear silently reverts on the next resync.

---

## P2 — cleanup, none urgent

- **Automations/flows write with the service-role client** scoped only by
  `.eq('user_id', …)` or `.eq('id', …)`
  (`automations/[id]/route.ts:36,155`, `duplicate/route.ts`,
  `flows/[id]/route.ts`, `activate/route.ts`,
  `src/lib/automations/steps-tree.ts`). Stricter than a leak today, but
  an admin cannot manage a departed member's automations, and that single
  `.eq` is the only thing between a client-supplied id and an RLS-free
  write.
- **`whatsapp/config/route.ts` calls `requireRole` zero times.** GET and
  DELETE have no role check; POST calls Meta *before* the RLS-enforced
  write, so a `viewer` can drive Meta side effects and probe tokens like
  an oracle. `verify-registration/route.ts:58-61` still does
  `.eq('account_id', …).maybeSingle()`, which breaks with 16 numbers.
- **Thread-to-centre link is soft.** `conversations.whatsapp_config_id` is
  `ON DELETE SET NULL` (040:99) with no tenant-scoped composite FK, so a
  plain `UPDATE` can move a thread to another centre and unplugging a
  centre silently orphans its threads.
- **Presence DELETE events never reach clients.** A realtime DELETE
  payload carries only the primary key, so it cannot match the
  `account_id` filter. Deliberate and documented in `usePresence` —
  pruned rows are hours stale and already invisible — but worth knowing
  before someone "fixes" it.
- **Thread switch emits a NULL heartbeat first.** `presence-focus.ts:42-47`
  emits on cleanup, and React runs cleanup before setup, so A→B produces
  beat(NULL) then beat(B) with the second debounced ~1s. For that second
  the database says the agent is viewing nothing, and realtime broadcasts
  it — the eye icon blinks on colleagues' screens whenever anyone browses
  the list. Fix: delay the emit-to-null ~150ms and cancel it if a new id
  arrives.
- **`peek_invitation` distinguishes `not_found` / `expired` / `used` to
  `anon`** (019:34). Documented as a deliberate trade, so this is a
  product decision rather than a bug — but it is enumeration.
- **`ENCRYPTION_KEY` and `META_APP_SECRET` are one global per instance.**
  Accepted risk, recorded so it is not rediscovered as news.

---

## Mobile

**FIXED in `f5064a8`.** `dashboard-shell.tsx:50` uses `h-dvh` and
`inbox/page.tsx:608` uses `h-[calc(100dvh-3.5rem)]`, so the layout tracks
the small viewport and the composer stays reachable behind the iOS Safari
toolbar.

Not fixed on phones, and not claimed to be: this has only been read, never
opened on a real iPhone. The remaining `min-h-screen` uses are the auth
pages, which scroll and are unaffected; `h-screen` survives on
loading/error states in `dashboard-shell.tsx:32` and
`automations/[id]/edit/page.tsx:55,69`, which have nothing anchored to the
bottom edge.

---

## Testing

**Unit tests do not cover what this batch actually changed.** 1043 tests
pass and the migrations replay clean on an empty Postgres, but the
behaviour of *two people using one inbox at the same time* has never been
observed — only reasoned about. Eleven manual QA procedures were written
across the audits and **none were run**.

There is also no DOM test environment (vitest runs on node, and the repo
has exactly one component test). Before adding one, note what it cannot
do: jsdom has no layout, so `getBoundingClientRect()` returns zero for
everything. A jsdom test would report a truncated label as *present and
readable* at the moment it is invisible to a human — coverage that
certifies the bug as correct.

Render tests are worth having for things that are true or false without
layout: a pill appears when `showBranch` is true and not when it is
false; a placeholder names the centre; the amber rail appears when a
co-viewer is present. Anything that depends on how it *looks* needs a
real browser (Playwright), which is a larger decision and should be
costed openly rather than slipped in as "add UI tests".

If you touch RLS, `supabase/tests/` has the pattern: seed as superuser,
then `SET LOCAL ROLE` plus `SET LOCAL request.jwt.claims` per persona —
and **clear the claims between personas**, because they persist for the
whole transaction and a stale persona makes a leak look like a pass.

---

## Deployment

At the time of writing, **migrations 041 through 048 have not been
applied to the production database. Production is on 040.**

Two traps when someone runs `db push`:

1. It pushes **everything** outstanding, not a selected migration. There
   is no CLI way to target one.
2. **047 makes the `chat-media` bucket private.** Every existing
   `media_url` in the database points at a public URL and will start
   returning 400 unless the new `/api/media/...` route is deployed at the
   same time. That code is on `origin` but is not running anywhere.

Migration 041 has also never been confirmed applied. If it did not land,
presence has been silently dead — both the online/away dot and the
co-viewer eye — with only a `console.error` to show for it.

---

## Ditemui semasa batch UI/UX Fasa 1 (14 Sep 2026)

Ketiga-tiga direkod di sini kerana ia BUKAN kerja UI dan tiada pemilik
dalam batch itu. Tiada satu pun dibaiki.

### `[buttons]` / `[list]` bocor ke UI — dan ke pangkalan data

`src/lib/whatsapp/interactive.ts:238`

`interactivePayloadPreviewText()` pulangkan literal `'[buttons]'` atau
`'[list]'` bila payload tiada body. Tiga panel UI merendernya terus:
`quick-replies-manager.tsx:181`, `quick-reply-picker.tsx:164`,
`automation-builder.tsx:1537`. Jadi panel yang kini 100% diterjemah masih
boleh memaparkan `[buttons]` kepada pengguna.

**Pembetulannya bukan membungkus fungsi itu.** Ia juga dipanggil oleh
`src/lib/whatsapp/send-message.ts:543`, yang menulis hasilnya ke
`conversations.last_message_text` — nilai yang DISIMPAN. Menterjemah
pulangan fungsi bermakna menulis rentetan mengikut locale ke dalam
pangkalan data, yang salah: nilai itu dibaca semula oleh semua pengguna,
bukan hanya yang menulisnya.

Pembetulan yang betul ialah di pemanggil UI — petakan sentinel kepada
label diterjemah pada masa render, biarkan fungsi pure kekal sebagai
sentinel. Merentas tiga pokok pemilikan (`settings/`, `inbox/`,
`automations/`), jadi ia perlukan satu pemilik dan satu helper dikongsi.

Berkait: `automation-builder.tsx:1537` juga membawa `"no body yet"` dan
`"pick a template"` hardcode sendiri.

### Tajuk kumpulan sidebar gagal kontras WCAG AA

`src/components/layout/sidebar.tsx:352`

Diukur dalam sRGB melalui canvas (CSS guna oklab, jadi nilai terkomputasi
tidak boleh dibaca terus):

| Mod | Latar | Teks | Nisbah |
| --- | --- | --- | --- |
| Gelap | `rgb(15,18,22)` | `rgb(102,105,111)` | **3.41:1** |
| Terang | `rgb(255,255,255)` | `rgb(146,150,156)` | **2.97:1** |

WCAG AA untuk teks kecil ialah 4.5:1. Baris nav dalam komponen yang sama
lulus (5.79:1 gelap, 5.52:1 terang), jadi ini khusus tajuk kumpulan.
Puncanya pengubah `/70` pada `text-muted-foreground/70`. Membuangnya
memulihkan nisbah baris nav.

Ditugaskan kepada pemilik `layout/**` sebagai pembetulan satu token.

### Konvensyen `middleware` ditamatkan oleh Next 16.2.12

`next dev` mengeluarkan amaran setiap kali boot: konvensyen fail
`middleware` ditamatkan, guna `proxy`. `AGENTS.md` mengarahkan supaya
notis deprecation dihiraukan, tetapi `src/middleware.ts` ialah laluan
merah dan ia akan pecah pada naik taraf Next. Kerja naik taraf dengan
risikonya sendiri, bukan kemasan.

### Lebar tajuk kumpulan sidebar hanya ada 9% lega

Diukur pada Inter 11px, jarak huruf 0.55px, dengan CSS terkompil dan fon
sebenar: `"Campaigns & automation"` menduduki 174px daripada 191px ruang
teks pada `lg:w-60`. Ia muat satu baris, dan Korea jauh lebih pendek
(79px). Tetapi ia ialah tajuk terpanjang yang muat — mana-mana locale
ketiga dengan frasa lebih panjang akan membalut. Relevan terus kepada
sebarang keputusan menambah `messages/ms.json`.

### Belanjawan lebar teks — diukur, bukan dianggar

Dua tempat sahaja dalam UI yang mengehadkan panjang label, dan kegagalannya
**berbeza bentuk**, jadi ia perlu diperiksa berasingan:

| Tempat | Bila melimpah | Kelihatan? |
| --- | --- | --- |
| Tajuk kumpulan sidebar | balut ke dua baris, 20px → 34px, menolak nav ke bawah | ya |
| `h1` header (`header.tsx:75`) | `truncate` — terkerat senyap dengan ellipsis | **tidak** |

Header lebih bahaya kerana tiada isyarat ia rosak selain tiga titik.

Diukur dengan CSS terkompil dan fon Inter sebenar, Bahasa Melayu:

- **Sidebar**, belanjawan 191px: `Kempen & automasi` 135px, lega 56px (29%).
  Inggeris `Campaigns & automation` 174px, lega 17px (9%). Melayu lebih
  selamat, bukan kurang.
- **Header**: chrome tetap 176px di bawah breakpoint `sm` dan ia tidak
  bergantung pada lebar viewport. Tajuk Melayu terpanjang
  `Pemberitahuan` 111px. Pada 320px viewport itu meninggalkan lega 33px.
  Tiada pengeratan pada mana-mana lebar, en mahupun ms.

**Kiraan aksara bukan pengganti untuk lebar piksel.** 24 aksara `W` melimpah
pada 281px sedangkan 25 aksara `Kempen, siaran & automasi` muat pada 189px.
Lebar glif yang menentukan. Guna kiraan aksara sebagai isyarat untuk meminta
pengukuran, bukan sebagai bukti.

Had: Chrome headless mengapit lebar tetingkap pada 500px, jadi angka 320px
dan 375px **diterbitkan** daripada pemalar chrome 176px, bukan diperhatikan.
Terbitan itu kukuh kerana chrome tetap tidak berubah di bawah `sm`, tetapi
ia bukan pemerhatian. Emulasi peranti melalui CDP diperlukan untuk menutupnya.

### ~~Tiga daripada empat halaman auth tiada i18n langsung~~ — DIBAIKI dalam `9218ba7`

Dikekalkan supaya tiada siapa melaporkannya semula. 47 rentetan dipindahkan
ke tiga namespace baharu; `signup` dan `forgot-password` disahkan render
bersih dalam Melayu dengan screenshot selepas hidrasi. Skrin "semak e-mel"
pada signup dan skrin luput/berjaya pada reset-password hanya muncul selepas
interaksi dan **belum dilihat** — kedua-duanya tepat di mana `t.rich` dengan
`<strong>` duduk, jadi ia baki paling berbaloi diuji.

Asal:

Diperhatikan dengan menjalankan app pada `NEXT_PUBLIC_APP_LOCALE=ms`, bukan
dibaca daripada kod.

| Halaman | `useTranslations` |
| --- | --- |
| `(auth)/login` | ada |
| `(auth)/signup` | **tiada** |
| `(auth)/forgot-password` | **tiada** |
| `(auth)/reset-password` | **tiada** |

Jadi selepas katalog Melayu diaktifkan, seorang staf yang mendaftar atau
menetapkan semula kata laluan mendapat skrin Inggeris penuh, betul-betul
selepas skrin log masuk yang berbahasa Melayu. Termasuk mesej ralat
(`"Passwords do not match"`, `"Password must be at least 6 characters"`)
dan label butang.

Ini kelas kecacatan yang sama dengan halaman Notifications — halaman yang
terlepas semasa i18n asal dipasang, dan tidak kelihatan sehingga locale
bukan-Inggeris dihidupkan.

`login` sudah diterjemah dan dirender dengan betul dalam Melayu, disahkan
pada 500px dan 1280px: tiada limpahan, tiada pengeratan, susun atur
identik dengan Inggeris.

**Nota kaedah — satu amaran palsu yang hampir dilaporkan:** screenshot pada
`--window-size=390` menunjukkan kad terpotong di sebelah kanan pada
`signup` DAN `login`. Itu bukan kecacatan halaman. Chrome headless mengapit
lebar tetingkap pada ~500px, jadi meminta 390 menangkap 390px daripada
susun atur 500px dan memotong bakinya. Pada 500px sebenar, kad `max-w-md`
(448px) muat dengan lega. Jangan laporkan pengeratan daripada screenshot di
bawah 500px tanpa emulasi peranti melalui CDP.

---

## Pusingan visual pertama — 10 halaman, log masuk, locale `ms`

Dijalankan 14 Sep pada `cf551d6` dengan `NEXT_PUBLIC_APP_LOCALE=ms`, akaun
ujian berasingan, Chrome dipandu melalui CDP. Sepuluh halaman dashboard
ditangkap selepas hidrasi.

**Sifar limpahan mendatar pada kesemua sepuluh** (`scrollWidth` diukur
terhadap `innerWidth`, bukan dipandang). Pengelompokan nav, kontras tajuk
kumpulan, dropdown pemilikan inbox dan katalog Melayu semuanya render
seperti direka. Ini pengesahan pertama bahawa mana-mana daripadanya
berfungsi di skrin.

Tiga perkara ditemui.

### Mata wang lalai USD dalam CRM Malaysia

`accounts.default_currency` lalai `'USD'` (`021:24`, sudah live) dan
`DEFAULT_CURRENCY = "USD"` (`src/lib/currency.ts:14`). Jadi Dashboard
memaparkan **`$0`** untuk "Nilai Deal Terbuka" dan Tetapan menunjukkan
"USD — US Dollar".

MYR wujud sepenuhnya sebagai pilihan (`currency.ts:58`, simbol `RM`,
locale `ms-MY`) dan boleh ditukar per akaun melalui Tetapan. Jadi ini
bukan kerosakan — ia lalai yang salah untuk organisasi ini, dan setiap
akaun baharu bermula salah. Keputusan produk, bukan pepijat.

### Nama mod tema tidak diterjemah

`MODES = ["light", "dark"]` (`src/lib/themes.ts:46`) ialah pengecam mentah
yang dirender terus. Dalam antara muka Melayu, panel Rupa memaparkan
"Light", dan `Settings.appearance.useMode` (`"Guna mod {mode}"`)
menyisipkan pengecam mentah itu — jadi pembaca skrin mendengar
"Guna mod light".

Nama tema aksen (`"PTMO"`, `themes.ts:78`) ialah kata nama khas dan
sepatutnya kekal.

### "Pilih satu perbualan" muncul dua kali

Bila tiada perbualan dipilih, kunci `Inbox.messageThread.selectConversation`
dirender oleh DUA komponen sekaligus:

```
src/components/inbox/message-thread.tsx:897   (tengah, dengan petunjuk)
src/components/inbox/contact-sidebar.tsx:125  (panel kanan)
```

Sedia ada, bukan daripada batch ini — ia berkelakuan sama dalam Inggeris.
Ia kelihatan seperti pengulangan, bukan reka bentuk tiga-panel.

### P0 — template automasi menghantar mesej Inggeris SaaS kepada ibu bapa

`src/lib/automations/templates.ts`

Empat template mula-pantas pada `/automations`. Nama dan huraiannya
Inggeris, tetapi itu bahagian kecil. Setiap satu membawa `step_type:
'send_message'` dengan `text:` — badan mesej yang **dihantar kepada Parent
melalui WhatsApp**.

`welcome_message` dicetuskan oleh `first_inbound_message`, jadi ia perkara
**pertama** yang ibu bapa terima:

```
:47   "Hi! 👋 Thanks for reaching out. We'll get back to you shortly."
:74   "Thanks for your message! Our team is offline right now (9am–6pm)
       and will reply first thing tomorrow."
:95   "Great — happy to help with pricing! Quick question: roughly how
       many seats are you looking for?"
:123  "Just circling back — did you have any other questions for us?"
```

Dua masalah berasingan, dan yang kedua lebih besar daripada bahasa:

1. **Ia Inggeris.** Ibu bapa PTMO menerima balasan automatik Inggeris.
2. **Kandungannya salah untuk perniagaan ini.** "how many seats are you
   looking for" ialah bahasa jualan SaaS B2B — *seats* bermaksud lesen
   perisian. PTMO ialah pusat tuisyen bercakap dengan ibu bapa tentang
   anak mereka. Dan "9am–6pm" bercanggah dengan waktu operasi sebenar;
   katalog sendiri menggunakan "Isnin-Khamis 8.30 pagi-1.30 petang".

Diwarisi daripada `wacrm` dan tidak pernah disesuaikan. Ia lulus setiap
gate kerana ia literal kod, bukan katalog — ujian pariti dan ICU tidak
melihatnya langsung.

**Ini menyekat Fasa 2.** Pilot WhatsApp bermakna nombor sebenar menerima
mesej ibu bapa sebenar, dan `welcome_message` akan membalas secara
automatik. Apa yang PTMO hantar kepada ibu bapa ialah keputusan
perniagaan, bukan terjemahan — ia perlukan Boss membaca dan meluluskan
teks gantian sebelum sesiapa menulisnya.

### P1 — tagline tema kekal Inggeris

`src/lib/themes.ts:79-109` membawa enam `tagline` Inggeris yang dirender
di tengah panel Rupa yang selainnya Melayu sepenuhnya — "Confident,
slightly playful.", "Clean B2B-SaaS blue — calm and product-y.", dan
empat lagi. Sebab yang sama: literal kod, bukan katalog.

`MODES = ["light","dark"]` (`:46`) juga dirender mentah — lihat penemuan
mod tema di atas. Bezanya penting: **tagline ialah teks paparan dan
boleh dipindahkan ke katalog; MODES ialah pengecam yang disimpan dalam
localStorage dan mesti kekal.**

### Limpahan Melayu — diuji, tidak berlaku

10 halaman × 2 lebar (1280px, 500px) dalam `ms`, diulang sepenuhnya dalam
`en` sebagai baseline dan dibandingkan. **Melayu tidak lebih teruk
daripada Inggeris pada mana-mana halaman.** Sifar teks terpotong, sifar
limpahan-X, kedua-dua lebar. Satu-satunya elemen terpotong ialah emel
akaun dalam sidebar, dan ia terpotong identik dalam Inggeris — truncate
yang disengajakan pada alamat panjang, bukan kesan terjemahan.

Risiko panjang teks yang ditandakan berulang kali sepanjang batch ini
kini ditutup dengan pengukuran, bukan anggaran.

### P0 — `SUPABASE_SERVICE_ROLE_KEY` sebenarnya kunci publishable

`.env.local` menyimpan kunci yang bermula dengan `sb_publisha…` dalam slot
`SUPABASE_SERVICE_ROLE_KEY`. Itu kunci **publishable** (awam), bukan kunci
rahsia. Disahkan: ia bukan JWT (satu bahagian, bukan tiga), dan
`/auth/v1/admin/users` menolaknya dengan `401 no_authorization`.

Kesannya bukan kosmetik. Setiap laluan server yang menganggap keistimewaan
service-role sedang berjalan dengan keistimewaan awam, dan RLS akan
menyekatnya secara senyap. Itu termasuk penghantaran webhook
(`src/lib/webhooks/deliver.ts`), dan ia juga sebab kenapa 046 GRANT kepada
`service_role` — fungsi itu dipanggil dari laluan yang sepatutnya
service-role.

Hanya `.env.local` yang boleh diperiksa dari sini. **Kalau production
membawa kunci yang sama, laluan server itu rosak di production dan
kerosakannya senyap.** Perlu disemak sebelum deploy.

Ia juga menyekat kerja coordinator: preflight dan migration memerlukan
akses DB yang naik taraf, dan tiada satu pun tersedia di sini — tiada
`supabase` CLI, tiada `psql`, tiada `DATABASE_URL`, dan `pooler-url`
tidak membawa kata laluan.

### P1 — `my_accounts` akan 404 selama-lamanya jika 044 kekal dikeluarkan

`src/lib/auth/zones.ts:125` memanggil RPC `my_accounts`. Hanya
`044_account_memberships.sql` menciptanya, dan 044 dikeluarkan daripada
release.

Laluan runtime, disahkan: header → `zone-switcher.tsx:37` → `useZones()`
→ `use-zones.ts:79` → `fetchZones()` → `db.rpc("my_accounts")`. Zone
switcher dirender pada setiap halaman dashboard, jadi ia menembak pada
setiap page load.

Probe REST terhadap production mengesahkan `/rest/v1/rpc/my_accounts`
memulangkan **404**.

Merosot dengan elok: `fetchZones` menangkap ralat, memulangkan
`{ok:false,reason:'failed'}`, dan `shouldShowSwitcher()` memerlukan
`zones.length > 1`, jadi switcher tidak render. Tiada skrin pecah.
**Bukan blocker deploy** — tetapi konsol dipenuhi ralat berulang yang akan
menyembunyikan ralat sebenar kemudian.

Bentuk **sama persis** dengan blocker 049, dan ia terlepas atas sebab yang
boleh dinamakan: semakan menyemak jadual yang migration cipta, bukan
fungsi. Peraturan baharu: semak `.rpc(` dan `.from(` dalam `src/`
terhadap setiap FUNGSI dan JADUAL yang migration cipta.

### P1 — baris nav gagal kontras WCAG AA dalam mod gelap

Diukur dalam aplikasi hidup, sRGB melalui canvas:

| Mod | Tajuk kumpulan | Baris nav |
| --- | --- | --- |
| Gelap | 5.79:1 | **3.91:1** — gagal |
| Terang | 5.52:1 | 4.81:1 — lulus, nipis |

Ambang teks kecil 4.5:1.

Kesan sampingan yang patut disebut: selepas tajuk kumpulan dinaikkan ke
AA, tajuk kini **lebih kuat** daripada baris nav di bawahnya. Hierarki
visual terbalik — tajuk seksyen sepatutnya lebih senyap daripada item
yang boleh diklik. Warna baris nav tidak disentuh oleh kerja itu; ia
sudah begitu sebelumnya, cuma tidak kelihatan sehingga jirannya dibaiki.

### GitHub Actions tidak pernah berjalan pada repo ini

`actions/runs` memulangkan `total_count: 0`. Kedua-dua workflow (`CI`,
`Migrations`) berstatus `active`, failnya ada pada `main` dan pada branch,
dan Actions dihidupkan pada peringkat repo. Namun tiada satu run pernah
direkod.

Ini bermakna setiap angka gate yang dilaporkan sepanjang fasa ini
dijalankan **secara tempatan sahaja**. Angka-angka itu dijalankan berkali
atas arkib bersih dan boleh dipercayai, tetapi ia bukan CI.

Ia juga bermakna prasyarat dalam runbook — job *upgrade path* mesti hijau
sebelum apa-apa diapply — menyatakan sesuatu yang belum pernah dipenuhi.

### `crm.ptmostaff.com` sudah hidup — board menyatakan sebaliknya

Domain menjawab `307 -> /dashboard` dan menyajikan
`<title>CRM PTMO OPERATION DEPT</title>` dengan borang log masuk Inggeris.
DNS menunjuk ke Vercel.

Board merekod "Branch batch belum di-merge dan deploy ke `main`/domain
`crm.ptmostaff.com`" seolah-olah domain itu belum wujud. Ia wujud, dan ia
menyajikan `4b04cff` — iaitu `main` semasa, dari 11 Sep.

**Maka merge ke `main` bukan operasi git semata-mata; ia auto-deploy ke
laman hidup.** Itu mengubah profil risiko merge sepenuhnya.

Dua projek Vercel tersambung pada repo ini:

| Projek | Production | Keadaan |
| --- | --- | --- |
| `crmfinal_ptmo` | 2 deploy, kedua-dua **berjaya** | menyajikan domain |
| `ptmo-crm` | 2 deploy, kedua-dua **GAGAL** | preview sahaja, duplikat |

`ptmo-crm` tidak pernah berjaya deploy ke production. Ia menambah satu
check yang gagal pada setiap PR dan patut dicabut.

### P1 — `text-primary` atas `bg-primary-soft` gagal AA dalam KEDUA-DUA mod

Pasangan token, bukan pepijat komponen. Ia menandakan keadaan **aktif
terpilih** merentas produk — baris nav aktif, rel tetapan aktif, chip
terpilih, quick reply terpilih, dan lain-lain.

Dikira terus daripada token tema PTMO, bebas daripada pengukuran pelayar,
dan angkanya padan tepat:

| Mod | Latar | Nisbah | Ambang |
| --- | --- | --- | --- |
| Terang | `--primary-soft` `#e8f3fb` | **4.27** | 4.5 — gagal |
| Gelap | 14% `#0a77bb` atas latar gelap | **3.47** | 4.5 — gagal |

Teks 14px berat medium, jadi ambang teks kecil terpakai.

Sembilan fail membawa `bg-primary-soft`; enam menggunakan pasangan penuh
`bg-primary-soft text-primary` secara literal. Membaiki satu komponen
membetulkan satu tapak dan menjadikannya tidak konsisten dengan jirannya.

**Pembetulannya tidak boleh satu nilai.** Kiraan luminans menunjukkan
kedua-dua mod menarik ke arah BERTENTANGAN:

```
luminans primary = 0.16846
TERANG  perlu <= 0.15716   ->  primary kena lebih GELAP
GELAP   perlu >= 0.23352   ->  primary kena lebih CERAH
```

Dan menggelapkan `--primary-soft` dalam mod gelap tidak boleh
menyelesaikannya: ia memerlukan luminans **-0.0015**, iaitu mustahil.

Jadi satu `--primary` tidak boleh memenuhi kedua-duanya. Ia memerlukan
sama ada `--primary` per-mod, atau token berasingan untuk teks-atas-soft
(contoh `--primary-on-soft`) yang bergerak bebas daripada warna butang.

Rujukan yang perlu dijaga semasa membaikinya: `primary` atas putih ialah
**4.81**, dan putih atas `primary` juga **4.81** — itu butang utama
(«Log masuk»). Ia lulus dengan margin nipis, jadi apa-apa perubahan pada
`--primary` mesti diukur semula terhadap butang itu juga.

Merentas empat blok tema (`globals.css` pada 161, 199, 212, 226) — jadi
pembetulan menyentuh setiap tema, bukan PTMO sahaja.

**Cara ia hampir tersalah lapor, dan itu berbaloi direkod.** Laporan
pertama mengukur pautan nav pertama pada `/dashboard`, yang kebetulan
AKTIF, dan membandingkan warna teksnya terhadap latar `aside` dan bukan
latarnya sendiri. Itu menghasilkan 3.91/4.81 dan satu dakwaan "hierarki
terbalik" antara tajuk kumpulan dan baris nav. Dakwaan itu tidak boleh
benar: sumber menunjukkan kedua-duanya menggunakan token yang **sama
persis**, jadi nisbahnya mesti identik — dan memang identik, 5.52 terang
dan 5.79 gelap, kedua-duanya lulus. Pengukur itu menangkap kesilapannya
sendiri dan menariknya balik sebelum sesiapa menampal apa-apa.

### P1 — ~170 warna hardcode menganggap mod gelap, dan mod terang ialah lalai

Inventori penuh, 54 fail. Tiada satu pun dibaiki — saiznya perlu diketahui
sebelum sesiapa bersetuju membetulkannya.

`themes.ts:52` menetapkan `DEFAULT_MODE = "light"` dan `layout.tsx:98`
meletakkannya pada `<html>`. Jadi setiap tapak di bawah gagal untuk
pengguna yang **tidak pernah menyentuh tetapan Rupa**.

**Yang paling teruk hidup pada domain sekarang:**

```
whatsapp-config.tsx:632   banner BERDAFTAR
  bg-emerald-950/30 + text-emerald-400
  mod terang  1.02:1        mod gelap  9.22:1
```

1.02 bermakna teks dan latar mempunyai luminans yang hampir sama — bukan
sukar dibaca, **halimunan**. Disahkan dua kali secara bebas: diukur dalam
pelayar, dan dikira daripada nilai Tailwind (emerald-950 pada 30% atas kad
putih = `rgb(179,192,189)`; emerald-400 atasnya = 1.02).

Ini banner yang memberitahu sama ada nombor WhatsApp berjaya didaftarkan.

| Kelas | Tapak | Perihal |
| --- | --- | --- |
| **D** — latar menganggap mod gelap | 8 (2 fail) | 1.02–2.89 dalam terang, semua lulus dalam gelap |
| **A** — teks menganggap mod gelap | ~154 (54 fail) | `text-red-400` 2.89, `text-amber-300` 1.45, `text-amber-200` 1.24 |
| **B** — teks menganggap mod terang | 8 | arah bertentangan, set kecil |
| **C** — tengah | 8 | gagal terang sahaja |

**Pembetulan tidak boleh bermula sehingga token wujud.** Tiada apa untuk
170 tapak itu ditukar KEPADA:

```
--destructive   wujud, tetapi IDENTIK dalam kedua-dua blok mod
                (globals.css:112 dan :141) — ia tidak menyesuaikan diri
--success       tiada
--warning       tiada
--info          tiada
```

Urutan: bina token status per-mod dahulu (satu fail), kemudian Kelas D
(paling teruk, paling kecil), kemudian Kelas A secara bertahap ikut
kawasan produk — bukan satu commit 54 fail.

**Perangkap kaedah yang patut direkod.** Larian pertama melaporkan
`text-red-200` lulus cemerlang pada 17.76/17.99. Itu mustahil untuk merah
jambu pucat atas kad putih. Puncanya: kelas itu **tidak dijana dalam
bundle** — ia hanya wujud sebagai `hover:text-red-200` — jadi harness
mengukur warna teks yang diwarisi dan ia kelihatan sempurna.

Kelas yang tidak wujud mengukur sebagai lulus. Sesiapa yang menjalankan
audit sebegini mesti mengesahkan kelas itu benar-benar dijana.

Akibatnya: setiap varian `hover:` dalam inventori ini **tidak diukur
secara langsung**. Hover perlukan pusingannya sendiri.

## Domain masih menyajikan Inggeris — `NEXT_PUBLIC_APP_LOCALE` belum ditetapkan

`crm.ptmostaff.com/login` memulangkan 200 dan merender `"Sign in"` /
`"Password"`, bukan Melayu. Semua kerja i18n sudah mendarat di main dan
katalog `ms` lengkap dengan 1839 kunci.

`NEXT_PUBLIC_*` dibakar pada masa **build**, jadi menetapkannya sahaja
tidak mencukupi — projek Vercel perlu di-redeploy selepas itu.

**Kerja Boss, bukan boleh dilakukan dari sini.** Vercel CLI tidak log
masuk dalam persekitaran ini (`vercel whoami` → `Logged out`), dan log
masuk itu interaktif.

Lihat juga `src/i18n/request.ts` — `.env.local` tempatan memegang
`"en "` dengan ruang di hujung sejak 10 Sep, dan `try/catch` lama
menyajikan `en.json` secara senyap. Itu sudah dibaiki; nilai yang tidak
sah kini memberi amaran dan jatuh ke `en` dengan nyata. Jadi kalau nilai
Vercel ditetapkan salah, log build akan menyebutnya.

## Teks lalai nod flow ikut locale pencipta — bocor ke dalam mesej pelanggan

**Tapak:** `flow-editor-state.tsx:151` (`button_label: "View options"`),
`flow-editor-state.tsx:156` (`title: "Option 1"`),
`node-config-form.tsx:257` (`title: "Option"`)

Ini nilai lalai yang ditulis ke dalam config nod bila pengguna menambah
langkah. Ia bukan kromium UI — ia menjadi kandungan tersimpan yang
dihantar kepada ibu bapa melalui WhatsApp.

Cadangan asal ialah menterjemahnya mengikut locale pencipta. **Jangan.**
Locale pencipta ialah pembolehubah yang salah.

PTMO ada 16 cawangan pada satu akaun. Butang yang staf cawangan A cipta
dihantar kepada ibu bapa yang sama seperti butang yang staf cawangan B
cipta. Kalau lalai mengikut locale pencipta, kandungan WhatsApp yang ibu
bapa terima bergantung pada **tetapan pelayar** orang yang kebetulan
menambah langkah itu.

Ibu bapa tidak pernah melihat UI. Mereka melihat mesej. Locale pencipta
ialah fakta tentang **staf** dan ia bocor ke dalam mesej **pelanggan**.

**Pembetulan sebenar:** lalai peringkat akaun — satu bahasa untuk segala
yang keluar melalui WhatsApp, tidak kira siapa menaipnya. Itu ciri, bukan
kemasan i18n. Menunggu keputusan Boss.

Sehingga itu, biarkan Inggeris. Satu bahasa yang salah lebih baik
daripada dua bahasa yang tidak boleh diramal.

## Peraturan: apa-apa yang DISIMPAN atau DIBANDINGKAN tidak melalui katalog

Dua kali dalam fasa ini rentetan hampir diterjemah yang bukan teks
paparan:

- `NODE_META.label` — `flow-editor-state.tsx:478` melakukan
  `slugify(meta.label, type)` untuk menyemai **kunci nod**. Kunci itu
  disimpan dan dibandingkan. Menterjemahnya bermakna dua pengguna dalam
  akaun yang sama menjana kunci berbeza untuk nod yang sama, dan
  perbandingan gagal secara senyap pada data yang kelihatan betul.
- Nilai lalai nod, di atas.

Bentuknya sama: **pengecam mengikut locale pengguna**. Ia lulus setiap
gate — tsc bersih, ujian lulus, pariti locale sempurna — dan gagal hanya
apabila dua locale bertemu dalam data yang sama.

`NODE_META.label` kini didokumenkan dalam **jenisnya**, bukan dalam komen
bebas. Komen dibaca oleh orang yang sudah curiga; jenis dibaca oleh orang
yang tidak.

## Peraturan: satukan bila kedua-duanya mesti BERSETUJU, bukan bila sepadan

`Flows.list.status*` dan `Flows.header.status*` disatukan menjadi
`Flows.status.*`. Tetapi `Flows.logs.statusActive` (status **larian**) dan
`Flows.editorState.statusArchived` (teks **toast**) sengaja dibiarkan
berasingan, walaupun ketiga-tiganya mengandungi perkataan yang sama.

Ujiannya bukan sama ada dua rentetan sepadan hari ini. Ia sama ada dua
rentetan mesti sentiasa bersetuju — biasanya kerana ia muncul bersebelahan
untuk keadaan yang sama.

Mengulang `"Delete"` merentas namespace selamat. Mengulang label status
ialah bahaya hanyut. Menyatukan atas dasar perkataan yang sama ialah
kesilapan yang sama seperti tidak menyatukan langsung, cuma arah
bertentangan.
---

## Kod mati yang kelihatan hidup — `SECTION_META.label`

`src/components/settings/settings-sections.ts` mentakrifkan `label` untuk
kesemua dua belas bahagian tetapan:

```
profile: { id: 'profile', label: 'Your profile', … }
members: { id: 'members', label: 'Team members', … }
api:     { id: 'api',     label: 'API keys',     … }
```

**Tiada satu pun sampai ke skrin.** `settings-rail.tsx` merender
`t(\`sections.${s}\`)` untuk label butang dan `t(\`groups.${group}\`)` untuk
tajuk kumpulan. `RAIL_GROUPS[].label` dibaca hanya sebagai boolean
(`label ? … : null`) untuk memutuskan sama ada tajuk kumpulan dilukis —
nilainya tidak pernah dipaparkan.

Ditemui semasa audit rentetan hardcode i18n (3c290e1). Ia **tidak**
diterjemah: menterjemah teks mati menambah lapan kunci yang mesti dijaga
selama-lamanya untuk teks yang tiada siapa nampak.

**Kenapa ia lebih daripada kemasan.** Seseorang yang menukar
`label: 'Team members'` kepada sesuatu yang lain akan menjangka UI
berubah. Ia tidak. Kod mati yang kelihatan seperti sumber kebenaran
ialah perangkap, dan ia duduk betul-betul di sebelah tempat label sebenar
ditakrifkan (`messages/*.json` di bawah `Settings.sections`).

**Cadangan:** buang medan `label` daripada `SectionMeta` dan daripada
kedua-dua struktur, sebagai commit tersendiri supaya pemadaman boleh
dibaca sendiri. Semak `RAIL_GROUPS` juga — kalau `label` hanya penanda
boolean, ia patut jadi `showHeading: boolean` dan bukan rentetan yang
menjemput orang menyuntingnya.

---

## Badge BETA — 1.33:1 dalam mod terang

Diukur semasa mengesahkan kerja token Kelas D, di luar dua fail yang
diubah. Badge `BETA` di sebelah Flow dalam sidebar mengukur **1.33:1**
terhadap latarnya dalam mod terang.

Ia dalam `src/components/layout/**`, bukan pokok settings, jadi ia tidak
disentuh. Diletakkan di sini supaya ia masuk ke dalam inventori Kelas A/B/C
dan bukan ditemui semula dari awal.

---

## P0 — varian `dark:` tidak pernah aktif, 41 tapak dalam 12 fail

`src/app/globals.css:5` mengisytiharkan:

```css
@custom-variant dark (&:is(.dark *));
```

Varian itu memerlukan kelas `.dark` pada leluhur. Aplikasi **tidak pernah
menambahnya**. Mod hidup pada `html[data-mode="dark"]`, ditetapkan oleh
`layout.tsx:78` dan `themes.ts`. Carian merentas `src/` tidak menemui satu
pun tempat `.dark` ditambah kepada mana-mana elemen.

**Disahkan dalam pelayar**, bukan dibaca daripada kod. Warna dikira bagi
chip peranan Pemilik, yang ditulis `text-amber-700 dark:text-amber-300`:

```
data-mode=light (lalai)       lab(47.2709 42.9082 69.2966)
data-mode=dark                lab(47.2709 42.9082 69.2966)   <- sama
data-mode=dark + kelas .dark  lab(86.4156  6.13147 78.3961)  <- baru berubah
```

Menukar `data-mode` tidak mengubah apa-apa. Hanya menambah `.dark` dengan
tangan yang mencetuskannya.

**Skala:** 41 penggunaan `dark:` merentas 12 fail. Kesemuanya mati.

**Kenapa ia penting melebihi kosmetik.** Setiap tapak yang ditulis
`text-x-700 dark:text-x-300` sedang menghantar nilai mod-terang kepada
pengguna mod gelap. Ia juga menjelaskan sebab inventori warna mendapati
varian `dark:` "tidak konsisten" — ia bukan tidak konsisten, ia tiada
kesan, jadi tiada siapa pernah melihatnya berfungsi atau gagal.

**Pembetulannya satu baris:**

```css
@custom-variant dark (&:is([data-mode="dark"] *));
```

**Tetapi jangan hantar ia sendirian.** Ia menghidupkan 41 tapak serentak,
dan tiada satu pun daripadanya pernah dirender dalam mod gelap — ia ditulis
dengan andaian ia berfungsi dan tidak pernah disemak. Pembetulan itu
memerlukan pusingan kontras mod gelap dalam larian yang sama, bukan
selepasnya.

Ditemui semasa menukar chip peranan Pemilik daripada 1.33:1 dalam mod
terang. Pembetulan chip itu dihantar dengan separuh `dark:` ditulis dengan
betul, supaya ia mula berfungsi sebaik varian itu dibetulkan.

---

## Selepas pembalikan varian `dark:` — apa yang berubah, untuk UAT

Varian dibalikkan kepada `&:is([data-mode="dark"] *)`, menghidupkan 41
utiliti `dark:` dalam 12 fail yang sebelum ini tidak berkesan.

**Diukur, sebelum dan selepas, 14 halaman × 2 mod (1363 elemen teks):**

```
sebelum   67 gagal / 1363
selepas   65 gagal / 1370
```

**Sifar regresi di bawah ambang.** Lapan tapak turun sedikit — butang
outline yang kini menerima `dark:bg-input/30`, jadi latarnya sedikit lebih
cerah — tetapi kesemuanya kekal lulus dengan lebar (19.31 -> 17.05,
6.22 -> 5.87). Dua tapak dibetulkan: chip peranan Pemilik, 3.24 -> 11.26
dalam mod gelap, yang memang sebab pembalikan ini dibuat.

**Ke mana UAT patut melihat.** Perubahan visual yang nyata, semuanya dalam
mod gelap sahaja:

- **Medan input, textarea, select** kini mempunyai permukaannya sendiri
  (`bg-input/30`) dan bukan warna kad. Ini yang paling luas — ia menyentuh
  setiap borang dalam aplikasi. Ia betul mengikut reka bentuk shadcn dan
  menjadikan medan boleh disunting lebih jelas, tetapi ia berbeza daripada
  apa yang sesiapa pernah lihat.
- **Butang outline dan ghost** mendapat latar dan sempadan mod gelap.
- **Tab** — tab aktif mendapat permukaan dan sempadan sendiri; tab tidak
  aktif kekal muted. Disahkan pada `/agents`, satu-satunya halaman dengan
  tab yang boleh dirender tanpa data.
- **Chip peranan Pemilik** kini amber terang dan bukan amber gelap.
- **Avatar** — `dark:after:mix-blend-lighten` kini berkuat kuasa pada
  penunjuk kehadiran.

**Keadaan yang TIDAK diuji, kerana ia memerlukan interaksi:** setiap
`dark:aria-invalid:*` (11 utiliti — keadaan ralat borang),
`dark:hover:*` (7), `dark:focus-visible:*` (2), `dark:disabled:*` (2).
Kesemuanya berasal daripada shadcn, jadi ia ditulis dan diuji di hulu
dalam mod gelap, tetapi tiada satu pun pernah dirender di sini.
Ia perlukan mata manusia pada borang sebenar.

**Kegagalan yang masih ada dan BUKAN daripada perubahan ini** — identik
sebelum dan selepas:
- 62 daripada 65 ialah huruf fallback avatar (`avatar.tsx`), 3.60-4.19
- `sasaran 5m` pada dashboard, 1.66 dalam mod terang
- dua pautan `text-xs` pada 3.91 dalam mod gelap

`radio-group.tsx` membawa 4 utiliti `dark:` dan **tiada pengguna** dalam
`src/`. Ia tidak boleh diuji kerana ia tidak dirender di mana-mana.

## Carian nama tidak boleh menemui kelas kecacatan ini

`bg-primary/10 text-primary` mengukur 4.19 terang / 3.60 gelap, dan
`bg-primary/20 text-primary` mengukur 3.66 / 3.24. Pasangan itu muncul
**23 kali dalam 18 fail** dan terselamat daripada **lima** pusingan warna
berturut-turut.

Ia terselamat kerana setiap pusingan mencari **nama token**.
`bg-primary-soft` dan `bg-primary/10` menghasilkan permukaan yang hampir
sama dan memerlukan pembetulan yang sama — tetapi hanya satu daripadanya
mengandungi perkataan yang sedang dicari. Pasangan kelegapan mengeja idea
yang sama tanpa sebarang nama yang boleh digrep.

**Pengesan yang betul untuk kelas ini bukan carian nama.** Ia: untuk
setiap pasangan latar-dan-teks yang **dirender**, kira nisbahnya. Harness
pengukuran menangkapnya serta-merta; lima larian grep tidak.

Peraturan yang sama menjelaskan kenapa `--destructive` yang identik dalam
kedua-dua blok mod tidak pernah dilaporkan oleh sesiapa: tiada nama yang
salah, hanya nilai yang salah.

## Penukar berasaskan corak mengedit komen yang menerangkan keadaan lama

Semasa migrasi pasangan di atas, penukar menulis semula `text-primary`
menjadi `text-primary-on-soft` **di dalam komen** yang merekodkan pepijat
bersejarah:

```
// `primary` — so the old `bg-primary/20 text-primary` chip was
// primary-on-primary and invisible.
```

Komen itu menerangkan keadaan **lama**. Menukarnya memadamkan rekod
kenapa pepijat itu wujud, sambil menjadikan ayat itu tidak masuk akal.

Ditangkap sebelum commit dan dipulihkan. Direkod kerana **mana-mana**
penukar berasaskan regex akan melakukan perkara yang sama, dan diffnya
kelihatan tidak mencurigakan melainkan pembaca menyemak baris komen.
Semak diff prosa, bukan hanya diff kod, selepas sebarang penukaran
berskop.

## `tsc` menyapu `.next` — dev sebelum typecheck memberi ralat palsu

`tsconfig.json` menggunakan `include: ["**/*.ts"]` dengan `exclude` yang
menyenaraikan `node_modules`, `project-command-board` dan `tools` sahaja.
`.next` tidak dikecualikan.

Jadi menjalankan dev server dan kemudian `npx tsc --noEmit` dalam worktree
yang sama memberikan ralat dalam `.next/dev/types/validator.ts` — artifak
binaan, bukan kod. `rm -rf .next/dev` membersihkannya.

Sesiapa yang menjalankan dev sebelum gate dalam worktree yang sama akan
terkena, dan ralatnya menunjuk kepada fail yang tiada siapa tulis.

## `radio-group.tsx` membawa empat keputusan yang tidak pernah dilihat

Ia mengandungi empat utiliti `dark:` dan **tiada pengimport di mana-mana
dalam `src/`**. Ia tidak dirender, jadi ia tidak boleh disemak — dan ia
tidak termasuk dalam sapuan pengukuran pembalikan varian atas sebab itu.

Ia akan muncul suatu hari nanti apabila seseorang menggunakannya, membawa
empat nilai mod gelap yang tidak pernah dilihat sesiapa berfungsi.
---

## Empat perkara daripada pusingan i18n `/agents`

**1. `agents/page.tsx` BUKAN kosong.** Ia dilaporkan sebagai mewakilkan
sepenuhnya kepada komponen. Ia tidak: pengesan menemui lima rentetan JSX
di dalamnya — tajuk "AI Agents", ayat huraian, dan ketiga-tiga label tab.
Rentetan komponen memang wujud SEBAGAI TAMBAHAN (26 lagi merentas
ai-playground dan ai-usage), tetapi halaman itu sendiri membawa teksnya
sendiri. Kesemua 31 kini diterjemah.

**2. Contoh pertama dalam `tools/find-untranslated.mjs` tidak berfungsi.**
Docstringnya menunjukkan:

```
node tools/find-untranslated.mjs "src/components/ops/**/*.tsx"
```

Alat itu membaca `process.argv.slice(2)` dan tidak mengembangkan glob
sendiri — ia bergantung sepenuhnya pada shell. Petikan menghalang shell
daripada mengembangkannya, jadi alat menerima corak itu sebagai nama fail
harfiah dan mati dengan `ENOENT: no such file or directory, open
'src/components/ops/**/*.tsx'`.

Contoh KEDUA (tanpa petikan) berfungsi. Laluan dengan kurungan seperti
`src/app/(dashboard)/...` mesti di-escape atau dipetik SEPARA — petikan
penuh memecahkannya dengan cara yang sama.

Perlindungan sifar-fail alat itu bagus dan patut disebut: bila shell
mengembangkan kepada tiada fail, ia mencetak arahan kalibrasi dan bukan
"Total: 0". Ia tidak akan menghasilkan laporan bersih palsu untuk kes itu.

**3. Tab tidak aktif mengukur 4.41:1 dalam mod terang.** Diukur pada
`/agents`, satu-satunya halaman bertab yang boleh dirender tanpa data.
Sedia ada dan tidak berubah oleh kerja i18n — 4.41 sebelum dan selepas.
Ia dalam `components/ui/tabs.tsx` (`text-muted-foreground` pada
TabsTrigger), yang dikongsi dengan `contact-detail-view`. Tidak disentuh:
membetulkannya menyentuh permukaan yang tidak boleh dirender di sini
tanpa data kenalan.

**4. Tarikh carta tidak dilokalkan.** `ai-usage.tsx` memformat label paksi
dengan `format(parseISO(d.date), 'MMM d')` daripada date-fns tanpa locale,
jadi ia menghasilkan "Sep 14" dalam setiap bahasa. Sama untuk mana-mana
`format()` date-fns lain dalam repo. Itu pusingan tersendiri — ia
memerlukan keputusan tentang import locale date-fns, bukan tampalan
katalog.

## Tiga kunci dalam `en.json` memegang teks Melayu

```
Sidebar.ops          "Belum Dibalas"
Header.ops           "Belum Dibalas"
Ops.unanswered.title "Belum Dibalas"
```

`en` ialah **locale sumber**. `src/i18n/request.ts` menetapkan
`SOURCE_LOCALE = 'en'` dan jatuh kepadanya apabila
`NEXT_PUBLIC_APP_LOCALE` tidak sah atau tiada — yang merupakan keadaan
domain hidup **sekarang**. Jadi ketiga-tiga label itu sedang merender
Melayu kepada setiap pelawat.

Ia tidak ditangkap oleh ujian pariti locale, kerana pariti mengira
**kunci** dan ketiga-tiganya ada dalam ketiga-tiga katalog. Ia juga tidak
ditangkap oleh mana-mana audit rentetan, kerana rentetan itu **berada**
dalam katalog — cuma dalam fail yang salah.

Ditemui semasa menyemak dakwaan bahawa 63 kunci `ms` identik dengan `en`.
Kebanyakan daripada 69 yang sebenarnya identik adalah sah — `"Dashboard"`,
`"Inbox"`, `"Admin"`, `"Video"`, `"Status"` ialah perkataan yang sama
dalam kedua-dua bahasa. Ketiga-tiga ini identik atas sebab bertentangan:
bukan `ms` yang belum diterjemah, tetapi `en` yang sudah.

**Pemeriksaan yang akan menangkapnya:** bukan "adakah `ms[k] === en[k]`",
tetapi "adakah `en[k]` mengandungi perkataan yang bukan Inggeris". Yang
pertama menghasilkan 69 hit yang kebanyakannya bunyi bising; yang kedua
menghasilkan tepat 3.

`Sidebar.title` = `"CRM PTMO OPERATION DEPT"` juga identik dan **bukan**
kecacatan — itu nama organisasi, dan nama tidak diterjemah.

## 119 kunci `ko` identik dengan `en`

Seluruh namespace `Ops.unanswered` — kesemua 25 kunci — masih Inggeris
dalam `ko.json`.

Korea **ditangguhkan** sebagai keputusan produk, jadi ini konsisten dengan
keputusan itu dan bukan kecacatan baharu. Direkod supaya ia tidak ditemui
semula sebagai kejutan, dan supaya sesiapa yang membangkitkan sokongan
Korea semula tahu skalanya sebelum menganggarkan.

## Kontras: 37 tapak yang larian automatik tidak akan pernah tunjukkan

`tools/measure-contrast.mjs` menyapu keadaan **rehat** sahaja. Ia tidak
boleh memasuki `hover:`, `focus-visible:`, `aria-invalid:` atau
`disabled:`, kerana tiada cara memaksa keadaan itu pada setiap elemen
halaman dan mengukurnya.

Akibatnya bukan teori. Larian bersih daripada alat itu bermakna "tiada
kegagalan rehat", dan tidak lebih — tetapi laporan yang mengatakan "sifar
kegagalan" dibaca sebagai "tiada kegagalan". Kiraan di bawah diambil
dengan grep kerana grep ialah satu-satunya cara melihat perkara ini.

Diukur pada `cd8204a`.

### Sembilan `hover:text-destructive/80`

    components/interactive/interactive-builder.tsx    ×3
    components/flows/forms/node-config-form.tsx       ×3
    components/flows/header.tsx                       ×1
    components/flows/flow-canvas.tsx                  ×1
    components/flows/flow-builder.tsx                 ×1

Kesemuanya butang buang/padam. Ia ditulis semasa migrasi warna token,
menggantikan `hover:text-red-300` — pasangan tona tangan yang ditala
untuk mod gelap sahaja. `/80` dipilih kerana ia menghasilkan langkah
hover yang kelihatan betul, **bukan kerana ia diukur**.

Nisbahnya tidak diketahui. Alat tidak boleh memberitahu, dan tiada siapa
telah mengukurnya dengan tangan.

### 28 sempadan di bawah `/70` dalam keadaan rehat

Ambang `/70` datang daripada pengukuran QA: `/40` diuji terhadap kad pada
lapan kes dan gagal ambang bukan-teks 3:1 pada kesemuanya — 1.84 hingga
2.50. Sempadan di bawah `/70` belum tentu gagal, tetapi tiada satu pun
telah diukur sejak ambang itu ditetapkan.

     9  border-border/50      contact-detail-view ×5, deal-form ×2,
                              ai-playground, deal-card
     4  border-primary/30     automations/[id]/logs, notifications,
                              step2-select-audience, template-picker
     3  border-primary/40     flow-builder, sidebar, settings/role-meta
     3  border-primary/60     appearance-panel ×2, message-reactions
     2  border-primary/20     step4-schedule-send, ai-thread-banner
     2  border-border/60      media-lightbox, message-media
     1  border-primary/50     flow-builder
     1  border-primary/35     import-modal
     1  border-primary-foreground/50  reply-quote
     1  border-destructive/40 failed-messages-alert
     1  border-destructive/30 settings/password-form

`border-border/50` ialah kes yang paling mungkin **bukan** kecacatan —
`--border` sudah rendah kontras secara reka bentuk, jadi melembutkannya
lagi mungkin disengajakan. Ia disenaraikan kerana ia tidak dibezakan
daripada yang lain tanpa pengukuran.

### 18 lagi di belakang varian

    8  hover:border-primary/50 dan seumpamanya
    5  aria-invalid:border-destructive/50   (input, select, textarea,
                                             radio-group, button)
    4  hover:border-primary/40
    1  hover:border-destructive/40

`aria-invalid:` ialah yang paling membimbangkan daripada kumpulan ini:
ia sempadan yang menandakan medan borang sebagai **tidak sah**, jadi ia
satu-satunya penanda visual bahawa sesuatu perlu dibetulkan — dan ia
muncul hanya dalam keadaan yang alat tidak boleh sapu.

### Apa yang diperlukan untuk menutupnya

Bukan grep yang lebih baik. Sama ada harness yang memaksa keadaan
(`element.classList.add` bagi setiap varian, kemudian ukur), atau satu
pusingan pengukuran tangan terhadap 37 tapak ini.

Sehingga salah satu berlaku, mana-mana laporan kontras hendaklah
mengatakan "tiada kegagalan **rehat**" dan bukan "tiada kegagalan".

## Job "upgrade path" tidak pernah lulus — dan NULL role bukan sebabnya

Ditemui semasa membetulkan `null_role_backfill_test` (14 Sep 2026).

Diagnosis asal — milik aku — ialah: seed menyisipkan profil dengan
`account_role` NULL, mustahil sejak 017:275, dan itu menjatuhkan job.
Separuh pertama betul. Separuh kedua salah, dan cara ia salah penting:
**job mati dua kali sebelum ia sampai ke baris itu.**

Dijalankan secara tempatan, langkah demi langkah, mengikut
`.github/workflows/migrations.yml`:

### 1. Langkah seed tidak boleh berjalan langsung (baris 195)

```
supabase db query --local --file supabase/ci/seed-legacy-state.sql
→ cannot insert multiple commands into a prepared statement
```

`db query --file` menghantar fail sebagai SATU pernyataan bersedia.
`seed-legacy-state.sql` mengandungi lapan INSERT. Ia tidak pernah
melaksanakan walau satu baris — jadi kecacatan NULL role tidak pernah
sempat dicapai, dan tiada seorang pun pernah melihat mesejnya.

Ini sebab yang sama `verify-schema.sql` dan
`grant-platform-privileges.sql` berbentuk satu blok `DO $$`. Seed tidak
mengikut corak itu.

### 2. Seed melawan trigger yang dokumentasinya sendiri bergantung padanya

Selepas menjalankan seed melalui `psql` (yang menerima berbilang
pernyataan), kegagalan seterusnya:

```
ERROR: duplicate key value violates unique constraint "idx_accounts_one_per_owner"
DETAIL: Key (owner_user_id)=(aaaaaaaa-0000-0000-0000-000000000001) already exists.
```

`on_auth_user_created` → `handle_new_user` sudah memperuntukkan satu
akaun dan satu profil untuk setiap baris `auth.users`. Seed kemudian
`INSERT INTO accounts ... ON CONFLICT (id) DO NOTHING` — dan `(id)`
tidak menangkap perlanggaran, yang berlaku pada `owner_user_id`.

`zone_isolation_test.sql:45` menerangkan trigger ini dengan betul dan
bekerja DENGANnya: ia menyisipkan `auth.users` sahaja, kemudian membaca
`account_id` yang trigger cipta. Seed melawannya.

Akibat sampingan yang boleh diperiksa: profil untuk
`aaaaaaaa-...0003` wujud sebagai **`owner`** dengan nama kosong — dibuat
oleh trigger — bukan `viewer` seperti yang seed hasratkan. `ON CONFLICT
DO NOTHING` menyembunyikan perbezaan itu dan bukan melaporkannya.

### 3. `verify-upgrade.sql` menegaskan tentang migration yang diparkir

Tiga blok membaca struktur yang tidak wujud dalam release seperti
yang diskopkan, kerana job upgrade memarkir migration yang menciptanya:

| blok | bergantung pada | dicipta oleh |
|------|-----------------|--------------|
| 044  | `account_members` | 044:110 — diparkir |
| 048  | `broadcasts.whatsapp_config_id` | 048:67 — diparkir |
| 042  | — | lulus secara remeh, tidak membuktikan apa-apa |

Dibuang dalam commit ini, dengan komen yang menerangkan sebabnya.
Yang tinggal — 045 (`member_presence`) dan 047 (bucket storage) — ialah
dua penegasan yang benar-benar menguji release ini.

### Apa yang masih terbuka

Membetulkan (1) dan (2) bukan pembetulan satu baris. Ia:

* membungkus semula seed sebagai satu `DO $$`, **atau** menukar baris
  195 daripada `db query --file` kepada `psql -f` — yang terakhir
  menyentuh `.github/workflows/`, di luar geran batch ini;
* menulis semula bahagian identiti supaya ia membaca apa yang trigger
  cipta dan bukan cuba menciptanya semula.

Dan satu soalan yang mengikutinya: sebahagian besar fixture seed —
empat baris `messages` dengan bentuk media yang berbeza — kini tidak
ditegaskan oleh sesiapa, kerana satu-satunya blok yang membacanya ialah
blok 042 yang dibuang. Fixture tanpa penegasan ialah kos tanpa faedah.
Sama ada penegasan media dipulihkan, atau baris itu digugurkan.

## Soalan release: adakah backfill VIEWER dalam 044 melindungi apa-apa?

**Ini keputusan Boss, bukan keputusan jurutera. Ia dalam repo supaya ia
tidak hilang dalam mesej.**

044 mem-backfill satu baris `account_members` bagi setiap profil,
dengan `viewer` sebagai jaring keselamatan untuk profil yang rolenya
tidak dapat ditentukan.

Penemuan 017 mempersoalkan sama ada jaring itu boleh tertangkap apa-apa:

* 017:122 menambah `profiles.account_role` sebagai nullable;
* 017:275 — **fail yang sama** — menjadikannya `NOT NULL`.

`SET NOT NULL` gagal jika ada satu baris NULL. 017 berjaya pada
produksi. Maka tiada profil tanpa peranan wujud pada masa itu, dan
kekangan telah melarangnya sejak. Invarian itu kini ditegaskan terus
dalam `verify-schema.sql`, dengan alasan yang dinyatakan: profil tanpa
peranan dikunci keluar daripada setiap polisi RLS serentak.

Jadi, atas pembacaan itu, cabang VIEWER dalam 044 ialah kod mati.

Yang aku **tidak** dapat buktikan, dan sebab ini diserahkan ke atas:

1. sama ada produksi memegang profil yang `account_role`-nya sah tetapi
   nilainya di luar set yang 044 tahu petakan — itu bukan NULL, jadi
   hujah di atas tidak menyentuhnya;
2. sama ada 044 pernah dijalankan separa pada mana-mana persekitaran
   sebelum diparkir, meninggalkan `account_members` yang tidak lengkap.

Kedua-duanya boleh dijawab dengan satu pertanyaan read-only terhadap
produksi (`supabase/preflight/` ialah tempatnya). Ia belum dijalankan.

## Baris `messages` dalam seed kini tidak ditegaskan oleh sesiapa

`seed-legacy-state.sql` menulis empat baris `messages` yang memegang URL
bucket awam pra-047. Satu-satunya pembacanya ialah blok 042 dalam
`verify-upgrade.sql`, dan blok itu dibuang bersama dua lagi apabila
042/044/048 diparkir daripada release.

Baris itu **kekal**, dan penegasan yang betul untuk ia bukan penegasan
042. Ia ini: selepas 047, URL tersimpan mesti **masih tidak berubah**.

Itu bukan butiran. Backfill yang akan menulis semula `messages.media_url`
telah **ditarik balik** daripada release kerana SQL tidak boleh
mengesahkan hos storan — pemetaan hidup dalam `resolveStoredMediaUrl()`
pada masa render. Jadi penegasan yang melindungi keputusan itu ialah
"tiada migration menyentuh lajur ini", dan `verify-upgrade.sql` sudah
menegaskan bentuk itu untuk set release.

**Tindakan:** pastikan penegasan negatif itu meliputi baris seed secara
eksplisit, atau baris itu ialah fixture yang tiada apa membaca. Yang
pertama lebih baik — ia menjadikan baris itu membayar sewa.

## Job upgrade tidak pernah sampai ke ujian yang gagal

Dua sekatan berlaku **sebelum** langkah yang dipercayai gagal:

1. `supabase db query --local --file` menghantar seluruh fail sebagai
   **satu prepared statement**, dan Postgres menolak prepared statement
   yang memegang berbilang arahan. Seed yang terdiri daripada lapan
   `INSERT` ditolak sebelum satu baris ditulis.

   Fail `.sql` lain dalam job itu terselamat kerana setiap satunya ialah
   satu blok `DO $$`. Dibetulkan dengan menukar arahan kepada `psql -f`,
   bukan dengan membungkus semula fixture untuk memuaskan alat yang
   salah.

2. Selepas dipaksa melalui `psql`, kegagalan seterusnya ialah
   `idx_accounts_one_per_owner`. Trigger `handle_new_user` sudah
   memperuntukkan akaun dan profil bagi setiap baris `auth.users`, dan
   `ON CONFLICT (id)` tidak menangkap perlanggaran pada `owner_user_id`.

   `zone_isolation_test.sql:45` bekerja **dengan** trigger itu; seed
   melawannya. Itu perbezaan reka bentuk antara dua fail yang kelihatan
   melakukan perkara yang sama.

**Maknanya untuk apa-apa yang dilaporkan sebelum ini:** kegagalan
`null_role_backfill` ialah kegagalan job **bersih**. Job **upgrade**
tidak pernah menjalankan seed langsung, jadi tiada apa yang ia dakwa
sahkan tentang data berbentuk-production pernah disahkan.

## `supabase db reset` tempatan memusnahkan data setiap worktree

Container `supabase_db_wacrm` dikongsi oleh setiap worktree pada mesin
ini. `supabase db reset` dalam mana-mana satu daripadanya menjatuhkan
pangkalan data untuk kesemuanya.

Tiada apa dalam repo mengatakannya, dan tiada apa menghalangnya.
Sesiapa yang memegang data ujian tempatan hendaklah menganggapnya fana
selagi lebih daripada satu sesi berjalan.

## Job upgrade: lima sekatan, bukan satu — kini semuanya hilang

Sambungan kepada bahagian di atas. Selepas psql menggantikan
`db query --file` (8562120), job berjalan lebih jauh dan mendedahkan
tiga sekatan lagi yang tiada siapa pernah lihat, atas sebab yang sama:
setiap satu tersembunyi di belakang yang sebelumnya.

Senarai penuh, mengikut urutan job menemuinya:

1. **`db query --file` menolak seed** — lapan INSERT, satu prepared
   statement. Dibetulkan dalam 8562120 dengan `psql -f`.
2. **Seed melawan `handle_new_user`** — `ON CONFLICT (id)` tidak
   menangkap perlanggaran pada `owner_user_id`. Seed kini membaca akaun
   yang trigger cipta (`seed_zone`) dan meng-UPDATE profil ke dalamnya.
3. **049 berada dalam baseline** — langkah split memindahkan 042-048
   sahaja, jadi "baseline (001-041)" sebenarnya berakhir pada 049. Dengan
   049 sudah direkod, `migration up` menolak keseluruhan langkah: 045-047
   ialah "local migration files to be inserted before the last migration
   on remote database". 049 kini dipindahkan bersama release.
4. **`verify-schema.sql` menegaskan 044 tanpa syarat** — enam penegasan,
   termasuk bahawa `idx_accounts_one_per_owner` telah DIGUGURKAN, yang
   hanya benar selepas 044. Dalam job upgrade 044 diparkir, jadi fail itu
   gagal dengan "migration 044 did not apply" — kenyataan yang benar,
   disengajakan, dan bukan kecacatan. Kini dibungkus dalam
   `IF v_has_044`, dibaca daripada `supabase_migrations.schema_migrations`.
5. **`verify-upgrade.sql` menegaskan tentang tiga migration yang
   diparkir** — dibuang dalam a503493.

### Corak yang menghubungkan kesemuanya

Tiada satu pun daripada lima ini ialah pepijat dalam migration. Semuanya
pepijat dalam **perancah yang sepatutnya menguji migration** — dan
kerana perancah gagal awal, setiap kegagalan menyembunyikan yang
berikutnya. Job yang gagal pada langkah 1 kelihatan sama seperti job yang
lulus langkah 1-4 dan gagal pada langkah 5: kedua-duanya merah.

Itulah sebabnya laporan "kedua-dua job gagal pada null_role" boleh
bertahan begitu lama. Ia bukan salah baca; ia bacaan yang munasabah bagi
satu-satunya isyarat yang ada.

### Penegasan media kini membayar sewa

Empat baris `messages` dalam seed sekali lagi mempunyai pembaca, dan
penegasannya ialah **negatif**: selepas 042-049, `messages.media_url`
mesti kekal bait demi bait seperti yang diseed.

Itu bukan kemasan. Backfill yang akan menulis semula lajur itu ditarik
balik kerana SQL tidak dapat mengesahkan hos storan; pemetaan hidup
dalam `resolveStoredMediaUrl()` pada masa render. "Tiada migration
menyentuh lajur ini" ialah jaminan yang keputusan itu bersandar padanya,
dan penegasan ialah satu-satunya perkara yang mengekalkan jaminan benar
selepas orang yang membuatnya pergi.

Disahkan dengan tiga mutasi, bukan dengan pemerhatian bahawa ia hijau:

| mutasi | hasil |
|--------|-------|
| satu `media_url` ditulis semula | merah, menamakan baris dan kedua-dua nilai |
| satu baris `messages` dipadam | merah, `-> ` kosong |
| `member_presence.tab_id` diubah | merah pada penegasan 045 |

Dan pembungkusan `IF v_has_044` diuji dalam KEDUA-DUA arah: job upgrade
melangkaunya, job bersih masih pergi merah bila `account_members`
dinamakan semula.

## Idempotency butang *Sediakan untuk WhatsApp* tidak tahan perlumbaan

Butang itu mempunyai tiga lapisan perlindungan, dan kesemuanya berada di
**klien**:

1. `findBranchAutomation(automations, code)` — kalau jumpa, keluar
   dengan toast `setupAlreadyDone`
2. `disabled={busy}` semasa permintaan dalam penerbangan
3. sebaik `wired`, butang **digantikan** oleh chip *"Sudah disediakan"*

Lapisan (1) membaca **state klien**, bukan pangkalan data. Dua tab
pelayar, atau dua staf cawangan yang sama, menekan serentak akan **lulus
kedua-dua semakan** dan mencipta dua automasi pada kata kunci yang sama.
Lapisan (2) dan (3) melindungi satu tab sahaja.

Disahkan: **tiada kekangan unik** pada `automations` untuk
`(account_id, kata kunci)`. Indeks yang wujud —
`idx_automations_account_active_trigger`, `idx_automations_user_id` —
kesemuanya bukan-unik.

Akibatnya bukan baris pendua yang tidak kemas. **Dua automasi
`keyword_match` pada kata kunci yang sama bermakna satu mesej ibu bapa
mencetuskan dua `add_tag`**, dan mana-mana langkah lain yang ditambah
kemudian berjalan dua kali.

**Pembetulan sebenar ialah kekangan pangkalan data**, bukan semakan klien
yang lebih baik. Itu bermakna migration `050`, dan migration baharu
diparkir sehingga keputusan dibuat tentang `042`–`048` yang tidak pernah
diapply.

Sehingga itu, risiko boleh diterima kerana penekan ialah admin dan
bilangan cawangan ialah 16 — tetapi ia mesti dinyatakan, bukan
dianggap selesai kerana tiga lapisan kedengaran banyak.

## `QualityBanner`: komennya mendakwa lebih daripada yang kod lakukan

```
GREEN    CheckCircle2     senyap
YELLOW   AlertTriangle    loud
RED      AlertTriangle    loud
UNKNOWN  XCircle
```

Komen fail itu berkata *"each state has its own icon, which is what makes
it work in greyscale and for a colourblind reader"*.

Kuning dan Merah **berkongsi** `AlertTriangle`. Maklumat tidak hilang —
label perkataannya berbeza dan kedua-duanya mendapat layanan `loud` —
tetapi dalam greyscale mereka dibezakan oleh **label sahaja**, dan niat
yang dinyatakan hanya separuh dipenuhi.

Ini bukan kemasan. `quality_rating` ialah satu-satunya isyarat awal
bahawa nombor WhatsApp akan disekat, dan Kuning lawan Merah ialah
perbezaan antara *"perhatikan"* dan *"berhenti menghantar"*.
## Pengasingan zon kini diuji dalam KEDUA-DUA pelaksanaan

Sekatan keenam dan ketujuh, dan keputusan yang datang bersamanya.

`zone_isolation_test.sql` gagal dalam job upgrade dengan
`relation "account_members" does not exist` — ia ditulis untuk dunia
pasca-044, dan job upgrade memarkir 044.

Pilihan yang paling mudah ialah melangkau keseluruhan suite di sana.
Ia ditolak: job yang membina pangkalan data **berbentuk production**
akan menjadi satu-satunya job yang tidak menguji pengasingan zon — dan
production berjalan pada laluan pra-044 **hari ini**.

### Kenapa mencabangkannya boleh dilakukan langsung

Kedua-dua pelaksanaan menjawab soalan yang sama bagi pengguna satu zon:

| | apa yang disemak |
|---|---|
| 017 | target IALAH akaun profil saya, dan peranan profil saya cukup tinggi |
| 044 | saya memegang baris `account_members` untuk target, **DAN** target ialah zon AKTIF saya, dan peranan baris itu cukup tinggi |

Bagi seseorang yang tergolong dalam satu zon, itu predikat yang sama
melalui dua laluan. Maka 20 daripada 25 penegasan ditulis sekali dan
berjalan dalam kedua-dua dunia.

Lima yang tidak boleh ialah yang tentang tergolong dalam zon KEDUA —
`is_account_member_any()` dan empat di sekeliling `set_active_account()`
— kerana pra-044 tiada tempat untuk merekod keahlian kedua. Ia di-`skip`,
bukan dipadam: plan kekal 25 dan larian menyebut dengan kuat apa yang ia
tidak semak.

Jurang yang tinggal sempit dengan sengaja: yang tidak diuji pra-044
hanyalah keupayaan BERGERAK antara zon, yang production pra-044 memang
tidak ada. Sempadan zon itu sendiri diuji di kedua-dua belah.

### Dibuktikan dengan melebarkan fungsi, bukan dengan memerhati hijau

`is_account_member()` versi 017 dilebarkan dengan membuang padanan
`account_id` dan mengekalkan peringkat peranan:

| keadaan | penegasan merah |
|---------|-----------------|
| 017 dilebarkan | **15** daripada 20 yang dikongsi |
| 017 dipulihkan | 0 |

Kebocoran yang dilaporkannya boleh dibaca terus:
`have: Ibu Bapa Ujian, Ibu Zon A, Ibu Zon B` — satu zon membaca ibu bapa
zon lain, tepat kelas kegagalan yang fail ini wujud untuk menangkap.

Pembungkusan `\if :has_044` guna psql, bukan `CASE` SQL. PostgreSQL
menyelesaikan nama fungsi ketika ia mem-PARSE pernyataan, jadi cabang
`CASE` yang menyebut `set_active_account()` tetap gagal dengan "function
does not exist" pada pangkalan data tanpa 044, walaupun cabang itu tidak
pernah diambil. `\if` tidak menghantar baris itu langsung.

### Sekatan ketujuh, ditemui semasa membetulkan keenam

Seed suite itu menyapu **setiap** baris dalam pangkalan data:

```sql
INSERT INTO conversations (...) SELECT c.account_id, c.user_id, c.id FROM contacts c;
```

Job upgrade menjalankan pgTAP terhadap pangkalan data yang
`seed-legacy-state.sql` sudah isi, jadi `FROM contacts` tanpa skop
menyapu ibu bapa fixture itu juga — yang sudah ada conversation — dan
INSERT mati pada `idx_conversations_account_contact`.

Suite itu ditulis terhadap pangkalan data kosong dan hanya pernah
berjalan terhadap satu. Ketiga-tiga INSERT seednya kini berskop kepada
dua zonnya sendiri.

### Kiraan setakat ini

Tujuh sekatan, tiada satu pun pepijat dalam migration. Semuanya dalam
perancah yang sepatutnya menguji migration. Andaian bahawa tujuh ialah
yang terakhir mempunyai rekod yang sama seperti lima dan enam.

## Ujian "senarai kosong" yang saya cadangkan tidak menguji apa-apa

Saya mencadangkan: buka halaman Flows atau Automations sambil log masuk;
kalau klien admin ialah anon-tanpa-sesi, senarai kembali kosong.

Kedua-dua senarai **memang** kosong. Ia tidak bermakna apa-apa, kerana
**tiada satu pun daripada dua halaman itu menggunakan klien admin untuk
membaca**:

```
/automations   membaca /rest/v1/automations terus — klien PELAYAR,
               dengan sesi, melalui RLS. Laluan API hanya disentuh
               untuk mutasi (toggle, duplicate, delete).
GET /api/flows menggunakan guard.supabase — klien KUKI.
               supabaseAdmin() muncul pada baris 99, di dalam POST.
/api/flows/templates  memulangkan pemalar kod, bukan bacaan DB.
```

Jadi kedua-dua senarai kosong ialah bacaan berskop-RLS dengan sesi sah,
pada akaun yang memang tiada baris. **Hasil yang betul, dan ia tidak
membezakan apa-apa.**

Ujian itu dicadangkan berdasarkan andaian tentang seni bina laluan yang
tidak disemak. Ia kelas kesilapan yang sama yang menghantar sesi ke
`avatar.tsx` yang tidak perlukan perubahan, dan yang menamakan
`text-muted-foreground` sebagai kelas yang gagal dalam `tabs.tsx`:
**mencadangkan diagnosis tanpa membuka fail.**

**Ujian yang betul ialah lima saat dan tidak menyentuh pangkalan data:**
buka tetapan Environment Variables Vercel dan bandingkan
`NEXT_PUBLIC_SUPABASE_ANON_KEY` dengan `SUPABASE_SERVICE_ROLE_KEY`.
Kalau ia berbeza di sana, seluruh isu ini ialah kecacatan pembangunan
tempatan.

Larian tempatan tidak boleh menjawab soalan tentang deployment, tidak
kira berapa banyak baris ditulis untuk mencubanya.

**Tambahan:** kedua-dua kunci bukan JWT — tiada struktur tiga-bahagian
berpisah-titik. Jadi ini bukan *"JWT yang salah di slot yang salah"*; ia
**satu** kunci publishable gaya baharu disalin ke **kedua-dua** slot.

## Langkah `wait` dalam automasi tidak akan pernah berjalan

`engine.ts:282` menulis baris ke `automation_pending_executions` apabila
langkah `wait` dicapai. Baris itu diproses oleh
`GET /api/automations/cron`, dan **tiada apa memanggil laluan itu**.

Tiada `vercel.json` dalam repo, jadi tiada cron Vercel dikonfigurasi.
Automasi dengan langkah kelewatan berhenti di situ secara kekal — bukan
gagal, **berhenti**, tanpa ralat dan tanpa apa-apa pada skrin.

**Dan laluan itu tidak serasi dengan Vercel Cron seperti ditulis.**
Ia menjangka header `x-cron-secret`. Vercel Cron menghantar
`Authorization: Bearer $CRON_SECRET` dan **tidak boleh menghantar header
tersuai**. Jadi menambah `vercel.json` sahaja tidak mencukupi — laluan
itu perlu menerima kedua-dua bentuk, atau penjadual luar diperlukan.

Sama untuk `GET /api/flows/cron`.

**Kesan kepada migrasi WhatsApp:** automasi auto-tag cawangan
(`keyword_match` → `add_tag`) **tiada langkah wait**, jadi migrasi itu
sendiri tidak terjejas. Ini menggigit pada automasi kedua yang sesiapa
bina dengan kelewatan — susulan, peringatan, apa-apa yang berkata
*"tunggu sejam kemudian"*.

## `WHATSAPP_TEMPLATES_DRY_RUN` ialah perangkap senyap dalam production

Apabila ditetapkan kepada `true` atau `1`, penyerahan templat **tidak
pernah sampai kepada Meta**. Ia menerima ID rekaan
(`dry-run-<uuid>`) dan status `PENDING`.

Jadi UI menunjukkan templat diserahkan dan menunggu kelulusan, dan Meta
tidak pernah mendengar tentangnya. Ia akan kekal `PENDING` selama-lamanya
dan tiada apa akan mengatakan sebabnya.

Pembolehubah itu mesti **tidak ditetapkan** pada production, bukan
ditetapkan kepada `false`. Nilai lain daripada `true`/`1` selamat, tetapi
kehadirannya menjemput seseorang menukarnya.

## `META_APP_ID` hanya diperlukan untuk templat berkepala imej

`template-header-handle.ts:37` **melempar** dengan mesej yang
menerangkan dirinya kalau ia hilang — tetapi hanya untuk templat dengan
kepala imej. Templat teks tidak menyentuhnya.

Gagal lantang dengan arahan ialah tingkah laku yang betul; direkod supaya
tiada siapa menganggapnya pembolehubah wajib.

## Actions masih tidak tercetus oleh `push` — dan arahan saya salah tempat

Saya memberitahu Boss untuk membetulkannya di **Settings → Actions**.
Selepas itu dibetulkan, keadaannya tidak berubah.

Bukti, dikumpul selepas sembilan merge ke `main`:

```
events API        PushEvent refs/heads/main   ✓ sampai ke GitHub
                  PullRequestEvent            ✓ sampai
actions/permissions  enabled: true, allowed_actions: all
workflows            CI active, Migrations active
larian sebenar       9 daripada 9 ialah workflow_dispatch
                     0 daripada push, 0 daripada pull_request
```

Jadi peristiwa **sampai**, workflow **aktif**, kebenaran **didayakan**,
dan tiada satu pun peristiwa memulakan larian. Hanya dispatch manual.

**Asimetri itu sendiri ialah petunjuknya.** Kalau workflow dimatikan,
dispatch akan gagal juga. Kalau pencetus salah, YAML akan menunjukkannya
— ia tidak; `push: branches: [main]` ada pada `main` tanpa penapis
laluan.

Corak "dispatch berfungsi, peristiwa tidak" ialah keadaan **fork yang
belum didayakan**. Repo ini fork bagi `ArnasDon/wacrm`.

**Butang untuk itu bukan dalam Settings.** Ia sepanduk pada **tab
Actions** sendiri — *"Workflows aren't being run on this forked
repository"* dengan butang untuk mendayakannya. Tetapan kebenaran dalam
Settings ialah skrin yang berbeza, dan membetulkannya tidak menjelaskan
sepanduk itu.

**Cara mengetahui tanpa meneka:** buka tab Actions. Kalau sepanduk itu
ada, itu jawapannya. Kalau tiada, punca sebenar masih tidak diketahui
dan perlu disiasat semula — jangan anggap hipotesis ini betul kerana ia
munasabah.

Ini bukan blocker: setiap gate boleh dicetuskan dengan
`gh workflow run "<nama>" --ref main`, dan itu yang telah dilakukan
sepanjang hari. Kosnya ialah tiada siapa akan perasan gate merah tanpa
seseorang mencetuskannya dengan tangan.

## Lampiran gagal lantang, avatar gagal senyap — dan itu tidak simetri

Selepas 047 menjadikan bucket peribadi, dua jenis media boleh gagal, dan
mereka gagal dengan cara yang sangat berbeza.

**Lampiran gagal lantang.** `message-media.tsx:152` memasang
`onError={() => setBroken(true)}`, dan baris 130 merender
`t("unavailable", { label })`. Imej yang gagal menjadi **mesej yang
kelihatan**, bukan ikon imej rosak. Staf akan melihatnya dan
melaporkannya.

**Avatar gagal senyap.** `ui/avatar.tsx` tiada pengendali ralat langsung.
`AvatarImage` base-ui jatuh ke `AvatarFallback` secara automatik, jadi
avatar yang rosak merender **inisial** — identik dengan pengguna yang
tidak pernah memuat naik gambar.

Akibatnya: kalau 047 memecahkan media, aduan tentang **lampiran** akan
tiba dalam beberapa minit, dan aduan tentang **avatar** mungkin **tidak
pernah tiba**.

**Maka "tiada aduan" bukan bukti avatar berfungsi.** Ia mesti disemak
secara eksplisit oleh seseorang yang mempunyai akaun dengan gambar
profil. Sandaran automatik itu ialah tingkah laku yang betul untuk
avatar yang tiada; ia hanya bermasalah kerana ia **tidak boleh dibezakan**
daripada avatar yang pecah.

Tidak diubah. Menambah pengendali ralat kepada avatar akan menukar rupa
setiap baris inbox untuk memburukkan satu kes, dan pertukaran itu bukan
jelas. Direkod supaya ketiadaan aduan tidak dibaca sebagai kesihatan.

## Akaun ujian tidak boleh menjawab soalan selepas-047

Akaun ujian mempunyai **sifar perbualan**, jadi sifar lampiran, dan
pengguna ujiannya tiada `avatar_url`. Satu-satunya imej pada halaman
inbox ialah `/brand/minda-optima-mark.png` daripada `/public` — bukan
bucket Supabase langsung.

Jadi soalan *"adakah lampiran pra-047 masih render"* **tidak boleh
diperhatikan** di sana, tidak kira berapa teliti seseorang melihat.

Yang **boleh** disahkan, dan telah:

```
tanpa sesi   401 pada kelima-lima laluan proksi
dengan sesi  404 {"error":"Not found"}            objek tiada
             404 {"error":"Unknown media bucket"} bucket tak dikenali
```

Tiada 500, tiada throw, dan bucket tidak dikenali mendapat mesejnya
sendiri — jadi laluan itu membezakan *"bukan bucket kita"* daripada
*"tiada objek"*. Mesin itu berfungsi.

`proxy-url.test.ts` meliputi tepat laluan legasi, termasuk semakan hos
yang menjadi sebab backfill ditarik balik. Tetapi itu ujian unit
terhadap **rentetan** — bukan baris sebenar dalam `messages.media_url`
menyelesai kepada objek sebenar dalam bucket peribadi.

**Soalan yang menjawab semuanya** ialah seksyen 4 preflight storage:
berapa baris `messages` memegang URL bucket awam pra-047. Kalau
jawapannya sifar, laluan legasi tidak pernah dilalui dalam production dan
risiko ini tidak wujud.

## `main` dan domain telah berpisah — deploy tidak berlaku sendiri

`/issues` wujud dalam `main`, dibina secara tempatan (`npx next build`
menyenaraikan `/issues` dan `/issues/[id]`), dan memulangkan **404** pada
`crm.ptmostaff.com`.

Bukan masalah cache: diuji dengan parameter query rawak, lapan kali
merentas enam minit. Dan ia bukan kegagalan laluan am — laluan sedia ada
berkelakuan betul:

```
/login             200
/forgot-password   200
/ops/unanswered    307   dilencongkan oleh middleware
/flows             307   dilencongkan oleh middleware
/issues            404   tidak wujud dalam build yang disajikan
```

`/issues` **ada dalam `protectedPaths`** pada `main`, jadi kalau build
yang disajikan membawanya, ia akan memulangkan 307 seperti dua yang lain
— walaupun halaman itu tiada. 404 bermakna **middleware yang disajikan
tidak mengenalinya**, jadi deployment itu lebih lama daripada commit itu.

**Ini berpasangan dengan penemuan Actions.** Kedua-dua automasi projek ini
bergantung padanya tidak menembak sendiri:

```
GitHub Actions   9 push ke main -> 0 larian; hanya workflow_dispatch
Vercel           beberapa merge ke main -> deployment tidak berubah
```

Setiap deploy yang berjaya hari ini berlaku selepas Boss menekan redeploy
dengan tangan — locale Melayu dan kunci service-role kedua-duanya
mendarat sedemikian, dan kedua-duanya diterangkan sebagai "redeploy"
dalam laporannya.

**Tidak boleh disahkan dari sini:** sesi ini tidak boleh membaca Vercel
(CLI tidak log masuk, dan log masuk itu interaktif). Jadi antara *deploy
tidak dicetuskan* dan *deploy dicetuskan dan gagal* tidak boleh
dibezakan tanpa membuka papan pemuka.

Dua sebab yang berbaloi disemak di sana, mengikut susunan:
1. **Auto-deploy dimatikan** pada projek yang menyajikan domain
   (`crmfinal_ptmo`), atau ia disambungkan kepada cabang selain `main`.
2. **Projek pendua.** Dua projek pernah disambung ke repo ini. Kalau
   `ptmo-crm` yang membina pada merge dan `crmfinal_ptmo` yang memegang
   domain, setiap merge membina projek yang salah.

Sehingga ini diselesaikan, **setiap perkara yang mendarat dalam `main`
tidak hidup sehingga seseorang menekan redeploy**. Itu bukan keadaan yang
selamat untuk hari nombor WhatsApp disambung: laluan webhook masuk berada
dalam kod yang di-deploy, bukan dalam `main`.

## Punca sebenar: kuota build Vercel habis — dan cara kerja saya yang menghabiskannya

Domain berhenti mengemas kini pada **cd1f2b4, 14:37**. Setiap push
selepas itu gagal dengan sebab yang sama, dan GitHub memegang jawapannya
sepanjang masa:

```
Vercel – crmfinal_ptmo   failure   Deployment rate limited — retry in 24 hours.
Vercel – ptmo-crm        failure   Deployment rate limited — retry in 24 hours.
```

Bukan auto-deploy dimatikan. Bukan cabang salah. **Kuota harian habis.**

### Dua sebab, dan yang pertama milik saya

**1. Cara kerja saya membakar satu build setiap perubahan, dua kali.**

56 PR digabung hari ini. Setiap satu ialah *push cabang* → *PR* →
*merge ke main* — jadi **dua** peristiwa boleh-deploy setiap perubahan.
Itu kira-kira 112 build daripada satu projek sahaja.

Saya memilih corak itu kerana ia memberi setiap perubahan badan PR yang
boleh dibaca dan titik pemulangan. Itu masih betul untuk perubahan yang
besar. Ia salah untuk **lima puluh enam** daripadanya dalam satu hari,
dan tiada apa dalam gelung saya pernah menyemak kos deploy — saya
mengukur lint, tsc, ujian dan build, dan tidak pernah kuota.

**2. Dua projek bersambung ke satu repo menggandakan setiap build.**

`crmfinal_ptmo` **dan** `ptmo-crm` kedua-duanya membina pada setiap push.
Ini direkod sebagai kemasan berminggu-minggu lalu — *"putuskan yang tidak
diguna"* — dan dibiarkan kerana ia kelihatan kosmetik.

Ia tidak kosmetik. Ia **menggandakan kadar pembakaran**, jadi had yang
sepatutnya bertahan sehari habis dalam setengah hari.

### Yang membetulkannya

1. **Putuskan projek Vercel pendua.** Satu repo, satu projek. Ini
   memotong penggunaan separuh dan ia percuma.
2. **Tunggu tetapan semula 24 jam**, atau naik taraf kalau hari esok
   memerlukan deploy.
3. **Berhenti menggabungkan setiap perubahan secara berasingan.**
   Kumpulkan kerja yang berkaitan menjadi satu PR. Badan PR yang baik
   masih boleh menerangkan enam commit.

### Apa yang tidak berlaku, dan tidak akan

Tiada apa hilang. Setiap commit ada dalam `main`, gate hijau, dan CI
Migrations hijau. Yang tertunggak hanyalah **deploy**, dan ia akan
berlaku pada push pertama selepas kuota kembali.

Sehingga itu, **`main` dan domain berbeza**, dan laluan webhook masuk
berjalan daripada build yang di-deploy. Itu mesti diselesaikan sebelum
nombor WhatsApp disambung.
