import { beforeEach, describe, expect, it } from 'vitest';
import { moveValue, parseMoveValue } from '../src/slack/actions.js';
import { publishHomeFor } from '../src/slack/home.js';
import { moveIssue, UnknownStatusError } from '../src/triage/move.js';
import { bugCardBlocks, homeView, trimBlocks, HOME_BLOCK_LIMIT } from '../src/format/slackBlocks.js';
import { fixtureIssue, makeTestContext, type TestHarness } from './helpers/context.js';
import { rows } from './helpers/db.js';
import type { AnyBlock } from '@slack/types';

let harness: TestHarness;

beforeEach(async () => {
  harness = await makeTestContext();
  harness.issuesByKey.set(
    'SUP-1',
    fixtureIssue({ key: 'SUP-1', status: 'Under Triage', priority: 'High' }),
  );
  await harness.repo.recordIssueReport({
    issueKey: 'SUP-1',
    slackUserId: 'U_REPORTER',
    slackChannelId: 'C_BUGS',
    intakeSource: 'slack_modal',
  });
  await harness.repo.setThread('SUP-1', 'C_BUGS', '111.222');
});

describe('moveValue / parseMoveValue', () => {
  it('round-trips an issue key and a status name', () => {
    expect(parseMoveValue(moveValue('SUP-1', 'Ready for Validation'))).toEqual({
      issueKey: 'SUP-1',
      statusName: 'Ready for Validation',
    });
  });

  it('refuses anything that is not both halves', () => {
    // The value comes back inside a Slack payload, so a missing half has to be
    // rejected rather than turned into a half-formed Jira call.
    expect(parseMoveValue('SUP-1')).toBeUndefined();
    expect(parseMoveValue('SUP-1::')).toBeUndefined();
    expect(parseMoveValue('::In Progress')).toBeUndefined();
    expect(parseMoveValue('')).toBeUndefined();
  });
});

