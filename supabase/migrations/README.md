# Migration ledger

There is no automatic record of what has been applied to the production
database. Supabase's own migration table was never the source of truth
here, because two migrations were applied by hand through the SQL editor
rather than by the CLI. This file is the ledger. **Update it in the same
commit that adds or applies a migration.**

## State as of 2026-09-13

| Range | In `main` | In `feat/multi-number` | Applied to production |
| --- | --- | --- | --- |
| `001` – `039` | yes | yes | yes, by CLI |
| `040`, `041` | **no** | yes | **yes, by hand** |
| `042` – `049` | no | yes | no |

Production schema is therefore at **041**. Production *code* is at
`main`, which contains no migration past 039 — the schema is ahead of
the code, which is the safe direction, because 040 and 041 are additive
and the older code ignores the columns they add.

### Why 040 and 041 are missing from `main`

They were written on `feat/multi-number` and applied straight to the
production database to unblock work, before the branch was ready to
merge. The files were never on `main`, so a reader of `main` alone
cannot reconstruct the live schema — and `supabase db reset` against a
checkout of `main` produces a database that does not match production.

Migration 045's header records the same fact from the other direction:
it deliberately restates 041's column and index with `IF NOT EXISTS`
guards, "so this migration stands alone if 041 never ran", because 041's
state could not be confirmed from the repo.

**Do not modify 040 or 041.** They are live. Anything they got wrong is
corrected by a new migration, never by editing the file.

### Restoring the ledger to source control

Nothing needs to be recovered from a backup: both files are present and
tracked on `feat/multi-number` at

```
supabase/migrations/040_multi_number_per_account.sql
supabase/migrations/041_presence_viewing_conversation.sql
```

They reach `main` when this branch merges. That merge is what makes
`main` able to rebuild production's schema from scratch again, and it
must land **before** 042–049 are applied anywhere, so that the file
order in source control matches the order of application.

## The unapplied set

Apply in filename order. `supabase/preflight/` holds two read-only
queries to run against production first; they answer the questions the
CI replay cannot, because CI only ever builds from an empty database.

| # | What it does | Class |
| --- | --- | --- |
| `042` | One conversation thread per (account, contact, number) | data-changing — executes a merge that deletes rows |
| `043` | Quick replies can be pinned to a branch | additive |
| `044` | Multi-zone membership; redefines `is_account_member()` | security-critical + data-changing |
| `045` | Presence keyed per browser tab | additive |
| `046` | Locks four `SECURITY DEFINER` functions to `service_role` | security-critical |
| `047` | Makes the three storage buckets private | security-critical |
| `048` | Broadcasts remember their number; RPC gains a parameter | data-changing |
| `049` | Centres and regions become real tables | additive |

### Code coupling

Two of these break the running application if applied out of step with
a deploy:

- **047** — apply *after* the code deploy. Alone it breaks media
  rendering, and the render-time compatibility described below is what
  the deploy brings.
- **048** — the 8-argument RPC is dropped and replaced by a 9-argument
  one. The old build breaks the moment it lands; the new build breaks
  until it lands. There is no ordering without a window; keep it short.

### Legacy attachments are handled in code, not by a migration

Rows written before 047 hold an absolute public-bucket URL that stops
resolving once the buckets go private. `resolveStoredMediaUrl()` in
`src/lib/media/proxy-url.ts` maps those onto the media proxy at render
time, so the attachments stay readable without touching the stored data.

A backfill migration that rewrote `messages.media_url` in place was
written and then **withdrawn from this release**. Doing the mapping in
SQL means doing it without the one check that makes it safe: the
database cannot tell our storage host from any other
`*.supabase.co`, so a row holding a URL from a different project would
have been rewritten into a pointer at OUR bucket. The TypeScript path
validates the host against `NEXT_PUBLIC_SUPABASE_URL` before it maps
anything, and refuses everything else.

The consequence is deliberate and should be stated plainly: after this
release the stored value stays a dead absolute URL, and the application
is what makes it work. Anything reading `messages.media_url` without
going through `resolveStoredMediaUrl()` will see a link that 400s. If
the data itself is ever to be corrected, the backfill must first be
given a host check of its own.

## Verification

- `.github/workflows/migrations.yml` replays every migration against an
  empty database, then asserts the schema and runs the pgTAP suites.
- The same workflow's **upgrade path** job replays `001`–`041`, seeds
  production-shaped rows, and only then applies `042`–`049`. That is the
  job that exercises the backfills, because a blank database has nothing
  to backfill.

Both must be green before anything is applied to production.

## 049 is not pilot-ready, and must not be counted as such

Migration 049 creates `regions` and `centres` and adds
`contacts.centre_id`. It is additive, low-risk, and correct. It is also
**not a working feature**, and the release plan should not treat it as
one.

`contacts.centre_id` has no writer. Nothing in `src/` reads or writes
it — `grep -rn "centre_id" src/` returns only the settings panel, which
touches the `centres` table, never the link to a Parent. `Contact` in
`src/types/index.ts` does not expose the field either.

So after 049 a Centre can be created, listed and deleted. A Parent
cannot be assigned to one. The column that the whole migration was
written to establish — the one that survives the WhatsApp number model
changing — is present and permanently empty until that code exists.

What this means in practice:

- 049 may ship with the release. It breaks nothing and blocks nothing.
- A pilot can verify that Centres and Zones can be **entered**, and that
  deleting a Zone keeps its Centres.
- A pilot **cannot** verify that the centre model works, because the
  only thing that would make it work is not built.

Do not describe Centres as ready until `contacts.centre_id` is written
by the application and a Parent can be seen to belong to a branch.
