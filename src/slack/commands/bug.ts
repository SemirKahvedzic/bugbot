/**
 * `/bug` and the form submission it leads to (SPEC 5, Phase 1).
 *
 * The submission is acknowledged inside Slack's three second window and the
 * Jira work happens afterwards, reporting back with chat.postMessage. If Jira
 * fails, the reporter is DM'd with what they typed still recoverable from the
 * log - a bug report must never vanish silently.
 */
import type { App } from '@slack/bolt';
import { renderDescription } from '../../format/description.js';
import { intakeConfirmationBlocks, issueUrl } from '../../format/slackBlocks.js';
import { allowedChannelMentions, channelAllowed, type BugbotContext } from '../../context.js';
import { COMMAND } from '../actions.js';
import {
  BUG_MODAL_CALLBACK_ID,
  buildBugModal,
  parseBugModalSubmission,
  type BugModalMetadata,
  type SubmittedView,
} from '../views/bugModal.js';
import type { BugReport, IntakeSource } from '../../types.js';

export interface FileBugInput {
  report: Omit<BugReport, 'reporter' | 'source'>;
  metadata: BugModalMetadata;
  slackUserId: string;
}

/**
 * Create the Jira issue, record it, and post the confirmation thread.
 * Exported so the shortcut path and tests can drive it directly.
 */
export async function fileBug(
  context: BugbotContext,
  input: FileBugInput,
): Promise<{ issueKey?: string }> {
  const { config, log, repo, issues, notifier, identity } = context;
  const source: IntakeSource = input.metadata.source ?? 'slack_modal';

  const who = await identity.forSlackUser(input.slackUserId);

  const report: BugReport = {
    ...input.report,
    source,
    reporter: {
      slackUserId: input.slackUserId,
      ...(who.displayName ? { displayName: who.displayName } : {}),
      ...(who.email ? { email: who.email } : {}),
      ...(who.jiraAccountId ? { jiraAccountId: who.jiraAccountId } : {}),
    },
    ...(input.metadata.channelId ? { slackChannelId: input.metadata.channelId } : {}),
    ...(input.metadata.permalink ? { slackMessagePermalink: input.metadata.permalink } : {}),
  };

  let created: Awaited<ReturnType<typeof issues.createBug>>;
  try {
    created = await issues.createBug(report, config.JIRA_STATUS_TRIAGE, {
      ...(config.JIRA_SET_REAL_REPORTER && who.jiraAccountId
        ? { reporterAccountId: who.jiraAccountId }
        : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Log the whole report so nothing typed by hand is lost. Redaction in
    // src/logger.ts keeps the reporter's email out of this.
    log.error({ err: message, report: { ...report, reporter: undefined } }, 'could not create Jira issue');
    await notifier.dm({
      userId: input.slackUserId,
      fallback: 'BugBot could not file your bug',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              ':x: I could not file your bug in Jira.\n' +
              `>${message}\n\n` +
              'Nothing you typed is lost — it is in the service log. Ping QA and it can be ' +
              'filed by hand, or try `/bug` again in a minute.',
          },
        },
      ],
    });
    return {};
  }

  const { issue, priority, transitioned } = created;

  repo.recordIssueReport({
    issueKey: issue.key,
    slackUserId: input.slackUserId,
    ...(input.metadata.channelId ? { slackChannelId: input.metadata.channelId } : {}),
    intakeSource: source,
  });

  log.info(
    {
      issueKey: issue.key,
      priority,
      transitioned,
      source,
      realReporter: Boolean(config.JIRA_SET_REAL_REPORTER && who.jiraAccountId),
    },
    'bug filed',
  );

  const blocks = intakeConfirmationBlocks({
    issueKey: issue.key,
    issueUrl: issueUrl(config.JIRA_BASE_URL, issue.key),
    report,
    priority,
    reporterSlackId: input.slackUserId,
    transitioned,
    triageStatusName: config.JIRA_STATUS_TRIAGE,
  });

  // Where the confirmation goes: the channel /bug ran in, the thread the
  // shortcut was used on, or a DM when we have neither.
  const target = input.metadata.channelId ?? input.slackUserId;
  const posted = await notifier.post({
    channel: target,
    fallback: `${issue.key} filed: ${input.report.summary}`,
    blocks,
    ...(input.metadata.threadTs ? { threadTs: input.metadata.threadTs } : {}),
  });

  // The confirmation message is the thread root for attachment sync (Phase 2).
  // For the shortcut path the original message's thread is the root instead.
  if (posted.ok && posted.channel && posted.ts) {
    const threadTs = input.metadata.threadTs ?? posted.ts;
    repo.setThread(issue.key, posted.channel, threadTs);
    await linkBackToSlack(context, { issueKey: issue.key, report, channel: posted.channel, threadTs });
  }

  return { issueKey: issue.key };
}

/**
 * Add a link from the Jira issue back to the Slack thread.
 *
 * The thread only exists once the confirmation has been posted, so this is a
 * second pass over the description rather than part of the create call. It
 * matters because most reporters have no Jira account: without it, a developer
 * triaging the issue sees a name and has no way to reach the person.
 *
 * Best effort - the issue is already filed and correct, so a failure here is
 * logged and nothing more.
 */
async function linkBackToSlack(
  context: BugbotContext,
  input: { issueKey: string; report: BugReport; channel: string; threadTs: string },
): Promise<void> {
  const { log, notifier, issues } = context;

  try {
    const permalink = await notifier.permalink(input.channel, input.threadTs);
    if (!permalink) return;

    // renderDescription is deterministic, so re-rendering with one more field
    // is safe and idempotent.
    const { adf } = renderDescription({ ...input.report, slackThreadPermalink: permalink });
    await issues.setDescription(input.issueKey, adf);
  } catch (error) {
    log.warn(
      {
        issueKey: input.issueKey,
        err: error instanceof Error ? error.message : String(error),
      },
      'could not link the issue back to its Slack thread',
    );
  }
}

export function registerBugCommand(app: App, context: BugbotContext): void {
  app.command(COMMAND.bug, async ({ command, ack, client, respond }) => {
    await ack();

    if (!channelAllowed(context, command.channel_id)) {
      await respond({
        response_type: 'ephemeral',
        text:
          `\`/bug\` is limited to ${allowedChannelMentions(context)} so reports do not get lost. ` +
          'Please file it there.',
      });
      return;
    }

    const metadata: BugModalMetadata = {
      channelId: command.channel_id,
      source: 'slack_modal',
    };

    try {
      await client.views.open({
        trigger_id: command.trigger_id,
        view: buildBugModal({
          metadata,
          // Anything typed after /bug becomes the summary.
          ...(command.text?.trim() ? { prefill: { summary: command.text.trim().slice(0, 120) } } : {}),
        }),
      });
    } catch (error) {
      context.log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'could not open the bug modal',
      );
      await respond({
        response_type: 'ephemeral',
        text: 'I could not open the form. Try again in a moment.',
      });
    }
  });

  app.view(BUG_MODAL_CALLBACK_ID, async ({ ack, body, view }) => {
    const parsed = parseBugModalSubmission(view as unknown as SubmittedView);

    if (!parsed.ok) {
      // Field-level errors keep the modal open with what they typed intact.
      await ack({ response_action: 'errors', errors: parsed.errors });
      return;
    }

    // Ack first: Jira is far too slow for Slack's three second budget.
    await ack();

    try {
      await fileBug(context, {
        report: parsed.report,
        metadata: parsed.metadata,
        slackUserId: body.user.id,
      });
    } catch (error) {
      context.log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'unhandled failure while filing a bug',
      );
    }
  });
}
