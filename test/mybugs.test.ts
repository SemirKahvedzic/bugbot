import { describe, expect, it } from 'vitest';
import { buildMyBugsJql, jqlUrl, toSummaryLine } from '../src/slack/commands/mybugs.js';
import { collectStats, formatDuration, statsBlocks, type Stats } from '../src/slack/commands/bugstats.js';
import { Leaders, parseLeaders, validLeaderKeys } from '../src/triage/leaders.js';
import { createLogger } from '../src/logger.js';
import { APPLICATIONS, slugify } from '../src/types.js';
import { fixtureIssue, makeTestContext } from './helpers/context.js';

describe('buildMyBugsJql (SPEC 8)', () => {
  it('unions the keys we recorded with what Jira thinks they reported', async () => {
    const jql = buildMyBugsJql({
      projectKey: 'SUP',
      issueKeys: ['SUP-1', 'SUP-2'],
      jiraAccountId: 'acc-1',
    });
    expect(jql).toBe(
      'project = SUP AND (issuekey IN (SUP-1, SUP-2) OR reporter = "acc-1") ORDER BY created DESC',
    );
  });

  it('works with only recorded keys', async () => {
    expect(buildMyBugsJql({ projectKey: 'SUP', issueKeys: ['SUP-1'] })).toBe(
      'project = SUP AND (issuekey IN (SUP-1)) ORDER BY created DESC',
    );
  });

  it('works with only a Jira account, for someone who only files in Jira', async () => {
    expect(buildMyBugsJql({ projectKey: 'SUP', issueKeys: [], jiraAccountId: 'acc-1' })).toBe(
      'project = SUP AND (reporter = "acc-1") ORDER BY created DESC',
    );
  });

  it('returns nothing when there is nothing to ask about', async () => {
    expect(buildMyBugsJql({ projectKey: 'SUP', issueKeys: [] })).toBeUndefined();
  });

  it('drops anything that is not an issue key, since keys go straight into JQL', async () => {
    const jql = buildMyBugsJql({
      projectKey: 'SUP',
      issueKeys: ['SUP-1', 'SUP-1) OR project = SOFT --', 'lowercase-1', ''],
    });
    expect(jql).toBe('project = SUP AND (issuekey IN (SUP-1)) ORDER BY created DESC');
  });

  it('strips quotes from an account id so it cannot break out of the clause', async () => {
    const jql = buildMyBugsJql({
      projectKey: 'SUP',
      issueKeys: [],
      jiraAccountId: 'acc" OR project = SOFT',
    });
    expect(jql).toContain('reporter = "acc OR project = SOFT"');
    expect(jql?.match(/"/g)).toHaveLength(2);
  });
});

describe('jqlUrl', () => {
  it('percent-encodes the query', async () => {
    const url = jqlUrl('https://roarington.atlassian.net', 'project = SUP AND status = "To Do"');
    expect(url).toContain('/issues/?jql=');
    expect(url).not.toContain(' ');
    expect(decodeURIComponent(url.split('jql=')[1]!)).toBe('project = SUP AND status = "To Do"');
  });
});

describe('toSummaryLine', () => {
  it('copes with an issue missing optional fields', async () => {
    expect(toSummaryLine({ key: 'SUP-1', fields: {} })).toEqual({
      key: 'SUP-1',
      summary: '(no summary)',
      status: 'Unknown',
    });
  });

  it('carries priority and updated when present', async () => {
    expect(
      toSummaryLine({
        key: 'SUP-2',
        fields: {
          summary: 'a',
          status: { name: 'Under Triage' },
          priority: { name: 'High' },
          updated: '2026-09-09T00:00:00Z',
        },
      }),
    ).toEqual({
      key: 'SUP-2',
      summary: 'a',
      status: 'Under Triage',
      priority: 'High',
      updated: '2026-09-09T00:00:00Z',
    });
  });
});

describe('Leaders (SPEC 9.2)', () => {
  const log = createLogger({ level: 'silent' });

  it('falls back to the default triager with nothing configured', () => {
    const leaders = new Leaders({ fallbackSlackUserId: 'U_QA', log });
    expect(leaders.forApplication('world.roarington.com')).toEqual({ slackUserId: 'U_QA' });
    expect(leaders.forApplication(undefined)).toEqual({ slackUserId: 'U_QA' });
  });

  it('routes each application to its own leader', () => {
    const leaders = new Leaders({
      config: 'world.roarington.com=U_WORLD,drive.roarington.com=U_DRIVE',
      fallbackSlackUserId: 'U_QA',
      log,
    });

    expect(leaders.forApplication('world.roarington.com')).toEqual({ slackUserId: 'U_WORLD' });
    expect(leaders.forApplication('drive.roarington.com')).toEqual({ slackUserId: 'U_DRIVE' });
    // Anything without an entry of its own still reaches someone.
    expect(leaders.forApplication('auth.roarington.com')).toEqual({ slackUserId: 'U_QA' });
    expect(leaders.configuredApplications().sort()).toEqual([
      'drive.roarington.com',
      'world.roarington.com',
    ]);
  });

  it('lets default= override the fallback', () => {
    const leaders = new Leaders({
      config: 'default=U_LEAD,staff.roarington.com=U_STAFF',
      fallbackSlackUserId: 'U_QA',
      log,
    });
    expect(leaders.forApplication('people.roarington.com')).toEqual({ slackUserId: 'U_LEAD' });
    expect(leaders.forApplication('staff.roarington.com')).toEqual({ slackUserId: 'U_STAFF' });
  });

  it('tolerates whitespace and stray commas', () => {
    const leaders = new Leaders({
      config: ' world.roarington.com = U_WORLD , , auth.roarington.com=U_AUTH ,',
      fallbackSlackUserId: 'U_QA',
      log,
    });
    expect(leaders.forApplication('world.roarington.com')).toEqual({ slackUserId: 'U_WORLD' });
    expect(leaders.forApplication('auth.roarington.com')).toEqual({ slackUserId: 'U_AUTH' });
  });

  it('reads the application from an app: label', () => {
    expect(Leaders.applicationFromLabels(['src:slack', 'app:world.roarington.com'])).toBe(
      'world.roarington.com',
    );
    expect(Leaders.applicationFromLabels(['src:slack'])).toBeUndefined();
    expect(Leaders.applicationFromLabels(undefined)).toBeUndefined();
  });

  it('resolves a leader by the label, not by the display name', () => {
    const leaders = new Leaders({ config: 'other=U_OTHER', fallbackSlackUserId: 'U_QA', log });
    // 'Other' in the form becomes 'other' as a label, and that is what routing
    // looks up.
    expect(Leaders.applicationFromLabels(['app:other'])).toBe('other');
    expect(leaders.forApplication('other')).toEqual({ slackUserId: 'U_OTHER' });
  });
});

describe('parseLeaders', () => {
  it('accepts every application the form offers, plus default', () => {
    for (const key of validLeaderKeys()) {
      const parsed = parseLeaders(`${key}=U1`);
      expect(parsed.problems).toEqual([]);
    }
    expect(validLeaderKeys()).toEqual([...APPLICATIONS.map(slugify), 'default']);
  });

  it('reports an unknown application instead of ignoring it', () => {
    // A typo here cannot fail loudly on its own - the lookup just misses and
    // falls back - so whoever set it would see escalations going to the wrong
    // person with nothing in the logs to explain it.
    const parsed = parseLeaders('word.roarington.com=U1');

    expect(parsed.byApplication.size).toBe(0);
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]).toContain('word.roarington.com');
    expect(parsed.problems[0]).toContain('world.roarington.com');
  });

  it('reports a malformed entry', () => {
    const parsed = parseLeaders('world.roarington.com,drive.roarington.com=');
    expect(parsed.byApplication.size).toBe(0);
    expect(parsed.problems).toHaveLength(2);
  });

  it('keeps the good entries when one is bad', () => {
    const parsed = parseLeaders('world.roarington.com=U1,nonsense=U2');
    expect(parsed.byApplication.get('world.roarington.com')).toBe('U1');
    expect(parsed.problems).toHaveLength(1);
  });

  it('is happy with nothing at all', () => {
    expect(parseLeaders(undefined)).toMatchObject({ problems: [] });
    expect(parseLeaders('').byApplication.size).toBe(0);
  });
});

