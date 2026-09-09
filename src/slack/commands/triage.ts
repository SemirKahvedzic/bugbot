/**
 * `/triage` and the buttons on it (SPEC 7), plus the team leader's
 * Approve/Reassign buttons.
 *
 * The buttons set the priority and then go through `decideRoute` /`applyRoute`
 * - the same pair the Jira webhook uses - so there is exactly one
 * implementation of the routing rules. They have to call it directly rather
 * than relying on the webhook their own change produces, because the loop
 * guard correctly ignores anything the service account did.
 */
import type { App } from '@slack/bolt';
import { issueUrl, triageQueueBlocks } from '../../format/slackBlocks.js';
import { applyRoute } from '../../triage/apply.js';
import { decideRoute } from '../../triage/route.js';
import { keepAlive } from '../../runtime.js';
import { ACTION, COMMAND } from '../actions.js';
import { toSummaryLine } from './mybugs.js';
import type { BugbotContext } from '../../context.js';
import type { Priority } from '../../types.js';

export const REASSIGN_CALLBACK_ID = 'bugbot_reassign';
const REASSIGN_BLOCK = 'assignee';
const REASSIGN_ACTION = 'assignee_input';

/**
 * Everyone allowed to drive the triage queue.
 *
 * The QA owner, anyone in `SLACK_TRIAGERS`, and every configured team leader -
 * the people who get escalations can also work the queue. An earlier version
 * allowed exactly one person, which is wrong for any team with more than one,
 * and there was no way to add a second.
 */
export function triagers(context: BugbotContext): string[] {
  const allowed = new Set<string>([context.config.SLACK_DEFAULT_TRIAGER]);

  for (const id of context.config.SLACK_TRIAGERS) allowed.add(id);

  const fallbackLeader = context.leaders.forApplication(undefined).slackUserId;
  if (fallbackLeader) allowed.add(fallbackLeader);
  for (const application of context.leaders.configuredApplications()) {
    const leader = context.leaders.forApplication(application).slackUserId;
    if (leader) allowed.add(leader);
  }

  return [...allowed];
}

export function mayTriage(context: BugbotContext, slackUserId: string): boolean {
  return triagers(context).includes(slackUserId);
}

/**
 * Why someone was refused, in a form that diagnoses itself.
 *
 * The old message said only "`/triage` is for QA", which is useless to the QA
 * engineer reading it: it does not say who is allowed, or which Slack id the
 * service thinks they are. Those two facts separate "my id is configured
 * wrongly" from "the deployment has not picked up the change yet", and without
 * them the only way to tell is to go and read the logs.
 */
export function refusalMessage(context: BugbotContext, slackUserId: string): string {
  const allowed = triagers(context)
    .map((id) => `<@${id}>`)
    .join(', ');

  return (
    `\`/triage\` is for QA, and you are not on the list. Use \`/mybugs\` to see your own reports.\n\n` +
    `Currently allowed: ${allowed}\n` +
    `You are <@${slackUserId}> (\`${slackUserId}\`).\n\n` +
    'To add someone, put their Slack id in `SLACK_TRIAGERS` on the deployment — comma separated. ' +
    'An environment change only takes effect after a redeploy.'
  );
}

/**
 * Priority a button implies.
 *
 * Backlog demotes anything urgent so the routing rules send it to the backlog;
 * Sprint promotes anything quiet so they send it to the sprint lane. A priority
 * that is already on the right side of the line is left alone - the triager's
 * own judgement beats the button's default.
 */
export function priorityForButton(actionId: string, current?: Priority): Priority | undefined {
  const backlogTier: Priority[] = ['Lowest', 'Low', 'Medium'];

  if (actionId === ACTION.triageBacklog) {
    return current && backlogTier.includes(current) ? current : 'Medium';
  }
  if (actionId === ACTION.triageSprint) {
    return current === 'Highest' ? 'Highest' : 'High';
  }
  return current;
}

async function loadTriageQueue(context: BugbotContext) {
  const jql =
    `project = ${context.config.JIRA_PROJECT_KEY} ` +
    `AND status = "${context.config.JIRA_STATUS_TRIAGE}" ORDER BY created ASC`;
  const found = await context.issues.search(jql, { maxResults: 25 });
  return found.map(toSummaryLine);
}

