# Open findings — handover

Six parallel audits ran against this repo on 2026-09-12 and landed 18
commits. What follows is what they found and did **not** fix. Every item
was re-verified against `78a71ef` before being written down, not recalled
from memory — but nothing here has been fixed, so verify again before
acting.

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

### Middleware does not gate every authenticated route

`src/middleware.ts:73`

`protectedPaths` is `['/dashboard', '/inbox', '/ops', '/contacts',
'/pipelines', '/broadcasts', '/automations', '/settings']`. Missing:
**`/flows`, `/agents`, `/notifications`**.

The API gate is also a substring match on `includes('/webhook')` rather
than a real allowlist, and there is no Origin/Referer check on non-GET
`/api` requests.

### Password reset lands on a 404

`/auth/callback` was added, which fixed the first half of the
forgot-password flow. But `forgot-password` sends users to
`/auth/callback?next=/reset-password`, and **`src/app/(auth)/reset-password`
does not exist**.

So a reset link now fails one step later than before. This reads as a
regression to anyone testing it who has not read commit `62a8263`, where
it is disclosed.

### Realtime is never rebuilt when the active zone changes

`src/hooks/use-realtime.ts:82`, `src/app/(dashboard)/inbox/page.tsx:363`

`useRealtime` subscribes to `messages` and `conversations` with **no
filter**, under a **static** `channelName` of `"inbox-realtime"`, with
deps `[channelName, enabled]`. Nothing in that list changes when the user
switches zones, so the channel is never torn down.

RLS still refuses to serve the other zone's rows, so this is **not** a
data leak — it is UI correctness. But the conversation list, messages and
unread counts are not cleared on a zone switch, so the previous zone's
rows stay rendered until something else replaces them.

`usePresence` already handles this shape correctly (it calls
`setRows(new Map())` when `accountId` changes). The inbox path needs the
same treatment: put `accountId` in the channel name, add it to the deps,
and clear cached state on change.

### Broadcasts can still strand

`src/hooks/use-broadcast-sending.ts:402`

Migration 048 fixed half of this — `whatsapp_config_id` is now a
parameter, so the 400 `ambiguous` is gone. But the `broadcasts` row is
still inserted with `status: 'sending'` **before** the first API call, so
a failure still leaves a campaign permanently stuck in `sending`.

Fix: insert as `'draft'`, flip to `'sending'` after the first successful
send.

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

`dashboard-shell.tsx:44` uses `h-screen overflow-hidden` and
`inbox/page.tsx:583` uses `h-[calc(100vh-3.5rem)]`. There is **no `dvh`
anywhere in the repo**.

On iOS Safari, `100vh` includes the area behind the browser toolbar.
Combined with `overflow-hidden`, the bottom of the layout — the composer
and the send button — sits under the toolbar and cannot be scrolled to.
Branch staff on phones cannot see the send button.

Two files, and it restores basic function.

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
