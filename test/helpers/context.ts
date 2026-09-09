/**
 * A BugbotContext wired to a real in-memory database and recording fakes for
 * everything that leaves the process. Lets the routing and webhook dispatch be
 * driven end to end - including replaying the same payload twice - without
 * touching Slack or Jira.
 */
import { loadConfig, type Config } from '../../src/config.js';
import { openDatabase, type Db } from '../../src/db/index.js';
import { Repo } from '../../src/db/repo.js';
import { createLogger } from '../../src/logger.js';
import { Leaders } from '../../src/triage/leaders.js';
import type { BugbotContext } from '../../src/context.js';
import type { Issue } from '../../src/jira/issues.js';
import type { Priority } from '../../src/types.js';

export const BASE_ENV = {
  JIRA_BASE_URL: 'https://roarington.atlassian.net',
  JIRA_CLOUD_ID: '57de5553-0941-4346-821f-c46f7dde06cc',
  JIRA_EMAIL: 'bugbot@roarington.com',
  JIRA_API_TOKEN: 'token',
  JIRA_PROJECT_KEY: 'SUP',
  JIRA_ISSUE_TYPE: 'Finding',
  JIRA_BOARD_ID: '468',
  JIRA_WEBHOOK_SECRET: 'a'.repeat(64),
  SLACK_DEFAULT_TRIAGER: 'U_QA',
  SLACK_ANNOUNCE_CHANNEL: 'C_ANNOUNCE',
  SLACK_DEV_CHANNEL: 'C_DEV',
} satisfies NodeJS.ProcessEnv;

export const SERVICE_ACCOUNT_ID = 'acc-service';

export interface PostedMessage {
  kind: 'channel' | 'dm';
  target: string;
  threadTs?: string;
  text: string;
}

export interface JiraCall {
  op: string;
  issueKey: string;
  detail?: unknown;
}

export interface TestHarness {
  context: BugbotContext;
  db: Db;
  repo: Repo;
  posts: PostedMessage[];
  jiraCalls: JiraCall[];
  /** Issues the fake Jira knows about, keyed by issue key. */
  issuesByKey: Map<string, Issue>;
  /** Status names the fake workflow can transition to. Empty means "any". */
  allowedTransitions: Set<string>;
  /** Mutate to change what Identity.forSlackUser reports. */
  identityResult: { displayName?: string; email?: string; jiraAccountId?: string };
  reset(): void;
}

