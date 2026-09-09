/**
 * Executes a RouteDecision: the Jira moves, the Slack messages, the audit row.
 *
 * Kept apart from `decideRoute` so the rules stay a pure function. Every
 * outbound message is gated on `notifications`, because Jira redelivers
 * webhooks and duplicate DMs destroy trust in the bot faster than anything
 * else (SPEC 7).
 */
import { issueUrl, leaderDmBlocks } from '../format/slackBlocks.js';
import { Leaders } from './leaders.js';
import { describeResolution, resolutionAsksForMore, type RouteDecision } from './route.js';
import type { BugbotContext } from '../context.js';
import type { Priority } from '../types.js';

export interface ApplyRouteInput {
  issueKey: string;
  decision: RouteDecision;
  priority?: Priority;
  fromStatus?: string;
  toStatus: string;
  /** Jira accountId of whoever made the change, for the audit row. */
  actorAccountId?: string;
  /** Makes notification dedupe keys unique per Jira change (the changelog id). */
  changeId: string;
  /** Labels already on the issue, used to find the application. */
  labels?: string[];
  summary: string;
}

export interface ApplyRouteResult {
  moved: boolean;
  notified: string[];
}

export async function applyRoute(
  context: BugbotContext,
  input: ApplyRouteInput,
): Promise<ApplyRouteResult> {
  const { config, log, repo, issues, notifier, leaders } = context;
  const { decision, issueKey } = input;
  const notified: string[] = [];
  const url = issueUrl(config.JIRA_BASE_URL, issueKey);
  const report = await repo.getIssueReport(issueKey);

  let moved = false;

  // --- Jira side ----------------------------------------------------------

  if (decision.targetStatus) {
    moved = await issues.transitionTo(issueKey, decision.targetStatus);
    if (!moved) {
      // SPEC 7: never fail silently. SUP has restricted transitions, so this is
      // a real possibility rather than a theoretical one.
      log.warn(
        { issueKey, target: decision.targetStatus, from: input.toStatus },
        'no transition to the routing target status - labelling instead',
      );
      decision.addLabels.push('needs-manual-move');
    }
  }

  if (decision.addLabels.length > 0) {
    try {
      await issues.addLabels(issueKey, decision.addLabels);
    } catch (error) {
      log.error(
        { issueKey, err: error instanceof Error ? error.message : String(error) },
        'could not add routing labels',
      );
    }
  }

  // --- Audit row ----------------------------------------------------------

  await repo.recordTriageEvent({
    issueKey,
    ...(input.fromStatus ? { fromStatus: input.fromStatus } : {}),
    toStatus: input.toStatus,
    ...(input.priority ? { priority: input.priority } : {}),
    routedTo: decision.destination,
    ...(input.actorAccountId ? { actorAccountId: input.actorAccountId } : {}),
  });

  // --- Reporter -----------------------------------------------------------

  if (decision.notifyReporter) {
    const text = decision.resolution
      ? await resolutionMessage(context, input, url)
      : routedMessage(input, url, decision);

    const sent = await tellReporter(context, {
      issueKey,
      dedupeKey: `reporter:${issueKey}:${input.changeId}`,
      fallback: `${issueKey} ${decision.resolution ? 'resolved' : 'triaged'}`,
      text,
      report,
    });
    if (sent) notified.push('reporter');
  }

  // --- Team leader --------------------------------------------------------

  if (decision.notifyLeader) {
    const application = Leaders.applicationFromLabels(input.labels);
    const leader = leaders.forApplication(application);

    if (leader.slackUserId && (await repo.claimNotification(`leader:${issueKey}:${input.changeId}`))) {
      const result = await notifier.dm({
        userId: leader.slackUserId,
        fallback: `${issueKey} needs your attention (${input.priority ?? 'unknown priority'})`,
        blocks: leaderDmBlocks({
          issueKey,
          issueUrl: url,
          summary: input.summary,
          priority: input.priority ?? 'Medium',
          ...(application ? { application } : {}),
          ...(report?.slack_user_id ? { reporterSlackId: report.slack_user_id } : {}),
          escalated: decision.escalated,
        }),
      });
      if (result.ok) notified.push('leader');
    } else if (!leader.slackUserId) {
      log.warn({ issueKey, application }, 'no team leader configured - nobody was notified');
    }
  }

  // --- Announce channel ---------------------------------------------------

  if (decision.announce && (await repo.claimNotification(`announce:${issueKey}:${input.changeId}`))) {
    const mention = decision.escalated ? escalationMention(config.ESCALATION_MENTION) : '';
    const reporterTag =
      decision.escalated && report?.slack_user_id ? ` (reported by <@${report.slack_user_id}>)` : '';
    const heading = decision.escalated ? ':rotating_light: Escalated' : ':inbox_tray: Triaged';

    const result = await notifier.post({
      channel: config.SLACK_ANNOUNCE_CHANNEL,
      fallback: `${issueKey} ${decision.escalated ? 'escalated' : 'triaged'}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `${mention}${heading} *${input.priority ?? 'Medium'}* — <${url}|${issueKey}>` +
              `${reporterTag}\n${input.summary}`,
          },
        },
      ],
    });
    if (result.ok) notified.push('announce');
  }

  log.info(
    {
      issueKey,
      destination: decision.destination,
      priority: input.priority,
      moved,
      notified,
      reason: decision.reason,
    },
    'routed',
  );

  return { moved, notified };
}

/** SPEC 7: no @here unless ESCALATION_MENTION says so. */
function escalationMention(mode: 'none' | 'here' | 'channel'): string {
  if (mode === 'here') return '<!here> ';
  if (mode === 'channel') return '<!channel> ';
  return '';
}

function routedMessage(input: ApplyRouteInput, url: string, decision: RouteDecision): string {
  const where =
    decision.destination === 'backlog'
      ? 'in the backlog'
      : 'queued for the current work lane';
  return (
    `:white_check_mark: <${url}|${input.issueKey}> has been triaged — it is now ${where}, ` +
    `priority *${input.priority ?? 'Medium'}*.`
  );
}

/** Rejection/duplicate/cannot-reproduce, with the triager's last comment. */
async function resolutionMessage(
  context: BugbotContext,
  input: ApplyRouteInput,
  url: string,
): Promise<string> {
  const resolution = input.decision.resolution!;
  const lines = [
    `<${url}|${input.issueKey}> ${describeResolution(resolution)}.`,
  ];

  const comment = await context.issues.lastCommentText(input.issueKey).catch(() => undefined);
  if (comment) {
    lines.push('', `The triager wrote:`, `>${comment.split('\n').join('\n>')}`);
  }

  if (resolutionAsksForMore(resolution)) {
    lines.push(
      '',
      'If you can still reproduce it, reply in the bug thread with a screen recording and the ' +
        'exact steps — that is usually all it takes to reopen it.',
    );
  }

  return lines.join('\n');
}

/**
 * Reply in the bug's confirmation thread when we know it, otherwise DM.
 * Silently does nothing when the reporter is unknown, which is the documented
 * SPEC 4 outcome for a Jira-native bug we could not map to a Slack user.
 */
async function tellReporter(
  context: BugbotContext,
  input: {
    issueKey: string;
    dedupeKey: string;
    fallback: string;
    text: string;
    report?: { slack_user_id: string | null; slack_channel_id: string | null; slack_thread_ts: string | null };
  },
): Promise<boolean> {
  const { repo, notifier, log } = context;
  const report = input.report;

  if (!report?.slack_channel_id && !report?.slack_user_id) {
    log.info({ issueKey: input.issueKey }, 'no Slack identity for this reporter - no notification');
    return false;
  }

  if (!(await repo.claimNotification(input.dedupeKey))) {
    log.debug({ issueKey: input.issueKey }, 'notification already sent, skipping');
    return false;
  }

  const blocks = [
    { type: 'section' as const, text: { type: 'mrkdwn' as const, text: input.text } },
  ];

  if (report.slack_channel_id && report.slack_thread_ts) {
    const result = await notifier.post({
      channel: report.slack_channel_id,
      threadTs: report.slack_thread_ts,
      fallback: input.fallback,
      blocks,
    });
    if (result.ok) return true;
  }

  if (report.slack_user_id) {
    const result = await notifier.dm({
      userId: report.slack_user_id,
      fallback: input.fallback,
      blocks,
    });
    return result.ok;
  }

  return false;
}
