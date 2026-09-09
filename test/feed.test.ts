import { beforeEach, describe, expect, it } from 'vitest';
import { bugFeedBlocks } from '../src/format/slackBlocks.js';
import { handleWebhook, webhookSchema } from '../src/jira/webhook.js';
import { fileBug } from '../src/slack/commands/bug.js';
import { postBugFeed } from '../src/slack/feed.js';
import { parseLabels, type BugReport } from '../src/types.js';
import { makeTestContext, type TestHarness } from './helpers/context.js';

const FEED = 'C_FEED';

const report: BugReport = {
  summary: 'Brake lights lag behind the pedal',
  application: 'world.roarington.com',
  environment: 'Production',
  device: 'Phone',
  deviceModel: 'iPhone 15 Pro',
  os: 'iOS 18.2',
  browser: 'Safari 18',
  viewport: '390x844',
  inputMethods: ['Touch'],
  steps: '1. Drive\n2. Brake',
  expected: 'Lights come on immediately',
  actual: 'Lights come on a second late',
  frequency: 'Always',
  severity: 'Major',
  reporter: { slackUserId: 'U_REPORTER' },
  source: 'slack_modal',
};

const formFields: Omit<BugReport, 'reporter' | 'source'> = { ...report } as never;

const json = (value: unknown) => JSON.stringify(value);

describe('parseLabels', () => {
  it('reads the key:value labels back out', () => {
    expect(
      parseLabels([
        'src:slack',
        'app:world.roarington.com',
        'env:production',
        'dev:phone',
        'sev:major',
        'freq:always',
      ]),
    ).toEqual({
      src: 'slack',
      app: 'world.roarington.com',
      env: 'production',
      dev: 'phone',
      sev: 'major',
      freq: 'always',
    });
  });

  it('ignores labels that are not key:value', () => {
    expect(parseLabels(['qa', 'regression', ':leading', 'trailing:'])).toEqual({});
  });

  it('keeps the first value when a key repeats, and copes with no labels', () => {
    expect(parseLabels(['app:a', 'app:b'])).toEqual({ app: 'a' });
    expect(parseLabels(undefined)).toEqual({});
  });

  it('keeps a value containing a colon intact', () => {
    expect(parseLabels(['note:see:this'])).toEqual({ note: 'see:this' });
  });
});

describe('bugFeedBlocks: a bug filed through the form', () => {
  const blocks = bugFeedBlocks({
    issueKey: 'SUP-12',
    issueUrl: 'https://roarington.atlassian.net/browse/SUP-12',
    summary: report.summary,
    source: 'slack_modal',
    status: 'Under Triage',
    priority: 'High',
    reporterSlackId: 'U_REPORTER',
    report,
  });

  it('leads with a link to the issue', () => {
    expect(json(blocks)).toContain('https://roarington.atlassian.net/browse/SUP-12');
    expect(json(blocks)).toContain('SUP-12');
  });

  it('shows priority, status, how it arrived and who reported it', () => {
    const text = json(blocks);
    expect(text).toContain('High');
    expect(text).toContain('Under Triage');
    expect(text).toContain('/bug');
    expect(text).toContain('<@U_REPORTER>');
  });

  it('shows the whole environment, which is the point of the card', () => {
    const text = json(blocks);
    expect(text).toContain('world.roarington.com');
    expect(text).toContain('Production');
    expect(text).toContain('iPhone 15 Pro');
    expect(text).toContain('iOS 18.2');
    expect(text).toContain('Safari 18');
    expect(text).toContain('390x844');
    expect(text).toContain('Touch');
  });

  it('shows severity, frequency and expected versus actual', () => {
    const text = json(blocks);
    expect(text).toContain('Major');
    expect(text).toContain('Always');
    expect(text).toContain('Lights come on immediately');
    expect(text).toContain('Lights come on a second late');
  });

  it('does not warn about missing QA fields', () => {
    expect(json(blocks)).not.toMatch(/without the QA form/i);
  });

  it('names the shortcut when that is how it arrived', () => {
    const text = json(
      bugFeedBlocks({
        issueKey: 'SUP-13',
        issueUrl: 'x',
        summary: 'a',
        source: 'slack_shortcut',
        report,
      }),
    );
    expect(text).toContain('Report as bug');
  });

  it('does NOT escape the summary, because it sits in a plain_text header', () => {
    // plain_text is not markup: Slack renders it literally, so escaping would
    // show "&lt;script&gt;" to the reader. It is also why this is safe -
    // plain_text interprets nothing, not mrkdwn and not mentions.
    const blocks = bugFeedBlocks({
      issueKey: 'SUP-14',
      issueUrl: 'x',
      summary: '<script> & "quotes"',
      source: 'slack_modal',
      report,
    });

    const header = blocks.find((block) => block.type === 'header') as
      | { text: { type: string; text: string } }
      | undefined;
    expect(header?.text.type).toBe('plain_text');
    expect(header?.text.text).toContain('<script> & "quotes"');
    expect(header?.text.text).not.toContain('&lt;');
  });

  it('does escape untrusted text that lands in mrkdwn', () => {
    // Everything outside the header is mrkdwn, where escaping is required.
    const text = json(
      bugFeedBlocks({
        issueKey: 'SUP-15',
        issueUrl: 'x',
        summary: 'a',
        source: 'slack_modal',
        report: { ...report, expected: '<b>bold</b> & more' },
      }),
    );
    expect(text).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; more');
  });
});

