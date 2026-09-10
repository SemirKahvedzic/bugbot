/**
 * Deleting a bug outright, from an App Home card.
 *
 * The one irreversible thing BugBot can do, so it is deliberately narrow: a
 * triager clicks Delete, confirms the dialog Slack puts in front of them, and
 * the issue goes from Jira along with every trace of it BugBot left in Slack.
 * Nothing here decides *whether* a bug should be deleted - that is the
 * triager's call and the confirm dialog is where it is made.
 *
 * "Every trace" is the part worth being careful about. Deleting only the Jira
 * issue would leave a feed card and a confirmation thread whose links 404,
 * which is worse than not deleting at all: the bug looks like it exists and
 * cannot be opened. So the card, the confirmation and the `issue_reports` row
 * go too - the last one because `/mybugs` builds `issuekey IN (...)` from it
 * and Jira rejects the whole query over one key that no longer exists.
 *
 * The `triage_events` rows stay. They are the audit trail of what was decided,
 * and a deletion is a decision like any other.
 */
import { JiraError } from '../jira/client.js';
import { escape } from '../format/slackBlocks.js';
import type { BugbotContext } from '../context.js';

export interface DeleteBugInput {
  issueKey: string;
  /** Who clicked, so the reporter is not told about their own click. */
  actorSlackId: string;
}

export type DeleteBugResult = {
  /** 'already_gone' means Jira had no such issue - the Slack side is still cleaned. */
  outcome: 'deleted' | 'already_gone';
  /** The summary, when Jira still had the issue to read it from. */
  summary?: string;
  /** Which Slack traces were taken down: 'feed', 'confirmation'. */
  removedFromSlack: string[];
  notifiedReporter: boolean;
};

export async function deleteBug(
  context: BugbotContext,
  input: DeleteBugInput,
): Promise<DeleteBugResult> {
  const { log, repo, issues, notifier, serviceAccount } = context;
  const { issueKey } = input;

  // Read before anything is deleted: this row carries the Slack traces and the
  // reporter, and it is one of the things about to go.
  const report = await repo.getIssueReport(issueKey);
  const issue = await describeIssue(context, issueKey);

  let outcome: DeleteBugResult['outcome'] = 'deleted';
  try {
    await issues.deleteIssue(issueKey);
  } catch (error) {
    if (!(error instanceof JiraError) || !error.isNotFound) {
      // A 403 - the service account without "Delete issues" in the project -
      // arrives here. The issue still exists, so nothing in Slack may be
      // cleaned up: the caller reports the failure instead.
      throw error;
    }
    outcome = 'already_gone';
    log.info({ issueKey }, 'nothing to delete in Jira - cleaning up the Slack side anyway');
  }

  if (outcome === 'deleted') {
    await repo.recordTriageEvent({
      issueKey,
      ...(issue?.status ? { fromStatus: issue.status } : {}),
      ...(issue?.priority ? { priority: issue.priority } : {}),
      // No toStatus: there is no status to be in any more.
      routedTo: 'deleted',
      ...(serviceAccount?.accountId ? { actorAccountId: serviceAccount.accountId } : {}),
    });
  }

  const removedFromSlack: string[] = [];

  if (report?.feed_channel_id && report.feed_ts) {
    if (await notifier.deleteMessage({ channel: report.feed_channel_id, ts: report.feed_ts })) {
      removedFromSlack.push('feed');
    }
  }

  // Only the confirmation BugBot posted itself. On the shortcut path the
  // recorded thread root is the *human's* message - Slack would refuse to
  // delete it, and it is not ours to delete.
  if (
    report?.slack_channel_id &&
    report.slack_thread_ts &&
    report.intake_source !== 'slack_shortcut'
  ) {
    if (
      await notifier.deleteMessage({
        channel: report.slack_channel_id,
        ts: report.slack_thread_ts,
      })
    ) {
      // Slack takes the thread's replies with the message they hang off, so
      // the screenshots posted under it go as well.
      removedFromSlack.push('confirmation');
    }
  }

  await repo.deleteIssueReport(issueKey);

  const notifiedReporter =
    outcome === 'deleted' ? await tellReporterItIsGone(context, { ...input, report, issue }) : false;

  log.info(
    {
      issueKey,
      outcome,
      actor: input.actorSlackId,
      removedFromSlack,
      notifiedReporter,
    },
    'bug deleted',
  );

  return {
    outcome,
    ...(issue?.summary ? { summary: issue.summary } : {}),
    removedFromSlack,
    notifiedReporter,
  };
}

/**
 * The summary, status and priority, for the audit row and the DM.
 *
 * Best effort on purpose: this is decoration, and a Jira read that fails must
 * not stop a delete the triager has already confirmed. A 404 here is also the
 * ordinary shape of "somebody deleted it in Jira first".
 */
async function describeIssue(
  context: BugbotContext,
  issueKey: string,
): Promise<{ summary?: string; status?: string; priority?: string } | undefined> {
  try {
    const issue = await context.issues.getIssue(issueKey);
    return {
      ...(issue.fields.summary ? { summary: issue.fields.summary } : {}),
      ...(issue.fields.status?.name ? { status: issue.fields.status.name } : {}),
      ...(issue.fields.priority?.name ? { priority: issue.fields.priority.name } : {}),
    };
  } catch (error) {
    context.log.info(
      { issueKey, err: error instanceof Error ? error.message : String(error) },
      'could not read the issue before deleting it',
    );
    return undefined;
  }
}

/**
 * Tell the reporter their bug is gone.
 *
 * A DM rather than a reply in the bug thread, which is where every other
 * notification goes: that thread has just been deleted. Without this the card
 * simply vanishes from their App Home and nobody ever says why - the one
 * outcome guaranteed to make people stop trusting the bot.
 */
async function tellReporterItIsGone(
  context: BugbotContext,
  input: {
    issueKey: string;
    actorSlackId: string;
    report?: { slack_user_id: string | null } | undefined;
    issue?: { summary?: string } | undefined;
  },
): Promise<boolean> {
  const { repo, notifier, identity, log } = context;
  const reporter = input.report?.slack_user_id;

  // Nobody to tell, or telling somebody what they themselves just clicked.
  if (!reporter || reporter === input.actorSlackId) return false;

  // Keyed on the issue: it can only be deleted once, so this is belt and
  // braces against a double click getting past the confirm dialog.
  if (!(await repo.claimNotification(`deleted:${input.issueKey}`))) return false;

  const summary = input.issue?.summary ? ` — ${escape(input.issue.summary)}` : '';
  const who = await identity.displayName(input.actorSlackId).catch(() => undefined);

  const result = await notifier.dm({
    userId: reporter,
    fallback: `${input.issueKey} was deleted`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `:wastebasket: Your bug *${input.issueKey}*${summary} has been deleted` +
            `${who ? ` by ${escape(who)}` : ''}, in Jira and here.\n` +
            'Nothing is left to open. If that was not meant to happen, file it again with ' +
            '`/bug` and say so in the report.',
        },
      },
    ],
  });

  if (!result.ok) {
    log.warn({ issueKey: input.issueKey }, 'could not tell the reporter their bug was deleted');
  }

  return result.ok;
}
