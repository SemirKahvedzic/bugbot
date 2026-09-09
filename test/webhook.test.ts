import { beforeEach, describe, expect, it } from 'vitest';
import {
  changeIdFor,
  extractStatusChange,
  handleWebhook,
  ipAllowed,
  ipv4InCidr,
  normaliseIp,
  secretMatches,
  webhookSchema,
  type WebhookPayload,
} from '../src/jira/webhook.js';
import { fixtureIssue, makeTestContext, SERVICE_ACCOUNT_ID, type TestHarness } from './helpers/context.js';
import { countOf, rows } from './helpers/db.js';
import type { Priority } from '../src/types.js';

// --- Security -------------------------------------------------------------

describe('secretMatches', () => {
  const secret = 'a'.repeat(64);

  it('accepts the right secret and rejects everything else', async () => {
    expect(secretMatches(secret, secret)).toBe(true);
    expect(secretMatches(`${'a'.repeat(63)}b`, secret)).toBe(false);
    expect(secretMatches('a', secret)).toBe(false);
    expect(secretMatches(undefined, secret)).toBe(false);
    expect(secretMatches('', secret)).toBe(false);
  });
});

describe('ipv4InCidr', () => {
  it.each([
    ['13.52.5.96', '13.52.5.96/28', true],
    ['13.52.5.100', '13.52.5.96/28', true],
    ['13.52.5.112', '13.52.5.96/28', false],
    ['192.168.1.1', '192.168.1.1/32', true],
    ['192.168.1.2', '192.168.1.1/32', false],
    ['8.8.8.8', '0.0.0.0/0', true],
  ])('%s in %s -> %s', (ip, cidr, expected) => {
    expect(ipv4InCidr(ip, cidr)).toBe(expected);
  });

  it('rejects malformed input rather than matching by accident', async () => {
    expect(ipv4InCidr('not-an-ip', '10.0.0.0/8')).toBe(false);
    expect(ipv4InCidr('10.0.0.1', 'garbage')).toBe(false);
    expect(ipv4InCidr('10.0.0.1', '10.0.0.0/33')).toBe(false);
    expect(ipv4InCidr('10.0.0.999', '10.0.0.0/8')).toBe(false);
  });

  it('understands the IPv4-mapped form Node reports behind a proxy', async () => {
    expect(normaliseIp('::ffff:13.52.5.100')).toBe('13.52.5.100');
    expect(ipv4InCidr('::ffff:13.52.5.100', '13.52.5.96/28')).toBe(true);
  });
});

describe('ipAllowed', () => {
  it('allows everything when the allowlist is empty, as documented', async () => {
    expect(ipAllowed('1.2.3.4', [])).toBe(true);
    expect(ipAllowed(undefined, [])).toBe(true);
  });

  it('enforces the list once it has entries', async () => {
    const list = ['13.52.5.96/28', '18.136.214.96/28'];
    expect(ipAllowed('13.52.5.100', list)).toBe(true);
    expect(ipAllowed('18.136.214.97', list)).toBe(true);
    expect(ipAllowed('203.0.113.5', list)).toBe(false);
    expect(ipAllowed(undefined, list)).toBe(false);
  });

  it('accepts a bare address as well as a CIDR', async () => {
    expect(ipAllowed('203.0.113.5', ['203.0.113.5'])).toBe(true);
    expect(ipAllowed('203.0.113.6', ['203.0.113.5'])).toBe(false);
  });
});

// --- Payload parsing ------------------------------------------------------

function payload(input: {
  event?: string;
  key?: string;
  projectKey?: string;
  actorAccountId?: string;
  from?: string;
  to?: string;
  priority?: Priority;
  labels?: string[];
  changelogId?: string;
  issueType?: string;
  status?: string;
  reporterEmail?: string;
}): WebhookPayload {
  const key = input.key ?? 'SUP-1';
  return webhookSchema.parse({
    webhookEvent: input.event ?? 'jira:issue_updated',
    user: { accountId: input.actorAccountId ?? 'acc-human', displayName: 'A Human' },
    issue: {
      id: '1000',
      key,
      fields: {
        summary: 'Brake lights lag',
        labels: input.labels ?? ['src:slack', 'app:world.roarington.com'],
        priority: { id: '3', name: input.priority ?? 'Medium' },
        status: { id: '1', name: input.status ?? 'To Do' },
        issuetype: { id: '10481', name: input.issueType ?? 'Finding' },
        project: { key: input.projectKey ?? 'SUP' },
        ...(input.reporterEmail
          ? { reporter: { accountId: 'acc-reporter', emailAddress: input.reporterEmail } }
          : {}),
      },
    },
    ...(input.from || input.to
      ? {
          changelog: {
            id: input.changelogId ?? '9001',
            items: [
              {
                field: 'status',
                fieldId: 'status',
                fromString: input.from ?? null,
                toString: input.to ?? null,
              },
            ],
          },
        }
      : {}),
  });
}

