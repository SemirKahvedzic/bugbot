import { describe, expect, it } from 'vitest';
import {
  bucketIssues,
  bugCardBlocks,
  HOME_MAX_CARDS,
  relativeTime,
  statusEmoji,
  escape,
  homeView,
  intakeConfirmationBlocks,
  issueUrl,
  leaderDmBlocks,
  myBugsBlocks,
  triageQueueBlocks,
  truncate,
  type IssueSummaryLine,
} from '../src/format/slackBlocks.js';
import { ACTION } from '../src/slack/actions.js';
import type { BugReport } from '../src/types.js';

const BASE = 'https://roarington.atlassian.net';

const report: BugReport = {
  summary: 'Brake lights lag',
  application: 'world.roarington.com',
  environment: 'Production',
  device: 'Phone',
  os: 'iOS 18.2',
  browser: 'Safari 18',
  viewport: '390x844',
  inputMethods: ['Touch'],
  steps: '1. Drive',
  expected: 'Lights',
  actual: 'No lights',
  frequency: 'Always',
  severity: 'Major',
  reporter: { slackUserId: 'U1' },
  source: 'slack_modal',
};

const json = (value: unknown) => JSON.stringify(value);

describe('issueUrl', () => {
  it('builds a browse link and tolerates a trailing slash', () => {
    expect(issueUrl(BASE, 'SUP-1')).toBe(`${BASE}/browse/SUP-1`);
    expect(issueUrl(`${BASE}/`, 'SUP-1')).toBe(`${BASE}/browse/SUP-1`);
  });
});

describe('escape and truncate', () => {
  it('escapes only Slack\'s three special characters', () => {
    expect(escape('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
    expect(escape("it's fine")).toBe("it's fine");
  });

  it('truncates with an ellipsis, leaving short text alone', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('abcdefghijk', 5)).toBe('abcd…');
  });
});

describe('intakeConfirmationBlocks (SPEC 5)', () => {
  it('shows the key, the reporter and the screenshot invitation', () => {
    const blocks = intakeConfirmationBlocks({
      issueKey: 'SUP-1',
      issueUrl: issueUrl(BASE, 'SUP-1'),
      report,
      priority: 'High',
      reporterSlackId: 'U1',
      transitioned: true,
      triageStatusName: 'Under Triage',
    });

    const text = json(blocks);
    expect(text).toContain('SUP-1');
    expect(text).toContain('<@U1>');
    expect(text).toContain('High');
    expect(text).toMatch(/screenshots or a video/i);
    expect(text).toContain('390x844');
  });

  it('warns when the issue could not be moved into triage', () => {
    const blocks = intakeConfirmationBlocks({
      issueKey: 'SUP-1',
      issueUrl: issueUrl(BASE, 'SUP-1'),
      report,
      priority: 'High',
      transitioned: false,
      triageStatusName: 'Under Triage',
    });
    const text = json(blocks);
    expect(text).toContain('Under Triage');
    expect(text).toMatch(/could not move it/i);
    // The reassurance matters: the report is not lost.
    expect(text).toMatch(/issue exists/i);
  });

  it('escapes a summary containing markup', () => {
    const blocks = intakeConfirmationBlocks({
      issueKey: 'SUP-1',
      issueUrl: issueUrl(BASE, 'SUP-1'),
      report: { ...report, summary: '<script> & "quotes"' },
      priority: 'Low',
      transitioned: true,
      triageStatusName: 'Under Triage',
    });
    expect(json(blocks)).toContain('&lt;script&gt; &amp; ');
  });
});

