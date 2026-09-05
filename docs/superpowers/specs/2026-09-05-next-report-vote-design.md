# Next-Report Vote — design spec

Date: 2026-09-05

## Problem

Users have no way to tell us which report they want next. We want to ask,
once, on the way out of a report they're reading — but only if they haven't
already answered, and only offering reports they haven't already bought. The
admin panel should show the aggregated answer as a single summary card above
the existing Report Ratings table.

## Decisions locked in during brainstorming

- **Modal stacking**: mutually exclusive with the existing exit-time rating
  sheet. On back: show the rating sheet if one is due; otherwise show the
  next-report prompt if the user hasn't voted yet and has upcoming reports.
  Never both on the same exit — if rating wins this time, the vote prompt
  waits for a future exit.
- **Vote scope**: one vote ever, per user account (not per birth profile).

## Data model

Add two nullable columns to `users` (`src/db/schema.ts`, alongside the other
one-time-flag columns like `gemstoneUnlockedAt`):

```ts
nextReportVote: text('next_report_vote'),
nextReportVotedAt: timestamp('next_report_voted_at', { withTimezone: true }),
```

Text, not an enum or FK — same reasoning as `incomeBracket`: report keys are
a product-config union (`ReportKey` in `config/reports.ts`) that gains new
values over time, and a pgEnum add is its own migration dance for a column
nothing joins on.

Migration `src/db/migrations/0072_next_report_vote.sql`, hand-written in the
post-0050 `IF NOT EXISTS` style (see 0071 — `drizzle-kit generate` diffs
against a stale snapshot and reinvents already-applied tables, so every
migration since 0056 has been hand-written):

```sql
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "next_report_vote" text;
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "next_report_voted_at" timestamp with time zone;
```

Add a journal entry (`src/db/migrations/meta/_journal.json`) for idx 72,
tag `0072_next_report_vote`, following the exact shape of the existing idx
70/71 entries.

## Backend

**`src/modules/users/users.repo.ts`** — two new functions, next to the
gemstone-unlock functions, same `.update().where(and(eq(id), isNull(col)))`
atomic-guard idiom as `unlockGemstoneForUser`:

```ts
/** Atomically records the vote iff the user hasn't voted before. Returns
 * false (not an error) when a vote already exists — the caller treats a
 * repeat submission as a harmless no-op, not a conflict, since nothing
 * scarce is being spent here (unlike unlockGemstoneForUser). */
export async function recordNextReportVote(userId: string, reportKey: string): Promise<boolean> {
  const [row] = await db
    .update(users)
    .set({ nextReportVote: reportKey, nextReportVotedAt: new Date() })
    .where(and(eq(users.id, userId), isNull(users.nextReportVote)))
    .returning({ id: users.id });
  return !!row;
}

/** Vote counts grouped by report key, most-requested first — active
 * (non-deleted) users only. Powers the admin summary card. */
export async function listNextReportVoteCounts(): Promise<{ reportKey: string; count: number }[]> {
  return db
    .select({ reportKey: users.nextReportVote, count: count() })
    .from(users)
    .where(and(isNotNull(users.nextReportVote), isNull(users.deletedAt)))
    .groupBy(users.nextReportVote)
    .orderBy(desc(count()));
}
```

(`reportKey` typed `string` in the return since `users.nextReportVote` is a
plain text column — cast at the call site, not here.)

**`src/modules/reports/reports.service.ts`** — new function:

```ts
export async function voteNextReport(
  userId: string,
  reportKey: string,
): Promise<{ alreadyVoted: boolean }> {
  if (!REPORT_CATALOGUE.some((r) => r.key === reportKey)) {
    throw Errors.notFound('Unknown report key');
  }
  const recorded = await recordNextReportVote(userId, reportKey);
  return { alreadyVoted: !recorded };
}
```

**`src/modules/reports/reports.routes.ts`** — new route, same shape as the
existing `rate` route in this file:

```
POST /reports/next-vote
body: { reportKey: string }
200: { alreadyVoted: boolean }
401, 404 (unknown reportKey)
```

**`src/modules/users/users.schemas.ts`** (wherever `UserSchema` lives) — add
`nextReportVote: z.string().nullable()` to the response shape returned by
`GET /v1/me`, so the frontend knows on app load whether to ever consider
showing the prompt, no extra round-trip.

**Admin** — `src/modules/admin/admin.service.ts`:

```ts
export async function getNextReportVoteCounts() {
  const rows = await listNextReportVoteCounts();
  return rows.map((r) => ({
    reportKey: r.reportKey,
    label: REPORT_CATALOGUE.find((c) => c.key === r.reportKey)?.label ?? r.reportKey,
    count: r.count,
  }));
}
```

`src/modules/admin/admin.schemas.ts` — `AdminNextReportVotesResponseSchema`:
`{ votes: Array<{ reportKey: string; label: string; count: number }> }`.

`src/modules/admin/admin.routes.ts` — `GET /admin/next-report-votes`,
`requireAdmin`, same shape as the `reportRatingsRoute` block (~line 478),
placed directly above it.

## Frontend

**`lib/api.ts`** — add `nextReportVote: string | null;` to the `User`
interface, next to `walletBalancePaise`.

**`lib/reports-api.ts`** — add to `reportsApi`:

```ts
voteNextReport: (reportKey: string) =>
  request<{ alreadyVoted: boolean }>('/v1/reports/next-vote', { method: 'POST', body: { reportKey }, auth: true }),
```

**`app/reports/[id]/page.tsx`** — extend `attemptBack()`. Needs the
catalogue (for locked/upcoming keys) fetched lazily, only when actually
about to decide:

