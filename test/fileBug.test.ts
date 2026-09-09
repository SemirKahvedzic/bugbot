import { beforeEach, describe, expect, it } from 'vitest';
import { fileBug } from '../src/slack/commands/bug.js';
import { renderDescription } from '../src/format/description.js';
import { makeTestContext, type TestHarness } from './helpers/context.js';
import type { BugReport } from '../src/types.js';

const formFields: Omit<BugReport, 'reporter' | 'source'> = {
  summary: 'Brake lights lag',
  application: 'world.roarington.com',
  environment: 'Production',
  device: 'Phone',
  deviceModel: 'iPhone 15 Pro',
  os: 'iOS 18.2',
  browser: 'Safari 18',
  viewport: '390x844',
  inputMethods: ['Touch'],
  steps: '1. Drive\n2. Brake',
  expected: 'Lights on',
  actual: 'Lights late',
  frequency: 'Always',
  severity: 'Major',
};

let harness: TestHarness;

beforeEach(() => {
  harness = makeTestContext();
});

/** The ADF pushed by the follow-up setDescription call. */
function updatedDescription(h: TestHarness): string | undefined {
  return h.jiraCalls.find((call) => call.op === 'setDescription')?.detail as string | undefined;
}

describe('fileBug: the happy path', () => {
  it('creates the issue, records it, confirms in the channel and stores the thread', async () => {
    const result = await fileBug(harness.context, {
      report: formFields,
      metadata: { channelId: 'C_BUGS', source: 'slack_modal' },
      slackUserId: 'U_REPORTER',
    });

    expect(result.issueKey).toBe('SUP-100');

    const create = harness.jiraCalls.find((call) => call.op === 'createBug');
    expect(create?.detail).toMatchObject({
      summary: 'Brake lights lag',
      triageStatusName: 'Under Triage',
    });

    const row = harness.repo.getIssueReport('SUP-100');
    expect(row?.slack_user_id).toBe('U_REPORTER');
    expect(row?.slack_channel_id).toBe('C_BUGS');
    expect(row?.intake_source).toBe('slack_modal');
    // The confirmation message is the thread root for attachment sync.
    expect(row?.slack_thread_ts).toBe('111.222');

    const confirmation = harness.posts.find((post) => post.target === 'C_BUGS');
    expect(confirmation?.text).toContain('SUP-100');
    expect(confirmation?.text).toMatch(/screenshots or a video/i);
  });

  it('sends the confirmation to the reporter when there is no channel', async () => {
    await fileBug(harness.context, {
      report: formFields,
      metadata: { source: 'slack_modal' },
      slackUserId: 'U_REPORTER',
    });

    // Posting to a user id is how chat.postMessage opens a DM, so the target
    // is the assertion here rather than the call shape.
    const confirmation = harness.posts.find((post) => post.target === 'U_REPORTER');
    expect(confirmation?.text).toContain('SUP-100');
    expect(harness.posts.some((post) => post.target === 'C_BUGS')).toBe(false);
  });
});

describe('fileBug: who the reporter is (SPEC 4)', () => {
  it('sets the real Jira reporter when the person has an account', async () => {
    harness.identityResult.jiraAccountId = 'acc-human';
    harness.identityResult.email = 'margherita@roarington.com';

    await fileBug(harness.context, {
      report: formFields,
      metadata: { channelId: 'C_BUGS', source: 'slack_modal' },
      slackUserId: 'U_REPORTER',
    });

    expect(harness.jiraCalls.find((call) => call.op === 'createBug')?.detail).toMatchObject({
      reporterAccountId: 'acc-human',
    });
  });

  it('files under the service account when the person has no Jira account', async () => {
    harness.identityResult.email = 'outsider@roarington.com';
    // No jiraAccountId: this is the common case.

    await fileBug(harness.context, {
      report: formFields,
      metadata: { channelId: 'C_BUGS', source: 'slack_modal' },
      slackUserId: 'U_REPORTER',
    });

    expect(harness.jiraCalls.find((call) => call.op === 'createBug')?.detail).toMatchObject({
      reporterAccountId: null,
    });

    // ...but the human is still recorded, in the description and in the DB.
    expect(updatedDescription(harness)).toContain('outsider@roarington.com');
    expect(harness.repo.getIssueReport('SUP-100')?.slack_user_id).toBe('U_REPORTER');
  });

  it('honours JIRA_SET_REAL_REPORTER=false even when an account exists', async () => {
    const off = makeTestContext({ JIRA_SET_REAL_REPORTER: 'false' });
    off.identityResult.jiraAccountId = 'acc-human';

    await fileBug(off.context, {
      report: formFields,
      metadata: { channelId: 'C_BUGS', source: 'slack_modal' },
      slackUserId: 'U_REPORTER',
    });

    expect(off.jiraCalls.find((call) => call.op === 'createBug')?.detail).toMatchObject({
      reporterAccountId: null,
    });
  });
});