export function makeTestContext(overrides: Partial<Record<string, string>> = {}): TestHarness {
  const config: Config = loadConfig({ ...BASE_ENV, ...overrides });
  const log = createLogger({ level: 'silent' });
  const db = openDatabase({ path: ':memory:' });
  const repo = new Repo(db);

  const posts: PostedMessage[] = [];
  const jiraCalls: JiraCall[] = [];
  const issuesByKey = new Map<string, Issue>();
  const allowedTransitions = new Set<string>();

  const flatten = (blocks: unknown): string => JSON.stringify(blocks ?? '');

  const notifier = {
    async post(input: { channel: string; fallback: string; blocks?: unknown; threadTs?: string }) {
      posts.push({
        kind: 'channel',
        target: input.channel,
        ...(input.threadTs ? { threadTs: input.threadTs } : {}),
        text: `${input.fallback} ${flatten(input.blocks)}`,
      });
      return { ok: true, channel: input.channel, ts: '111.222' };
    },
    async dm(input: { userId: string; fallback: string; blocks?: unknown }) {
      posts.push({
        kind: 'dm',
        target: input.userId,
        text: `${input.fallback} ${flatten(input.blocks)}`,
      });
      return { ok: true, channel: input.userId, ts: '111.222' };
    },
    async react() {
      return true;
    },
    async publishHome() {
      return true;
    },
    async permalink() {
      return 'https://roarington.slack.com/archives/C1/p1';
    },
  };

  // Mutable so a test can say "this reporter has no Jira account".
  const identityResult: {
    displayName?: string;
    email?: string;
    jiraAccountId?: string;
  } = {};

  let nextIssueKey = 100;

  const issues = {
    async createBug(
      report: { summary: string },
      triageStatusName: string,
      options: { reporterAccountId?: string; priority?: Priority } = {},
    ) {
      const key = `SUP-${nextIssueKey++}`;
      jiraCalls.push({
        op: 'createBug',
        issueKey: key,
        detail: {
          summary: report.summary,
          triageStatusName,
          reporterAccountId: options.reporterAccountId ?? null,
        },
      });
      const allowed = allowedTransitions.size === 0 || allowedTransitions.has(triageStatusName);
      return {
        issue: { id: '1', key, self: `https://example/${key}` },
        priority: (options.priority ?? 'Medium') as Priority,
        transitioned: allowed,
      };
    },
    async setDescription(issueKey: string, adf: unknown) {
      jiraCalls.push({ op: 'setDescription', issueKey, detail: JSON.stringify(adf) });
    },
    async getIssue(issueKey: string): Promise<Issue> {
      const issue = issuesByKey.get(issueKey);
      if (!issue) throw new Error(`test fixture has no issue ${issueKey}`);
      return issue;
    },
    async transitionTo(issueKey: string, statusName: string): Promise<boolean> {
      const allowed = allowedTransitions.size === 0 || allowedTransitions.has(statusName);
      jiraCalls.push({ op: 'transition', issueKey, detail: { statusName, allowed } });
      if (!allowed) return false;
      const issue = issuesByKey.get(issueKey);
      if (issue) issue.fields.status = { id: '0', name: statusName };
      return true;
    },
    async addLabels(issueKey: string, labels: string[]) {
      jiraCalls.push({ op: 'addLabels', issueKey, detail: labels });
      const issue = issuesByKey.get(issueKey);
      if (issue) issue.fields.labels = [...(issue.fields.labels ?? []), ...labels];
    },
    async removeLabels(issueKey: string, labels: string[]) {
      jiraCalls.push({ op: 'removeLabels', issueKey, detail: labels });
    },
    async setPriority(issueKey: string, priority: Priority) {
      jiraCalls.push({ op: 'setPriority', issueKey, detail: priority });
      const issue = issuesByKey.get(issueKey);
      if (issue) issue.fields.priority = { id: '0', name: priority };
    },
    async lastCommentText(issueKey: string) {
      jiraCalls.push({ op: 'lastComment', issueKey });
      return 'Not enough information to reproduce.';
    },
    async search() {
      return [...issuesByKey.values()];
    },
    async findAccountIdByEmail() {
      return undefined;
    },
    async attach(issueKey: string, file: { filename: string }) {
      jiraCalls.push({ op: 'attach', issueKey, detail: file.filename });
      return [{ id: 'att-1', filename: file.filename }];
    },
  };

  const identity = {
    async forSlackUser(slackUserId: string) {
      return { slackUserId, displayName: `User ${slackUserId}`, ...identityResult };
    },
    async slackUserForJiraAccount(_accountId: string, email?: string) {
      // Only the fixture address maps to a Slack user.
      return email === 'reporter@roarington.com' ? 'U_REPORTER' : undefined;
    },
    async displayName(slackUserId: string) {
      return `User ${slackUserId}`;
    },
  };

  const jira = {
    async get() {
      return {};
    },
    async post() {
      return {};
    },
    async put() {
      return {};
    },
  };

  const context = {
    config,
    log,
    db,
    repo,
    jira,
    meta: {},
    issues,
    slack: {},
    notifier,
    identity,
    leaders: new Leaders({ fallbackSlackUserId: config.SLACK_DEFAULT_TRIAGER, log }),
    serviceAccount: {
      accountId: SERVICE_ACCOUNT_ID,
      displayName: 'BugBot',
      active: true,
    },
  } as unknown as BugbotContext;

  return {
    context,
    db,
    repo,
    posts,
    jiraCalls,
    issuesByKey,
    allowedTransitions,
    identityResult,
    reset() {
      posts.length = 0;
      jiraCalls.length = 0;
    },
  };
}

/** A Jira issue as the fake client would return it. */
export function fixtureIssue(input: {
  key: string;
  summary?: string;
  status?: string;
  priority?: Priority;
  labels?: string[];
}): Issue {
  return {
    id: '1000',
    key: input.key,
    fields: {
      summary: input.summary ?? 'Something is broken',
      status: { id: '10598', name: input.status ?? 'Under Triage' },
      priority: { id: '3', name: input.priority ?? 'Medium' },
      labels: input.labels ?? ['src:slack', 'app:world.roarington.com'],
      issuetype: { id: '10481', name: 'Finding' },
    },
  };
}
