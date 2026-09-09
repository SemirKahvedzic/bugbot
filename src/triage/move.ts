/**
 * Moving a bug to a status chosen by hand, from an App Home card.
 *
 * `/triage` decides where a bug belongs from severity and frequency; this is a
 * triager overriding that with a column. So there is no RouteDecision here -
 * only the transition, the audit row, and the reporter being told, which from
 * the reporter's side is the whole point of the bot.
 *
 * The target is a status *name*. Its transition id is resolved against the
 * live workflow at click time, like every other move in the service, so a
 * workflow edit can never leave a stale id behind.
 */
import { escape, issueUrl } from '../format/slackBlocks.js';
import { tellReporter } from './apply.js';
import type { BugbotContext } from '../context.js';

export interface MoveIssueInput {
  issueKey: string;
  targetStatus: string;
  /** Who clicked, so the reporter is not told about their own click. */
  actorSlackId: string;
}

export type MoveResult =
  | { outcome: 'moved'; from?: string; to: string; notifiedReporter: boolean }
  | { outcome: 'already_there'; to: string }
  | { outcome: 'refused_by_workflow'; from?: string; to: string; available: string[] };

/** A target status that is not in the workflow at all. */
export class UnknownStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownStatusError';
  }
}

export async function moveIssue(
  context: BugbotContext,
  input: MoveIssueInput,
): Promise<MoveResult> {
  const { config, log, repo, issues, meta, serviceAccount } = context;
  const { issueKey, targetStatus } = input;

  // The target arrives inside a Slack interaction payload, so it is checked
  // against the real workflow before any of it reaches Jira.
  if (!meta.hasStatus(targetStatus)) {
    throw new UnknownStatusError(
      `"${targetStatus}" is not a status in the ${config.JIRA_ISSUE_TYPE} workflow. ` +
        `It offers: ${meta.statusNames().join(', ') || '(none)'}.`,
    );
  }

  const issue = await issues.getIssue(issueKey);
  const from = issue.fields.status?.name;

  if (from && from.toLowerCase() === targetStatus.toLowerCase()) {
    return { outcome: 'already_there', to: targetStatus };
  }

  const moved = await issues.transitionTo(issueKey, targetStatus);

  if (!moved) {
    // SUP's workflow is restricted, so this is routine rather than exotic:
    // there is simply no transition from where the issue sits to where the
    // triager asked for. What *is* reachable is far more use than the failure.
    const available = (await issues.transitionsFor(issueKey)).map(
      (transition) => transition.to.name,
    );
    log.info(
      { issueKey, from, to: targetStatus, available },
      'the workflow offers no such move',
    );
    return {
      outcome: 'refused_by_workflow',
      ...(from ? { from } : {}),
      to: targetStatus,
      available,
    };
  }

  await repo.recordTriageEvent({
    issueKey,
    ...(from ? { fromStatus: from } : {}),
    toStatus: targetStatus,
    ...(issue.fields.priority?.name ? { priority: issue.fields.priority.name } : {}),
    // Distinct from the routing destinations so /bugstats can tell a rule from
    // a decision somebody made themselves.
    routedTo: 'manual',
    // The Jira change is made by the service account, whoever pressed it. That
    // is a known cost of one shared account and is why the Slack side logs the
    // human as well.
    ...(serviceAccount?.accountId ? { actorAccountId: serviceAccount.accountId } : {}),
  });

  const report = await repo.getIssueReport(issueKey);
  const url = issueUrl(config.JIRA_BASE_URL, issueKey);

  // Telling somebody what they themselves just clicked is noise.
  const isOwnReport = report?.slack_user_id === input.actorSlackId;

  const notifiedReporter = isOwnReport
    ? false
    : await tellReporter(context, {
        issueKey,
        // Keyed on the exact move, so a double click cannot produce two DMs.
        dedupeKey: `move:${issueKey}:${from ?? 'unknown'}->${targetStatus}`,
        fallback: `${issueKey} moved to ${targetStatus}`,
        text:
          `:arrow_right: Your bug <${url}|${issueKey}> is now *${escape(targetStatus)}*` +
          (from ? ` (was ${escape(from)})` : '') +
          '.',
        ...(report ? { report } : {}),
      });

  log.info(
    { issueKey, from, to: targetStatus, actor: input.actorSlackId, notifiedReporter },
    'issue moved by hand',
  );

  return { outcome: 'moved', ...(from ? { from } : {}), to: targetStatus, notifiedReporter };
}