describe('moveIssue', () => {
  it('transitions the issue and records the move', async () => {
    const result = await moveIssue(harness.context, {
      issueKey: 'SUP-1',
      targetStatus: 'In Progress',
      actorSlackId: 'U_QA',
    });

    expect(result).toMatchObject({ outcome: 'moved', from: 'Under Triage', to: 'In Progress' });
    expect(harness.jiraCalls).toContainEqual({
      op: 'transition',
      issueKey: 'SUP-1',
      detail: { statusName: 'In Progress', allowed: true },
    });

    const events = await rows(harness.db, 'SELECT * FROM triage_events');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      issue_key: 'SUP-1',
      from_status: 'Under Triage',
      to_status: 'In Progress',
      // Distinct from the routing destinations, so /bugstats can tell a
      // decision somebody made from one a rule made.
      routed_to: 'manual',
    });
  });

  it('tells the reporter their bug moved', async () => {
    await moveIssue(harness.context, {
      issueKey: 'SUP-1',
      targetStatus: 'In Progress',
      actorSlackId: 'U_QA',
    });

    // In the bug thread, which is where the reporter is already looking.
    const told = harness.posts.find((post) => post.threadTs === '111.222');
    expect(told?.text).toContain('SUP-1');
    expect(told?.text).toContain('In Progress');
    expect(told?.text).toContain('Under Triage');
  });

  it('does not tell the reporter about their own click', async () => {
    const result = await moveIssue(harness.context, {
      issueKey: 'SUP-1',
      targetStatus: 'In Progress',
      actorSlackId: 'U_REPORTER',
    });

    expect(result).toMatchObject({ outcome: 'moved', notifiedReporter: false });
    expect(harness.posts).toHaveLength(0);
  });

  it('sends one message for one move, however many times it is clicked', async () => {
    await moveIssue(harness.context, {
      issueKey: 'SUP-1',
      targetStatus: 'In Progress',
      actorSlackId: 'U_QA',
    });
    // Put it back by hand, as a redelivered or double click effectively would,
    // and ask for the same move again.
    harness.issuesByKey.get('SUP-1')!.fields.status = { id: '0', name: 'Under Triage' };

    const again = await moveIssue(harness.context, {
      issueKey: 'SUP-1',
      targetStatus: 'In Progress',
      actorSlackId: 'U_QA',
    });

    expect(again).toMatchObject({ outcome: 'moved', notifiedReporter: false });
    expect(harness.posts).toHaveLength(1);
  });

  it('does nothing when the issue is already in that status', async () => {
    const result = await moveIssue(harness.context, {
      issueKey: 'SUP-1',
      targetStatus: 'Under Triage',
      actorSlackId: 'U_QA',
    });

    expect(result).toEqual({ outcome: 'already_there', to: 'Under Triage' });
    expect(harness.jiraCalls.some((call) => call.op === 'transition')).toBe(false);
    expect(await rows(harness.db, 'SELECT * FROM triage_events')).toHaveLength(0);
    expect(harness.posts).toHaveLength(0);
  });

  it('reports what the workflow does allow when the move is refused', async () => {
    // SUP has a restricted workflow, so this is routine rather than exotic:
    // the menu offers every column, and only the click knows what is reachable.
    harness.allowedTransitions.add('Rejected');

    const result = await moveIssue(harness.context, {
      issueKey: 'SUP-1',
      targetStatus: 'In Progress',
      actorSlackId: 'U_QA',
    });

    expect(result).toMatchObject({
      outcome: 'refused_by_workflow',
      from: 'Under Triage',
      to: 'In Progress',
      available: ['Rejected'],
    });

    // Nothing happened, so nothing is claimed to have happened.
    expect(await rows(harness.db, 'SELECT * FROM triage_events')).toHaveLength(0);
    expect(harness.posts).toHaveLength(0);
  });

  it('refuses a status that is not in the workflow at all, before calling Jira', async () => {
    // The target arrives inside a Slack payload, so it is checked against the
    // real workflow rather than forwarded.
    await expect(
      moveIssue(harness.context, {
        issueKey: 'SUP-1',
        targetStatus: 'Shipped',
        actorSlackId: 'U_QA',
      }),
    ).rejects.toThrow(UnknownStatusError);

    expect(harness.jiraCalls).toHaveLength(0);
  });
});

// --- what the cards and the view look like ---------------------------------

const card = {
  key: 'SUP-1',
  summary: 'Brake lights lag',
  status: 'Under Triage',
  priority: 'High',
};

const json = (blocks: AnyBlock[] | { blocks: AnyBlock[] }): string =>
  JSON.stringify('blocks' in blocks ? blocks.blocks : blocks);

describe('bugCardBlocks', () => {
  it('is read-only without move targets', () => {
    const text = json(bugCardBlocks('https://jira.example', card));
    expect(text).toContain('open_issue');
    expect(text).not.toContain('move_issue');
  });

  it('offers a Move to menu when given targets, minus the current status', () => {
    const blocks = bugCardBlocks('https://jira.example', card, {
      moveTargets: ['Under Triage', 'In Progress', 'Done'],
    });
    const text = json(blocks);

    expect(text).toContain('move_issue');
    expect(text).toContain('SUP-1::In Progress');
    expect(text).toContain('SUP-1::Done');
    // Moving to where it already is would be a no-op, so it is not offered.
    expect(text).not.toContain('SUP-1::Under Triage');
    // It replaces the Open button rather than joining it; the issue key in the
    // card text is already a link to Jira.
    expect(text).not.toContain('open_issue');
  });

  it('keeps the Open button when the only target is where the issue already is', () => {
    const text = json(bugCardBlocks('https://jira.example', card, { moveTargets: ['Under Triage'] }));
    // An empty static_select is rejected by Slack, so the card falls back
    // rather than taking the whole view down.
    expect(text).toContain('open_issue');
    expect(text).not.toContain('move_issue');
  });
});