describe('bucketIssues (SPEC 8)', () => {
  const issues: IssueSummaryLine[] = [
    { key: 'SUP-0', summary: 'z', status: 'To Do' },
    { key: 'SUP-1', summary: 'a', status: 'Under Triage' },
    { key: 'SUP-2', summary: 'b', status: 'In Progress' },
    { key: 'SUP-3', summary: 'c', status: 'Ready for Validation' },
    { key: 'SUP-4', summary: 'd', status: 'Done' },
    { key: 'SUP-5', summary: 'e', status: 'Rejected' },
    { key: 'SUP-6', summary: 'f', status: 'Duplicate' },
    { key: 'SUP-7', summary: 'g', status: 'Cannot Reproduce' },
  ];

  it('groups into the documented buckets, plus To Do', () => {
    const buckets = bucketIssues(issues);
    // SPEC 8 lists four. To Do is the board's first column and where backlog
    // routing puts things, so it earns a heading rather than falling to Other.
    expect(buckets.map((bucket) => bucket.label)).toEqual([
      'To Do',
      'Under Triage',
      'In Progress',
      'Ready for Validation',
      'Closed',
    ]);
    expect(buckets[4]!.issues.map((issue) => issue.key)).toEqual([
      'SUP-4',
      'SUP-5',
      'SUP-6',
      'SUP-7',
    ]);
  });

  it('drops empty buckets rather than showing zeroes', () => {
    const buckets = bucketIssues([{ key: 'SUP-1', summary: 'a', status: 'Done' }]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.label).toBe('Closed');
  });

  it('puts an unrecognised status in Other instead of losing it', () => {
    const buckets = bucketIssues([{ key: 'SUP-9', summary: 'x', status: 'Blocked On Legal' }]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.label).toBe('Other');
    expect(buckets[0]!.issues[0]!.key).toBe('SUP-9');
  });

  it('preserves input order inside a bucket', () => {
    const buckets = bucketIssues([
      { key: 'SUP-2', summary: 'b', status: 'Done' },
      { key: 'SUP-1', summary: 'a', status: 'Done' },
    ]);
    expect(buckets[0]!.issues.map((issue) => issue.key)).toEqual(['SUP-2', 'SUP-1']);
  });
});

describe('myBugsBlocks (SPEC 8)', () => {
  const many: IssueSummaryLine[] = Array.from({ length: 25 }, (_, index) => ({
    key: `SUP-${index + 1}`,
    summary: `bug ${index + 1}`,
    status: 'Under Triage',
    priority: 'Medium',
  }));

  it('invites a first report when there are none', () => {
    const blocks = myBugsBlocks({ baseUrl: BASE, issues: [], jqlUrl: 'x', limit: 20 });
    expect(json(blocks)).toMatch(/have not reported any bugs/i);
    expect(json(blocks)).toContain('/bug');
  });

  it('caps the list and links to the rest in Jira', () => {
    const blocks = myBugsBlocks({ baseUrl: BASE, issues: many, jqlUrl: 'https://jql', limit: 20 });
    const text = json(blocks);
    expect(text).toContain('SUP-20');
    expect(text).not.toContain('SUP-21');
    expect(text).toContain('Showing 20 of 25');
    expect(text).toContain('https://jql');
  });

  it('links to Jira without a count when nothing is hidden', () => {
    const blocks = myBugsBlocks({
      baseUrl: BASE,
      issues: many.slice(0, 3),
      jqlUrl: 'https://jql',
      limit: 20,
    });
    expect(json(blocks)).not.toContain('Showing');
    expect(json(blocks)).toContain('View all in Jira');
  });
});

