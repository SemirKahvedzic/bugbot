/**
 * Every SQL statement BugBot runs, in one place (SPEC 3).
 *
 * Postgres, so every method is async and parameters are $n. `COUNT(*)` and
 * bigint columns come back as strings, hence `toCount` on anything numeric -
 * forgetting it yields string concatenation instead of arithmetic, silently.
 */
import { toCount, type Db } from './index.js';
import type { IntakeSource } from '../types.js';

const nullable = <T>(value: T | undefined | null): T | null => value ?? null;

const now = () => new Date().toISOString();

export interface IssueReportRow {
  issue_key: string;
  slack_user_id: string | null;
  slack_channel_id: string | null;
  slack_thread_ts: string | null;
  /** The feed card BugBot posted, when there is one. */
  feed_channel_id: string | null;
  feed_ts: string | null;
  intake_source: string;
  created_at: string;
}

export interface UserMapRow {
  slack_user_id: string;
  jira_account_id: string | null;
  email: string | null;
  updated_at: string;
}

export interface TriageEventInput {
  issueKey: string;
  fromStatus?: string;
  toStatus?: string;
  priority?: string;
  /** 'manual' is a triager choosing a column by hand, not a routing rule. */
  routedTo?: 'backlog' | 'sprint' | 'closed' | 'none' | 'manual' | 'deleted';
  actorAccountId?: string;
}

export class Repo {
  constructor(private readonly db: Db) {}

  // --- issue_reports -------------------------------------------------------

  async recordIssueReport(input: {
    issueKey: string;
    slackUserId?: string;
    slackChannelId?: string;
    slackThreadTs?: string;
    intakeSource: IntakeSource;
  }): Promise<void> {
    // COALESCE on conflict: a later, less informed write - a webhook replay,
    // or a Jira-native event for a bug we already know from Slack - must never
    // erase an identity we already have.
    await this.db.query(
      `INSERT INTO issue_reports
         (issue_key, slack_user_id, slack_channel_id, slack_thread_ts, intake_source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (issue_key) DO UPDATE SET
         slack_user_id    = COALESCE(excluded.slack_user_id, issue_reports.slack_user_id),
         slack_channel_id = COALESCE(excluded.slack_channel_id, issue_reports.slack_channel_id),
         slack_thread_ts  = COALESCE(excluded.slack_thread_ts, issue_reports.slack_thread_ts)`,
      [
        input.issueKey,
        nullable(input.slackUserId),
        nullable(input.slackChannelId),
        nullable(input.slackThreadTs),
        input.intakeSource,
        now(),
      ],
    );
  }

  async getIssueReport(issueKey: string): Promise<IssueReportRow | undefined> {
    const result = await this.db.query<IssueReportRow>(
      'SELECT * FROM issue_reports WHERE issue_key = $1',
      [issueKey],
    );
    return result.rows[0];
  }

  /** Store the confirmation thread, so Phase 2 can attach files posted in it. */
  async setThread(issueKey: string, channelId: string, threadTs: string): Promise<void> {
    await this.db.query(
      'UPDATE issue_reports SET slack_channel_id = $1, slack_thread_ts = $2 WHERE issue_key = $3',
      [channelId, threadTs, issueKey],
    );
  }

  /**
   * Remember the feed card, so deleting the bug can take the card down too.
   *
   * A no-op when the issue has no row yet, which cannot happen: both intake
   * paths record the report before they post the card.
   */
  async setFeedMessage(issueKey: string, channelId: string, ts: string): Promise<void> {
    await this.db.query(
      'UPDATE issue_reports SET feed_channel_id = $1, feed_ts = $2 WHERE issue_key = $3',
      [channelId, ts, issueKey],
    );
  }

