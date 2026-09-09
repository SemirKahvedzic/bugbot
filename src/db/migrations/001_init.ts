import type { Migration } from './types.js';

/** The four tables from SPEC 4. */
export const migration: Migration = {
  id: '001_init',
  sql: `
    -- Every bug we know about, however it was reported.
    CREATE TABLE IF NOT EXISTS issue_reports (
      issue_key        TEXT PRIMARY KEY,
      slack_user_id    TEXT,
      slack_channel_id TEXT,
      slack_thread_ts  TEXT,
      intake_source    TEXT NOT NULL,
      created_at       TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_issue_reports_slack_user
      ON issue_reports (slack_user_id);
    CREATE INDEX IF NOT EXISTS idx_issue_reports_thread
      ON issue_reports (slack_channel_id, slack_thread_ts);

    -- Slack <-> Jira identity cache, populated via users.lookupByEmail.
    CREATE TABLE IF NOT EXISTS user_map (
      slack_user_id   TEXT PRIMARY KEY,
      jira_account_id TEXT,
      email           TEXT,
      updated_at      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_user_map_jira_account
      ON user_map (jira_account_id);

    -- Idempotency ledger: Jira redelivers webhooks, and a duplicate DM
    -- destroys trust in the bot faster than anything else (SPEC 7).
    CREATE TABLE IF NOT EXISTS notifications (
      dedupe_key TEXT PRIMARY KEY,
      sent_at    TEXT NOT NULL
    );

    -- One row per routing decision, for the SPEC 8 metrics digest.
    CREATE TABLE IF NOT EXISTS triage_events (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_key         TEXT NOT NULL,
      from_status       TEXT,
      to_status         TEXT,
      priority          TEXT,
      routed_to         TEXT,
      actor_account_id  TEXT,
      at                TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_triage_events_issue
      ON triage_events (issue_key);
    CREATE INDEX IF NOT EXISTS idx_triage_events_at
      ON triage_events (at);
  `,
};
