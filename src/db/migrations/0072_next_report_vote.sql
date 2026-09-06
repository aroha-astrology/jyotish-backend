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
