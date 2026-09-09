import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JiraClient } from '../src/jira/client.js';
import { assertStatusesExist, JiraMeta, JiraMetaError } from '../src/jira/meta.js';

const BASE = 'https://roarington.atlassian.net';

/**
 * Shaped after the real SUP project as verified on 2026-09-09: issue type
 * `Finding` (10481) at hierarchy level 1, plus a `Sub-task`. Status ids are the
 * real ones where known.
 */
const SUP_PROJECT = { id: '10396', key: 'SUP', name: 'Support', style: 'classic' };

const SUP_STATUSES = [
  {
    id: '10481',
    name: 'Finding',
    subtask: false,
    statuses: [
      { id: '10000', name: 'To Do', statusCategory: { id: 2, key: 'new', name: 'To Do' } },
      {
        id: '10500',
        name: 'Under Triage',
        statusCategory: { id: 4, key: 'indeterminate', name: 'In Progress' },
      },
      { id: '3', name: 'In Progress', statusCategory: { id: 4, key: 'indeterminate', name: 'In Progress' } },
      {
        id: '10501',
        name: 'Ready for Validation',
        statusCategory: { id: 4, key: 'indeterminate', name: 'In Progress' },
      },
      { id: '10001', name: 'Done', statusCategory: { id: 3, key: 'done', name: 'Done' } },
      { id: '10502', name: 'Rejected', statusCategory: { id: 3, key: 'done', name: 'Done' } },
      { id: '10503', name: 'Duplicate', statusCategory: { id: 3, key: 'done', name: 'Done' } },
      { id: '10504', name: 'Cannot Reproduce', statusCategory: { id: 3, key: 'done', name: 'Done' } },
    ],
  },
  { id: '10003', name: 'Sub-task', subtask: true, statuses: [{ id: '10000', name: 'To Do' }] },
];

const PRIORITIES = [
  { id: '1', name: 'Highest' },
  { id: '2', name: 'High' },
  { id: '3', name: 'Medium' },
  { id: '4', name: 'Low' },
  { id: '5', name: 'Lowest' },
];

/**
 * Board 468's columns, in the order the board shows them. Note that this is
 * *not* the workflow order above: the board puts the three closed-without-work
 * statuses between In Progress and Ready for Validation.
 */
const SUP_BOARD_CONFIG = {
  id: 468,
  name: 'SUP board',
  columnConfig: {
    columns: [
      { name: 'To Do', statuses: [{ id: '10000' }] },
      { name: 'Under Triage', statuses: [{ id: '10500' }] },
      { name: 'In Progress', statuses: [{ id: '3' }] },
      { name: 'Cannot Reproduce', statuses: [{ id: '10504' }] },
      { name: 'Rejected', statuses: [{ id: '10502' }] },
      { name: 'Duplicate', statuses: [{ id: '10503' }] },
      { name: 'Ready for Validation', statuses: [{ id: '10501' }] },
      { name: 'Done', statuses: [{ id: '10001' }] },
    ],
  },
};