describe('bugCardBlocks: what the card says', () => {
  const cardText = (blocks: AnyBlock[]): string =>
    (blocks[0] as { text?: { text?: string } }).text?.text ?? '';

  it('spends the title line on the summary, not the status', () => {
    const text = cardText(bugCardBlocks('https://jira.example', card));
    expect(text).toContain('SUP-1');
    expect(text).toContain('Brake lights lag');
  });

  it('leaves the status off when the heading above already names it', () => {
    const blocks = bugCardBlocks('https://jira.example', card, { bucketLabel: 'Under Triage' });
    // It was on every card and the cards are already sorted under that
    // heading, so it was the same word twice.
    expect(json(blocks)).not.toContain('Under Triage');
  });

  it('keeps the status when the heading covers several of them', () => {
    // 'Closed' is Done, Rejected, Duplicate and Cannot Reproduce, so which one
    // it is cannot be read off the heading.
    const closed = { ...card, key: 'SUP-2', status: 'Rejected' };
    expect(json(bugCardBlocks('https://jira.example', closed, { bucketLabel: 'Closed' }))).toContain(
      'Rejected',
    );

    // Same for 'In Progress', which also matches In Review and In QA.
    const inReview = { ...card, key: 'SUP-3', status: 'In Review' };
    expect(
      json(bugCardBlocks('https://jira.example', inReview, { bucketLabel: 'In Progress' })),
    ).toContain('In Review');
  });

  it('keeps the status when there is no heading at all', () => {
    expect(json(bugCardBlocks('https://jira.example', card))).toContain('Under Triage');
  });
});

describe('homeView', () => {
  const base = {
    baseUrl: 'https://jira.example',
    issues: [card],
    jqlUrl: 'https://jira.example/issues/?jql=mine',
    limit: 20,
  };

  it('is read-only for a reporter', () => {
    const text = json(homeView(base));
    expect(text).toContain('Your bug reports');
    expect(text).not.toContain('move_issue');
  });

  it('puts a move menu on every card for a triager', () => {
    const text = json(homeView({ ...base, moveTargets: ['Under Triage', 'In Progress'] }));
    expect(text).toContain('SUP-1::In Progress');
  });

  it('keeps a full list inside the Slack block limit', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      ...card,
      key: `SUP-${index + 1}`,
      status: index % 2 === 0 ? 'Under Triage' : 'In Progress',
    }));

    const view = homeView({
      ...base,
      issues: many,
      limit: 25,
      moveTargets: ['To Do', 'Under Triage', 'In Progress', 'Done'],
    });

    expect(view.blocks.length).toBeLessThanOrEqual(HOME_BLOCK_LIMIT);
  });
});

describe('trimBlocks', () => {
  it('says what it dropped rather than silently shortening', () => {
    const blocks = Array.from({ length: 120 }, () => ({ type: 'divider' }) as AnyBlock);
    const trimmed = trimBlocks(blocks);

    expect(trimmed).toHaveLength(HOME_BLOCK_LIMIT);
    expect(JSON.stringify(trimmed.at(-1))).toMatch(/Too many bugs/i);
  });
});

describe('publishHomeFor', () => {
  it('gives a triager movable cards, in the board column order', async () => {
    // Home lists the bugs you reported, and the QA owner reported none in the
    // fixture - a Jira account is what puts SUP-1 in their list.
    harness.identityResult.jiraAccountId = 'acc-qa';

    await publishHomeFor(harness.context, 'U_QA');

    const text = json(harness.homeViews[0]!);
    expect(text).toContain('move_issue');

    // The menu has to read left to right the way the board does, which is not
    // the workflow order: Cannot Reproduce, Rejected and Duplicate come before
    // Ready for Validation on board 468.
    const offered = [...text.matchAll(/SUP-1::([^"]+)/g)].map((match) => match[1]);
    expect(offered).toEqual([
      'To Do',
      'In Progress',
      'Cannot Reproduce',
      'Rejected',
      'Duplicate',
      'Ready for Validation',
      'Done',
    ]);
  });

  it('gives everyone else the view they always had', async () => {
    await publishHomeFor(harness.context, 'U_REPORTER');

    const text = json(harness.homeViews[0]!);
    expect(text).not.toContain('move_issue');
  });
});
