# Zones — HQ multi-zone access

PTMO runs as several **zones** (A, B, C, D). Each zone is a separate
Supabase account. Zone staff see only their own zone. A few HQ people
belong to every zone and switch between them to answer any of them.

This document explains the design, and — more importantly — what breaks
if you change it. The reasoning is not obvious from the code, and one
line in particular looks redundant while being the only thing holding
tenant isolation together.

## The shape

Two questions were being answered by one column, `profiles.account_id`.
They are now separate:

| Question | Where it lives |
|---|---|
| Which zones may I enter, and as what? | `account_members` (durable) |
| Which zone am I looking at right now? | `profiles.account_id` (momentary) |

A **zone** is an account. A **centre** is a `whatsapp_config` row within
it — one WhatsApp number each (migration 040). So a zone holds many
centres, and a parent who messages two zones exists as two separate
contact rows, because `contacts` is account-scoped with a unique index
on `(account_id, phone_normalized)` (migration 022).

Switching zones is one RPC, `set_active_account(uuid)`. It validates
membership, then repoints `profiles.account_id` and refreshes the cached
`profiles.account_role`.

## The load-bearing line

`is_account_member(target_account_id, min_role)` still means *my active
zone*. Its body reads the role from `account_members`, but this condition
remains:

```sql
AND p.account_id = target_account_id   -- ACTIVE ZONE
```

It looks redundant — we already joined `account_members`, so why also
require the target to be the zone the user is currently in?

Because roughly **119 RLS policies** call this one function, and large
parts of the application query their tables with **no `account_id` filter
at all**:

- ~41 client-side Supabase mutations in `src/components/**` and
  `src/app/(dashboard)/**`
- all of `src/lib/ops/`
- `src/lib/dashboard/queries.ts`

Those are correct today *only* because this function narrows them to a
single account. Remove the ACTIVE ZONE line and every one of them
silently starts returning rows from every zone the user belongs to.
Nothing throws. No test goes red. Zone A staff simply begin seeing
Zone B parents.

This is why the design keeps RLS **fail-closed** rather than widening it
and re-narrowing in the application. Widening is not recoverable by code
review: it takes one forgotten filter in one of forty-one places.
Staying fail-closed needs no review at all.

`supabase/tests/zone_isolation_test.sql` proves this. Removing the
ACTIVE ZONE condition turns **8 of 25 assertions red**, including the
core one.

## Cross-zone reads

The HQ roll-up dashboard is deliberately **not** served by these
policies. Cross-zone reads go through purpose-built `SECURITY DEFINER`
RPCs that check membership via `is_account_member_any()` and return
**aggregates only** — never raw rows.

`is_account_member_any()` must never appear in a `CREATE POLICY`. It
exists for exactly two callers: the zone switcher (may I move here?) and
those aggregate RPCs (may I count this zone?).

## Ownership

`UNIQUE(owner_user_id)` on `accounts` was dropped, deliberately. One
person owning all four zones is the intended operating model, and
recovery depends on it: if a zone lead loses access, the owner is the
only one who can restore it.

This diverges from upstream `wacrm`, which assumes one account per user.
Expect a merge conflict here, and keep the reasoning rather than the
upstream constraint. `supabase/ci/verify-schema.sql` asserts the index
stays gone, so a re-run of 017 or an upstream merge that re-creates it
fails CI instead of quietly blocking multi-zone ownership.

## Known limitation: one active zone per user, not per tab

The active zone lives in the database, so it is shared across every tab
that user has open. Switch zones in one tab and the others are pointing
somewhere else without knowing.

This is the direct cost of keeping RLS fail-closed — a cookie or header
cannot reach RLS, and anything RLS cannot see cannot be trusted to scope
a query. The mitigation is a client-supplied `X-Zone-Id` header on write
paths, compared server-side against the real active zone, returning
**409** on a mismatch so a stale tab cannot reply into the wrong zone.

Realtime subscriptions must be torn down and rebuilt on a zone change,
and cached state cleared — `usePresence` calls `setRows(new Map())` when
`accountId` changes. The database will not serve the old zone's rows
after a switch, but stale client state can still display them.

## Migrations

| # | What |
|---|---|
| 040 | one account, many numbers — a centre is a `whatsapp_config` row |
| 041 | `member_presence.viewing_conversation_id` — who has a thread open |
| 042 | one thread per (account, contact, number), not per (account, contact) |
| 043 | branch-aware quick replies |
| 044 | `account_members`, `set_active_account`, `my_accounts` — this document |
| 045 | presence keyed per tab |
| 046 | lock four `SECURITY DEFINER` functions that were callable by anyone |
| 048 | `broadcasts.whatsapp_config_id`, so a resumed broadcast keeps its number |

## If you change this

Run `supabase test db --local supabase/tests` before and after. If your
change does not turn assertions red when you break the ACTIVE ZONE
condition on purpose, the suite is not testing what you think it is.
