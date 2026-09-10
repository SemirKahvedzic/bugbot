/**
 * The bug feed: one card per new bug in a dedicated channel, whichever way the
 * bug arrived.
 *
 * Both intake paths call this - the Slack form and the `jira:issue_created`
 * webhook - so the channel shows the complete intake rather than only the half
 * that came through Slack. That is the visible half of the "single funnel" in
 * SPEC 1.
 *
 * Posting is claimed on `feed:<issueKey>`, so a redelivered webhook, or a bug
 * that somehow reaches both paths, still produces exactly one card.
 */
import { bugFeedBlocks, issueUrl } from '../format/slackBlocks.js';
import type { BugbotContext } from '../context.js';
import type { BugReport, IntakeSource } from '../types.js';

export interface BugFeedPost {
  issueKey: string;
  summary: string;
  source: IntakeSource;
  status?: string;
  priority?: string;
  labels?: string[];
  reporterSlackId?: string;
  reporterName?: string;
  /** Full detail, when the bug came through the form. */
  report?: BugReport;
  /**
   * Channel the confirmation already went to. When it is the feed channel,
   * the card is skipped rather than posting twice in the same place.
   */
  alreadyPostedIn?: string;
}

export async function postBugFeed(
  context: BugbotContext,
  input: BugFeedPost,
): Promise<boolean> {
  const { config, log, repo, notifier } = context;
  const channel = config.SLACK_BUG_FEED_CHANNEL;

  if (!channel) return false;

  if (input.alreadyPostedIn && input.alreadyPostedIn === channel) {
    log.debug(
      { issueKey: input.issueKey },
      'confirmation already went to the feed channel - not posting a second card',
    );
    return false;
  }

  if (!(await repo.claimNotification(`feed:${input.issueKey}`))) {
    log.debug({ issueKey: input.issueKey }, 'feed card already posted for this issue');
    return false;
  }

  const result = await notifier.post({
    channel,
    fallback: `${input.issueKey}: ${input.summary}`,
    blocks: bugFeedBlocks({
      issueKey: input.issueKey,
      issueUrl: issueUrl(config.JIRA_BASE_URL, input.issueKey),
      summary: input.summary,
      source: input.source,
      ...(input.status ? { status: input.status } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.labels ? { labels: input.labels } : {}),
      ...(input.reporterSlackId ? { reporterSlackId: input.reporterSlackId } : {}),
      ...(input.reporterName ? { reporterName: input.reporterName } : {}),
      ...(input.report ? { report: input.report } : {}),
    }),
  });

  if (result.ok) {
    log.info({ issueKey: input.issueKey, channel, source: input.source }, 'posted to the bug feed');

    // Remembered so that deleting the bug can take its card down as well.
    // Without this the feed keeps a card whose Jira link is dead.
    if (result.channel && result.ts) {
      await repo.setFeedMessage(input.issueKey, result.channel, result.ts);
    }
  }

  return result.ok;
}
