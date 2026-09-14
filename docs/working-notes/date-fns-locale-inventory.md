# date-fns locale — inventory before the decision

Every `date-fns` call site in `src/`, what it actually renders, and what
would change if a locale were passed. Written so the locale decision is
one read rather than an investigation.

**This is an inventory, not a proposal to implement.** No code changed.

Measured against `date-fns@4.4.0` as installed, on commit `5b5f0bf`.

---

## The short version

Twelve call sites. Eight render something a reader could notice, and they
do not all have the same fix:

| Problem | Sites | Fixed by |
|---|---|---|
| Relative phrases in English | 3 | passing a locale |
| Hardcoded English date *shape* | 4 | pattern → preset, **and** a locale |
| Already preset-shaped | 1 | passing a locale, nothing else |
| Digits only — nothing to localise | 2 | nothing |
| Not display at all — must stay fixed | 2 | nothing, and **do not touch** |

3 + 4 + 1 + 2 + 2 = 12.

The second row is the one that would be missed. Passing a locale to
`format(d, "MMM d, yyyy")` does **not** localise it, because the pattern
itself is English-shaped and date-fns renders the pattern it is given.

---

## What passing a locale actually changes

Measured, not assumed — `2026-09-14T15:04:05Z`, a 3-hour-old timestamp:

| call | no locale | `ms` | `ko` |
|---|---|---|---|
| `format(d,"MMM d")` | `Sep 14` | `Sep 14` | `9월 14` |
| `format(d,"MMMM d, yyyy")` | `September 14, 2026` | `September 14, 2026` | `9월 14, 2026` |
| `format(d,"HH:mm")` | `23:04` | `23:04` | `23:04` |
| `format(d,"PP p")` | `Sep 14, 2026 11:04 PM` | `14 Sep 2026 23.04` | `2026.09.14 23:04` |
| `formatDistanceToNow(…)` | `about 3 hours ago` | `sekitar 3 jam yang lalu` | `약 3시간 전` |

Two things fall out of that table, and neither is obvious:

**1. Malay month names are identical to English.** `Sep`, `September` —
same word. So for the Malay rollout, passing a locale to the `MMM`/`MMMM`
sites buys nothing visible. The entire Malay-visible win sits in
`formatDistanceToNow` and in the `PP`/`p` presets, which reorder the date
(`14 Sep 2026`, not `Sep 14, 2026`) and use `.` as the time separator.

For Korean, by contrast, every row changes.

**2. Hardcoded patterns keep their English shape even with a locale.**
`"MMMM d, yyyy"` renders `9월 14, 2026` in Korean — Korean month, English
word order and comma. date-fns localises the *tokens*, never the pattern.
Only the localised presets reorder:

| preset | en | ms | ko |
|---|---|---|---|
| `P` | `09/14/2026` | `14/9/2026` | `2026.09.14` |
| `p` | `11:04 PM` | `23.04` | `23:04` |
| `PPp` | `Sep 14, 2026, 11:04 PM` | `14 Sep 2026, 23.04` | `2026.09.14 23:04` |

So a locale-aware fix for those four sites means replacing the pattern
with a preset, which **changes the layout for English users too**. That is
a product decision, not a mechanical one, and it is the main reason this
is a round of its own.

---

## Every call site

### A. Renders English words — the actual defect (8)

| File | Line | Call | Renders |
|---|---|---|---|
| `components/inbox/conversation-list.tsx` | 609 | `formatDistanceToNow(…, {addSuffix:false})` | `about 3 hours` |
| `app/(dashboard)/notifications/page.tsx` | 257 | `formatDistanceToNow(…, {addSuffix:true})` | `about 3 hours ago` |
| `app/(dashboard)/flows/[id]/runs/page.tsx` | 232 | `formatDistanceToNow(…, {addSuffix:false})` | `about 3 hours` |
| `components/inbox/message-thread.tsx` | 125 | `format(date,"MMMM d, yyyy")` | `September 14, 2026` |
| `components/inbox/contact-sidebar.tsx` | 304 | `format(…,"MMM d, yyyy HH:mm")` | `Sep 14, 2026 23:04` |
| `components/inbox/media-lightbox.tsx` | 119 | `format(…,"MMM d, yyyy HH:mm")` | `Sep 14, 2026 23:04` |
| `components/agents/ai-usage.tsx` | 102 | `format(parseISO(d.date),'MMM d')` | `Sep 14` |
| `app/(dashboard)/flows/[id]/runs/page.tsx` | 276 | `format(…,"PP p")` | `Sep 14, 2026 11:04 PM` |

Two of those eight want separate notes.

`ai-usage.tsx:102` is a **chart axis label**. Axis ticks have width
constraints and Korean `9월 14` is a different width from `Sep 14`, so it
needs a look at the rendered chart, not just a locale argument.