  /**
   * Forget an issue entirely. Returns false when there was nothing to forget.
   *
   * Required rather than tidy: `/mybugs` and App Home build JQL with
   * `issuekey IN (...)` from these rows, and Jira rejects the *whole query*
   * when one key no longer exists. Leaving the row behind after a delete would
   * empty the reporter's list rather than remove one card from it.
   *
   * The `triage_events` rows are deliberately kept - they are the audit trail,
   * and /bugstats counts decisions, not surviving issues.
   */
  async deleteIssueReport(issueKey: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM issue_reports WHERE issue_key = $1', [
      issueKey,
    ]);
    return result.rowCount === 1;
  }

  /** Which issue, if any, does this Slack thread belong to? */
  async findByThread(channelId: string, threadTs: string): Promise<IssueReportRow | undefined> {
    const result = await this.db.query<IssueReportRow>(
      'SELECT * FROM issue_reports WHERE slack_channel_id = $1 AND slack_thread_ts = $2 LIMIT 1',
      [channelId, threadTs],
    );
    return result.rows[0];
  }

  async issueKeysForSlackUser(slackUserId: string, limit = 100): Promise<string[]> {
    const result = await this.db.query<{ issue_key: string }>(
      `SELECT issue_key FROM issue_reports
       WHERE slack_user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [slackUserId, limit],
    );
    return result.rows.map((row) => row.issue_key);
  }

  // --- user_map ------------------------------------------------------------

  async upsertUserMap(input: {
    slackUserId: string;
    jiraAccountId?: string;
    email?: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO user_map (slack_user_id, jira_account_id, email, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slack_user_id) DO UPDATE SET
         jira_account_id = COALESCE(excluded.jira_account_id, user_map.jira_account_id),
         email           = COALESCE(excluded.email, user_map.email),
         updated_at      = excluded.updated_at`,
      [input.slackUserId, nullable(input.jiraAccountId), nullable(input.email), now()],
    );
  }

  async userBySlackId(slackUserId: string): Promise<UserMapRow | undefined> {
    const result = await this.db.query<UserMapRow>(
      'SELECT * FROM user_map WHERE slack_user_id = $1',
      [slackUserId],
    );
    return result.rows[0];
  }

  async userByJiraAccountId(accountId: string): Promise<UserMapRow | undefined> {
    const result = await this.db.query<UserMapRow>(
      'SELECT * FROM user_map WHERE jira_account_id = $1 LIMIT 1',
      [accountId],
    );
    return result.rows[0];
  }

  async userByEmail(email: string): Promise<UserMapRow | undefined> {
    const result = await this.db.query<UserMapRow>(
      'SELECT * FROM user_map WHERE lower(email) = lower($1) LIMIT 1',
      [email],
    );
    return result.rows[0];
  }

  // --- notifications (idempotency) ----------------------------------------

  /**
   * Claim a one-shot notification.
   *
   * Returns true exactly once per dedupe key. Jira redelivers webhooks, and a
   * duplicate DM destroys trust in the bot faster than anything else (SPEC 7),
   * so every outbound message is gated on this. The atomicity is Postgres's:
   * two concurrent invocations cannot both get a rowCount of 1.
   */
  async claimNotification(dedupeKey: string): Promise<boolean> {
    const result = await this.db.query(
      // No conflict target on purpose. `dedupe_key` is the only constraint on
      // this table, so the targeted and untargeted forms behave identically on
      // Postgres - but pg-mem reports rowCount 1 for the targeted form even
      // when nothing was inserted, which would make the offline suite unable
      // to verify the one guarantee that matters most here.
      `INSERT INTO notifications (dedupe_key, sent_at) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [dedupeKey, now()],
    );
    return result.rowCount === 1;
  }

  /**
   * Rate-limit a per-issue notification stream (SPEC 8: "if an issue changes
   * twice within 5 minutes, send once"). Returns true when it is time to send,
   * and records the send.
   *
   * Two statements rather than a conditional upsert, and both are atomic on
   * their own, so two concurrent invocations cannot both decide it is their
   * turn: either one wins the INSERT, or exactly one wins the UPDATE whose
   * predicate includes the window check. Reading the timestamp and then
   * writing it would be the racy version of this.
   */
  async claimDigest(key: string, windowMs: number): Promise<boolean> {
    const first = await this.db.query(
      // Untargeted for the same reason as claimNotification above.
      `INSERT INTO notifications (dedupe_key, sent_at) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [key, now()],
    );
    // Nothing was there: this is the first notification for this key.
    if (first.rowCount === 1) return true;

    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const again = await this.db.query(
      'UPDATE notifications SET sent_at = $1 WHERE dedupe_key = $2 AND sent_at < $3',
      [now(), key, cutoff],
    );
    return again.rowCount === 1;
  }

  /** Housekeeping: the ledger only needs to remember recent history. */
  async pruneNotifications(olderThanDays = 30): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const result = await this.db.query('DELETE FROM notifications WHERE sent_at < $1', [cutoff]);
    return result.rowCount;
  }

  // --- triage_events -------------------------------------------------------

  async recordTriageEvent(input: TriageEventInput): Promise<void> {
    await this.db.query(
      `INSERT INTO triage_events
         (issue_key, from_status, to_status, priority, routed_to, actor_account_id, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.issueKey,
        nullable(input.fromStatus),
        nullable(input.toStatus),
        nullable(input.priority),
        nullable(input.routedTo),
        nullable(input.actorAccountId),
        now(),
      ],
    );
  }

  // --- metrics (SPEC 8 /bugstats) -----------------------------------------

  async intakeSince(sinceIso: string): Promise<Array<{ intake_source: string; count: number }>> {
    const result = await this.db.query<{ intake_source: string; count: unknown }>(
      `SELECT intake_source, COUNT(*) AS count
       FROM issue_reports
       WHERE created_at >= $1
       GROUP BY intake_source
       ORDER BY COUNT(*) DESC, intake_source ASC`,
      [sinceIso],
    );
    return result.rows.map((row) => ({
      intake_source: row.intake_source,
      count: toCount(row.count),
    }));
  }

  async routingSplitSince(sinceIso: string): Promise<Array<{ routed_to: string; count: number }>> {
    const result = await this.db.query<{ routed_to: string; count: unknown }>(
      `SELECT routed_to, COUNT(*) AS count
       FROM triage_events
       WHERE at >= $1 AND routed_to IS NOT NULL
       GROUP BY routed_to
       ORDER BY COUNT(*) DESC, routed_to ASC`,
      [sinceIso],
    );
    return result.rows.map((row) => ({ routed_to: row.routed_to, count: toCount(row.count) }));
  }

  async topReportersSince(
    sinceIso: string,
    limit = 3,
  ): Promise<Array<{ slack_user_id: string; count: number }>> {
    const result = await this.db.query<{ slack_user_id: string; count: unknown }>(
      `SELECT slack_user_id, COUNT(*) AS count
       FROM issue_reports
       WHERE created_at >= $1 AND slack_user_id IS NOT NULL
       GROUP BY slack_user_id
       ORDER BY COUNT(*) DESC, slack_user_id ASC
       LIMIT $2`,
      [sinceIso, limit],
    );
    return result.rows.map((row) => ({
      slack_user_id: row.slack_user_id,
      count: toCount(row.count),
    }));
  }

  /**
   * Median milliseconds between an issue being created and it first leaving
   * triage. Returns undefined when nothing has been triaged in the window.
   */
  async medianTimeInTriageMs(sinceIso: string): Promise<number | undefined> {
    const result = await this.db.query<{ created_at: string; triaged_at: string }>(
      `SELECT r.created_at AS created_at, MIN(e.at) AS triaged_at
       FROM issue_reports r
       JOIN triage_events e ON e.issue_key = r.issue_key
       WHERE e.at >= $1
       GROUP BY r.issue_key, r.created_at`,
      [sinceIso],
    );

    const durations = result.rows
      .map((row) => new Date(row.triaged_at).getTime() - new Date(row.created_at).getTime())
      .filter((ms) => Number.isFinite(ms) && ms >= 0)
      .sort((a, b) => a - b);

    if (durations.length === 0) return undefined;
    const middle = Math.floor(durations.length / 2);
    return durations.length % 2 === 1
      ? durations[middle]!
      : Math.round((durations[middle - 1]! + durations[middle]!) / 2);
  }
}