export function registerTriageCommand(app: App, context: BugbotContext): void {
  const { config, log } = context;

  app.command(COMMAND.triage, async ({ command, ack, respond }) => {
    await ack();

    if (!mayTriage(context, command.user_id)) {
      log.info(
        { slackUserId: command.user_id, allowed: triagers(context) },
        '/triage refused - the caller is not a configured triager',
      );
      await respond({ response_type: 'ephemeral', text: refusalMessage(context, command.user_id) });
      return;
    }

    // A Jira search can outlast Slack's three second budget, so the queue is
    // built after the ack and delivered through response_url.
    keepAlive(
      (async () => {
        try {
          const issues = await loadTriageQueue(context);
          await respond({
            response_type: 'ephemeral',
            text: `${issues.length} bug(s) awaiting triage.`,
            blocks: triageQueueBlocks({
              baseUrl: config.JIRA_BASE_URL,
              issues,
              triageStatusName: config.JIRA_STATUS_TRIAGE,
            }),
          });
        } catch (error) {
          log.error(
            { err: error instanceof Error ? error.message : String(error) },
            'could not load the triage queue',
          );
          await respond({
            response_type: 'ephemeral',
            text: 'I could not read the triage queue from Jira. Check `/readyz`.',
          });
        }
      })(),
      'triageQueue',
    );
  });

  // --- The four queue buttons ---------------------------------------------

  for (const actionId of [
    ACTION.triageBacklog,
    ACTION.triageSprint,
    ACTION.triageDuplicate,
    ACTION.triageNeedInfo,
  ]) {
    app.action(actionId, async ({ ack, body, respond, action }) => {
      await ack();

      const issueKey = (action as { value?: string }).value;
      if (!issueKey) return;

      if (!mayTriage(context, body.user.id)) {
        log.info(
          { slackUserId: body.user.id, allowed: triagers(context) },
          'triage button refused - the caller is not a configured triager',
        );
        await respond({ response_type: 'ephemeral', text: refusalMessage(context, body.user.id) });
        return;
      }

      // Routing means several Jira calls and several Slack messages, far past
      // the three second budget, so it happens after the ack and reports back
      // through response_url.
      keepAlive(
        (async () => {
          try {
            const message = await runTriageButton(context, {
              actionId,
              issueKey,
              actorSlackId: body.user.id,
            });
            await respond({ response_type: 'ephemeral', replace_original: false, text: message });
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            log.error({ issueKey, actionId, err: detail }, 'triage button failed');
            await respond({
              response_type: 'ephemeral',
              replace_original: false,
              text: `:x: ${issueKey}: ${detail}`,
            });
          }
        })(),
        `triageButton:${actionId}`,
      );
    });
  }

  // --- Team leader buttons -------------------------------------------------

  app.action(ACTION.leaderApprove, async ({ ack, body, action, respond }) => {
    await ack();
    const issueKey = (action as { value?: string }).value;
    if (!issueKey) return;

    keepAlive(
      (async () => {
        try {
          await context.issues.removeLabels(issueKey, ['needs-lead-review']);
          log.info({ issueKey, actor: body.user.id }, 'lead approved a routed bug');
          await respond({
            response_type: 'ephemeral',
            replace_original: false,
            text: `:white_check_mark: ${issueKey} approved — \`needs-lead-review\` removed.`,
          });
        } catch (error) {
          await respond({
            response_type: 'ephemeral',
            replace_original: false,
            text: `:x: Could not update ${issueKey}: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      })(),
      'leaderApprove',
    );
  });

  app.action(ACTION.leaderReassign, async ({ ack, body, action, client }) => {
    await ack();
    const issueKey = (action as { value?: string }).value;
    const triggerId = (body as { trigger_id?: string }).trigger_id;
    if (!issueKey || !triggerId) return;

    await client.views
      .open({
        trigger_id: triggerId,
        view: {
          type: 'modal',
          callback_id: REASSIGN_CALLBACK_ID,
          private_metadata: issueKey,
          title: { type: 'plain_text', text: 'Reassign bug' },
          submit: { type: 'plain_text', text: 'Assign' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `Assigning *${issueKey}*.` },
            },
            {
              type: 'input',
              block_id: REASSIGN_BLOCK,
              label: { type: 'plain_text', text: 'Assignee' },
              hint: {
                type: 'plain_text',
                text: 'They need a Jira account with the same email address as their Slack account.',
              },
              element: { type: 'users_select', action_id: REASSIGN_ACTION },
            },
          ],
        },
      })
      .catch((error: unknown) => {
        log.error(
          { issueKey, err: error instanceof Error ? error.message : String(error) },
          'could not open the reassign modal',
        );
      });
  });

  app.view(REASSIGN_CALLBACK_ID, async ({ ack, body, view }) => {
    await ack();

    const issueKey = view.private_metadata;
    const selected =
      view.state.values[REASSIGN_BLOCK]?.[REASSIGN_ACTION]?.selected_user ?? undefined;
    if (!issueKey || !selected) return;

    const who = await context.identity.forSlackUser(selected);

    if (!who.jiraAccountId) {
      await context.notifier.dm({
        userId: body.user.id,
        fallback: `Could not reassign ${issueKey}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                `:x: I could not reassign <${issueUrl(config.JIRA_BASE_URL, issueKey)}|${issueKey}> ` +
                `to <@${selected}> — no Jira account matches their email address. ` +
                'Assign it in Jira directly.',
            },
          },
        ],
      });
      return;
    }

    try {
      await context.jira.put(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/assignee`, {
        accountId: who.jiraAccountId,
      });
      log.info({ issueKey, assignee: selected }, 'bug reassigned');
      await context.notifier.dm({
        userId: body.user.id,
        fallback: `${issueKey} assigned`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:white_check_mark: <${issueUrl(config.JIRA_BASE_URL, issueKey)}|${issueKey}> assigned to <@${selected}>.`,
            },
          },
        ],
      });
    } catch (error) {
      await context.notifier.dm({
        userId: body.user.id,
        fallback: `Could not reassign ${issueKey}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:x: Could not assign ${issueKey}: ${error instanceof Error ? error.message : String(error)}`,
            },
          },
        ],
      });
    }
  });
}