`runs/page.tsx:276` already uses the `"PP p"` preset and is already passed
through `t("started", {time})`. It is the only site in the repo shaped
correctly for a locale today — it needs the locale argument and nothing
else, which makes it the cheapest place to prove the approach.

### B. Digits only — nothing to localise (2)

| File | Line | Pattern | Why it is fine |
|---|---|---|---|
| `components/inbox/message-bubble.tsx` | 229 | `HH:mm` | 24-hour clock, no words |
| `app/(dashboard)/flows/[id]/runs/page.tsx` | 328 | `HH:mm:ss` | event log timestamp |

Note `HH:mm` renders identically with and without a locale (verified). If
the product ever wants 12-hour time per locale, that is the `p` preset and
belongs in section A, not here.

### C. Not display — must NOT be localised (2)

| File | Line | Pattern | What it is |
|---|---|---|---|
| `lib/media/filename.ts` | 195 | `yyyyMMdd-HHmmss` | a **filename stamp** written to storage |
| `components/inbox/message-thread.tsx` | 133 | `yyyy-MM-dd` | a **grouping key** comparing one day to the next |

These are the `NODE_META.label` case again: a value that is stored or
compared must not vary with the reader's locale. The filename lands in
object storage; the day key decides where date separators are drawn. Both
are already digit-only so a locale would not change them today — but they
should be marked so nobody "completes" the migration by sweeping them.

---

## What an implementation would need to decide

**1. Where the locale comes from.** `src/i18n/request.ts` exports
`resolveLocale()`, which reads and validates `NEXT_PUBLIC_APP_LOCALE`. But
most of these sites are client components, and `next-intl` exports
`useLocale()` for exactly this (confirmed present in the installed
version; not currently used anywhere in `src/`). A helper that maps a
locale string to a date-fns locale object is one small module; the open
question is whether it reads `useLocale()` or the env var directly, and
those disagree the moment per-user locale ever ships.

**2. Static or dynamic import.** Each locale is small — `ms.js` is 736
bytes, `ko.js` 869 — so statically importing both costs almost nothing and
avoids an async boundary in components that render synchronously. The
`108K` per-locale directory figure is the whole unbundled folder, not what
ships. Recommend static; note it so nobody reaches for `import()` on the
assumption that locales are heavy.

**3. Preset or pattern, for the four shape sites.** Switching
`"MMM d, yyyy HH:mm"` → `"PPp"` is what makes Malay and Korean read
correctly, and it changes the English layout as a side effect. Someone has
to agree to that. Keeping the pattern and only passing a locale is the
smaller change and fixes almost nothing for Malay.

**4. Whether relative time should use date-fns at all.** There is already
a catalogue-based precedent in this repo, written twice:

- `components/ops/unanswered-board.tsx:468` — `t("sentMinutesAgo", {count})`
  with `Ops.unanswered.sent*Ago` keys
- `components/dashboard/activity-feed.tsx:160` — a local `relativeTime()`
  taking a translator, using `Dashboard.activityFeed.time{S,M,H,D}`

Both bypass date-fns entirely. A third option is therefore to delete
`formatDistanceToNow` from these three sites and reuse that pattern, which
needs no locale plumbing at all and gives translators control over the
wording. It costs three new key sets and loses date-fns's plural handling.

**Correction to an earlier draft of this file:** it said both precedents
"read correctly in all three locales today". That is true of English and
Malay only. The whole `Ops.unanswered` namespace — all 25 keys, including
`sent*Ago` — is still the English text in `ko.json`, so the Ops board
reads English under the Korean locale. Korean was shelved by the Boss, so
this is consistent with that decision rather than a new defect, but the
claim as written was wrong and would have overstated how ready the
catalogue approach is.

One more path this inventory missed on the first pass: `relativeTime()`
falls through to `new Date(iso).toLocaleDateString()` beyond thirty days.
That is not date-fns, so it is outside the twelve — but it is a
locale-sensitive date render with no locale argument, and it belongs in
whatever round settles this.

---

## Recommendation

Split it. The three `formatDistanceToNow` sites and the three pattern
sites are different decisions and should not ride in one commit:

- **Relative time** is the highest visible value for the Malay rollout and
  has a working in-repo precedent. Decide between date-fns-with-locale and
  the catalogue approach first; it unblocks the largest visible win.
- **The three pattern sites** need a product call on changing English
  layout before any code moves.
- **Sections B and C need no work**, and section C should get a one-line
  comment marking it as stored-or-compared so a later sweep does not
  "finish the job".

Not recommended: passing a locale to every `format()` call in one pass. It
would read as complete, change almost nothing for Malay, leave English
word order in place, and make the remaining problem harder to see.

---

## Open question this inventory could not answer

Whether any of this is visible to customers. Everything above is staff UI.
`docs/open-findings.md` already records that default node content reaches
parents over WhatsApp; nothing in this inventory feeds that path, but the
media filename in section C does land in stored object names, which is the
closest thing here to an artifact that outlives the session that made it.