describe('bugFeedBlocks: a bug filed straight into Jira', () => {
  const blocks = bugFeedBlocks({
    issueKey: 'SUP-20',
    issueUrl: 'https://roarington.atlassian.net/browse/SUP-20',
    summary: 'Something is broken',
    source: 'jira_native',
    status: 'Under Triage',
    priority: 'Medium',
    labels: ['src:jira'],
    reporterName: 'Margherita Turrin',
  });

  it('says it was created in Jira and names the reporter', () => {
    const text = json(blocks);
    expect(text).toContain('created directly in Jira');
    expect(text).toContain('Margherita Turrin');
  });

  it('says plainly that the QA fields are missing', () => {
    const text = json(blocks);
    expect(text).toMatch(/without the QA form/i);
    expect(text).toContain('/bug');
  });

  it('shows whatever the labels do carry', () => {
    const text = json(
      bugFeedBlocks({
        issueKey: 'SUP-21',
        issueUrl: 'x',
        summary: 'a',
        source: 'jira_native',
        labels: ['src:jira', 'app:car-studio', 'sev:minor'],
      }),
    );
    expect(text).toContain('car-studio');
    expect(text).toContain('minor');
  });

  it('falls back to "unknown reporter" rather than leaving it blank', () => {
    expect(json(bugFeedBlocks({ issueKey: 'SUP-22', issueUrl: 'x', summary: 'a', source: 'jira_native' })))
      .toContain('unknown reporter');
  });
});

describe('bugFeedBlocks: the card layout', () => {
  const blocks = bugFeedBlocks({
    issueKey: 'SUP-12',
    issueUrl: 'https://roarington.atlassian.net/browse/SUP-12',
    summary: report.summary,
    source: 'slack_modal',
    status: 'Under Triage',
    priority: 'High',
    reporterSlackId: 'U_REPORTER',
    report,
  });

  it('opens with a divider and a header, so consecutive cards read apart', () => {
    expect(blocks[0]!.type).toBe('divider');
    expect(blocks[1]!.type).toBe('header');
  });

  it('puts the environment in a two-column field grid', () => {
    const grid = blocks.find(
      (block) => block.type === 'section' && 'fields' in block,
    ) as { fields: Array<{ text: string }> } | undefined;

    expect(grid).toBeDefined();
    // Slack rejects a section with more than ten fields.
    expect(grid!.fields.length).toBeLessThanOrEqual(10);
    const labels = grid!.fields.map((f) => f.text.split('\n')[0]);
    expect(labels).toEqual([
      '*Application*',
      '*Environment*',
      '*Device*',
      '*OS*',
      '*Browser*',
      '*Viewport*',
      '*Input*',
      '*Severity*',
    ]);
  });

  it('carries an Open in Jira button', () => {
    const withButton = blocks.find(
      (block) => 'accessory' in block && Boolean((block as { accessory?: unknown }).accessory),
    ) as { accessory: { url: string; action_id: string } } | undefined;

    expect(withButton?.accessory.url).toBe('https://roarington.atlassian.net/browse/SUP-12');
    // A URL button still fires an interaction, so it needs an id to ack.
    expect(withButton?.accessory.action_id).toBe('open_issue');
  });

  it('never exceeds ten fields even for a Jira-native bug', () => {
    const native = bugFeedBlocks({
      issueKey: 'SUP-30',
      issueUrl: 'x',
      summary: 'a',
      source: 'jira_native',
      labels: ['src:jira', 'app:a', 'env:b', 'dev:c', 'sev:d', 'freq:e'],
    });
    for (const block of native) {
      if (block.type === 'section' && 'fields' in block) {
        expect((block as { fields: unknown[] }).fields.length).toBeLessThanOrEqual(10);
      }
    }
  });

  it('shows notes only when there are any', () => {
    expect(json(blocks)).not.toContain('*Notes*');
    const withNotes = json(
      bugFeedBlocks({
        issueKey: 'SUP-31',
        issueUrl: 'x',
        summary: 'a',
        source: 'slack_modal',
        report: { ...report, notes: 'Console: TypeError' },
      }),
    );
    expect(withNotes).toContain('*Notes*');
    expect(withNotes).toContain('Console: TypeError');
  });

  it('closes with who reported it and how', () => {
    const last = blocks[blocks.length - 1]!;
    expect(last.type).toBe('context');
    expect(json(last)).toContain('<@U_REPORTER>');
    expect(json(last)).toContain('/bug');
  });
});

