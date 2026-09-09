import { describe, expect, it } from 'vitest';
import {
  bucketIssues,
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
    { key: 'SUP-1', summary: 'a', status: 'Under Triage' },
    { key: 'SUP-2', summary: 'b', status: 'In Progress' },
    { key: 'SUP-3', summary: 'c', status: 'Ready for Validation' },
    { key: 'SUP-4', summary: 'd', status: 'Done' },
    { key: 'SUP-5', summary: 'e', status: 'Rejected' },
    { key: 'SUP-6', summary: 'f', status: 'Duplicate' },
    { key: 'SUP-7', summary: 'g', status: 'Cannot Reproduce' },
  ];

  it('groups into the four documented buckets', () => {
    const buckets = bucketIssues(issues);
    expect(buckets.map((bucket) => bucket.label)).toEqual([
      'Under Triage',
      'In Progress',
      'Ready for Validation',
      'Closed',
    ]);
    expect(buckets[3]!.issues.map((issue) => issue.key)).toEqual([
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

describe('homeView', () => {
  it('is a home view with a report button and a refresh button', () => {
    const view = homeView({ baseUrl: BASE, issues: [], jqlUrl: 'x', limit: 20 });
    expect(view.type).toBe('home');
    const text = json(view.blocks);
    expect(text).toContain(ACTION.homeFileBug);
    expect(text).toContain(ACTION.homeRefresh);
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
