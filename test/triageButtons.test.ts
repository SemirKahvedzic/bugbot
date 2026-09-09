import { beforeEach, describe, expect, it } from 'vitest';
import { ACTION } from '../src/slack/actions.js';
import {
  mayTriage,
  priorityForButton,
  refusalMessage,
  runTriageButton,
  triagers,
} from '../src/slack/commands/triage.js';
import { fixtureIssue, makeTestContext, type TestHarness } from './helpers/context.js';
import { countOf, rows } from './helpers/db.js';
import type { Priority } from '../src/types.js';

let harness: TestHarness;

beforeEach(async () => {
  harness = await makeTestContext();
  harness.issuesByKey.set('SUP-1', fixtureIssue({ key: 'SUP-1', priority: 'Medium' }));
  await harness.repo.recordIssueReport({
    issueKey: 'SUP-1',
    slackUserId: 'U_REPORTER',
    slackChannelId: 'C_BUGS',
    intakeSource: 'slack_modal',
  });
  await harness.repo.setThread('SUP-1', 'C_BUGS', '111.222');
});

describe('mayTriage', () => {
  it('lets the QA owner through, and a stranger not at all', async () => {
    expect(mayTriage(harness.context, 'U_QA')).toBe(true);
    expect(mayTriage(harness.context, 'U_RANDOM')).toBe(false);
  });

  it('lets everyone in SLACK_TRIAGERS through', async () => {
    // The whole point: a team with two QA engineers. The earlier version
    // allowed exactly one person and offered no way to add a second.
    const team = await makeTestContext({ SLACK_TRIAGERS: 'U_QA2, U_QA3' });

    expect(mayTriage(team.context, 'U_QA')).toBe(true);
    expect(mayTriage(team.context, 'U_QA2')).toBe(true);
    expect(mayTriage(team.context, 'U_QA3')).toBe(true);
    expect(mayTriage(team.context, 'U_RANDOM')).toBe(false);
  });

  it('lets a team leader work the queue as well', async () => {
    // Leaders receive the escalations, so refusing them the queue would mean
    // being told to look at a bug you are not allowed to touch.
    const team = await makeTestContext({ BUGBOT_LEADERS: 'world.roarington.com=U_WORLD' });

    expect(mayTriage(team.context, 'U_WORLD')).toBe(true);
    expect(triagers(team.context)).toContain('U_WORLD');
  });
});

describe('refusalMessage', () => {
  it('names who is allowed and which id the service sees', async () => {
    const team = await makeTestContext({ SLACK_TRIAGERS: 'U_QA2' });
    const text = refusalMessage(team.context, 'U_RANDOM');

    // Those two facts are what separate "my id is wrong" from "the deployment
    // has not picked the change up yet". Without them the only way to tell is
    // to go and read the logs.
    expect(text).toContain('<@U_QA>');
    expect(text).toContain('<@U_QA2>');
    expect(text).toContain('U_RANDOM');
    expect(text).toMatch(/SLACK_TRIAGERS/);
    expect(text).toMatch(/redeploy/i);
  });
});

describe('priorityForButton', () => {
  it('demotes an urgent bug when Backlog is pressed', async () => {
    expect(priorityForButton(ACTION.triageBacklog, 'Highest')).toBe('Medium');
    expect(priorityForButton(ACTION.triageBacklog, 'High')).toBe('Medium');
  });

  it('leaves an already-quiet priority alone, trusting the triager', async () => {
    for (const priority of ['Lowest', 'Low', 'Medium'] as Priority[]) {
      expect(priorityForButton(ACTION.triageBacklog, priority)).toBe(priority);
    }
  });

  it('promotes a quiet bug when Sprint is pressed', async () => {
    for (const priority of ['Lowest', 'Low', 'Medium'] as Priority[]) {
      expect(priorityForButton(ACTION.triageSprint, priority)).toBe('High');
    }
  });

  it('does not demote Highest when Sprint is pressed', async () => {
    expect(priorityForButton(ACTION.triageSprint, 'Highest')).toBe('Highest');
  });

  it('defaults sensibly when the current priority is unknown', async () => {
    expect(priorityForButton(ACTION.triageBacklog, undefined)).toBe('Medium');
    expect(priorityForButton(ACTION.triageSprint, undefined)).toBe('High');
  });
});

describe('runTriageButton: Backlog', () => {
  it('routes to the backlog through the same rules as the webhook', async () => {
    const message = await runTriageButton(harness.context, {
      actionId: ACTION.triageBacklog,
      issueKey: 'SUP-1',
      actorSlackId: 'U_QA',
    });

    expect(message).toContain('backlog');
    expect(harness.jiraCalls).toEqual(
      expect.arrayContaining([
        { op: 'transition', issueKey: 'SUP-1', detail: { statusName: 'To Do', allowed: true } },
        { op: 'addLabels', issueKey: 'SUP-1', detail: ['triaged:backlog'] },
      ]),
    );

    // No leader DM, no announcement - same as the webhook path for Medium.
    expect(harness.posts.some((post) => post.target === 'C_ANNOUNCE')).toBe(false);
    expect(harness.posts.some((post) => post.target === 'U_QA' && post.kind === 'dm')).toBe(false);

    expect(await rows(harness.db, 'SELECT routed_to, priority FROM triage_events')).toEqual([
      { routed_to: 'backlog', priority: 'Medium' },
    ]);
  });

  it('does not rewrite a priority that is already correct', async () => {
    await runTriageButton(harness.context, {
      actionId: ACTION.triageBacklog,
      issueKey: 'SUP-1',
      actorSlackId: 'U_QA',
    });
    expect(harness.jiraCalls.some((call) => call.op === 'setPriority')).toBe(false);
  });
});

