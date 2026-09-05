# Next-Report Vote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user exits a report they're reading, ask them once which report they'd like next (offering only reports they haven't bought), never ask again after they answer, and show the aggregated votes as one summary card above the admin Report Ratings table.

**Architecture:** Two new nullable columns on `users` (`next_report_vote`, `next_report_voted_at`) store a one-time, account-level vote, written via a `WHERE ... IS NULL` atomic guard (same idiom as the existing `gemstoneUnlockedAt` gate). A new `POST /v1/reports/next-vote` endpoint records it; `GET /v1/me` echoes it back so the client knows without an extra round trip. On the report detail page, the catalogue is prefetched once a report is `ready` and unvoted, so both the on-screen back button AND the hardware-back stack hook (which today bypasses the page's own back handler unless the existing rating sheet is "armed") can synchronously decide whether to show the new `NextReportSheet`, mutually exclusive with the existing rating sheet. Admin gets one new `GET /v1/admin/next-report-votes` endpoint and a ranked-bar-list card.

**Tech Stack:** Hono + drizzle + Postgres (backend, `jyotish-backend`), Next.js + react-i18next + framer-motion (frontend, `frontend`). Both are separate git repos/checkouts — this plan touches both.

**Spec:** `docs/superpowers/specs/2026-09-05-next-report-vote-design.md` (this repo).

**Repos referenced below:**

- `BACKEND` = `C:\dev\aroha-astrology\jyotish-backend`
- `FRONTEND` = `C:\dev\aroha-astrology\frontend`

(Not the `scratch/aroha-astrology` or other checkouts — `BACKEND`/`FRONTEND` above are confirmed current with `origin/main`; other checkouts on this machine have drifted before.)

---

### Task 1: DB migration — `next_report_vote` / `next_report_voted_at` columns

**Files:**

- Modify: `BACKEND/src/db/schema.ts:367` (end of the `gemstoneWeightKg` line, before the `--- multi-profile` comment at line 369)
- Create: `BACKEND/src/db/migrations/0072_next_report_vote.sql`
- Modify: `BACKEND/src/db/migrations/meta/_journal.json` (append idx 72)

- [ ] **Step 1: Add the two columns to the Drizzle schema**

In `BACKEND/src/db/schema.ts`, immediately after this existing line (367):

```ts
    gemstoneWeightKg: doublePrecision('gemstone_weight_kg'),
```

insert:

```ts

    // --- next-report vote (2026-09-05) --------------------------------------
    // One-time, account-level: which report the user said they want next, asked
    // on exit from a report they just read (see app/reports/[id]/page.tsx on the
    // frontend). Null = never asked, or asked and the prompt is still pending —
    // the WHERE ... IS NULL guard in recordNextReportVote (users.repo.ts) is the
    // real "don't ask again" enforcement, not any client-side flag.
    nextReportVote: text('next_report_vote'),
    nextReportVotedAt: timestamp('next_report_voted_at', { withTimezone: true }),
```

- [ ] **Step 2: Write the hand-written migration file**

Create `BACKEND/src/db/migrations/0072_next_report_vote.sql` with exactly:

```sql
-- One-time, account-level "which report do you want next" vote — asked once
-- on exit from a report the user just read, never re-asked once set. See
-- users.repo.ts's recordNextReportVote for the WHERE ... IS NULL guard that
-- makes this a true one-time write, not just a UI nicety.
--
-- Hand-written (post-0050 convention): IF NOT EXISTS guard makes this safe
-- to re-run. See 0071_feature_flags_enabled_at.sql.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "next_report_vote" text;
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "next_report_voted_at" timestamp with time zone;
```

- [ ] **Step 3: Register the migration in the journal**

In `BACKEND/src/db/migrations/meta/_journal.json`, the entries array currently ends with:

```json
    {
      "idx": 71,
      "version": "7",
      "when": 1788600000000,
      "tag": "0071_feature_flags_enabled_at",
      "breakpoints": true
    }
  ]
}
```

Change it to:

```json
    {
      "idx": 71,
      "version": "7",
      "when": 1788600000000,
      "tag": "0071_feature_flags_enabled_at",
      "breakpoints": true
    },
    {
      "idx": 72,
      "version": "7",
      "when": 1788700000000,
      "tag": "0072_next_report_vote",
      "breakpoints": true
    }
  ]
}
```

- [ ] **Step 4: Verify the schema compiles**

Run (from `BACKEND`): `npx tsc --noEmit`
Expected: no NEW errors introduced by this change (this codebase has a pre-existing baseline of tsc errors elsewhere — see project memory; just confirm nothing new points at `schema.ts`).

- [ ] **Step 5: Apply the migration to the dev database**

Run (from `BACKEND`): `npm run db:migrate`
Expected: output mentions applying `0072_next_report_vote` (or "already applied" on a re-run) with no errors.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/migrations/0072_next_report_vote.sql src/db/migrations/meta/_journal.json
git commit -m "feat(reports): add next_report_vote columns to users

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `users.repo.ts` — record + count repo functions

**Files:**

- Modify: `BACKEND/src/modules/users/users.repo.ts:1241` (insert `listNextReportVoteCounts` right after `listReferrals` ends)
- Modify: `BACKEND/src/modules/users/users.repo.ts:1325` (insert `recordNextReportVote` right after `unlockGemstoneForUser` ends)

No dedicated test in this task — every sibling one-time-flag function in this file (`unlockGemstoneForUser`, `unlockHouseForUser`) and every other admin-aggregate function (`listReferrals`) is untested at the repo layer in this codebase (DB-touching repo functions have no unit-test harness here — `grep` across `test/` confirms zero files import `config/db.js` directly). Coverage for the new business logic comes from the service-layer test in Task 3, which mocks these two functions exactly the way `report-ratings-service.spec.ts` mocks `insertReportRating`/`stampRefund`.

- [ ] **Step 1: Add `listNextReportVoteCounts`**

In `BACKEND/src/modules/users/users.repo.ts`, immediately after this existing closing brace (the end of `listReferrals`, currently line 1241):

```ts
  }));
}
```

(the one right before the doc comment `/** \`pricePaise\` is resolved by the caller...`), insert:

```ts
/** Vote counts grouped by report key, most-requested first — active
 * (non-deleted) users only. Powers the admin "Next Report Requests" card. */
export async function listNextReportVoteCounts(): Promise<{ reportKey: string; count: number }[]> {
  const rows = await db
    .select({ reportKey: users.nextReportVote, count: count() })
    .from(users)
    .where(and(isNotNull(users.nextReportVote), isNull(users.deletedAt)))
    .groupBy(users.nextReportVote)
    .orderBy(desc(count()));
  return rows as { reportKey: string; count: number }[];
}
```

(The cast is because `users.nextReportVote` is a nullable `text` column, so drizzle infers `reportKey: string | null` here even though the `isNotNull` filter guarantees it's never null in practice.)

- [ ] **Step 2: Add `recordNextReportVote`**

In the same file, immediately after this existing closing brace (the end of `unlockGemstoneForUser`, currently line 1325):

```ts
    return true;
  });
}
```

(right before the doc comment `/**\n * Reverts an unlock when background generation fails.`), insert:

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
```

- [ ] **Step 3: Verify it compiles**

Run (from `BACKEND`): `npx tsc --noEmit`
Expected: no new errors (the `and`, `eq`, `isNull`, `isNotNull`, `count`, `desc` drizzle helpers are already imported at the top of this file).

- [ ] **Step 4: Commit**

```bash
git add src/modules/users/users.repo.ts
git commit -m "feat(reports): add next-report-vote repo functions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `reports.service.ts` — `voteNextReport` business logic (TDD)

**Files:**

- Modify: `BACKEND/src/modules/reports/reports.service.ts:29` (add `recordNextReportVote` to the existing users.repo import)
- Modify: `BACKEND/src/modules/reports/reports.service.ts` (append `voteNextReport` at end of file, currently line 1698)
- Modify: `BACKEND/test/reports-service.spec.ts` (add mock + new `describe` block)

- [ ] **Step 1: Write the failing test**

In `BACKEND/test/reports-service.spec.ts`, add `recordNextReportVote: vi.fn(),` to the hoisted `state` object (in the block starting `const state = vi.hoisted(() => ({` — add it as a new line anywhere inside, e.g. right after `findActiveUserById: vi.fn(),`).

Then change this existing mock block:

```ts
vi.mock('../src/modules/users/users.repo.js', () => ({
  deductWalletBalance: state.deductWalletBalance,
  addWalletBalance: state.addWalletBalance,
  findActiveUserById: state.findActiveUserById,
}));
```

to:

```ts
vi.mock('../src/modules/users/users.repo.js', () => ({
  deductWalletBalance: state.deductWalletBalance,
  addWalletBalance: state.addWalletBalance,
  findActiveUserById: state.findActiveUserById,
  recordNextReportVote: state.recordNextReportVote,
}));
```

Then add `voteNextReport,` to the destructured import from `reports.service.js` (the block ending `} = await import('../src/modules/reports/reports.service.js');` around line 140) — anywhere in the list, e.g. right after `MAX_REPORT_GENERATION_ATTEMPTS,`.

Then append this block at the very end of the file (after the last `});`):

```ts
describe('voteNextReport', () => {
  beforeEach(() => {
    state.recordNextReportVote.mockReset();
  });

  it('rejects an unknown report key without calling the repo', async () => {
    await expect(voteNextReport('user-1', 'not_a_real_key')).rejects.toMatchObject({ status: 404 });
    expect(state.recordNextReportVote).not.toHaveBeenCalled();
  });

  it('records a first-ever vote and reports alreadyVoted: false', async () => {
    state.recordNextReportVote.mockResolvedValue(true);
    const result = await voteNextReport('user-1', 'wealth');
    expect(result).toEqual({ alreadyVoted: false });
    expect(state.recordNextReportVote).toHaveBeenCalledWith('user-1', 'wealth');
  });

  it('reports alreadyVoted: true when the user has voted before, without throwing', async () => {
    state.recordNextReportVote.mockResolvedValue(false);
    const result = await voteNextReport('user-1', 'wealth');
    expect(result).toEqual({ alreadyVoted: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `BACKEND`): `npx vitest run test/reports-service.spec.ts -t voteNextReport`
Expected: FAIL — `voteNextReport is not a function` (or a TypeScript error if run through a type-checked path; either way, it must fail because the function doesn't exist yet).

- [ ] **Step 3: Implement `voteNextReport`**

In `BACKEND/src/modules/reports/reports.service.ts`, change this import (line 29):

```ts
import { deductWalletBalance, addWalletBalance, findActiveUserById } from '../users/users.repo.js';
```

to:

```ts
import {
  deductWalletBalance,
  addWalletBalance,
  findActiveUserById,
  recordNextReportVote,
} from '../users/users.repo.js';
```

Then append this at the very end of the file:

```ts
/**
 * Records the one-time "which report do you want next" vote — see
 * db/schema.ts's nextReportVote doc comment. Idempotent: a repeat vote (from
 * a client that somehow still thinks it hasn't asked) is reported back as
 * `alreadyVoted: true` rather than thrown as a conflict, since nothing
 * scarce is being spent here.
 */
export async function voteNextReport(
  userId: string,
  reportKey: string,
): Promise<{ alreadyVoted: boolean }> {
  if (!getReportDef(reportKey)) {
    throw Errors.notFound(`Unknown report key: ${reportKey}`);
  }
  const recorded = await recordNextReportVote(userId, reportKey);
  return { alreadyVoted: !recorded };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `BACKEND`): `npx vitest run test/reports-service.spec.ts -t voteNextReport`
Expected: PASS — 3 tests passing.

- [ ] **Step 5: Run the full reports-service suite to check for regressions**

Run (from `BACKEND`): `npx vitest run test/reports-service.spec.ts`
Expected: PASS — same pass count as before this task, plus the 3 new tests.

- [ ] **Step 6: Commit**

```bash
git add src/modules/reports/reports.service.ts test/reports-service.spec.ts
git commit -m "feat(reports): add voteNextReport service function

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `POST /v1/reports/next-vote` route

**Files:**

- Modify: `BACKEND/src/modules/reports/reports.schemas.ts` (append at end, currently line 202)
- Modify: `BACKEND/src/modules/reports/reports.routes.ts:4-17` (schema import), `:18-25` (service import), append route at end (currently line 277)

- [ ] **Step 1: Add the request/response schemas**

Append to the end of `BACKEND/src/modules/reports/reports.schemas.ts`:

```ts
export const VoteNextReportBodySchema = z
  .object({ reportKey: z.string() })
  .openapi('VoteNextReportBody');

export const VoteNextReportResponseSchema = z
  .object({ alreadyVoted: z.boolean() })
  .openapi('VoteNextReportResponse');
```

- [ ] **Step 2: Wire the route**

In `BACKEND/src/modules/reports/reports.routes.ts`, add `VoteNextReportBodySchema` and `VoteNextReportResponseSchema` to the existing schema import block (lines 4-17) — anywhere in the list, e.g. right after `ReportStatsResponseSchema,`.

Add `voteNextReport` to the existing service import block (lines 18-25) — right after `purchaseReport,`.

Append this at the end of the file (after the existing `rateReportRoute` handler, currently line 277):

```ts
const voteNextReportRoute = createRoute({
  method: 'post',
  path: '/reports/next-vote',
  tags: ['Reports'],
  summary: 'One-time vote for which report the user wants prepared next',
  description:
    'Idempotent — voting again after an existing vote is a harmless no-op, reported back as ' +
    '`alreadyVoted: true` rather than a conflict.',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: VoteNextReportBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Vote recorded (or already existed)',
      content: { 'application/json': { schema: VoteNextReportResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
    404: errorResponse('Unknown report key'),
  },
});

reportsRouter.openapi(voteNextReportRoute, async (c) => {
  const user = c.get('user');
  const { reportKey } = c.req.valid('json');
  const result = await voteNextReport(user.id, reportKey);
  return c.json(result, 200);
});
```

- [ ] **Step 3: Verify it compiles**

Run (from `BACKEND`): `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Manually verify against a running dev server**

Run (from `BACKEND`, in the background): `npm run dev`
Then, with a valid Firebase ID token for a test user (`$TOKEN` below):

```bash
curl -s -X POST http://localhost:3001/v1/reports/next-vote \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"reportKey":"wealth"}'
```

Expected: `{"alreadyVoted":false}` on the first call, `{"alreadyVoted":true}` on a repeat call for the same user. A call with `{"reportKey":"nonsense"}` returns 404.

- [ ] **Step 5: Commit**

```bash
git add src/modules/reports/reports.schemas.ts src/modules/reports/reports.routes.ts
git commit -m "feat(reports): add POST /v1/reports/next-vote route

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Expose `nextReportVote` on `GET /v1/me`

**Files:**

- Modify: `BACKEND/src/modules/users/users.schemas.ts:275` (add field to `UserSchema`)
- Modify: `BACKEND/src/modules/users/users.service.ts:206` (add field to `toUserDto`)

- [ ] **Step 1: Add the field to the response schema**

In `BACKEND/src/modules/users/users.schemas.ts`, immediately after this existing line (275):

```ts
    unlockedHouses: z.array(z.number().int()),
```

insert:

```ts
    nextReportVote: z.string().nullable(),
```

- [ ] **Step 2: Add the field to the DTO mapper**

In `BACKEND/src/modules/users/users.service.ts`, immediately after this existing line (206, inside `toUserDto`):

```ts
    walletBalancePaise: row.walletBalancePaise,
```

insert:

```ts
    nextReportVote: row.nextReportVote,
```

(Account-level, not profile-scoped — same pattern as `walletBalancePaise` above it, which reads from `row` rather than `profile` for that exact reason.)

- [ ] **Step 3: Verify it compiles**

Run (from `BACKEND`): `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Run the users test suite to check for regressions**

Run (from `BACKEND`): `npx vitest run test/users.spec.ts`
Expected: PASS, same count as before (this is an additive field on an existing DTO — no existing assertion should equality-check the whole object and break, but confirm).

- [ ] **Step 5: Commit**

```bash
git add src/modules/users/users.schemas.ts src/modules/users/users.service.ts
git commit -m "feat(reports): expose nextReportVote on GET /v1/me

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Admin `GET /v1/admin/next-report-votes`

**Files:**

- Modify: `BACKEND/src/modules/admin/admin.service.ts:1-20` (imports), append function near `getReportRatings` (currently ends line 381)
- Modify: `BACKEND/src/modules/admin/admin.schemas.ts` (insert after `AdminReportRatingsResponseSchema`, currently ends line 287)
- Modify: `BACKEND/src/modules/admin/admin.routes.ts` (imports + new route, mirroring `reportRatingsRoute`)

- [ ] **Step 1: Add the response schema**

In `BACKEND/src/modules/admin/admin.schemas.ts`, immediately after this existing block:

```ts
export const AdminReportRatingsResponseSchema = z
  .object({
    ratings: z.array(AdminReportRatingRowSchema),
    total: z.number(),
    offset: z.number(),
    limit: z.number(),
  })
  .openapi('AdminReportRatingsResponse');
```

insert:

```ts
const AdminNextReportVoteRowSchema = z.object({
  reportKey: z.string(),
  label: z.string(),
  count: z.number(),
});

export const AdminNextReportVotesResponseSchema = z
  .object({ votes: z.array(AdminNextReportVoteRowSchema) })
  .openapi('AdminNextReportVotesResponse');
```

- [ ] **Step 2: Add the service function**

In `BACKEND/src/modules/admin/admin.service.ts`, add `getReportDef` to the config import — since this file currently has no `config/reports.js` import, add a new import line right after the existing `import { FEATURE_REGISTRY, isKnownFeatureKey } from '../../config/features.js';` (line 1):

```ts
import { getReportDef } from '../../config/reports.js';
```

Add `listNextReportVoteCounts` to the existing `users.repo.js` import block (lines 5-20) — right after `listReferrals,`.

Immediately after this existing function (which currently ends at line 381):

```ts
export async function getReportRatings(
  reportKey: string | undefined,
  limit: number,
  offset: number,
) {
  const { rows, total } = await listAllReportRatings(reportKey, limit, offset);
  const ratings = rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  return { ratings, total, offset, limit };
}
```

insert:

```ts
/** Vote counts for "which report should we prepare next", most-requested
 * first, with each report's display label resolved from the catalogue. */
export async function getNextReportVoteCounts() {
  const rows = await listNextReportVoteCounts();
  const votes = rows.map((r) => ({
    reportKey: r.reportKey,
    label: getReportDef(r.reportKey)?.label ?? r.reportKey,
    count: r.count,
  }));
  return { votes };
}
```

- [ ] **Step 3: Wire the route**

In `BACKEND/src/modules/admin/admin.routes.ts`, add `AdminNextReportVotesResponseSchema` to the schema import block (lines 5-33) — right after `AdminReportRatingsResponseSchema,`.

Add `getNextReportVoteCounts` to the service import block (lines 36-56) — right after `getReportRatings,`.

Immediately after the existing `reportRatingsRoute` handler (which currently ends at line 502):

```ts
adminRouter.openapi(reportRatingsRoute, async (c) => {
  const { reportKey, offset, limit } = c.req.valid('query');
  const page = await getReportRatings(reportKey, limit, offset);
  await auditRead(c, 'GET /v1/admin/report-ratings', { reportKey, offset, limit });
  return c.json(page, 200);
});
```

insert:

```ts
/* -------------------------------------------------------------------------- */
/* GET /admin/next-report-votes                                               */
/* -------------------------------------------------------------------------- */

const nextReportVotesRoute = createRoute({
  method: 'get',
  path: '/admin/next-report-votes',
  tags: ['Admin'],
  summary: 'Vote counts for "which report should we prepare next", most-requested first',
  security: [{ bearerAuth: [] }],
  middleware: [requireAdmin] as const,
  responses: {
    200: {
      description: 'Vote counts',
      content: { 'application/json': { schema: AdminNextReportVotesResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
    403: errorResponse('Admin access required'),
  },
});

adminRouter.openapi(nextReportVotesRoute, async (c) => {
  const result = await getNextReportVoteCounts();
  await auditRead(c, 'GET /v1/admin/next-report-votes', {});
  return c.json(result, 200);
});
```

- [ ] **Step 4: Verify it compiles**

Run (from `BACKEND`): `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Manually verify against a running dev server**

With the dev server running and an admin token (`$ADMIN_TOKEN`):

```bash
curl -s http://localhost:3001/v1/admin/next-report-votes -H "Authorization: Bearer $ADMIN_TOKEN"
```

Expected: `{"votes":[{"reportKey":"wealth","label":"Wealth Report","count":1}]}` (or similar, reflecting whatever votes exist from Task 4's manual test) — sorted by count descending.

- [ ] **Step 6: Commit**

```bash
git add src/modules/admin/admin.schemas.ts src/modules/admin/admin.service.ts src/modules/admin/admin.routes.ts
git commit -m "feat(admin): add GET /v1/admin/next-report-votes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Frontend types + API clients

**Files:**

- Modify: `FRONTEND/lib/api.ts:74` (add `nextReportVote` to `User`)
- Modify: `FRONTEND/lib/reports-api.ts` (add `voteNextReport` to `reportsApi`)
- Modify: `FRONTEND/lib/admin-api.ts` (add types + `getNextReportVotes` to `adminApi`)

- [ ] **Step 1: Add `nextReportVote` to the `User` type**

In `FRONTEND/lib/api.ts`, immediately after this existing line (74):

```ts
walletBalancePaise: number;
```

insert:

```ts
/** The report key the user voted for on "what should we prepare next?", or null if
 * never asked / still pending. Account-level, not profile-scoped. */
nextReportVote: string | null;
```

- [ ] **Step 2: Add `voteNextReport` to `reportsApi`**

In `FRONTEND/lib/reports-api.ts`, immediately after this existing entry (the `rate` method, at the end of the `reportsApi` object, currently the last property before the closing `};` at line 240):

```ts
  rate: (id: string, body: { rating: number; comment?: string }) =>
    request<RateReportResponse>(`/v1/reports/${id}/rating`, { method: "POST", body, auth: true }),
```

insert (before the closing `};`):

```ts

  /** One-time vote for "which report should we prepare next?" — idempotent,
   * `alreadyVoted: true` on a repeat call rather than an error. */
  voteNextReport: (reportKey: string) =>
    request<{ alreadyVoted: boolean }>("/v1/reports/next-vote", {
      method: "POST",
      body: { reportKey },
      auth: true,
    }),
```

- [ ] **Step 3: Add the admin types + client function**

In `FRONTEND/lib/admin-api.ts`, immediately after this existing interface (the `AdminReportRatingsResponse` block, ending around line 214):

```ts
  ratings: AdminReportRatingRow[];
  total: number;
  offset: number;
  limit: number;
}
```

insert:

```ts
export interface AdminNextReportVoteRow {
  reportKey: string;
  label: string;
  count: number;
}

export interface AdminNextReportVotesResponse {
  votes: AdminNextReportVoteRow[];
}
```

Then, immediately after this existing entry in the `adminApi` object (right after `listReportRatings`, currently ending around line 532):

```ts
  listReportRatings: (params: { reportKey?: string; offset?: number; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.reportKey) qs.set("reportKey", params.reportKey);
    qs.set("offset", String(params.offset ?? 0));
    qs.set("limit", String(params.limit ?? 50));
    return request<AdminReportRatingsResponse>(`/v1/admin/report-ratings?${qs.toString()}`, { auth: true });
  },
```

insert:

```ts

  /** Vote counts for "which report should we prepare next", most-requested first. */
  getNextReportVotes: () =>
    request<AdminNextReportVotesResponse>("/v1/admin/next-report-votes", { auth: true }),
```

- [ ] **Step 4: Verify it compiles**

Run (from `FRONTEND`): `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add lib/api.ts lib/reports-api.ts lib/admin-api.ts
git commit -m "feat(reports): add next-report-vote types and API clients

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: `isReportLocked` extraction (TDD)

**Files:**

- Modify: `FRONTEND/lib/reports-logic.ts:243-253` (extract the predicate out of `sortUnlockedFirst`)
- Modify: `FRONTEND/lib/reports-logic.test.ts:282` (add tests, right before the existing `sortUnlockedFirst` describe block)

- [ ] **Step 1: Write the failing test**

In `FRONTEND/lib/reports-logic.test.ts`, add `isReportLocked` to the existing import list from `./reports-logic` (the block starting `import { ... } from "./reports-logic";`), then insert this new `describe` block immediately before the existing `describe("sortUnlockedFirst", ...)` block (currently starting at line 282):

```ts
describe('isReportLocked', () => {
  it('is true for a report with no purchases', () => {
    expect(isReportLocked({ key: 'a', isMonthly: false, purchases: [] })).toBe(true);
  });

  it('is false for a one-time report with a ready purchase', () => {
    expect(
      isReportLocked({ key: 'a', isMonthly: false, purchases: [purchase('p1', 'ready')] }),
    ).toBe(false);
  });

  it('is false for a one-time report with only a failed attempt (still retryable, not locked)', () => {
    expect(
      isReportLocked({ key: 'a', isMonthly: false, purchases: [purchase('p1', 'failed')] }),
    ).toBe(false);
  });

  it('is true for a monthly report whose only purchase is a past month', () => {
    expect(
      isReportLocked({
        key: 'a',
        isMonthly: true,
        purchases: [purchase('p1', 'ready', '2000-01')],
      }),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `FRONTEND`): `npx vitest run lib/reports-logic.test.ts -t isReportLocked`
Expected: FAIL — `isReportLocked is not exported` / `is not a function`.

- [ ] **Step 3: Extract the predicate**

In `FRONTEND/lib/reports-logic.ts`, replace this existing block (currently lines 243-253):

```ts
export function sortUnlockedFirst<T extends PurchasableReport>(reports: readonly T[]): T[] {
  const isLocked = (r: T) => {
    const state = r.isMonthly
      ? monthlyCardState(r.purchases)
      : r.isYearly
        ? yearlyCardState(r.purchases)
        : deriveOneTimeCardState(r.purchases);
    return state.state === 'none';
  };
  return [...reports].sort((a, b) => Number(isLocked(a)) - Number(isLocked(b)));
}
```

with:

```ts
/** Whether a catalogue entry has never been purchased (or, for a monthly/yearly entry, has no
 * currently-active purchase) — shared by sortUnlockedFirst (list ordering) and the next-report
 * vote prompt (app/reports/[id]/page.tsx), which needs the same "still locked" definition to
 * decide which report keys it's allowed to offer. */
export function isReportLocked<T extends PurchasableReport>(r: T): boolean {
  const state = r.isMonthly
    ? monthlyCardState(r.purchases)
    : r.isYearly
      ? yearlyCardState(r.purchases)
      : deriveOneTimeCardState(r.purchases);
  return state.state === 'none';
}

export function sortUnlockedFirst<T extends PurchasableReport>(reports: readonly T[]): T[] {
  return [...reports].sort((a, b) => Number(isReportLocked(a)) - Number(isReportLocked(b)));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `FRONTEND`): `npx vitest run lib/reports-logic.test.ts`
Expected: PASS — all existing `sortUnlockedFirst` tests still pass (it's now implemented in terms of `isReportLocked`, same behavior), plus the 4 new `isReportLocked` tests.

- [ ] **Step 5: Commit**

```bash
git add lib/reports-logic.ts lib/reports-logic.test.ts
git commit -m "refactor(reports): extract isReportLocked from sortUnlockedFirst

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: i18n — `nextReportVote` copy in all 7 languages

**Files:**

- Modify: `FRONTEND/i18n/resources.ts` (7 insertions, one per language block, each right after that language's `reportRating` block)

Each language's `reportRating` block is textually unique (different translated strings), so each insertion below targets an unambiguous, unique anchor in the file.

- [ ] **Step 1: English**

Immediately after this existing block:

```ts
      reportRating: {
        title: "Rate this report",
        prompt: "How was this report?",
        refunded: "We're sorry to hear that — {{amount}} has been added to your wallet.",
      },
```

insert:

```ts
      nextReportVote: {
        title: "Pick your next report",
        prompt: "Which one should we prepare for you next?",
        success: "Got it — we'll have it ready for you soon.",
      },
```

- [ ] **Step 2: Hindi**

Immediately after this existing block:

```ts
      reportRating: {
        title: "इस रिपोर्ट को रेट करें",
        prompt: "यह रिपोर्ट कैसी थी?",
        refunded: "यह सुनकर खेद है — {{amount}} आपके वॉलेट में जोड़ दिया गया है।",
      },
```

insert:

```ts
      nextReportVote: {
        title: "अपनी अगली रिपोर्ट चुनें",
        prompt: "हम आपके लिए आगे कौन सी रिपोर्ट तैयार करें?",
        success: "समझ गए — हम इसे जल्द ही आपके लिए तैयार करेंगे।",
      },
```

- [ ] **Step 3: Bengali**

Immediately after this existing block:

```ts
      reportRating: {
        title: "এই রিপোর্টটি রেট করুন",
        prompt: "এই রিপোর্টটি কেমন ছিল?",
        refunded: "এটা শুনে দুঃখিত — {{amount}} আপনার ওয়ালেটে যোগ করা হয়েছে।",
      },
```

insert:

```ts
      nextReportVote: {
        title: "আপনার পরবর্তী রিপোর্ট বেছে নিন",
        prompt: "আমরা এরপর আপনার জন্য কোন রিপোর্টটি তৈরি করব?",
        success: "বুঝেছি — আমরা শীঘ্রই এটি আপনার জন্য প্রস্তুত করব।",
      },
```

- [ ] **Step 4: Marathi**

Immediately after this existing block:

```ts
      reportRating: {
        title: "या अहवालाला रेट करा",
        prompt: "हा अहवाल कसा होता?",
        refunded: "हे ऐकून वाईट वाटले — {{amount}} तुमच्या वॉलेटमध्ये जमा करण्यात आले आहे.",
      },
```

insert:

```ts
      nextReportVote: {
        title: "तुमचा पुढील अहवाल निवडा",
        prompt: "आम्ही तुमच्यासाठी पुढे कोणता अहवाल तयार करावा?",
        success: "समजले — आम्ही लवकरच तो तुमच्यासाठी तयार करू.",
      },
```

- [ ] **Step 5: Telugu**

Immediately after this existing block:

```ts
      reportRating: {
        title: "ఈ నివేదికను రేట్ చేయండి",
        prompt: "ఈ నివేదిక ఎలా ఉంది?",
        refunded: "ఇది వినడానికి చింతిస్తున్నాము — {{amount}} మీ వాలెట్‌కు జోడించబడింది.",
      },
```

insert:

```ts
      nextReportVote: {
        title: "మీ తదుపరి నివేదికను ఎంచుకోండి",
        prompt: "మేము మీ కోసం తర్వాత ఏ నివేదికను సిద్ధం చేయాలి?",
        success: "అర్థమైంది — మేము దీన్ని త్వరలో మీ కోసం సిద్ధం చేస్తాము.",
      },
```

- [ ] **Step 6: Tamil**

Immediately after this existing block:

```ts
      reportRating: {
        title: "இந்த அறிக்கையை மதிப்பிடுங்கள்",
        prompt: "இந்த அறிக்கை எப்படி இருந்தது?",
        refunded: "இதைக் கேட்டு வருந்துகிறோம் — {{amount}} உங்கள் வாலட்டில் சேர்க்கப்பட்டுள்ளது.",
      },
```

insert:

```ts
      nextReportVote: {
        title: "உங்கள் அடுத்த அறிக்கையைத் தேர்ந்தெடுக்கவும்",
        prompt: "அடுத்து உங்களுக்காக நாங்கள் எந்த அறிக்கையைத் தயார் செய்ய வேண்டும்?",
        success: "சரி — இதை விரைவில் உங்களுக்காகத் தயார் செய்கிறோம்.",
      },
```

- [ ] **Step 7: Gujarati**

Immediately after this existing block:

```ts
      reportRating: {
        title: "આ રિપોર્ટને રેટ કરો",
        prompt: "આ રિપોર્ટ કેવો રહ્યો?",
        refunded: "આ સાંભળીને દુઃખ થયું — {{amount}} તમારા વૉલેટમાં ઉમેરવામાં આવ્યા છે.",
      },
```

insert:

```ts
      nextReportVote: {
        title: "તમારો આગલો રિપોર્ટ પસંદ કરો",
        prompt: "અમે તમારા માટે આગળ કયો રિપોર્ટ તૈયાર કરીએ?",
        success: "સમજાઈ ગયું — અમે તેને જલ્દી તમારા માટે તૈયાર કરીશું.",
      },
```

- [ ] **Step 8: Verify it compiles and every language has the key**

Run (from `FRONTEND`): `npx tsc --noEmit`
Expected: no new errors.

Run: `node -e "const r = require('./i18n/resources.ts')" 2>&1 | head -1 || true` — this file is TS, so instead just grep-count:

Run: `grep -c "nextReportVote:" i18n/resources.ts`
Expected: `7`

- [ ] **Step 9: Commit**

```bash
git add i18n/resources.ts
git commit -m "feat(i18n): add nextReportVote copy in all 7 languages

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: `NextReportSheet` component

**Files:**

- Create: `FRONTEND/components/reports/NextReportSheet.tsx`

- [ ] **Step 1: Write the component**

Create `FRONTEND/components/reports/NextReportSheet.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Check } from 'lucide-react';
import BottomSheetModal from '@/components/ui/BottomSheetModal';
import { useDismissOnBackPress } from '@/providers/back-handler-provider';
import { useAuth } from '@/providers/auth-provider';
import { reportsApi } from '@/lib/reports-api';
import { getReportTheme } from '@/lib/report-theme';
import { HUE_GRADIENT } from './ReportThemeCard';

/**
 * One-time "which report should we prepare next" prompt, offered on exit
 * from a report the user just read — see app/reports/[id]/page.tsx's
 * `offerNextReportVote`. Tap = select AND submit in one motion (a low-stakes
 * preference pick doesn't need a confirm step). Same bottom-sheet shell as
 * ReportRatingSheet, and the same fire-and-forget-on-error idiom: losing one
 * vote isn't worth an error state.
 */
export default function NextReportSheet({
  reportKeys,
  onClose,
}: {
  reportKeys: string[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { refresh } = useAuth();
  const [selected, setSelected] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useDismissOnBackPress(true, onClose);

  const pick = async (key: string) => {
    if (selected) return;
    setSelected(key);
    try {
      await reportsApi.voteNextReport(key);
      void refresh();
    } catch {
      // Losing one vote isn't worth an error state — same idiom as ReportRatingSheet.
    }
    setSubmitted(true);
    setTimeout(onClose, 900);
  };

  return (
    <BottomSheetModal
      onClose={onClose}
      closeLabel={t('common.close')}
      header={
        <h2 className="text-base font-display text-foreground">{t('nextReportVote.title')}</h2>
      }
    >
      {submitted ? (
        <div className="py-6 flex flex-col items-center gap-3 text-center">
          <div className="w-12 h-12 rounded-full bg-gradient-to-br from-yellow-400 to-yellow-600 flex items-center justify-center">
            <Check size={22} className="text-black" />
          </div>
          <p className="text-sm text-foreground">{t('nextReportVote.success')}</p>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted mb-4">{t('nextReportVote.prompt')}</p>
          <div className="grid grid-cols-2 gap-3">
            {reportKeys.map((key) => {
              const theme = getReportTheme(key);
              const Icon = theme.icon;
              const isSelected = selected === key;
              return (
                <motion.button
                  key={key}
                  type="button"
                  whileTap={{ scale: 0.95 }}
                  onClick={() => pick(key)}
                  disabled={!!selected}
                  className={`flex flex-col items-center gap-2 rounded-2xl border p-3 text-center transition-colors ${
                    isSelected ? 'border-gold bg-gold/10' : 'border-gold/15 bg-card'
                  }`}
                >
                  <div
                    className={`w-11 h-11 rounded-full flex items-center justify-center bg-gradient-to-br ${HUE_GRADIENT[theme.hue]}`}
                  >
                    <div className="w-8 h-8 rounded-full border border-gold/40 bg-background/30 backdrop-blur-sm flex items-center justify-center text-gold">
                      <Icon size={16} />
                    </div>
                  </div>
                  <p className="text-xs font-semibold text-foreground leading-snug line-clamp-2">
                    {t(`reports.labels.${key}`, key)}
                  </p>
                </motion.button>
              );
            })}
          </div>
        </>
      )}
    </BottomSheetModal>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run (from `FRONTEND`): `npx tsc --noEmit`
Expected: no new errors. (This component isn't wired into any page yet — Task 11 does that — so this step only confirms the file itself is well-typed in isolation, e.g. `HUE_GRADIENT` and `getReportTheme` imports resolve.)

- [ ] **Step 3: Commit**

```bash
git add components/reports/NextReportSheet.tsx
git commit -m "feat(reports): add NextReportSheet component

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11: Wire the prompt into the report detail page

**Files:**

- Modify: `FRONTEND/app/reports/[id]/page.tsx`

- [ ] **Step 1: Add imports**

Immediately after this existing line (20):

```ts
import { useTour, useTourReady } from '@/providers/tour-provider';
```

insert:

```ts
import { useAuth } from '@/providers/auth-provider';
```

Immediately after this existing line (27):

```ts
import {
  formatPeriodMonth,
  formatDateKey,
  addOneYear,
  YEARLY_REPORT_KEYS,
} from '@/lib/reports-logic';
```

change it to:

```ts
import {
  formatPeriodMonth,
  formatDateKey,
  addOneYear,
  YEARLY_REPORT_KEYS,
  isReportLocked,
} from '@/lib/reports-logic';
```

Immediately after this existing line (28):

```ts
import { maybeRequestReview, markReportGeneratedForReview } from '@/lib/app-review';
```

insert:

```ts
import { reportsApi } from '@/lib/reports-api';
```

Immediately after this existing line (31):

```ts
import { hasRatedReport } from '@/lib/report-rating';
```

insert:

```ts
import NextReportSheet from '@/components/reports/NextReportSheet';
```

- [ ] **Step 2: Add the eager catalogue prefetch and vote-offer state**

Immediately after this existing line (inside the component, currently line 57):

```ts
const { state, data, failedError, retry } = useReport(id, i18n.language);
```

insert:

```ts
const { user } = useAuth();
```

Immediately after this existing block (currently lines 79-83, the `showRatingModal`/`ratingModalBacks` state declarations):

```ts
const [showRatingModal, setShowRatingModal] = useState(false);
// Whether closing the rating sheet should complete a back-navigation it interrupted —
// true when opened by the scroll+back trigger, false when opened by the visible
// "Rate this report" button below, which isn't a substitute for leaving the page.
const [ratingModalBacks, setRatingModalBacks] = useState(false);
```

insert:

```ts
// Prefetched eagerly (not lazily inside attemptBack) because hardware back on
// native goes through the separate useDismissOnBackPress stack hook below, which
// needs a synchronous boolean to decide whether to offer this — a fetch kicked off
// only inside attemptBack would never even run on that path when `armed` is false.
const [upcomingReportKeys, setUpcomingReportKeys] = useState<string[]>([]);
const [nextReportVoteSubmitted, setNextReportVoteSubmitted] = useState(false);
const [showNextReportModal, setShowNextReportModal] = useState(false);
```

- [ ] **Step 3: Add the prefetch effect**

Immediately after this existing effect (currently lines 85-100, the scroll-count `useEffect`):

```ts
useEffect(() => {
  if (!ready) return;
  let n = 0;
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      n += 1;
      setScrollCount(n);
      ticking = false;
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  return () => window.removeEventListener('scroll', onScroll);
}, [ready]);
```

insert:

```ts
useEffect(() => {
  if (!ready || !user || user.nextReportVote) return;
  let cancelled = false;
  reportsApi
    .catalogue()
    .then(({ reports }) => {
      if (!cancelled) setUpcomingReportKeys(reports.filter(isReportLocked).map((r) => r.key));
    })
    .catch(() => {}); // fail open — the prompt simply never offers if this fails
  return () => {
    cancelled = true;
  };
}, [ready, user]);
```

- [ ] **Step 4: Update the back-handling logic**

Replace this existing block (currently lines 102-117):

```ts
const armed = ready && scrollCount >= ARM_AFTER_SCROLLS && !hasRatedReport(id);

const openRatingModalForBack = () => {
  setRatingModalBacks(true);
  setShowRatingModal(true);
};

useDismissOnBackPress(armed && !showRatingModal, openRatingModalForBack);

const attemptBack = () => {
  if (armed && !showRatingModal) {
    openRatingModalForBack();
    return;
  }
  router.back();
};
```

with:

```ts
const armed = ready && scrollCount >= ARM_AFTER_SCROLLS && !hasRatedReport(id);

const openRatingModalForBack = () => {
  setRatingModalBacks(true);
  setShowRatingModal(true);
};

const offerNextReportVote =
  !nextReportVoteSubmitted && !!user && !user.nextReportVote && upcomingReportKeys.length > 0;
const openNextReportModalForBack = () => setShowNextReportModal(true);

// Mutually exclusive with the rating sheet, on EITHER exit path — rating wins if both are due.
useDismissOnBackPress(
  (armed || offerNextReportVote) && !showRatingModal && !showNextReportModal,
  () => (armed ? openRatingModalForBack() : openNextReportModalForBack()),
);

const attemptBack = () => {
  if (armed && !showRatingModal) {
    openRatingModalForBack();
    return;
  }
  if (offerNextReportVote && !showNextReportModal) {
    openNextReportModalForBack();
    return;
  }
  router.back();
};

const closeNextReportModal = () => {
  setShowNextReportModal(false);
  // Instant local gate, same reasoning as hasRatedReport's localStorage check for the
  // rating sheet: closes the small window before a refresh() round-trip lands
  // user.nextReportVote, during which a second back-tap could otherwise reopen this.
  setNextReportVoteSubmitted(true);
  router.back();
};
```

- [ ] **Step 5: Render the sheet**

Immediately after this existing line (currently line 353):

```tsx
{
  showRatingModal && <ReportRatingSheet reportId={id} onClose={closeRatingModal} />;
}
```

insert:

```tsx
{
  showNextReportModal && (
    <NextReportSheet reportKeys={upcomingReportKeys} onClose={closeNextReportModal} />
  );
}
```

- [ ] **Step 6: Verify it compiles**

Run (from `FRONTEND`): `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Manually verify in the browser**

Run (from `FRONTEND`, in the background): `npm run dev`

1. Sign in as a test user who has purchased at least one report but not all of them, and has never voted (`nextReportVote` null — check via `GET /v1/me`).
2. Open a purchased report at `/reports/<id>`, scroll down less than twice, tap the back arrow.
3. Expected: `NextReportSheet` opens (not the rating sheet, since it's not armed), showing a grid of every NOT-yet-purchased report.
4. Tap one card. Expected: a brief selected/checkmark state, then the sheet closes and the page navigates back to `/reports`.
5. Open a different purchased report and tap back again. Expected: NO sheet opens this time (vote already recorded) — back navigates immediately.
6. Repeat steps 2-3 with a user who has purchased every report. Expected: no sheet opens (nothing left to offer), back navigates immediately.
7. Repeat with a user who scrolls 2+ times on an unrated report: expected the RATING sheet appears (not the next-report one), confirming mutual exclusivity.

- [ ] **Step 8: Commit**

```bash
git add app/reports/[id]/page.tsx
git commit -m "feat(reports): show next-report vote prompt on exit

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 12: Admin summary card

**Files:**

- Modify: `FRONTEND/app/admin/report-ratings/page.tsx`

- [ ] **Step 1: Add the card component and fetch**

In `FRONTEND/app/admin/report-ratings/page.tsx`, add `Card` and `AdminNextReportVoteRow` to the imports — change:

```tsx
import { adminApi, type AdminReportRatingRow } from '@/lib/admin-api';
```

to:

```tsx
import { adminApi, type AdminReportRatingRow, type AdminNextReportVoteRow } from '@/lib/admin-api';
import Card from '@/components/ui/Card';
```

Immediately after this existing function (the `formatDateTime` helper, ending at line 22):

```tsx
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
```

insert:

```tsx
function NextReportVotesCard({ votes }: { votes: AdminNextReportVoteRow[] }) {
  if (votes.length === 0) {
    return (
      <Card className="p-4 mb-4">
        <h2 className="text-sm font-semibold text-gold mb-1">Next Report Requests</h2>
        <p className="text-xs text-muted">No votes yet.</p>
      </Card>
    );
  }
  const max = votes[0].count;
  return (
    <Card className="p-4 mb-4">
      <h2 className="text-sm font-semibold text-gold mb-3">Next Report Requests</h2>
      <div className="space-y-2">
        {votes.map((v) => (
          <div key={v.reportKey} className="flex items-center gap-3">
            <span className="text-xs text-foreground w-32 shrink-0 truncate">{v.label}</span>
            <div className="flex-1 h-2 rounded-full bg-surface overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-yellow-400 to-yellow-600"
                style={{ width: `${(v.count / max) * 100}%` }}
              />
            </div>
            <span className="text-xs text-muted w-8 text-right shrink-0">{v.count}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}
```

- [ ] **Step 2: Fetch the votes once on mount**

Immediately after this existing state declaration (currently line 29):

```tsx
const [filterKey, setFilterKey] = useState<string>('');
```

insert:

```tsx
const [nextReportVotes, setNextReportVotes] = useState<AdminNextReportVoteRow[] | null>(null);

useEffect(() => {
  adminApi
    .getNextReportVotes()
    .then((res) => setNextReportVotes(res.votes))
    .catch(() => setNextReportVotes([]));
}, []);
```

- [ ] **Step 3: Render the card above the existing filter/table**

Replace this existing line (currently line 63):

```tsx
<p className="text-sm text-muted mb-4">
  Every rating a user has left on a report — a rating under 3 stars auto-refunds 100% of the price
  paid, shown in the Refunded column.
</p>
```

with:

```tsx
<p className="text-sm text-muted mb-4">
  Every rating a user has left on a report — a rating under 3 stars auto-refunds 100% of the price
  paid, shown in the Refunded column.
</p>;

{
  nextReportVotes && <NextReportVotesCard votes={nextReportVotes} />;
}
```

- [ ] **Step 4: Verify it compiles**

Run (from `FRONTEND`): `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Manually verify in the browser**

With the dev server running and Task 11's manual test having produced at least one vote:

1. Sign in as an admin, open `/admin/report-ratings`.
2. Expected: a "Next Report Requests" card appears above the report-key filter dropdown, showing the report label, a proportional bar, and the count for each report key voted on so far — sorted highest-count first.
3. Reload the page. Expected: the card still shows the same data (confirms it's reading from the real backend, not local-only state).

- [ ] **Step 6: Commit**

```bash
git add app/admin/report-ratings/page.tsx
git commit -m "feat(admin): show next-report vote counts above Report Ratings

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Explicitly out of scope (see spec)

- Per-profile votes (this is account-level only).
- A "change your vote" affordance anywhere in settings.
- Cooldown/retry logic for a dismissed-without-submitting prompt (app-switch mid-sheet) — it simply reappears on the next exit from any report, same as the rating sheet today.
- Surfacing the vote back to the user anywhere ("you asked for X, here it is").
