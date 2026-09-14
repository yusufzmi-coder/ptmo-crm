# `SUPABASE_SERVICE_ROLE_KEY` — what actually depends on it

Companion to the P0 in `docs/open-findings.md`, which establishes that the
variable holds a publishable key. This answers the next question: **what
breaks, where, and how loudly.**

Inventory only. No code changed.

Read on `cdf0856`. Key values were never printed — shape and equality were
checked by prefix, length and SHA-256 prefix.

---

## The finding that is new here

The two keys are **the same value**, byte for byte:

| variable | shape | length | sha256[:8] |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `sb_publishable…` | 46 | `9222dc36` |
| `SUPABASE_SERVICE_ROLE_KEY` | `sb_publishable…` | 46 | `9222dc36` |

So this is not "the service key is the wrong kind of key". It is: **every
`supabaseAdmin()` client in the app is an anon client**, holding the same
credential the browser ships publicly, with no user session attached.

That last clause matters more than the role name. A browser anon client at
least carries a logged-in user's JWT, so `auth.uid()` resolves and RLS
policies pass. These server clients are created with the bare key and no
session, so `auth.uid()` is **NULL** and every policy written against it
fails for reasons that have nothing to do with roles.

---

## Answering the 046 question first, because it lands tomorrow

046 revokes EXECUTE from `anon`/`authenticated` on four SECURITY DEFINER
functions and grants it to `service_role`. Two of the four are called from
server code:

| function | called from | client | reached when |
|---|---|---|---|
| `claim_ai_reply_slot` | `src/lib/ai/auto-reply.ts:166` | `lib/ai/admin-client.ts` | an inbound WhatsApp message triggers the AI auto-reply |
| `record_webhook_failure` | `src/lib/webhooks/deliver.ts:151` | passed down from `api/whatsapp/webhook/route.ts` | an outbound webhook delivery fails |

`_bcast_bump` and `recompute_broadcast_counts` have **no caller in `src/`**
at all — they are invoked from SQL, so the key does not reach them.

**So yes, the gap is real, and it is exactly two call sites.** Both run
through clients built from `SUPABASE_SERVICE_ROLE_KEY`, which is the anon
key, so after 046 both call as a role that has just had EXECUTE revoked.

Today those calls likely succeed, because Postgres grants EXECUTE to
PUBLIC by default and 046 has not landed. Tomorrow they start returning
`42501 permission denied for function`.

Two things follow, and they point in opposite directions:

- This is **not** a reason to hold 046. The functions are SECURITY
  DEFINER and currently callable by anon; 046 is the fix. The key gap
  already exists and 046 only makes it visible.
- But the timing is unkind. 046 applies on the same day the WhatsApp
  number connects, and both failures surface on the inbound message path.
  **Both will look like WhatsApp problems.** If the number goes live and
  auto-reply misbehaves, check this before touching anything Meta-facing.

`auto-reply.ts:174` already anticipates this in a comment — it names
"`claim_ai_reply_slot` not EXECUTE-able" as a deploy issue and logs rather
than throwing. So the AI path fails **soft**: no reply is sent, one line in
the server log, and nothing user-visible says why.

---

## Blast radius

Five files read the variable. Three of them are thin factories that many
routes share:

| reader | consumers |
|---|---|
| `lib/flows/admin-client.ts` | 10 — flows CRUD/activate/cron, broadcast resume, `lib/auth/api-context.ts`, `lib/api-keys/store.ts`, `lib/whatsapp/send-message.ts`, flows engine + meta-send |
| `lib/automations/admin-client.ts` | 9 — automations CRUD/duplicate/cron, quick replies, the automation engine, steps-tree, meta-send |
| `lib/ai/admin-client.ts` | 2 — the AI draft route and auto-reply |
| `api/whatsapp/webhook/route.ts` | itself — inline factory, the inbound message path |
| `api/whatsapp/config/route.ts` | itself — inline factory, 14 operations on `whatsapp_config` |

Twenty-one distinct consumer files, counted by resolving each import
rather than by grepping for the string `admin-client`: several modules
import more than one of these factories, so a plain text match
double-counts them. An earlier draft of this table said 13/11/6 for that
reason.

`lib/auth/api-context.ts:112` is worth calling out: it hands the admin
client to every public-API request authenticated by a `wacrm_live_…`
bearer token. That is the whole external API surface, not one route.

---

## How each failure presents — they are not all silent

The P0 says RLS blocks these "silently". That is true of most operations
but not all, and the difference decides whether anyone notices.

`supabase/ci/grant-platform-privileges.sql` already establishes the
production behaviour, verified there rather than assumed: the hosted
platform grants table DML to `anon`, so a request **runs** and RLS then
decides which rows it sees. The observed production response for `anon` is
`200 []`, not `403`.

| operation | with anon + no session | noticed? |
|---|---|---|
| `SELECT` | `200 []` — zero rows | **no.** Reads as "no data yet" |
| `UPDATE` / `DELETE` | zero rows affected, no error | **no.** Supabase does not error on an empty match |
| `INSERT` | `42501` row-level security violation | **yes** — loud, surfaces as a 500 |
| `.rpc()` after 046 | `42501` permission denied | **yes** — loud, but see the soft-fail note above |

So the inbound webhook path fails in the worst possible mix: the INSERT of
a parent's message would raise loudly, while the lookups that precede it
return empty and may route the code down a "new contact" or "no config"
branch **before** ever reaching the INSERT. A silent wrong branch is worse
than a loud failure, because the log will describe the symptom and not the
cause.

---

## The three questions, per group

**1. Does it write or read as service_role?** All five do — that is the
only reason they exist. None of them attaches a user session.

**2. Is there an RLS policy that lets the public role do the same thing?**
No. Across `supabase/migrations/`, policy role clauses are:
`TO authenticated` ×16, `TO service_role` ×13, `TO authenticated,
service_role` ×8, `TO anon, authenticated` ×1 — and that one is a function
GRANT (`peek_invitation`, 019), not a table policy. There is no table
policy admitting `anon`.

So none of these paths works "by accident today" in the sense the question
anticipates. They work, where they work, because the operation is a read
that legitimately returns nothing, or because the path has not run yet.

**3. Is anything broken now and not reporting it?** The webhook path has
never run in anger — no number is connected. That is the single reason
this has not already been noticed, and it expires tomorrow.

---

## What this inventory could not settle

**Whether production carries the same key.** Only `.env.local` is readable
from here. If the deployment holds a real `sb_secret…` key, everything
above is a local-development defect and tomorrow is unaffected.

That is a one-minute check and it should happen before anything else:

- Open any page that lists flows or automations while signed in. Those
  routes authenticate the user with a cookie client and then read data
  through the admin client. If the admin client is anon-with-no-session,
  the list comes back **empty for every user**, regardless of what is in
  the table.
- A non-empty list is proof the deployed key is a real service key. An
  empty list on an account that should have rows is proof it is not.

That test is better than reading the env var because it exercises the
actual path, and it needs no access to the deployment's secrets.

---

## Shape of the fix, when it is time

This is a **configuration** change, not a code change. One variable, and
nothing in `src/` is wrong.

What is worth adding afterwards, in code, is the thing that would have
caught it: the admin-client factories accept whatever string is in the
variable and cannot tell a publishable key from a secret one. A check at
client construction — refuse a key that does not have the secret shape,
and fail loudly at boot rather than silently at the first RLS-filtered
read — turns this whole class from invisible into a startup error.

Three factories would each need three lines, or one shared helper. Not
done here; this file is an inventory.
