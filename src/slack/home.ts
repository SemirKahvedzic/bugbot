/**
 * App Home (SPEC 8): the same view as `/mybugs`, always available, with a
 * refresh button. Better UX than the slash command, which is why both exist -
 * the command is what people reach for first.
 *
 * A triager gets two things more: every open bug on the board, and a
 * "Move to..." menu on each card that transitions the issue in Jira. That
 * makes the board workable from Slack without opening Jira, which is the
 * point. Everyone else sees exactly what they saw before.
 */
import type { App } from '@slack/bolt';
import {
  homeView,
  issueUrl,
  HOME_MAX_BOARD_CARDS,
  type IssueSummaryLine,
} from '../format/slackBlocks.js';
import { keepAlive } from '../runtime.js';
import { moveIssue } from '../triage/move.js';
import { ACTION, parseMoveValue } from './actions.js';
import { fetchMyBugs, jqlUrl, MY_BUGS_LIMIT, toSummaryLine } from './commands/mybugs.js';
import { mayTriage, refusalMessage, triagers } from './commands/triage.js';
import { buildBugModal } from './views/bugModal.js';
import type { BugbotContext } from '../context.js';

interface BoardBugs {
  issues: IssueSummaryLine[];
  jqlUrl: string;
}

/**
 * Every open bug on the board, for a triager's App Home.
 *
 * `statusCategory != Done` rather than a list of status names: Done, Rejected,
 * Duplicate and Cannot Reproduce all sit in Jira's Done category, so this
 * means "still open" without naming a status that a workflow edit could
 * rename underneath it.
 *
 * Returns undefined when Jira cannot be read, so the section is left out
 * altogether - an empty list would render as "nothing open on the board",
 * which would be a lie.
 */
async function fetchBoardBugs(context: BugbotContext): Promise<BoardBugs | undefined> {
  const { config, issues, log } = context;
  const jql =
    `project = ${config.JIRA_PROJECT_KEY} AND statusCategory != Done ORDER BY created ASC`;

  try {
    const found = await issues.search(jql, { maxResults: HOME_MAX_BOARD_CARDS });
    return { issues: found.map(toSummaryLine), jqlUrl: jqlUrl(config.JIRA_BASE_URL, jql) };
  } catch (error) {
    log.error(
      { err: error instanceof Error ? error.message : String(error) },
      'could not read the board for App Home',
    );
    return undefined;
  }
}

export async function publishHomeFor(
  context: BugbotContext,
  slackUserId: string,
): Promise<boolean> {
  const isTriager = mayTriage(context, slackUserId);

  const [mine, board] = await Promise.all([
    fetchMyBugs(context, slackUserId),
    isTriager ? fetchBoardBugs(context) : undefined,
  ]);

  return context.notifier.publishHome(
    slackUserId,
    homeView({
      baseUrl: context.config.JIRA_BASE_URL,
      issues: mine.issues,
      jqlUrl: mine.jqlUrl,
      limit: MY_BUGS_LIMIT,
      ...(board ? { boardIssues: board.issues, boardJqlUrl: board.jqlUrl } : {}),
      // The menu comes from the live workflow, so it offers exactly the columns
      // the board has and cannot drift out of date. Given even when the board
      // read failed, so a triager's own cards stay movable.
      ...(isTriager ? { moveTargets: context.meta.statusNames() } : {}),
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

    if (!mayTriage(context, actorSlackId)) {
      // The menu is only rendered for triagers, so getting here means an App
      // Home view left over from before someone was removed - or a crafted
      // payload. Either way the answer is the one /triage already gives.
      context.log.info(
        { slackUserId: actorSlackId, issueKey: parsed.issueKey, allowed: triagers(context) },
        'move refused - the caller is not a configured triager',
      );
      keepAlive(
        context.notifier.dm({
          userId: actorSlackId,
          fallback: 'Moving bugs is for QA',
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: refusalMessage(context, actorSlackId) },
            },
          ],
        }),
        'moveRefused',
      );
      return;
    }

    keepAlive(runMove(context, { ...parsed, actorSlackId }), `moveIssue:${parsed.issueKey}`);
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
