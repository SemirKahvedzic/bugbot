/**
 * App Home (SPEC 8): the same view as `/mybugs`, always available, with a
 * refresh button. Better UX than the slash command, which is why both exist -
 * the command is what people reach for first.
 *
 * A triager gets two things more on each card: a "Move to..." menu, which
 * transitions the issue in Jira, and a Delete button, which removes it from
 * Jira and from Slack for good. That makes a bug workable - and disposable -
 * from Slack without opening Jira, which is the point. Everyone else sees
 * exactly what they saw before.
 */
import type { App } from '@slack/bolt';
import { homeView, issueUrl } from '../format/slackBlocks.js';
import { JiraError } from '../jira/client.js';
import { keepAlive } from '../runtime.js';
import { moveIssue } from '../triage/move.js';
import { deleteBug } from '../triage/remove.js';
import { ACTION, parseMoveValue } from './actions.js';
import { fetchMyBugs, MY_BUGS_LIMIT } from './commands/mybugs.js';
import { mayTriage, refusalMessage, triagers } from './commands/triage.js';
import { buildBugModal } from './views/bugModal.js';
import type { BugbotContext } from '../context.js';

export async function publishHomeFor(
  context: BugbotContext,
  slackUserId: string,
): Promise<boolean> {
  const mine = await fetchMyBugs(context, slackUserId);

  return context.notifier.publishHome(
    slackUserId,
    homeView({
      baseUrl: context.config.JIRA_BASE_URL,
      issues: mine.issues,
      jqlUrl: mine.jqlUrl,
      limit: MY_BUGS_LIMIT,
      // In the board's own column order, read from the board configuration at
      // boot - so the menu reads left to right the way the board does. Only
      // for a triager: a control that changes Jira state for the whole team
      // does not belong on a reporter's card.
      ...(mayTriage(context, slackUserId)
        ? { moveTargets: context.meta.statusNamesInBoardOrder(), allowDelete: true }
        : {}),
    }),
  );
}

/**
 * Do the move, then say something only if it did not work.
 *
 * A successful move needs no message: republishing App Home shows the card in
 * its new column, which is the feedback. Anything else has to be a DM, because
 * a block action inside App Home carries no response_url to reply through.
 */
async function runMove(
  context: BugbotContext,
  input: { issueKey: string; statusName: string; actorSlackId: string },
): Promise<void> {
  const url = issueUrl(context.config.JIRA_BASE_URL, input.issueKey);
  let note: string | undefined;

  try {
    const result = await moveIssue(context, {
      issueKey: input.issueKey,
      targetStatus: input.statusName,
      actorSlackId: input.actorSlackId,
    });

    if (result.outcome === 'refused_by_workflow') {
      note =
        `:warning: <${url}|${input.issueKey}> could not go to *${input.statusName}*.\n` +
        (result.available.length > 0
          ? `From *${result.from ?? 'where it is'}* the workflow only allows: ` +
            `${result.available.join(', ')}.`
          : 'The workflow offers no moves from where it is at all.');
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    context.log.error(
      { issueKey: input.issueKey, to: input.statusName, err: detail },
      'could not move the issue from App Home',
    );
    note = `:x: <${url}|${input.issueKey}>: ${detail}`;
  }

  if (note) {
    await context.notifier.dm({
      userId: input.actorSlackId,
      fallback: `BugBot could not move ${input.issueKey}`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: note } }],
    });
  }

  await publishHomeFor(context, input.actorSlackId);
}

/**
 * Do the delete, then say something only if it did not work.
 *
 * A success needs no message here either: the card is gone from the
 * republished App Home, the feed card has gone with it, and the reporter has
 * been told directly - which is the only notification a deletion owes anyone.
 */