/**
 * What a queue button actually does. Returns the line to show the triager.
 * Exported for tests.
 */
export async function runTriageButton(
  context: BugbotContext,
  input: { actionId: string; issueKey: string; actorSlackId: string },
): Promise<string> {
  const { config, issues, repo, notifier } = context;
  const { issueKey, actionId } = input;

  const issue = await issues.getIssue(issueKey);
  const summary = issue.fields.summary ?? issueKey;
  const labels = issue.fields.labels ?? [];
  const currentPriority = issue.fields.priority?.name as Priority | undefined;
  const url = issueUrl(config.JIRA_BASE_URL, issueKey);

  // "Need info" is not a routing decision: the bug stays in triage while the
  // reporter is asked for what is missing.
  if (actionId === ACTION.triageNeedInfo) {
    await issues.addLabels(issueKey, ['needs-info']);
    const report = await repo.getIssueReport(issueKey);

    if (report?.slack_channel_id && report.slack_thread_ts) {
      await notifier.post({
        channel: report.slack_channel_id,
        threadTs: report.slack_thread_ts,
        fallback: `${issueKey} needs more information`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                `:mag: QA needs a bit more on <${url}|${issueKey}> before it can be triaged.\n` +
                'A screen recording, the exact steps, or the browser console output usually does it — ' +
                'reply in this thread and I will attach whatever you post.',
            },
          },
        ],
      });
    } else if (report?.slack_user_id) {
      await notifier.dm({
        userId: report.slack_user_id,
        fallback: `${issueKey} needs more information`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:mag: QA needs more detail on <${url}|${issueKey}> before it can be triaged.`,
            },
          },
        ],
      });
    }

    return `:mag: ${issueKey} labelled \`needs-info\` and the reporter has been asked. It stays in ${config.JIRA_STATUS_TRIAGE}.`;
  }

  const targetPriority = priorityForButton(actionId, currentPriority);
  if (targetPriority && targetPriority !== currentPriority) {
    await issues.setPriority(issueKey, targetPriority);
  }

  const toStatus =
    actionId === ACTION.triageDuplicate ? config.JIRA_STATUS_DUPLICATE : config.JIRA_STATUS_BACKLOG;

  // The closed path does no transition of its own, so do it here.
  if (actionId === ACTION.triageDuplicate) {
    const moved = await issues.transitionTo(issueKey, toStatus);
    if (!moved) {
      return (
        `:warning: ${issueKey}: the workflow offers no transition to *${toStatus}* from ` +
        `${issue.fields.status?.name ?? 'its current status'}. Nothing was changed.`
      );
    }
  }

  const actor = await context.identity.forSlackUser(input.actorSlackId);

  const decision = decideRoute({
    toStatus,
    ...(targetPriority ? { priority: targetPriority } : {}),
    statuses: {
      backlog: config.JIRA_STATUS_BACKLOG,
      rejected: config.JIRA_STATUS_REJECTED,
      duplicate: config.JIRA_STATUS_DUPLICATE,
      cannotReproduce: config.JIRA_STATUS_CANNOT_REPRODUCE,
    },
  });

  const result = await applyRoute(context, {
    issueKey,
    decision,
    ...(targetPriority ? { priority: targetPriority } : {}),
    fromStatus: config.JIRA_STATUS_TRIAGE,
    toStatus,
    ...(actor.jiraAccountId ? { actorAccountId: actor.jiraAccountId } : {}),
    // Coarse minute bucket: a double click is one action, a genuine re-triage
    // later is not.
    changeId: `button:${actionId}:${Math.floor(Date.now() / 60_000)}`,
    labels,
    summary,
  });

  const where = decision.destination === 'closed' ? toStatus : decision.destination;
  const movedNote = decision.targetStatus && !result.moved ? ' (needs moving by hand)' : '';
  return `:white_check_mark: ${issueKey} → *${where}*${movedNote}. Notified: ${result.notified.join(', ') || 'nobody'}.`;
}