describe('payload helpers', () => {
  it('extracts a status change', async () => {
    expect(extractStatusChange(payload({ from: 'Under Triage', to: 'To Do' }))).toEqual({
      fromStatus: 'Under Triage',
      toStatus: 'To Do',
    });
  });

  it('returns nothing when the change was not a status change', async () => {
    const raw = webhookSchema.parse({
      webhookEvent: 'jira:issue_updated',
      issue: { key: 'SUP-1', fields: { project: { key: 'SUP' } } },
      changelog: { id: '1', items: [{ field: 'description', fieldId: 'description' }] },
    });
    expect(extractStatusChange(raw)).toBeUndefined();
  });

  it('uses the changelog id as the dedupe id, falling back to the event', async () => {
    expect(changeIdFor(payload({ from: 'Under Triage', to: 'To Do', changelogId: '77' }))).toBe('77');
    expect(changeIdFor(payload({}))).toBe('jira:issue_updated:SUP-1');
  });
});

// --- Dispatch -------------------------------------------------------------

let harness: TestHarness;

beforeEach(async () => {
  harness = await makeTestContext();
  harness.issuesByKey.set('SUP-1', fixtureIssue({ key: 'SUP-1' }));
  // The reporter is known, as they would be for a Slack-filed bug.
  await harness.repo.recordIssueReport({
    issueKey: 'SUP-1',
    slackUserId: 'U_REPORTER',
    slackChannelId: 'C_BUGS',
    intakeSource: 'slack_modal',
  });
  await harness.repo.setThread('SUP-1', 'C_BUGS', '111.222');
});

describe('handleWebhook guards (SPEC 11)', () => {
  it('rejects an issue from another project', async () => {
    const result = await handleWebhook(
      harness.context,
      payload({ key: 'SOFT-99', projectKey: 'SOFT', from: 'Under Triage', to: 'To Do' }),
    );
    expect(result.action).toBe('ignored_project');
    expect(harness.posts).toHaveLength(0);
  });

  it('falls back to the key prefix when the project field is absent', async () => {
    const raw = webhookSchema.parse({
      webhookEvent: 'jira:issue_updated',
      issue: { key: 'SOFT-99', fields: {} },
      changelog: { id: '1', items: [{ fieldId: 'status', fromString: 'Under Triage', toString: 'To Do' }] },
    });
    expect((await handleWebhook(harness.context, raw)).action).toBe('ignored_project');
  });

  it('ignores our own changes, or BugBot would answer itself', async () => {
    const result = await handleWebhook(
      harness.context,
      payload({ actorAccountId: SERVICE_ACCOUNT_ID, from: 'Under Triage', to: 'To Do' }),
    );
    expect(result.action).toBe('ignored_self');
    expect(harness.jiraCalls).toHaveLength(0);
    expect(harness.posts).toHaveLength(0);
  });

  it('ignores a different issue type', async () => {
    const result = await handleWebhook(
      harness.context,
      payload({ issueType: 'Sub-task', from: 'Under Triage', to: 'To Do' }),
    );
    expect(result.action).toBe('ignored_type');
  });

  it('ignores an update that changed no status', async () => {
    expect((await handleWebhook(harness.context, payload({}))).action).toBe(
      'ignored_no_status_change',
    );
  });
});

