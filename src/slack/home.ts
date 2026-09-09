/**
 * App Home (SPEC 8): the same view as `/mybugs`, always available, with a
 * refresh button. Better UX than the slash command, which is why both exist -
 * the command is what people reach for first.
 */
import type { App } from '@slack/bolt';
import { homeView } from '../format/slackBlocks.js';
import { keepAlive } from '../runtime.js';
import { ACTION } from './actions.js';
import { fetchMyBugs, MY_BUGS_LIMIT } from './commands/mybugs.js';
import { buildBugModal } from './views/bugModal.js';
import type { BugbotContext } from '../context.js';

export async function publishHomeFor(
  context: BugbotContext,
  slackUserId: string,
): Promise<boolean> {
  const { issues, jqlUrl } = await fetchMyBugs(context, slackUserId);
  return context.notifier.publishHome(
    slackUserId,
    homeView({
      baseUrl: context.config.JIRA_BASE_URL,
      issues,
      jqlUrl,
      limit: MY_BUGS_LIMIT,
    }),
  );
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