describe('runTriageButton: Sprint', () => {
  it('promotes the priority, labels it and notifies the leader', async () => {
    const message = await runTriageButton(harness.context, {
      actionId: ACTION.triageSprint,
      issueKey: 'SUP-1',
      actorSlackId: 'U_QA',
    });

    expect(message).toContain('sprint');
    expect(harness.jiraCalls).toEqual(
      expect.arrayContaining([
        { op: 'setPriority', issueKey: 'SUP-1', detail: 'High' },
        { op: 'addLabels', issueKey: 'SUP-1', detail: ['triaged:sprint', 'needs-lead-review'] },
      ]),
    );

    expect(harness.posts.some((post) => post.kind === 'dm' && post.target === 'U_QA')).toBe(true);
    expect(harness.posts.some((post) => post.target === 'C_ANNOUNCE')).toBe(true);

    expect(await rows(harness.db, 'SELECT routed_to, priority FROM triage_events')).toEqual([
      { routed_to: 'sprint', priority: 'High' },
    ]);
  });

  it('keeps Highest as an escalation rather than demoting it to High', async () => {
    harness.issuesByKey.set('SUP-2', fixtureIssue({ key: 'SUP-2', priority: 'Highest' }));
    await runTriageButton(harness.context, {
      actionId: ACTION.triageSprint,
      issueKey: 'SUP-2',
      actorSlackId: 'U_QA',
    });

    expect(harness.jiraCalls.some((call) => call.op === 'setPriority')).toBe(false);
    const labels = harness.jiraCalls.find((call) => call.op === 'addLabels');
    expect(labels?.detail).toEqual(['triaged:sprint', 'escalated']);
  });
});

describe('runTriageButton: Duplicate', () => {
  it('moves it to Duplicate and tells the reporter, without routing it anywhere', async () => {
    const message = await runTriageButton(harness.context, {
      actionId: ACTION.triageDuplicate,
      issueKey: 'SUP-1',
      actorSlackId: 'U_QA',
    });

    expect(message).toContain('Duplicate');
    expect(harness.jiraCalls).toEqual(
      expect.arrayContaining([
        { op: 'transition', issueKey: 'SUP-1', detail: { statusName: 'Duplicate', allowed: true } },
      ]),
    );
    // The closed path adds no labels and announces nothing.
    expect(harness.jiraCalls.some((call) => call.op === 'addLabels')).toBe(false);
    expect(harness.posts.some((post) => post.target === 'C_ANNOUNCE')).toBe(false);

    const reporterPost = harness.posts.find((post) => post.target === 'C_BUGS');
    expect(reporterPost?.text).toMatch(/duplicate/i);

    expect(await rows(harness.db, 'SELECT routed_to FROM triage_events')).toEqual([
      { routed_to: 'closed' },
    ]);
  });

  it('changes nothing when the workflow has no transition to Duplicate', async () => {
    harness.allowedTransitions.add('To Do');

    const message = await runTriageButton(harness.context, {
      actionId: ACTION.triageDuplicate,
      issueKey: 'SUP-1',
      actorSlackId: 'U_QA',
    });

    expect(message).toMatch(/no transition to \*Duplicate\*/);
    expect(await countOf(harness.db, 'triage_events')).toBe(0);
    expect(harness.posts).toHaveLength(0);
  });
});

describe('runTriageButton: Need info', () => {
  it('keeps the bug in triage and asks the reporter in their thread', async () => {
    const message = await runTriageButton(harness.context, {
      actionId: ACTION.triageNeedInfo,
      issueKey: 'SUP-1',
      actorSlackId: 'U_QA',
    });

    expect(message).toContain('needs-info');
    expect(message).toContain('Under Triage');

    expect(harness.jiraCalls).toEqual([
      { op: 'addLabels', issueKey: 'SUP-1', detail: ['needs-info'] },
    ]);
    // Deliberately no transition and no triage event: nothing was decided.
    expect(harness.jiraCalls.some((call) => call.op === 'transition')).toBe(false);
    expect(await countOf(harness.db, 'triage_events')).toBe(0);

    const post = harness.posts.find((p) => p.target === 'C_BUGS');
    expect(post?.threadTs).toBe('111.222');
    expect(post?.text).toMatch(/more/i);
  });

  it('DMs the reporter when there is no thread to reply in', async () => {
    harness.issuesByKey.set('SUP-3', fixtureIssue({ key: 'SUP-3' }));
    await harness.repo.recordIssueReport({
      issueKey: 'SUP-3',
      slackUserId: 'U_REPORTER',
      intakeSource: 'jira_native',
    });

    await runTriageButton(harness.context, {
      actionId: ACTION.triageNeedInfo,
      issueKey: 'SUP-3',
      actorSlackId: 'U_QA',
    });

    expect(harness.posts.some((post) => post.kind === 'dm' && post.target === 'U_REPORTER')).toBe(
      true,
    );
  });
});

describe('runTriageButton: double click', () => {
  it('is idempotent within a minute, so a double click sends one set of messages', async () => {
    await runTriageButton(harness.context, {
      actionId: ACTION.triageSprint,
      issueKey: 'SUP-1',
      actorSlackId: 'U_QA',
    });
    const postsAfterFirst = harness.posts.length;

    await runTriageButton(harness.context, {
      actionId: ACTION.triageSprint,
      issueKey: 'SUP-1',
      actorSlackId: 'U_QA',
    });

    expect(harness.posts).toHaveLength(postsAfterFirst);
  });
});