describe('fileBug: linking Jira back to Slack', () => {
  it('updates the description with a link to the bug thread', async () => {
    await fileBug(harness.context, {
      report: formFields,
      metadata: { channelId: 'C_BUGS', source: 'slack_modal' },
      slackUserId: 'U_REPORTER',
    });

    const adf = updatedDescription(harness);
    expect(adf).toBeDefined();
    expect(adf).toContain('https://roarington.slack.com/archives/C1/p1');
    expect(adf).toMatch(/reply here to reach the reporter/i);
  });

  it('keeps both links for the shortcut path', async () => {
    await fileBug(harness.context, {
      report: formFields,
      metadata: {
        channelId: 'C_BUGS',
        threadTs: '555.666',
        permalink: 'https://roarington.slack.com/archives/C_BUGS/p555666',
        source: 'slack_shortcut',
      },
      slackUserId: 'U_REPORTER',
    });

    const adf = updatedDescription(harness);
    expect(adf).toContain('p555666');
    expect(adf).toMatch(/the message this was reported from/i);
    expect(adf).toMatch(/Slack thread/i);

    // The shortcut replies in the original message's thread, not a new one.
    expect(harness.repo.getIssueReport('SUP-100')?.slack_thread_ts).toBe('555.666');
  });

  it('still files the bug if the description update fails', async () => {
    const broken = makeTestContext();
    Object.assign(broken.context.issues, {
      setDescription: async () => {
        throw new Error('Jira said no');
      },
    });

    const result = await fileBug(broken.context, {
      report: formFields,
      metadata: { channelId: 'C_BUGS', source: 'slack_modal' },
      slackUserId: 'U_REPORTER',
    });

    expect(result.issueKey).toBe('SUP-100');
    expect(broken.posts.some((post) => post.target === 'C_BUGS')).toBe(true);
  });
});

describe('fileBug: when Jira refuses', () => {
  it('tells the reporter instead of losing the report silently', async () => {
    const broken = makeTestContext();
    Object.assign(broken.context.issues, {
      createBug: async () => {
        throw new Error('Jira POST /rest/api/3/issue failed (403): no create permission');
      },
    });

    const result = await fileBug(broken.context, {
      report: formFields,
      metadata: { channelId: 'C_BUGS', source: 'slack_modal' },
      slackUserId: 'U_REPORTER',
    });

    expect(result.issueKey).toBeUndefined();

    const dm = broken.posts.find((post) => post.kind === 'dm' && post.target === 'U_REPORTER');
    expect(dm?.text).toMatch(/could not file your bug/i);
    expect(dm?.text).toContain('no create permission');
    expect(dm?.text).toMatch(/Nothing you typed is lost/i);

    // Nothing was recorded, so /mybugs will not show a phantom issue.
    expect(broken.db.prepare('SELECT COUNT(*) AS n FROM issue_reports').get()).toEqual({ n: 0 });
  });
});

describe('fileBug: when the triage transition is unavailable', () => {
  it('warns in the confirmation rather than pretending it worked', async () => {
    // The fake workflow allows nothing, as a restricted SUP workflow might.
    harness.allowedTransitions.add('Nowhere');

    await fileBug(harness.context, {
      report: formFields,
      metadata: { channelId: 'C_BUGS', source: 'slack_modal' },
      slackUserId: 'U_REPORTER',
    });

    const confirmation = harness.posts.find((post) => post.target === 'C_BUGS');
    expect(confirmation?.text).toMatch(/could not move it/i);
    expect(confirmation?.text).toContain('Under Triage');
  });
});

describe('the reporter line in the description', () => {
  const base: BugReport = {
    ...formFields,
    source: 'slack_modal',
    reporter: {},
  };

  const line = (reporter: BugReport['reporter']): string =>
    JSON.stringify(renderDescription({ ...base, reporter }).adf);

  it('prefers name and email together', () => {
    expect(line({ displayName: 'Margherita Turrin', email: 'm@roarington.com' })).toContain(
      'Margherita Turrin <m@roarington.com>',
    );
  });

  it('falls back to the name alone', () => {
    expect(line({ displayName: 'Margherita Turrin' })).toContain('Margherita Turrin - via');
  });

  it('falls back to the email when the Slack profile has no name', () => {
    expect(line({ email: 'm@roarington.com', slackUserId: 'U1' })).toContain('m@roarington.com');
  });

  it('falls back to a labelled Slack id rather than a bare one', () => {
    const text = line({ slackUserId: 'U08HVG0H2EL' });
    expect(text).toContain('Slack user U08HVG0H2EL');
  });

  it('says unknown when we know nothing at all', () => {
    expect(line({})).toContain('unknown');
  });
});
