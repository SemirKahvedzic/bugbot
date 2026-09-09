/**
 * `/mybugs` (SPEC 8): the reporter's own bugs, grouped by status bucket.
 *
 * Two sources are unioned, because a reporter's bugs can arrive either way:
 * the issue keys we recorded at intake, and - when we managed to map them to a
 * Jira account - everything Jira itself thinks they reported.
 */
import type { App } from '@slack/bolt';
import { myBugsBlocks, type IssueSummaryLine } from '../../format/slackBlocks.js';
import { COMMAND } from '../actions.js';
import type { BugbotContext } from '../../context.js';

export const MY_BUGS_LIMIT = 20;

/** Issue keys are interpolated into JQL, so they are validated first. */
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;

export function buildMyBugsJql(input: {
  projectKey: string;
  issueKeys: string[];
  jiraAccountId?: string;
}): string | undefined {
  const keys = input.issueKeys.filter((key) => ISSUE_KEY_PATTERN.test(key));
  const clauses: string[] = [];

  if (keys.length > 0) clauses.push(`issuekey IN (${keys.join(', ')})`);
  if (input.jiraAccountId) clauses.push(`reporter = "${input.jiraAccountId.replace(/"/g, '')}"`);

  if (clauses.length === 0) return undefined;
  return `project = ${input.projectKey} AND (${clauses.join(' OR ')}) ORDER BY created DESC`;
}

export function jqlUrl(baseUrl: string, jql: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/issues/?jql=${encodeURIComponent(jql)}`;
}

export interface MyBugs {
  issues: IssueSummaryLine[];
  jqlUrl: string;
}

export async function fetchMyBugs(
  context: BugbotContext,
  slackUserId: string,
): Promise<MyBugs> {
  const { config, repo, issues, identity, log } = context;

  const issueKeys = repo.issueKeysForSlackUser(slackUserId, 100);
  const cached = repo.userBySlackId(slackUserId);
  let jiraAccountId = cached?.jira_account_id ?? undefined;

  if (!jiraAccountId) {
    // Cheap to try, and it makes every later call better.
    jiraAccountId = (await identity.forSlackUser(slackUserId)).jiraAccountId;
  }

  const jql = buildMyBugsJql({
    projectKey: config.JIRA_PROJECT_KEY,
    issueKeys,
    ...(jiraAccountId ? { jiraAccountId } : {}),
  });

  if (!jql) return { issues: [], jqlUrl: jqlUrl(config.JIRA_BASE_URL, `project = ${config.JIRA_PROJECT_KEY}`) };

  try {
    const found = await issues.search(jql, { maxResults: 100 });
    return {
      issues: found.map(toSummaryLine),
      jqlUrl: jqlUrl(config.JIRA_BASE_URL, jql),
    };
  } catch (error) {
    log.error(
      { err: error instanceof Error ? error.message : String(error) },
      'could not fetch the reporter\'s bugs',
    );
    return { issues: [], jqlUrl: jqlUrl(config.JIRA_BASE_URL, jql) };
  }
}

export function toSummaryLine(issue: {
  key: string;
  fields: {
    summary?: string;
    status?: { name: string };
    priority?: { name: string } | null;
    updated?: string;
  };
}): IssueSummaryLine {
  return {
    key: issue.key,
    summary: issue.fields.summary ?? '(no summary)',
    status: issue.fields.status?.name ?? 'Unknown',
    ...(issue.fields.priority?.name ? { priority: issue.fields.priority.name } : {}),
    ...(issue.fields.updated ? { updated: issue.fields.updated } : {}),
  };
}

export function registerMyBugsCommand(app: App, context: BugbotContext): void {
  app.command(COMMAND.myBugs, async ({ command, ack, respond }) => {
    await ack();

    const { issues, jqlUrl: url } = await fetchMyBugs(context, command.user_id);

    await respond({
      response_type: 'ephemeral',
      text: `You have ${issues.length} bug report(s).`,
      blocks: myBugsBlocks({
        baseUrl: context.config.JIRA_BASE_URL,
        issues,
        jqlUrl: url,
        limit: MY_BUGS_LIMIT,
      }),
    });
  });
}
