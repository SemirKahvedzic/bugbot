import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';

let db: Db;
let repo: Repo;

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  repo = new Repo(db);
});

describe('issue_reports', () => {
  it('records and reads back a Slack-filed bug', () => {
    repo.recordIssueReport({
      issueKey: 'SUP-10',
      slackUserId: 'U1',
      slackChannelId: 'C1',
      intakeSource: 'slack_modal',
    });

    const row = repo.getIssueReport('SUP-10');
    expect(row?.slack_user_id).toBe('U1');
    expect(row?.slack_channel_id).toBe('C1');
    expect(row?.intake_source).toBe('slack_modal');
    expect(row?.created_at).toBeTruthy();
  });

  it('records a Jira-native bug with no Slack identity', () => {
    repo.recordIssueReport({ issueKey: 'SUP-11', intakeSource: 'jira_native' });
    const row = repo.getIssueReport('SUP-11');
    expect(row?.slack_user_id).toBeNull();
    expect(row?.intake_source).toBe('jira_native');
  });

  it('is safe to record twice - a webhook replay must not fail or wipe data', () => {
    repo.recordIssueReport({
      issueKey: 'SUP-12',
      slackUserId: 'U1',
      slackChannelId: 'C1',
      intakeSource: 'slack_modal',
    });
    repo.setThread('SUP-12', 'C1', '111.222');

    // A later record with less information must not erase what we know.
    repo.recordIssueReport({ issueKey: 'SUP-12', intakeSource: 'jira_native' });

    const row = repo.getIssueReport('SUP-12');
    expect(row?.slack_user_id).toBe('U1');
    expect(row?.slack_thread_ts).toBe('111.222');
  });

  it('backfills the Slack user on a bug first seen from Jira', () => {
    repo.recordIssueReport({ issueKey: 'SUP-13', intakeSource: 'jira_native' });
    repo.recordIssueReport({ issueKey: 'SUP-13', slackUserId: 'U9', intakeSource: 'jira_native' });
    expect(repo.getIssueReport('SUP-13')?.slack_user_id).toBe('U9');
  });

  it('finds the issue that owns a Slack thread', () => {
    repo.recordIssueReport({ issueKey: 'SUP-14', slackChannelId: 'C1', intakeSource: 'slack_modal' });
    repo.setThread('SUP-14', 'C1', '999.000');

    expect(repo.findByThread('C1', '999.000')?.issue_key).toBe('SUP-14');
    expect(repo.findByThread('C1', 'other')).toBeUndefined();
    expect(repo.findByThread('C2', '999.000')).toBeUndefined();
  });

  it('lists a reporter\'s issue keys, newest first', () => {
    for (const key of ['SUP-1', 'SUP-2', 'SUP-3']) {
      repo.recordIssueReport({ issueKey: key, slackUserId: 'U1', intakeSource: 'slack_modal' });
      // created_at has second-ish resolution; nudge the order explicitly.
      db.prepare('UPDATE issue_reports SET created_at = ? WHERE issue_key = ?').run(
        `2026-09-0${key.split('-')[1]}T00:00:00Z`,
        key,
      );
    }
    repo.recordIssueReport({ issueKey: 'SUP-9', slackUserId: 'U2', intakeSource: 'slack_modal' });

    expect(repo.issueKeysForSlackUser('U1')).toEqual(['SUP-3', 'SUP-2', 'SUP-1']);
    expect(repo.issueKeysForSlackUser('U2')).toEqual(['SUP-9']);
    expect(repo.issueKeysForSlackUser('U1', 2)).toEqual(['SUP-3', 'SUP-2']);
  });
});

describe('user_map', () => {
  it('caches an identity and merges later partial updates', () => {
    repo.upsertUserMap({ slackUserId: 'U1', email: 'a@roarington.com' });
    expect(repo.userBySlackId('U1')?.jira_account_id).toBeNull();

    repo.upsertUserMap({ slackUserId: 'U1', jiraAccountId: 'acc-1' });

    const row = repo.userBySlackId('U1');
    expect(row?.email).toBe('a@roarington.com');
    expect(row?.jira_account_id).toBe('acc-1');
  });

  it('looks up by Jira account and by email, case-insensitively', () => {
    repo.upsertUserMap({ slackUserId: 'U1', jiraAccountId: 'acc-1', email: 'A@Roarington.com' });
    expect(repo.userByJiraAccountId('acc-1')?.slack_user_id).toBe('U1');
    expect(repo.userByEmail('a@roarington.com')?.slack_user_id).toBe('U1');
    expect(repo.userByEmail('nobody@roarington.com')).toBeUndefined();
  });
});

describe('notifications: idempotency (SPEC 7)', () => {
  it('claims a key exactly once', () => {
    expect(repo.claimNotification('route:SUP-1:900')).toBe(true);
    expect(repo.claimNotification('route:SUP-1:900')).toBe(false);
    expect(repo.claimNotification('route:SUP-1:900')).toBe(false);
  });

  it('treats different changes as different claims', () => {
    expect(repo.claimNotification('route:SUP-1:900')).toBe(true);
    expect(repo.claimNotification('route:SUP-1:901')).toBe(true);
    expect(repo.claimNotification('route:SUP-2:900')).toBe(true);
  });

  it('prunes only old rows', () => {
    repo.claimNotification('old');
    repo.claimNotification('new');
    db.prepare('UPDATE notifications SET sent_at = ? WHERE dedupe_key = ?').run(
      '2020-01-01T00:00:00Z',
      'old',
    );

    expect(repo.pruneNotifications(30)).toBe(1);
    expect(repo.claimNotification('new')).toBe(false);
    expect(repo.claimNotification('old')).toBe(true);
  });
});

