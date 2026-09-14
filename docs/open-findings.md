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