describe('handleWebhook routing: all five priorities (SPEC 7)', () => {
  const cases: Array<[Priority, 'backlog' | 'sprint', string[], boolean, boolean]> = [
    // priority, destination, labels, leader DM, announce
    ['Lowest', 'backlog', ['triaged:backlog'], false, false],
    ['Low', 'backlog', ['triaged:backlog'], false, false],
    ['Medium', 'backlog', ['triaged:backlog'], false, false],
    ['High', 'sprint', ['triaged:sprint', 'needs-lead-review'], true, true],
    ['Highest', 'sprint', ['triaged:sprint', 'escalated'], true, true],
  ];

  it.each(cases)(
    '%s -> %s',
    async (priority, destination, labels, expectLeaderDm, expectAnnounce) => {
      const result = await handleWebhook(
        harness.context,
        payload({ from: 'Under Triage', to: 'To Do', priority }),
      );

      expect(result.action).toBe('routed');

      // Moved to the backlog status.
      expect(harness.jiraCalls).toEqual(
        expect.arrayContaining([
          { op: 'transition', issueKey: 'SUP-1', detail: { statusName: 'To Do', allowed: true } },
          { op: 'addLabels', issueKey: 'SUP-1', detail: labels },
        ]),
      );

      // The reporter always hears about it, in their bug thread.
      const reporterPost = harness.posts.find((post) => post.target === 'C_BUGS');
      expect(reporterPost?.threadTs).toBe('111.222');

      const leaderDm = harness.posts.find(
        (post) => post.kind === 'dm' && post.target === 'U_QA',
      );
      expect(Boolean(leaderDm)).toBe(expectLeaderDm);

      const announce = harness.posts.find((post) => post.target === 'C_ANNOUNCE');
      expect(Boolean(announce)).toBe(expectAnnounce);

      // The audit row records the decision.
      const events = await rows(harness.db, 'SELECT priority, routed_to FROM triage_events WHERE issue_key = $1', ['SUP-1']);
      expect(events).toEqual([{ priority, routed_to: destination }]);
    },
  );

  it('tags the reporter and never uses @here unless configured', async () => {
    await handleWebhook(
      harness.context,
      payload({ from: 'Under Triage', to: 'To Do', priority: 'Highest' }),
    );
    const announce = harness.posts.find((post) => post.target === 'C_ANNOUNCE');
    expect(announce?.text).toContain('U_REPORTER');
    expect(announce?.text).not.toContain('<!here>');
  });

  it('uses @here only when ESCALATION_MENTION says so', async () => {
    const loud = await makeTestContext({ ESCALATION_MENTION: 'here' });
    loud.issuesByKey.set('SUP-1', fixtureIssue({ key: 'SUP-1' }));
    await loud.repo.recordIssueReport({ issueKey: 'SUP-1', slackUserId: 'U_REPORTER', intakeSource: 'slack_modal' });

    await handleWebhook(loud.context, payload({ from: 'Under Triage', to: 'To Do', priority: 'Highest' }));
    const announce = loud.posts.find((post) => post.target === 'C_ANNOUNCE');
    expect(announce?.text).toContain('<!here>');
  });
});

describe('handleWebhook routing: the missing-transition fallback', () => {
  it('labels the issue and says so rather than failing silently', async () => {
    // The SUP workflow restricts transitions; simulate To Do being unreachable.
    harness.allowedTransitions.add('Nowhere');

    await handleWebhook(
      harness.context,
      payload({ from: 'Under Triage', to: 'In Progress', priority: 'High' }),
    );

    const labelCall = harness.jiraCalls.find((call) => call.op === 'addLabels');
    expect(labelCall?.detail).toEqual(['triaged:sprint', 'needs-lead-review', 'needs-manual-move']);

    // Still recorded, still notified - the decision happened, only the move failed.
    expect(
      await rows(harness.db, 'SELECT routed_to FROM triage_events'),
    ).toEqual([{ routed_to: 'sprint' }]);
  });
});

describe('handleWebhook: terminal statuses (SPEC 7)', () => {
  it.each(['Rejected', 'Duplicate', 'Cannot Reproduce'])(
    '%s DMs the reporter with the resolution and skips routing',
    async (status) => {
      const result = await handleWebhook(
        harness.context,
        payload({ from: 'Under Triage', to: status, priority: 'Highest' }),
      );

      expect(result.action).toBe('routed');
      // No move, no labels, nobody escalated.
      expect(harness.jiraCalls.some((call) => call.op === 'transition')).toBe(false);
      expect(harness.jiraCalls.some((call) => call.op === 'addLabels')).toBe(false);
      expect(harness.posts.some((post) => post.target === 'C_ANNOUNCE')).toBe(false);

      const toReporter = harness.posts.find((post) => post.target === 'C_BUGS');
      expect(toReporter?.text).toContain('Not enough information to reproduce.');

      expect(await rows(harness.db, 'SELECT routed_to FROM triage_events')).toEqual([
        { routed_to: 'closed' },
      ]);
    },
  );

  it('asks for more only where the status implies it', async () => {
    await handleWebhook(
      harness.context,
      payload({ from: 'Under Triage', to: 'Cannot Reproduce' }),
    );
    expect(harness.posts.find((post) => post.target === 'C_BUGS')?.text).toMatch(
      /screen recording/i,
    );

    harness.reset();
    await handleWebhook(
      harness.context,
      payload({ from: 'Under Triage', to: 'Rejected', changelogId: '9002' }),
    );
    expect(harness.posts.find((post) => post.target === 'C_BUGS')?.text).not.toMatch(
      /screen recording/i,
    );
  });
});