describe('statusEmoji', () => {
  it('gives each status category its own dot, so a column is scannable', () => {
    const dots = [
      statusEmoji('Under Triage'),
      statusEmoji('In Progress'),
      statusEmoji('Ready for Validation'),
      statusEmoji('Done'),
      statusEmoji('Rejected'),
    ];
    expect(new Set(dots).size).toBe(5);
    expect(dots.every((dot) => dot.startsWith(':') && dot.endsWith(':'))).toBe(true);
  });

  it('groups the in-flight statuses together', () => {
    expect(statusEmoji('In Review')).toBe(statusEmoji('In Progress'));
    expect(statusEmoji('IN QA')).toBe(statusEmoji('In Progress'));
  });

  it('treats duplicate and cannot reproduce like a rejection, not like done', () => {
    expect(statusEmoji('Duplicate')).toBe(statusEmoji('Rejected'));
    expect(statusEmoji('Cannot Reproduce')).toBe(statusEmoji('Rejected'));
    expect(statusEmoji('Done')).not.toBe(statusEmoji('Rejected'));
  });

  it('has a fallback for a status nobody told us about', () => {
    // Deliberately not the To Do dot: an unrecognised status should look
    // unrecognised rather than borrow the one meaning "not started yet".
    expect(statusEmoji('Blocked On Legal')).toBe(':grey_question:');
    expect(statusEmoji('Blocked On Legal')).not.toBe(statusEmoji('To Do'));
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-09-09T12:00:00Z').getTime();
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it.each([
    [30_000, 'just now'],
    [10 * 60_000, '10m ago'],
    [5 * 3600_000, '5h ago'],
    [3 * 86_400_000, '3 days ago'],
    [86_400_000, '1 day ago'],
    [21 * 86_400_000, '3 weeks ago'],
    [120 * 86_400_000, '4 months ago'],
  ])('renders %dms ago as %s', (offset, expected) => {
    expect(relativeTime(ago(offset), now)).toBe(expected);
  });

  it('returns nothing rather than a lie for missing or unparseable input', () => {
    expect(relativeTime(undefined, now)).toBeUndefined();
    expect(relativeTime('not a date', now)).toBeUndefined();
  });

  it('does not render a negative age when clocks disagree', () => {
    expect(relativeTime(new Date(now + 60_000).toISOString(), now)).toBe('just now');
  });
});

describe('bugCardBlocks', () => {
  const issue: IssueSummaryLine = {
    key: 'SUP-12',
    summary: 'Brake lights lag behind the pedal',
    status: 'Under Triage',
    priority: 'High',
    labels: ['src:slack', 'app:world.roarington.com', 'env:production', 'dev:phone', 'sev:major', 'freq:always'],
    created: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  };

  it('is three blocks: the card, its metadata, and a divider', () => {
    const blocks = bugCardBlocks(BASE, issue);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]!.type).toBe('section');
    expect(blocks[1]!.type).toBe('context');
    expect(blocks[2]!.type).toBe('divider');
  });

  it('shows the key, status, summary and a status dot', () => {
    const text = json(bugCardBlocks(BASE, issue));
    expect(text).toContain('SUP-12');
    expect(text).toContain('Under Triage');
    expect(text).toContain('Brake lights lag behind the pedal');
    expect(text).toContain(statusEmoji('Under Triage'));
  });

  it('unpacks the QA fields out of the labels', () => {
    const text = json(bugCardBlocks(BASE, issue));
    expect(text).toContain('world.roarington.com');
    expect(text).toContain('production');
    expect(text).toContain('phone');
    expect(text).toContain('severity major');
    expect(text).toContain('happens always');
  });

  it('says how old it is and whether anyone is on it', () => {
    const text = json(bugCardBlocks(BASE, issue));
    expect(text).toContain('filed 3 days ago');
    expect(text).toContain('unassigned');

    const assigned = json(bugCardBlocks(BASE, { ...issue, assigneeName: 'Jakub Krawczyk' }));
    expect(assigned).toContain('assigned to Jakub Krawczyk');
    expect(assigned).not.toContain('unassigned');
  });

  it('carries an Open button that links to Jira', () => {
    const blocks = bugCardBlocks(BASE, issue);
    const accessory = (blocks[0] as { accessory?: { url?: string; action_id?: string } }).accessory;
    expect(accessory?.url).toBe(`${BASE}/browse/SUP-12`);
    // A URL button still fires an interaction, so it needs an id to ack.
    expect(accessory?.action_id).toBe(ACTION.openIssue);
  });

  it('degrades to just the essentials when a bug has no labels', () => {
    const bare: IssueSummaryLine = { key: 'SUP-99', summary: 'a', status: 'To Do' };
    const text = json(bugCardBlocks(BASE, bare));
    expect(text).toContain('SUP-99');
    expect(text).toContain('unassigned');
  });

  it('escapes the summary', () => {
    const text = json(bugCardBlocks(BASE, { ...issue, summary: '<b> & "x"' }));
    expect(text).toContain('&lt;b&gt; &amp;');
  });
});