describe('bugstats (SPEC 8)', () => {
  it('formats durations at a useful granularity', async () => {
    expect(formatDuration(90_000)).toBe('2m');
    expect(formatDuration(3 * 3600_000)).toBe('3h');
    expect(formatDuration(5 * 86_400_000)).toBe('5d');
  });

  it('collects counts by application and severity from labels', async () => {
    const harness = await makeTestContext();
    harness.issuesByKey.set(
      'SUP-1',
      fixtureIssue({ key: 'SUP-1', labels: ['app:world.roarington.com', 'sev:major'] }),
    );
    harness.issuesByKey.set(
      'SUP-2',
      fixtureIssue({ key: 'SUP-2', labels: ['app:world.roarington.com', 'sev:minor'] }),
    );
    harness.issuesByKey.set(
      'SUP-3',
      fixtureIssue({ key: 'SUP-3', labels: ['app:drive.roarington.com', 'sev:major'] }),
    );

    const stats = await collectStats(harness.context, 7);

    expect(stats.total).toBe(3);
    expect(stats.byApplication).toEqual([
      { application: 'world.roarington.com', count: 2 },
      { application: 'drive.roarington.com', count: 1 },
    ]);
    expect(stats.bySeverity).toEqual([
      { severity: 'major', count: 2 },
      { severity: 'minor', count: 1 },
    ]);
  });

  it('renders a digest that names the numbers', async () => {
    const stats: Stats = {
      since: '2026-09-01T00:00:00Z',
      days: 7,
      total: 12,
      byApplication: [{ application: 'world.roarington.com', count: 9 }],
      bySeverity: [{ severity: 'major', count: 5 }],
      routing: [
        { routedTo: 'backlog', count: 7 },
        { routedTo: 'sprint', count: 3 },
        { routedTo: 'closed', count: 2 },
      ],
      medianTriageMs: 4 * 3600_000,
      topReporters: [{ slackUserId: 'U1', count: 6 }],
    };

    const text = JSON.stringify(statsBlocks(stats));
    expect(text).toContain('12');
    expect(text).toContain('world.roarington.com');
    expect(text).toContain('backlog 7');
    expect(text).toContain('sprint lane 3');
    expect(text).toContain('4h');
    expect(text).toContain('<@U1>');
  });

  it('says so plainly when nothing was triaged', async () => {
    const text = JSON.stringify(
      statsBlocks({
        since: '2026-09-01T00:00:00Z',
        days: 7,
        total: 0,
        byApplication: [],
        bySeverity: [],
        routing: [],
        topReporters: [],
      }),
    );
    expect(text).toMatch(/no median time in triage/i);
    expect(text).toContain('backlog 0');
  });
});
