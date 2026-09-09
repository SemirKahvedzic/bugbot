/**
 * Every SQL statement BugBot runs, in one place (SPEC 3: keep all SQL in
 * src/db/ so Postgres stays a drop-in later).
 *
 * node:sqlite refuses `undefined` as a bound parameter, so everything optional
 * goes through `nullable()`.
 */
import type { Db } from './index.js';
import type { IntakeSource } from '../types.js';

const nullable = <T>(value: T | undefined | null): T | null => value ?? null;

const now = () => new Date().toISOString();

export interface IssueReportRow {
  issue_key: string;
  slack_user_id: string | null;
  slack_channel_id: string | null;
  slack_thread_ts: string | null;
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
  routedTo?: 'backlog' | 'sprint' | 'closed' | 'none';
  actorAccountId?: string;
}

export class Repo {
  constructor(private readonly db: Db) {}

  // --- issue_reports -------------------------------------------------------

  recordIssueReport(input: {
    issueKey: string;
    slackUserId?: string;
    slackChannelId?: string;
    slackThreadTs?: string;
    intakeSource: IntakeSource;
  }): void {
    this.db
      .prepare(
        `INSERT INTO issue_reports
           (issue_key, slack_user_id, slack_channel_id, slack_thread_ts, intake_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(issue_key) DO UPDATE SET
           slack_user_id    = COALESCE(excluded.slack_user_id, issue_reports.slack_user_id),
           slack_channel_id = COALESCE(excluded.slack_channel_id, issue_reports.slack_channel_id),
           slack_thread_ts  = COALESCE(excluded.slack_thread_ts, issue_reports.slack_thread_ts)`,
      )
      .run(
        input.issueKey,
        nullable(input.slackUserId),
        nullable(input.slackChannelId),
        nullable(input.slackThreadTs),
        input.intakeSource,
        now(),
      );
  }

  getIssueReport(issueKey: string): IssueReportRow | undefined {
    return this.db.prepare('SELECT * FROM issue_reports WHERE issue_key = ?').get(issueKey) as
      | IssueReportRow
      | undefined;
  }

  /** Store the confirmation thread, so Phase 2 can attach files posted in it. */
  setThread(issueKey: string, channelId: string, threadTs: string): void {
    this.db
      .prepare(
        'UPDATE issue_reports SET slack_channel_id = ?, slack_thread_ts = ? WHERE issue_key = ?',
      )
      .run(channelId, threadTs, issueKey);
  }

  /** Which issue, if any, does this Slack thread belong to? */
  findByThread(channelId: string, threadTs: string): IssueReportRow | undefined {
    return this.db
      .prepare(
        'SELECT * FROM issue_reports WHERE slack_channel_id = ? AND slack_thread_ts = ? LIMIT 1',
      )
      .get(channelId, threadTs) as IssueReportRow | undefined;
  }