describe('handleWebhook idempotency (SPEC 7, Phase 3 acceptance)', () => {
  it('replaying the same webhook sends nothing twice', async () => {
    const event = payload({ from: 'Under Triage', to: 'To Do', priority: 'High', changelogId: '9001' });

    const first = await handleWebhook(harness.context, event);
    expect(first.action).toBe('routed');

    const postsAfterFirst = harness.posts.length;
    const callsAfterFirst = harness.jiraCalls.length;
    expect(postsAfterFirst).toBeGreaterThan(0);

    const second = await handleWebhook(harness.context, event);
    expect(second.action).toBe('ignored_duplicate');

    // Nothing further was sent, and nothing further was written to Jira.
    expect(harness.posts).toHaveLength(postsAfterFirst);
    expect(harness.jiraCalls).toHaveLength(callsAfterFirst);
    expect(await countOf(harness.db, 'triage_events')).toBe(1);
  });

  it('a genuinely different change is still processed', async () => {
    await handleWebhook(
      harness.context,
      payload({ from: 'Under Triage', to: 'To Do', priority: 'High', changelogId: '9001' }),
    );
    const result = await handleWebhook(
      harness.context,
      payload({ from: 'Under Triage', to: 'Rejected', changelogId: '9002' }),
    );
    expect(result.action).toBe('routed');
    expect(await countOf(harness.db, 'triage_events')).toBe(2);
  });
});

describe('handleWebhook: status-change DMs (SPEC 8)', () => {
  it('DMs the reporter for a change that is not a triage exit', async () => {
    const result = await handleWebhook(
      harness.context,
      payload({ from: 'To Do', to: 'In Progress', changelogId: '5001' }),
    );

    expect(result.action).toBe('status_dm');
    const dm = harness.posts.find((post) => post.kind === 'dm' && post.target === 'U_REPORTER');
    expect(dm?.text).toContain('In Progress');
  });

  it('sends once when an issue changes twice inside the digest window', async () => {
    await handleWebhook(harness.context, payload({ from: 'To Do', to: 'In Progress', changelogId: '5001' }));
    expect(harness.posts).toHaveLength(1);

    const second = await handleWebhook(
      harness.context,
      payload({ from: 'In Progress', to: 'Ready for Validation', changelogId: '5002' }),
    );
    expect(second.action).toBe('ignored_duplicate');
    expect(harness.posts).toHaveLength(1);
  });

  it('says nothing when the reporter is unknown', async () => {
    await harness.repo.recordIssueReport({ issueKey: 'SUP-2', intakeSource: 'jira_native' });
    const result = await handleWebhook(
      harness.context,
      payload({ key: 'SUP-2', from: 'To Do', to: 'In Progress', changelogId: '5003' }),
    );
    expect(result.action).toBe('ignored_not_triage_exit');
    expect(harness.posts).toHaveLength(0);
  });
});

describe('handleWebhook: Jira-native intake (SPEC 1, SPEC 4)', () => {
  it('funnels a bug created in Jira and maps its reporter', async () => {
    const result = await handleWebhook(
      harness.context,
      payload({
        event: 'jira:issue_created',
        key: 'SUP-50',
        status: 'To Do',
        reporterEmail: 'reporter@roarington.com',
      }),
    );

    expect(result.action).toBe('created');

    const row = await harness.repo.getIssueReport('SUP-50');
    expect(row?.intake_source).toBe('jira_native');
    expect(row?.slack_user_id).toBe('U_REPORTER');

    expect(harness.jiraCalls).toEqual(
      expect.arrayContaining([
        { op: 'addLabels', issueKey: 'SUP-50', detail: ['src:jira'] },
        { op: 'transition', issueKey: 'SUP-50', detail: { statusName: 'Under Triage', allowed: true } },
      ]),
    );
  });

  it('still funnels the bug when the reporter cannot be mapped', async () => {
    await handleWebhook(
      harness.context,
      payload({
        event: 'jira:issue_created',
        key: 'SUP-51',
        status: 'To Do',
        reporterEmail: 'contractor@example.com',
      }),
    );

    const row = await harness.repo.getIssueReport('SUP-51');
    expect(row).toBeDefined();
    expect(row?.slack_user_id).toBeNull();
    expect(
      harness.jiraCalls.some(
        (call) => call.op === 'transition' && call.issueKey === 'SUP-51',
      ),
    ).toBe(true);
  });

  it('does not re-transition a bug already in triage', async () => {
    await handleWebhook(
      harness.context,
      payload({ event: 'jira:issue_created', key: 'SUP-52', status: 'Under Triage' }),
    );
    expect(harness.jiraCalls.some((call) => call.op === 'transition')).toBe(false);
  });

  it('ignores a redelivered creation event', async () => {
    const event = payload({ event: 'jira:issue_created', key: 'SUP-53', status: 'To Do' });
    expect((await handleWebhook(harness.context, event)).action).toBe('created');
    expect((await handleWebhook(harness.context, event)).action).toBe('ignored_duplicate');
  });
});