describe('homeView', () => {
  const bug = (index: number, status: string): IssueSummaryLine => ({
    key: `SUP-${index}`,
    summary: `bug ${index}`,
    status,
    priority: 'Medium',
    labels: ['app:world.roarington.com'],
    created: new Date(Date.now() - 86_400_000).toISOString(),
  });

  it('invites a first report when there is nothing to show', () => {
    const view = homeView({ baseUrl: BASE, issues: [], jqlUrl: 'x', limit: 20 });
    expect(view.type).toBe('home');
    const text = json(view.blocks);
    expect(text).toContain(ACTION.homeFileBug);
    expect(text).toContain(ACTION.homeRefresh);
    expect(text).toMatch(/have not reported any bugs/i);
  });

  it('leads with a header, the buttons, and the counts per bucket', () => {
    const view = homeView({
      baseUrl: BASE,
      issues: [bug(1, 'Under Triage'), bug(2, 'Under Triage'), bug(3, 'Done')],
      jqlUrl: 'https://jql',
      limit: 20,
    });

    expect(view.blocks[0]!.type).toBe('header');
    expect(view.blocks[1]!.type).toBe('actions');
    const counts = json(view.blocks[2]);
    expect(counts).toContain('Under Triage *2*');
    expect(counts).toContain('Closed *1*');
  });

  it('renders a card per bug, not a bullet list', () => {
    const view = homeView({
      baseUrl: BASE,
      issues: [bug(1, 'Under Triage')],
      jqlUrl: 'x',
      limit: 20,
    });
    const text = json(view.blocks);
    expect(text).toContain(ACTION.openIssue);
    expect(text).toContain('world.roarington.com');
    expect(view.blocks.filter((block) => block.type === 'divider').length).toBeGreaterThan(0);
  });

  it('stays under Slack\'s 100-block limit however many bugs there are', () => {
    // Over the cap Slack rejects the whole view, which leaves App Home blank
    // rather than truncated - so this is the failure worth guarding.
    const many = Array.from({ length: 200 }, (_, index) => bug(index, 'Under Triage'));
    const view = homeView({ baseUrl: BASE, issues: many, jqlUrl: 'x', limit: 500 });

    expect(view.blocks.length).toBeLessThanOrEqual(100);
    expect(json(view.blocks)).toContain(`Showing ${HOME_MAX_CARDS} of 200`);
  });

  it('respects a caller limit below the cap', () => {
    const many = Array.from({ length: 50 }, (_, index) => bug(index, 'Under Triage'));
    const view = homeView({ baseUrl: BASE, issues: many, jqlUrl: 'x', limit: 5 });
    expect(json(view.blocks)).toContain('Showing 5 of 50');
  });

  it('links to Jira without a count when nothing is hidden', () => {
    const view = homeView({
      baseUrl: BASE,
      issues: [bug(1, 'Done')],
      jqlUrl: 'https://jql',
      limit: 20,
    });
    const text = json(view.blocks);
    expect(text).toContain('View all in Jira');
    expect(text).not.toContain('Showing');
  });
});

describe('triageQueueBlocks (SPEC 7)', () => {
  it('celebrates an empty queue', () => {
    const blocks = triageQueueBlocks({ baseUrl: BASE, issues: [], triageStatusName: 'Under Triage' });
    expect(json(blocks)).toMatch(/queue is empty/i);
  });

  it('gives every bug the four documented buttons', () => {
    const blocks = triageQueueBlocks({
      baseUrl: BASE,
      issues: [{ key: 'SUP-1', summary: 'a', status: 'Under Triage', priority: 'Medium' }],
      triageStatusName: 'Under Triage',
    });
    const text = json(blocks);
    for (const action of [
      ACTION.triageBacklog,
      ACTION.triageSprint,
      ACTION.triageNeedInfo,
      ACTION.triageDuplicate,
    ]) {
      expect(text).toContain(action);
    }
    // Every button carries the issue key it acts on.
    expect(text).toContain('"value":"SUP-1"');
  });
});

describe('leaderDmBlocks (SPEC 7)', () => {
  it('distinguishes an escalation from a normal sprint routing', () => {
    const normal = json(
      leaderDmBlocks({
        issueKey: 'SUP-1',
        issueUrl: issueUrl(BASE, 'SUP-1'),
        summary: 'a',
        priority: 'High',
        escalated: false,
      }),
    );
    expect(normal).toMatch(/Triaged to sprint/);
    expect(normal).not.toMatch(/Escalated/);

    const escalated = json(
      leaderDmBlocks({
        issueKey: 'SUP-1',
        issueUrl: issueUrl(BASE, 'SUP-1'),
        summary: 'a',
        priority: 'Highest',
        escalated: true,
      }),
    );
    expect(escalated).toMatch(/Escalated/);
    expect(escalated).toContain('rotating_light');
  });

  it('offers Approve and Reassign, carrying the issue key', () => {
    const text = json(
      leaderDmBlocks({
        issueKey: 'SUP-7',
        issueUrl: issueUrl(BASE, 'SUP-7'),
        summary: 'a',
        priority: 'High',
        application: 'world.roarington.com',
        reporterSlackId: 'U1',
        escalated: false,
      }),
    );
    expect(text).toContain(ACTION.leaderApprove);
    expect(text).toContain(ACTION.leaderReassign);
    expect(text).toContain('"value":"SUP-7"');
    expect(text).toContain('<@U1>');
    expect(text).toContain('world.roarington.com');
  });

  it('degrades gracefully with no application and no reporter', () => {
    const text = json(
      leaderDmBlocks({
        issueKey: 'SUP-8',
        issueUrl: issueUrl(BASE, 'SUP-8'),
        summary: 'a',
        priority: 'High',
        escalated: false,
      }),
    );
    expect(text).toContain('no further context');
  });
});