  issueKeysForSlackUser(slackUserId: string, limit = 100): string[] {
    return this.db
      .prepare(
        `SELECT issue_key FROM issue_reports
         WHERE slack_user_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(slackUserId, limit)
      .map((row) => String((row as { issue_key: string }).issue_key));
  }

  // --- user_map ------------------------------------------------------------

  upsertUserMap(input: { slackUserId: string; jiraAccountId?: string; email?: string }): void {
    this.db
      .prepare(
        `INSERT INTO user_map (slack_user_id, jira_account_id, email, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(slack_user_id) DO UPDATE SET
           jira_account_id = COALESCE(excluded.jira_account_id, user_map.jira_account_id),
           email           = COALESCE(excluded.email, user_map.email),
           updated_at      = excluded.updated_at`,
      )
      .run(input.slackUserId, nullable(input.jiraAccountId), nullable(input.email), now());
  }

  userBySlackId(slackUserId: string): UserMapRow | undefined {
    return this.db.prepare('SELECT * FROM user_map WHERE slack_user_id = ?').get(slackUserId) as
      | UserMapRow
      | undefined;
  }

  userByJiraAccountId(accountId: string): UserMapRow | undefined {
    return this.db
      .prepare('SELECT * FROM user_map WHERE jira_account_id = ? LIMIT 1')
      .get(accountId) as UserMapRow | undefined;
  }

  userByEmail(email: string): UserMapRow | undefined {
    return this.db
      .prepare('SELECT * FROM user_map WHERE lower(email) = lower(?) LIMIT 1')
      .get(email) as UserMapRow | undefined;
  }

  // --- notifications (idempotency) ----------------------------------------

  /**
   * Claim a one-shot notification.
   *
   * Returns true exactly once per dedupe key. Jira redelivers webhooks, and a
   * duplicate DM destroys trust in the bot faster than anything else (SPEC 7),
   * so every outbound message is gated on this.
   */
  claimNotification(dedupeKey: string): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO notifications (dedupe_key, sent_at) VALUES (?, ?)')
      .run(dedupeKey, now());
    return result.changes === 1;
  }

  /**
   * Rate-limit a per-issue notification stream (SPEC 8: "if an issue changes
   * twice within 5 minutes, send once"). Returns true when it is time to send,
   * and records the send.
   */
  claimDigest(key: string, windowMs: number): boolean {
    const row = this.db.prepare('SELECT sent_at FROM notifications WHERE dedupe_key = ?').get(key) as
      | { sent_at: string }
      | undefined;

    if (row) {
      const age = Date.now() - new Date(row.sent_at).getTime();
      if (age < windowMs) return false;
    }

    this.db
      .prepare(
        `INSERT INTO notifications (dedupe_key, sent_at) VALUES (?, ?)
         ON CONFLICT(dedupe_key) DO UPDATE SET sent_at = excluded.sent_at`,
      )
      .run(key, now());
    return true;
  }

  /** Housekeeping: the ledger only needs to remember recent history. */
  pruneNotifications(olderThanDays = 30): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    return this.db.prepare('DELETE FROM notifications WHERE sent_at < ?').run(cutoff)
      .changes as number;
  }

  // --- triage_events -------------------------------------------------------

  recordTriageEvent(input: TriageEventInput): void {
    this.db
      .prepare(
        `INSERT INTO triage_events
           (issue_key, from_status, to_status, priority, routed_to, actor_account_id, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.issueKey,
        nullable(input.fromStatus),
        nullable(input.toStatus),
        nullable(input.priority),
        nullable(input.routedTo),
        nullable(input.actorAccountId),
        now(),
      );
  }

  // --- metrics (SPEC 8 /bugstats) -----------------------------------------

  /** Issues created since a cutoff, grouped by the `app:` label we stored. */
  intakeSince(sinceIso: string): Array<{ intake_source: string; count: number }> {
    return this.db
      .prepare(
        `SELECT intake_source, COUNT(*) AS count
         FROM issue_reports
         WHERE created_at >= ?
         GROUP BY intake_source
         ORDER BY count DESC`,
      )
      .all(sinceIso) as Array<{ intake_source: string; count: number }>;
  }

  routingSplitSince(sinceIso: string): Array<{ routed_to: string; count: number }> {
    return this.db
      .prepare(
        `SELECT routed_to, COUNT(*) AS count
         FROM triage_events
         WHERE at >= ? AND routed_to IS NOT NULL
         GROUP BY routed_to
         ORDER BY count DESC`,
      )
      .all(sinceIso) as Array<{ routed_to: string; count: number }>;
  }

  topReportersSince(
    sinceIso: string,
    limit = 3,
  ): Array<{ slack_user_id: string; count: number }> {
    return this.db
      .prepare(
        `SELECT slack_user_id, COUNT(*) AS count
         FROM issue_reports
         WHERE created_at >= ? AND slack_user_id IS NOT NULL
         GROUP BY slack_user_id
         ORDER BY count DESC
         LIMIT ?`,
      )
      .all(sinceIso, limit) as Array<{ slack_user_id: string; count: number }>;
  }

  /**
   * Median milliseconds between an issue being created and it leaving triage.
   * Returns undefined when nothing has been triaged in the window.
   */
  medianTimeInTriageMs(sinceIso: string): number | undefined {
    const rows = this.db
      .prepare(
        `SELECT r.created_at AS created_at, MIN(e.at) AS triaged_at
         FROM issue_reports r
         JOIN triage_events e ON e.issue_key = r.issue_key
         WHERE e.at >= ?
         GROUP BY r.issue_key`,
      )
      .all(sinceIso) as Array<{ created_at: string; triaged_at: string }>;

    const durations = rows
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