async function runDelete(
  context: BugbotContext,
  input: { issueKey: string; actorSlackId: string },
): Promise<void> {
  const url = issueUrl(context.config.JIRA_BASE_URL, input.issueKey);
  let note: string | undefined;
  let fallback = `BugBot could not delete ${input.issueKey}`;

  try {
    const result = await deleteBug(context, input);

    if (result.outcome === 'already_gone') {
      fallback = `${input.issueKey} was already gone`;
      note =
        `:information_source: *${input.issueKey}* was not in Jira any more - somebody deleted ` +
        'it there first. Everything it left behind in Slack is cleaned up.';
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    context.log.error(
      { issueKey: input.issueKey, err: detail },
      'could not delete the issue from App Home',
    );

    note =
      `:x: <${url}|${input.issueKey}> is still there: ${detail}` +
      // Worth spelling out, because it is the one failure that is neither a
      // bug nor transient: deleting is a separate Jira project permission and
      // the service account is routinely granted everything but that.
      (error instanceof JiraError && error.status === 403
        ? '\n\nThat is Jira refusing the service account. Deleting needs the *Delete issues* ' +
          'project permission, which has to be granted in Jira - the bot cannot grant it to ' +
          'itself. Until then, move the bug to *Rejected* or *Duplicate* instead.'
        : '');
  }

  if (note) {
    await context.notifier.dm({
      userId: input.actorSlackId,
      fallback,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: note } }],
    });
  }

  await publishHomeFor(context, input.actorSlackId);
}

/**
 * The triager gate both controls on a card share.
 *
 * They are only rendered for a triager, so a click that gets here comes from
 * an App Home view left over from before someone was removed - or from a
 * crafted payload. Either way the answer is the one `/triage` already gives,
 * which says who is allowed and which Slack id it thinks you are.
 */
function refuseUnlessTriager(
  context: BugbotContext,
  input: { actorSlackId: string; issueKey: string; what: string },
): boolean {
  if (mayTriage(context, input.actorSlackId)) return true;

  context.log.info(
    {
      slackUserId: input.actorSlackId,
      issueKey: input.issueKey,
      what: input.what,
      allowed: triagers(context),
    },
    'refused - the caller is not a configured triager',
  );

  keepAlive(
    context.notifier.dm({
      userId: input.actorSlackId,
      fallback: `${input.what} bugs is for QA`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: refusalMessage(context, input.actorSlackId) },
        },
      ],
    }),
    'refused',
  );

  return false;
}

export function registerHome(app: App, context: BugbotContext): void {
  app.event('app_home_opened', async ({ event }) => {
    // Slack also fires this for the messages tab; only the home tab needs a view.
    if (event.tab !== 'home') return;
    keepAlive(publishHomeFor(context, event.user), 'publishHome');
  });

  app.action(ACTION.homeRefresh, async ({ ack, body }) => {
    await ack();
    keepAlive(publishHomeFor(context, body.user.id), 'homeRefresh');
  });

  // A URL button still produces an interaction. Acknowledging it is all that
  // is needed; without this, every "Open" click logs an unhandled request.
  app.action(ACTION.openIssue, async ({ ack }) => {
    await ack();
  });

  app.action(ACTION.moveIssue, async ({ ack, body, action }) => {
    await ack();

    const value = (action as { selected_option?: { value?: string } }).selected_option?.value;
    const parsed = value ? parseMoveValue(value) : undefined;
    if (!parsed) {
      context.log.warn({ value }, 'the move menu sent no usable option');
      return;
    }

    const actorSlackId = body.user.id;

    if (!refuseUnlessTriager(context, { actorSlackId, issueKey: parsed.issueKey, what: 'Moving' })) {
      return;
    }

    keepAlive(runMove(context, { ...parsed, actorSlackId }), `moveIssue:${parsed.issueKey}`);
  });

  app.action(ACTION.deleteIssue, async ({ ack, body, action }) => {
    await ack();

    // Slack has already shown the confirm dialog the card attaches, so a click
    // that arrives here is a decision somebody made twice.
    const issueKey = (action as { value?: string }).value;
    if (!issueKey) {
      context.log.warn('the delete button sent no issue key');
      return;
    }

    const actorSlackId = body.user.id;

    if (!refuseUnlessTriager(context, { actorSlackId, issueKey, what: 'Deleting' })) return;

    keepAlive(runDelete(context, { issueKey, actorSlackId }), `deleteIssue:${issueKey}`);
  });

  app.action(ACTION.homeFileBug, async ({ ack, body, client }) => {
    await ack();
    const triggerId = (body as { trigger_id?: string }).trigger_id;
    if (!triggerId) return;

    try {
      await client.views.open({
        trigger_id: triggerId,
        // Opened from Home, so there is no channel - the confirmation is DM'd
        // and the announce channel is where the team sees it.
        view: buildBugModal({ metadata: { source: 'slack_modal' } }),
      });
    } catch (error) {
      context.log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'could not open the bug modal from App Home',
      );
    }
  });
}
