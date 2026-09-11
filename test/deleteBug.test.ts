import { beforeEach, describe, expect, it } from 'vitest';
import { publishHomeFor } from '../src/slack/home.js';
import { deleteBug } from '../src/triage/remove.js';
import { buildMyBugsJql } from '../src/slack/commands/mybugs.js';
import {
  bugCardBlocks,
  homeView,
  HOME_BLOCK_LIMIT,
  HOME_MAX_CARDS_WITH_CONTROLS,
} from '../src/format/slackBlocks.js';
import { fixtureIssue, makeTestContext, type TestHarness } from './helpers/context.js';
import { countOf, rows } from './helpers/db.js';
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
  // The two messages BugBot leaves in Slack for every bug it files: the
  // confirmation thread it posted, and the card in the feed channel.
  await harness.repo.setThread('SUP-1', 'C_BUGS', '111.222');
  await harness.repo.setFeedMessage('SUP-1', 'C_FEED', '333.444');
});

describe('deleteBug', () => {
  it('deletes the issue in Jira', async () => {
    const result = await deleteBug(harness.context, {
      issueKey: 'SUP-1',
      actorSlackId: 'U_QA',
    });

    expect(result).toMatchObject({ outcome: 'deleted', summary: 'Something is broken' });
    expect(harness.jiraCalls).toContainEqual({ op: 'deleteIssue', issueKey: 'SUP-1' });
    expect(harness.issuesByKey.has('SUP-1')).toBe(false);
  });

  it('records the deletion, so /bugstats can still count it', async () => {
    await deleteBug(harness.context, { issueKey: 'SUP-1', actorSlackId: 'U_QA' });

    const events = await rows(harness.db, 'SELECT * FROM triage_events');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      issue_key: 'SUP-1',
      from_status: 'Under Triage',
      // There is no status to be in any more, so none is claimed.
      to_status: null,
      routed_to: 'deleted',
    });
  });

  it('takes the feed card and the confirmation down with it', async () => {
    // Deleting only the Jira issue is worse than not deleting at all: the
    // cards stay, and every link on them 404s.
    const result = await deleteBug(harness.context, {
      issueKey: 'SUP-1',
      actorSlackId: 'U_QA',
    });

    expect(harness.deletedMessages).toEqual([
      { channel: 'C_FEED', ts: '333.444' },
      { channel: 'C_BUGS', ts: '111.222' },
    ]);
    expect(result.removedFromSlack).toEqual(['feed', 'confirmation']);
  });

  it('leaves the reporter\'s own message alone on the shortcut path', async () => {
    // There the recorded thread root is the message somebody wrote themselves,
    // not a confirmation BugBot posted. Slack would refuse to delete it, and
    // it is not ours to delete.
    await harness.repo.recordIssueReport({
      issueKey: 'SUP-2',
      slackUserId: 'U_REPORTER',
      intakeSource: 'slack_shortcut',
    });
    await harness.repo.setThread('SUP-2', 'C_TALK', '555.666');
    await harness.repo.setFeedMessage('SUP-2', 'C_FEED', '777.888');
    harness.issuesByKey.set('SUP-2', fixtureIssue({ key: 'SUP-2' }));

    const result = await deleteBug(harness.context, {
      issueKey: 'SUP-2',
      actorSlackId: 'U_QA',
    });

    expect(result.removedFromSlack).toEqual(['feed']);
    expect(harness.deletedMessages).toEqual([{ channel: 'C_FEED', ts: '777.888' }]);
  });

  it('forgets the issue, so the reporter\'s bug list still works', async () => {
    await deleteBug(harness.context, { issueKey: 'SUP-1', actorSlackId: 'U_QA' });

    expect(await countOf(harness.db, 'issue_reports', 'issue_key = $1', ['SUP-1'])).toBe(0);

    // The reason it has to go: /mybugs and App Home build `issuekey IN (...)`
    // from these rows, and Jira rejects the whole query over one key that no
    // longer exists - emptying the list rather than shortening it.
    const keys = await harness.repo.issueKeysForSlackUser('U_REPORTER');
    expect(keys).not.toContain('SUP-1');
    expect(buildMyBugsJql({ projectKey: 'SUP', issueKeys: keys })).toBeUndefined();
  });

  it('tells the reporter, once', async () => {
    const result = await deleteBug(harness.context, {
      issueKey: 'SUP-1',
      actorSlackId: 'U_QA',
    });

    expect(result.notifiedReporter).toBe(true);
    // A DM, not a thread reply: the thread it would have gone in has just
    // been deleted.
    const told = harness.posts.filter((post) => post.kind === 'dm');
    expect(told).toHaveLength(1);
    expect(told[0]!.target).toBe('U_REPORTER');
    expect(told[0]!.text).toContain('SUP-1');
    expect(told[0]!.text).toMatch(/deleted/i);

    // A second attempt - a double click that got past the confirm dialog -
    // says nothing more.
    harness.reset();
    await deleteBug(harness.context, { issueKey: 'SUP-1', actorSlackId: 'U_QA' });
    expect(harness.posts).toHaveLength(0);
  });

  it('does not tell the reporter about their own click', async () => {
    const result = await deleteBug(harness.context, {
      issueKey: 'SUP-1',
      actorSlackId: 'U_REPORTER',
    });

    expect(result.notifiedReporter).toBe(false);
    expect(harness.posts).toHaveLength(0);
  });

  it('cleans up Slack even when the issue was already gone in Jira', async () => {
    harness.issuesByKey.delete('SUP-1');

    const result = await deleteBug(harness.context, {
      issueKey: 'SUP-1',
      actorSlackId: 'U_QA',
    });

    expect(result.outcome).toBe('already_gone');
    expect(result.removedFromSlack).toEqual(['feed', 'confirmation']);
    expect(await countOf(harness.db, 'issue_reports')).toBe(0);
    // Nothing was deleted by us, so nothing is recorded as having been.
    expect(await rows(harness.db, 'SELECT * FROM triage_events')).toHaveLength(0);
    // And nobody is told their bug was deleted when it was not this click
    // that deleted it.
    expect(result.notifiedReporter).toBe(false);
  });

  it('changes nothing in Slack when Jira refuses the delete', async () => {
    // A project that withholds "Delete issues" from the service account. The
    // issue still exists, so removing its cards would be a lie.
    harness.deleteRefusal.status = 403;

    await expect(
      deleteBug(harness.context, { issueKey: 'SUP-1', actorSlackId: 'U_QA' }),
    ).rejects.toThrow(/403/);

    expect(harness.deletedMessages).toHaveLength(0);
    expect(harness.posts).toHaveLength(0);
    expect(await countOf(harness.db, 'issue_reports', 'issue_key = $1', ['SUP-1'])).toBe(1);
    expect(harness.issuesByKey.has('SUP-1')).toBe(true);
  });

  it('deletes a bug it has no record of at all', async () => {
    // A Jira-native bug nobody filed through Slack. There is nothing to clean
    // up and nobody to tell, but the issue still goes.
    harness.issuesByKey.set('SUP-9', fixtureIssue({ key: 'SUP-9' }));

    const result = await deleteBug(harness.context, {
      issueKey: 'SUP-9',
      actorSlackId: 'U_QA',
    });

    expect(result).toMatchObject({ outcome: 'deleted', removedFromSlack: [], notifiedReporter: false });
    expect(harness.issuesByKey.has('SUP-9')).toBe(false);
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

describe('bugCardBlocks: the Delete button', () => {
  it('is absent unless the card is told to offer it', () => {
    expect(json(bugCardBlocks('https://jira.example', card))).not.toContain('delete_issue');
    expect(
      json(bugCardBlocks('https://jira.example', card, { moveTargets: ['Done'] })),
    ).not.toContain('delete_issue');
  });

  it('carries the issue key and a confirm dialog naming it', () => {
    const blocks = bugCardBlocks('https://jira.example', card, { allowDelete: true });
    const text = json(blocks);

    expect(text).toContain('delete_issue');
    expect(text).toContain('"value":"SUP-1"');
    // The dialog is the whole safety story: Slack will not deliver the click
    // until somebody has read it, so it has to say what goes.
    expect(text).toContain('"confirm"');
    expect(text).toContain('cannot be undone');
    expect(text).toContain('Brake lights lag');
    expect(text).toContain('"style":"danger"');
  });

  it('shares a row with the move menu at the foot of the card', () => {
    const readOnly = bugCardBlocks('https://jira.example', card);
    const both = bugCardBlocks('https://jira.example', card, {
      moveTargets: ['In Progress', 'Done'],
      allowDelete: true,
    });

    expect(readOnly).toHaveLength(3);
    expect(both).toHaveLength(4);

    // Title, then the metadata, then the controls: they sit under everything
    // the card says about the bug rather than between the two halves of it.
    expect(both.map((block) => block.type)).toEqual(['section', 'context', 'actions', 'divider']);

    const actions = both[2] as { elements: Array<{ action_id: string }> };
    // Move first, delete last, so the destructive one is not where the eye
    // lands or the thumb reaches first.
    expect(actions.elements.map((element) => element.action_id)).toEqual([
      'move_issue',
      'delete_issue',
    ]);
  });

  it('sits in that same row when it is the only control', () => {
    // Not in the accessory slot it would fit in: the controls belong in one
    // place on every card, and one of them is not worth crowding the summary.
    const blocks = bugCardBlocks('https://jira.example', card, { allowDelete: true });
    expect(blocks.map((block) => block.type)).toEqual([
      'section',
      'context',
      'actions',
      'divider',
    ]);
    expect(json(blocks)).not.toContain('open_issue');
  });
});

describe('homeView: with both controls', () => {
  const base = {
    baseUrl: 'https://jira.example',
    issues: [card],
    jqlUrl: 'https://jira.example/issues/?jql=mine',
    limit: 20,
  };

  it('is read-only for a reporter', () => {
    expect(json(homeView(base))).not.toContain('delete_issue');
  });

  it('puts a Delete button on every card for a triager', () => {
    const text = json(homeView({ ...base, moveTargets: ['Done'], allowDelete: true }));
    expect(text).toContain('delete_issue');
  });

  it('keeps a full list inside the Slack block limit', () => {
    // Slack rejects an over-long view whole rather than trimming it, so a
    // taller card has to mean fewer cards, not a blank tab.
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
      allowDelete: true,
    });

    expect(view.blocks.length).toBeLessThanOrEqual(HOME_BLOCK_LIMIT);
    // Trimmed by the card cap, not by the emergency block trim - the last
    // block is the footer, not the "too many bugs" notice.
    expect(json(view)).not.toMatch(/Too many bugs/);
    expect(json(view)).toContain(`SUP-${HOME_MAX_CARDS_WITH_CONTROLS}`);
  });
});

describe('publishHomeFor', () => {
  it('gives a triager a Delete button on each card', async () => {
    // Home lists the bugs you reported, and the QA owner reported none in the
    // fixture - a Jira account is what puts SUP-1 in their list.
    harness.identityResult.jiraAccountId = 'acc-qa';

    await publishHomeFor(harness.context, 'U_QA');

    expect(json(harness.homeViews[0]!)).toContain('delete_issue');
  });

  it('gives everyone else the view they always had', async () => {
    await publishHomeFor(harness.context, 'U_REPORTER');

    expect(json(harness.homeViews[0]!)).not.toContain('delete_issue');
  });
});
