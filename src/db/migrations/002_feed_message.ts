import type { Migration } from './types.js';

/**
 * Where each bug's feed card is, so a delete can take it down with the issue.
 *
 * Only the card BugBot posted itself is recorded. The confirmation message
 * already had somewhere to live - `slack_channel_id` / `slack_thread_ts`,
 * which attachment sync needs - and the feed card is a different message in a
 * different channel, so it needs its own pair.
 */
export const migration: Migration = {
  id: '002_feed_message',
  sql: `
    ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS feed_channel_id TEXT;
    ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS feed_ts TEXT;
  `,
};
