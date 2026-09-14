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

### Tiga daripada empat halaman auth tiada i18n langsung

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