describe('notifications: digest window (SPEC 8)', () => {
  it('sends once, then suppresses inside the window', () => {
    expect(repo.claimDigest('digest:SUP-1', 300_000)).toBe(true);
    expect(repo.claimDigest('digest:SUP-1', 300_000)).toBe(false);
  });

  it('sends again once the window has passed', () => {
    expect(repo.claimDigest('digest:SUP-1', 300_000)).toBe(true);

    db.prepare('UPDATE notifications SET sent_at = ? WHERE dedupe_key = ?').run(
      new Date(Date.now() - 600_000).toISOString(),
      'digest:SUP-1',
    );

    expect(repo.claimDigest('digest:SUP-1', 300_000)).toBe(true);
    // ...and the clock restarts.
    expect(repo.claimDigest('digest:SUP-1', 300_000)).toBe(false);
  });

  it('keeps issues independent', () => {
    expect(repo.claimDigest('digest:SUP-1', 300_000)).toBe(true);
    expect(repo.claimDigest('digest:SUP-2', 300_000)).toBe(true);
  });
});

describe('triage_events and metrics (SPEC 8)', () => {
  const since = '2026-01-01T00:00:00Z';

  it('records a routing decision', () => {
    repo.recordTriageEvent({
      issueKey: 'SUP-1',
      fromStatus: 'Under Triage',
      toStatus: 'To Do',
      priority: 'High',
      routedTo: 'sprint',
      actorAccountId: 'acc-1',
    });

    const rows = repo.routingSplitSince(since);
    expect(rows).toEqual([{ routed_to: 'sprint', count: 1 }]);
  });

  it('splits backlog from sprint, which is why routed_to survived the Kanban change', () => {
    repo.recordTriageEvent({ issueKey: 'SUP-1', routedTo: 'backlog' });
    repo.recordTriageEvent({ issueKey: 'SUP-2', routedTo: 'backlog' });
    repo.recordTriageEvent({ issueKey: 'SUP-3', routedTo: 'sprint' });

    expect(repo.routingSplitSince(since)).toEqual([
      { routed_to: 'backlog', count: 2 },
      { routed_to: 'sprint', count: 1 },
    ]);
  });

  it('counts intake by source', () => {
    repo.recordIssueReport({ issueKey: 'SUP-1', intakeSource: 'slack_modal' });
    repo.recordIssueReport({ issueKey: 'SUP-2', intakeSource: 'slack_modal' });
    repo.recordIssueReport({ issueKey: 'SUP-3', intakeSource: 'jira_native' });

    expect(repo.intakeSince(since)).toEqual([
      { intake_source: 'slack_modal', count: 2 },
      { intake_source: 'jira_native', count: 1 },
    ]);
  });

  it('ranks the top reporters and ignores unknown ones', () => {
    repo.recordIssueReport({ issueKey: 'SUP-1', slackUserId: 'U1', intakeSource: 'slack_modal' });
    repo.recordIssueReport({ issueKey: 'SUP-2', slackUserId: 'U1', intakeSource: 'slack_modal' });
    repo.recordIssueReport({ issueKey: 'SUP-3', slackUserId: 'U2', intakeSource: 'slack_modal' });
    repo.recordIssueReport({ issueKey: 'SUP-4', intakeSource: 'jira_native' });

    expect(repo.topReportersSince(since, 3)).toEqual([
      { slack_user_id: 'U1', count: 2 },
      { slack_user_id: 'U2', count: 1 },
    ]);
  });

  it('computes the median time in triage', () => {
    // Two issues: one triaged after 1h, one after 3h. Median of two = 2h.
    repo.recordIssueReport({ issueKey: 'SUP-1', intakeSource: 'slack_modal' });
    repo.recordIssueReport({ issueKey: 'SUP-2', intakeSource: 'slack_modal' });
    db.prepare('UPDATE issue_reports SET created_at = ? WHERE issue_key = ?').run(
      '2026-02-01T00:00:00Z',
      'SUP-1',
    );
    db.prepare('UPDATE issue_reports SET created_at = ? WHERE issue_key = ?').run(
      '2026-02-01T00:00:00Z',
      'SUP-2',
    );

    repo.recordTriageEvent({ issueKey: 'SUP-1', routedTo: 'backlog' });
    repo.recordTriageEvent({ issueKey: 'SUP-2', routedTo: 'sprint' });
    db.prepare('UPDATE triage_events SET at = ? WHERE issue_key = ?').run(
      '2026-02-01T01:00:00Z',
      'SUP-1',
    );
    db.prepare('UPDATE triage_events SET at = ? WHERE issue_key = ?').run(
      '2026-02-01T03:00:00Z',
      'SUP-2',
    );

    expect(repo.medianTimeInTriageMs(since)).toBe(2 * 3600 * 1000);
  });

  it('returns no median when nothing was triaged', () => {
    expect(repo.medianTimeInTriageMs(since)).toBeUndefined();
  });

  it('uses the first triage event, not a later one, for an issue triaged twice', () => {
    repo.recordIssueReport({ issueKey: 'SUP-1', intakeSource: 'slack_modal' });
    db.prepare('UPDATE issue_reports SET created_at = ? WHERE issue_key = ?').run(
      '2026-02-01T00:00:00Z',
      'SUP-1',
    );
    repo.recordTriageEvent({ issueKey: 'SUP-1', routedTo: 'backlog' });
    repo.recordTriageEvent({ issueKey: 'SUP-1', routedTo: 'sprint' });
    db.prepare("UPDATE triage_events SET at = '2026-02-01T01:00:00Z' WHERE id = 1").run();
    db.prepare("UPDATE triage_events SET at = '2026-02-05T00:00:00Z' WHERE id = 2").run();

    expect(repo.medianTimeInTriageMs(since)).toBe(3600 * 1000);
  });
});