describe('postBugFeed', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await makeTestContext({ SLACK_BUG_FEED_CHANNEL: FEED });
  });

  it('posts one card to the feed channel', async () => {
    const sent = await postBugFeed(harness.context, {
      issueKey: 'SUP-1',
      summary: 'a',
      source: 'slack_modal',
      report,
    });

    expect(sent).toBe(true);
    const card = harness.posts.find((post) => post.target === FEED);
    expect(card?.text).toContain('SUP-1');
  });

  it('posts exactly once per issue, however many times it is called', async () => {
    expect(await postBugFeed(harness.context, { issueKey: 'SUP-1', summary: 'a', source: 'slack_modal' })).toBe(true);
    expect(await postBugFeed(harness.context, { issueKey: 'SUP-1', summary: 'a', source: 'jira_native' })).toBe(false);
    expect(harness.posts.filter((post) => post.target === FEED)).toHaveLength(1);
  });

  it('does not post twice in the same place when the confirmation already went there', async () => {
    const sent = await postBugFeed(harness.context, {
      issueKey: 'SUP-1',
      summary: 'a',
      source: 'slack_modal',
      alreadyPostedIn: FEED,
    });

    expect(sent).toBe(false);
    expect(harness.posts).toHaveLength(0);
  });

  it('still posts when the confirmation went somewhere else', async () => {
    expect(
      await postBugFeed(harness.context, {
        issueKey: 'SUP-1',
        summary: 'a',
        source: 'slack_modal',
        alreadyPostedIn: 'C_BUGS',
      }),
    ).toBe(true);
  });

  it('does nothing when no feed channel is configured', async () => {
    const noFeed = await makeTestContext();
    expect(
      await postBugFeed(noFeed.context, { issueKey: 'SUP-1', summary: 'a', source: 'slack_modal' }),
    ).toBe(false);
    expect(noFeed.posts).toHaveLength(0);
  });
});

describe('the feed covers both intake paths (SPEC 1)', () => {
  it('a bug filed from Slack lands in the feed with full detail', async () => {
    const harness = await makeTestContext({ SLACK_BUG_FEED_CHANNEL: FEED });

    await fileBug(harness.context, {
      report: formFields,
      metadata: { channelId: 'C_BUGS', source: 'slack_modal' },
      slackUserId: 'U_REPORTER',
    });

    // The reporter's confirmation goes to the origin channel...
    expect(harness.posts.some((post) => post.target === 'C_BUGS')).toBe(true);

    // ...and the card goes to the feed, with the environment on it.
    const card = harness.posts.find((post) => post.target === FEED);
    expect(card?.text).toContain('390x844');
    expect(card?.text).toContain('iPhone 15 Pro');
    expect(card?.text).not.toMatch(/without the QA form/i);
  });

  it('a bug created in Jira lands in the same feed', async () => {
    const harness = await makeTestContext({ SLACK_BUG_FEED_CHANNEL: FEED });

    const payload = webhookSchema.parse({
      webhookEvent: 'jira:issue_created',
      user: { accountId: 'acc-human' },
      issue: {
        key: 'SUP-77',
        fields: {
          summary: 'Camera clips through the wall',
          project: { key: 'SUP' },
          issuetype: { name: 'Finding' },
          status: { name: 'To Do' },
          priority: { name: 'Medium' },
          reporter: {
            accountId: 'acc-reporter',
            emailAddress: 'reporter@roarington.com',
            displayName: 'Margherita Turrin',
          },
        },
      },
    });

    const result = await handleWebhook(harness.context, payload);
    expect(result.action).toBe('created');

    const card = harness.posts.find((post) => post.target === FEED);
    expect(card?.text).toContain('SUP-77');
    expect(card?.text).toContain('Camera clips through the wall');
    expect(card?.text).toContain('created directly in Jira');
    // The reporter mapped to a Slack user, so they are mentioned.
    expect(card?.text).toContain('<@U_REPORTER>');
    // And the card is honest about what the form would have collected.
    expect(card?.text).toMatch(/without the QA form/i);
  });

  it('a replayed creation webhook does not post a second card', async () => {
    const harness = await makeTestContext({ SLACK_BUG_FEED_CHANNEL: FEED });
    const payload = webhookSchema.parse({
      webhookEvent: 'jira:issue_created',
      issue: {
        key: 'SUP-78',
        fields: { summary: 'a', project: { key: 'SUP' }, status: { name: 'To Do' } },
      },
    });

    await handleWebhook(harness.context, payload);
    await handleWebhook(harness.context, payload);

    expect(harness.posts.filter((post) => post.target === FEED)).toHaveLength(1);
  });

  it('shows the status the issue is actually in when it could not be moved', async () => {
    const harness = await makeTestContext({ SLACK_BUG_FEED_CHANNEL: FEED });
    // The workflow offers no route into triage.
    harness.allowedTransitions.add('Nowhere');

    await handleWebhook(
      harness.context,
      webhookSchema.parse({
        webhookEvent: 'jira:issue_created',
        issue: {
          key: 'SUP-79',
          fields: { summary: 'a', project: { key: 'SUP' }, status: { name: 'To Do' } },
        },
      }),
    );

    const card = harness.posts.find((post) => post.target === FEED);
    expect(card?.text).toContain('To Do');
    expect(card?.text).not.toContain('Under Triage');
  });
});