```ts
const { user } = useAuth();
const [showNextReportModal, setShowNextReportModal] = useState(false);
const [upcomingReportKeys, setUpcomingReportKeys] = useState<string[] | null>(null);

const attemptBack = async () => {
  if (armed && !showRatingModal) {
    openRatingModalForBack();
    return;
  }
  if (!showNextReportModal && user && !user.nextReportVote) {
    if (upcomingReportKeys === null) {
      // Fail open on a network error — never strand the user on the page
      // over a nice-to-have prompt, same idiom as ReportRatingSheet's submit.
      try {
        const { reports } = await reportsApi.catalogue();
        const locked = reports.filter((r) => isReportLocked(r)).map((r) => r.key);
        setUpcomingReportKeys(locked);
        if (locked.length > 0) {
          setShowNextReportModal(true);
          return;
        }
      } catch {
        router.back();
        return;
      }
    } else if (upcomingReportKeys.length > 0) {
      setShowNextReportModal(true);
      return;
    }
  }
  router.back();
};
```

`isReportLocked` reuses the SAME locked check `sortUnlockedFirst`
already computes internally (`isMonthly ? monthlyCardState(...) : isYearly ?
yearlyCardState(...) : deriveOneTimeCardState(...)`, state === "none") — pull
that predicate out of `sortUnlockedFirst` in `lib/reports-logic.ts` into its
own exported `isReportLocked(entry)` so both call sites share it, rather
than duplicating the branch.

`useDismissOnBackPress` registration for the new sheet mirrors the rating
sheet's (`openRatingModalForBack` / `showRatingModal` pair) — the existing
`armed && !showRatingModal` hook call becomes an `armed && !showRatingModal
&& !showNextReportModal` guard so the two overlays never both claim the back
stack.

Render, right after the existing `{showRatingModal && <ReportRatingSheet .../>}`
line:

```tsx
{
  showNextReportModal && upcomingReportKeys && (
    <NextReportSheet
      reportKeys={upcomingReportKeys}
      onClose={() => {
        setShowNextReportModal(false);
        router.back();
      }}
    />
  );
}
```

**New component `components/reports/NextReportSheet.tsx`** — same shell/
wiring as `ReportRatingSheet.tsx` (`BottomSheetModal`, `useDismissOnBackPress(true, onClose)`).
Content, reusing the existing per-report visual system from `ReportCard.tsx`
(`getReportTheme(key)` for icon/hue, `/reports/<key>.png` art with icon
fallback, `NewBadge` for `isNew` entries) so the picker reads as the same
design system as the reports list, not a new one:

- Headline: `t("nextReportVote.title")`, e.g. "What should we prepare next
  for you?"
- A scrollable grid (2 columns) of tappable cards, one per key in
  `reportKeys`, each showing the art/icon + `t(\`reports.labels.${key}\`)`.
- Tap = select AND submit in one motion (no separate confirm step — a low-
  stakes preference pick doesn't need a second tap). On tap: optimistic
  selected-state animation (scale/border pulse via framer-motion, already a
  dependency), call `reportsApi.voteNextReport(key)`, then `refresh()`
  (useAuth) so `user.nextReportVote` is populated locally, show a brief
  success state (`t("nextReportVote.success")` — "Got it — we'll surprise
  you 😉"), then after ~900ms call `onClose()`.
- Errors: same fire-and-forget-on-failure idiom as `ReportRatingSheet`'s
  `submit` — losing one vote isn't worth an error state, close as if it
  landed.

**i18n** — `i18n/resources.ts`, add a `nextReportVote` namespace next to
`reportRating` in ALL 7 language blocks (en/hi/bn/mr/te/ta/gu):
`{ title, success }`. Report labels themselves reuse the existing
`reports.labels.<key>` keys — already translated for every key.

## Admin

**`app/admin/report-ratings/page.tsx`** — new card inserted between the
`<h1>`/description block and the filter `<select>`. Plain hardcoded English
per this page's existing i18n exception (see file's own top-of-file
comment). New client fn:

```ts
// lib/admin-api.ts
export interface AdminNextReportVoteRow { reportKey: string; label: string; count: number }
export interface AdminNextReportVotesResponse { votes: AdminNextReportVoteRow[] }
// in adminApi:
getNextReportVotes: () => request<AdminNextReportVotesResponse>("/v1/admin/next-report-votes", { auth: true }),
```

Card component (inline in the page, it's a single small ranked list — not
worth its own file): a `Card` (`components/ui/Card`) titled "Next Report
Requests", listing each `{label, count}` row as a label + a proportional
horizontal bar (width % = `count / votes[0].count`) + the count, sorted
desc (already sorted server-side). Empty state: "No votes yet." Not a
`KpiTile` — this needs a breakdown, not one number.

## Self-check

One backend test (`src/modules/users/users.repo.test.ts` or wherever the
existing gemstone-unlock tests live) exercising `recordNextReportVote`'s
idempotency: first call for a fresh user returns `true` and sets the column;
a second call with a DIFFERENT reportKey returns `false` and leaves the
column at the FIRST value. This is the one invariant the entire "don't ask
again" UX depends on — if it breaks, votes silently overwrite instead of
locking.

## Explicitly out of scope (YAGNI)

- Per-profile votes.
- A "change your vote" affordance anywhere in settings.
- Any cooldown/retry logic for a prompt the user dismissed without
  submitting (hardware back / app-switch away mid-sheet) — it simply
  reappears next time they exit a report, same as the rating sheet today.
- Surfacing the vote back to the user anywhere (e.g. "you asked for X, here
  it is") — this is a signal for admin/product, not a user-facing promise.