const server = setupServer(
  http.get(`${BASE}/rest/api/3/project/SUP`, () => HttpResponse.json(SUP_PROJECT)),
  http.get(`${BASE}/rest/api/3/project/SUP/statuses`, () => HttpResponse.json(SUP_STATUSES)),
  http.get(`${BASE}/rest/api/3/priority`, () => HttpResponse.json(PRIORITIES)),
  http.get(`${BASE}/rest/agile/1.0/board/468/configuration`, () =>
    HttpResponse.json(SUP_BOARD_CONFIG),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeMeta(issueTypeName = 'Finding'): JiraMeta {
  const client = new JiraClient({
    baseUrl: BASE,
    email: 'bugbot@roarington.com',
    apiToken: 'token',
  });
  return new JiraMeta(client, { projectKey: 'SUP', issueTypeName });
}

function makeBoardMeta(): JiraMeta {
  const client = new JiraClient({
    baseUrl: BASE,
    email: 'bugbot@roarington.com',
    apiToken: 'token',
  });
  return new JiraMeta(client, { projectKey: 'SUP', issueTypeName: 'Finding', boardId: 468 });
}

describe('board column order', () => {
  it('orders statuses the way the board lays out its columns', async () => {
    const meta = makeBoardMeta();
    await meta.load();

    // The point of reading the board at all: this order is not derivable from
    // the workflow, which puts Ready for Validation and Done before the three
    // closed-without-work statuses.
    expect(meta.statusNamesInBoardOrder()).toEqual([
      'To Do',
      'Under Triage',
      'In Progress',
      'Cannot Reproduce',
      'Rejected',
      'Duplicate',
      'Ready for Validation',
      'Done',
    ]);
  });

  it('falls back to workflow order with no board configured', async () => {
    const meta = makeMeta();
    await meta.load();
    expect(meta.statusNamesInBoardOrder()).toEqual(meta.statusNames());
  });

  it('falls back to workflow order when the board cannot be read', async () => {
    // Reading a board needs the Agile API and a board the service account can
    // see. Neither is needed anywhere else, so losing it costs a tidy menu and
    // must not cost a boot.
    server.use(
      http.get(`${BASE}/rest/agile/1.0/board/468/configuration`, () =>
        HttpResponse.json({ errorMessages: ['no permission'] }, { status: 403 }),
      ),
    );

    const meta = makeBoardMeta();
    await meta.load();
    expect(meta.statusNamesInBoardOrder()).toEqual(meta.statusNames());
  });

  it('appends a status the board does not show rather than dropping it', async () => {
    server.use(
      http.get(`${BASE}/rest/agile/1.0/board/468/configuration`, () =>
        HttpResponse.json({
          id: 468,
          name: 'SUP board',
          columnConfig: { columns: [{ name: 'To Do', statuses: [{ id: '10000' }] }] },
        }),
      ),
    );

    const meta = makeBoardMeta();
    await meta.load();
    const order = meta.statusNamesInBoardOrder();

    // A column missing from the board must never make a status unreachable.
    expect(order[0]).toBe('To Do');
    expect(order).toHaveLength(meta.statusNames().length);
    expect(order).toContain('Done');
  });
});

describe('JiraMeta name resolution', () => {
  it('refuses to resolve before load()', () => {
    expect(() => makeMeta().projectId).toThrow(/load\(\) must be awaited/);
  });

  it('resolves project, issue type and statuses', async () => {
    const meta = makeMeta();
    await meta.load();

    expect(meta.projectId).toBe('10396');
    expect(meta.projectKey).toBe('SUP');
    expect(meta.issueTypeId).toBe('10481');
    expect(meta.issueTypeName).toBe('Finding');
    expect(meta.statusId('Under Triage')).toBe('10500');
    expect(meta.statusId('To Do')).toBe('10000');
  });

  it('matches names case-insensitively, so "IN QA" style casing still works', async () => {
    const meta = makeMeta('finding');
    await meta.load();
    expect(meta.issueTypeId).toBe('10481');
    expect(meta.statusId('under triage')).toBe('10500');
    expect(meta.priorityId('HIGHEST')).toBe('1');
  });

  it('lists what exists when a status name is wrong', async () => {
    const meta = makeMeta();
    await meta.load();
    expect(() => meta.statusId('Triaging')).toThrow(JiraMetaError);
    expect(() => meta.statusId('Triaging')).toThrow(/Under Triage/);
    expect(() => meta.statusId('Triaging')).toThrow(/not part of the Finding workflow/);
  });

  it('lists what exists when the issue type is wrong', async () => {
    const meta = makeMeta('Bug');
    await meta.load();
    // SUP genuinely has no Bug type - this is the error the operator must see.
    expect(() => meta.issueTypeId).toThrow(/Issue type "Bug" does not exist/);
    expect(() => meta.issueTypeId).toThrow(/Finding, Sub-task/);
    expect(() => meta.issueTypeId).toThrow(/JIRA_ISSUE_TYPE/);
  });

  it('resolves the full priority scheme needed by the SPEC 6 matrix', async () => {
    const meta = makeMeta();
    await meta.load();
    expect(meta.priorityId('Highest')).toBe('1');
    expect(meta.priorityId('High')).toBe('2');
    expect(meta.priorityId('Medium')).toBe('3');
    expect(meta.priorityId('Low')).toBe('4');
    expect(meta.priorityId('Lowest')).toBe('5');
    expect(() => meta.priorityId('Blocker')).toThrow(/does not exist on this site/);
  });

  it('reports status presence without throwing', async () => {
    const meta = makeMeta();
    await meta.load();
    expect(meta.hasStatus('Under Triage')).toBe(true);
    expect(meta.hasStatus('Triaging')).toBe(false);
  });

  it('scopes statuses to the configured issue type', async () => {
    const meta = makeMeta('Sub-task');
    await meta.load();
    expect(meta.statusNames()).toEqual(['To Do']);
    expect(meta.hasStatus('Under Triage')).toBe(false);
  });
});

describe('assertStatusesExist', () => {
  it('passes when the workflow has everything BugBot routes on', async () => {
    const meta = makeMeta();
    await meta.load();
    expect(() =>
      assertStatusesExist(meta, {
        JIRA_STATUS_TRIAGE: 'Under Triage',
        JIRA_STATUS_BACKLOG: 'To Do',
        JIRA_STATUS_REJECTED: 'Rejected',
        JIRA_STATUS_DUPLICATE: 'Duplicate',
        JIRA_STATUS_CANNOT_REPRODUCE: 'Cannot Reproduce',
      }),
    ).not.toThrow();
  });

  it('reports every missing status at once, not just the first', async () => {
    const meta = makeMeta();
    await meta.load();
    try {
      assertStatusesExist(meta, {
        JIRA_STATUS_TRIAGE: 'Triaging',
        JIRA_STATUS_BACKLOG: 'To Do',
        JIRA_STATUS_REJECTED: 'Wont Fix',
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('JIRA_STATUS_TRIAGE="Triaging"');
      expect(message).toContain('JIRA_STATUS_REJECTED="Wont Fix"');
      expect(message).not.toContain('JIRA_STATUS_BACKLOG');
      expect(message).toContain('Under Triage');
    }
  });
});

describe('JiraMeta transitions', () => {
  const transitions = {
    transitions: [
      { id: '11', name: 'Start triage', to: { id: '10500', name: 'Under Triage' } },
      { id: '21', name: 'Back to backlog', to: { id: '10000', name: 'To Do' } },
      { id: '31', name: 'Reject', to: { id: '10502', name: 'Rejected' } },
    ],
  };

  it('resolves a transition id by the status it lands in', async () => {
    server.use(
      http.get(`${BASE}/rest/api/3/issue/SUP-1/transitions`, () => HttpResponse.json(transitions)),
    );
    const meta = makeMeta();
    await meta.load();

    await expect(meta.findTransitionId('SUP-1', 'Under Triage')).resolves.toBe('11');
    await expect(meta.findTransitionId('SUP-1', 'to do')).resolves.toBe('21');
  });

  it('returns undefined when the target status is unreachable from here', async () => {
    server.use(
      http.get(`${BASE}/rest/api/3/issue/SUP-1/transitions`, () => HttpResponse.json(transitions)),
    );
    const meta = makeMeta();
    await meta.load();
    await expect(meta.findTransitionId('SUP-1', 'Done')).resolves.toBeUndefined();
  });

  it('tolerates a workflow with no transitions offered', async () => {
    server.use(
      http.get(`${BASE}/rest/api/3/issue/SUP-2/transitions`, () => HttpResponse.json({})),
    );
    const meta = makeMeta();
    await meta.load();
    await expect(meta.transitionsFor('SUP-2')).resolves.toEqual([]);
  });
});
