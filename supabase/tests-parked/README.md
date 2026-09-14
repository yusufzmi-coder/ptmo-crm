# Parked tests

`supabase test db --local supabase/tests` runs the directory it is given
and nothing else, so a file here is not executed by either job of
`.github/workflows/migrations.yml`. That is the point: this is the test
equivalent of the `/tmp/parked` step that holds 042, 043, 044 and 048
back from the release.

A file belongs here when it tests something the release does not apply,
or when its premise turns out not to hold. Not when it is inconvenient.

---

## null_role_backfill_test.sql

Parked for both reasons at once.

**It tests a migration that is not in the release.** It exercises 044's
backfill, and 044 is one of the four held back. A test measuring a
migration no database will run measures nothing.

**Its premise does not hold either way.** The file seeds a profile with
`account_role = NULL` to represent what an unhardened backfill would
leave behind. That row cannot exist:

```
017:122   ADD COLUMN account_role account_role_enum   -- nullable
017:275   ALTER COLUMN account_role SET NOT NULL      -- same file, 153 lines later
```

The header cites 017 for the nullable half and stops there. Confirmed on
a fully replayed database: `is_nullable = NO`. No `DROP NOT NULL` on that
column exists anywhere in the repo.

`ALTER COLUMN SET NOT NULL` fails if any row is NULL, so 017 succeeding
on production — which sits at 041 — proves no such row existed then, and
the constraint has forbidden one since.

**What replaced it.** Deleting this outright would have dropped real
coverage, so `supabase/ci/verify-schema.sql` now asserts the invariant
directly: `profiles.account_role` must be NOT NULL. That check bites on
the way the state could actually return — somebody writing
`DROP NOT NULL` — which is what this file was reaching for.

**The open question it leaves.** If the NULL state cannot occur, it is
not clear what 044's VIEWER backfill protects against. That is a release
decision, written up in `docs/open-findings.md`. Nothing here changes
044.
