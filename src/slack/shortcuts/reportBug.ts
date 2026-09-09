/**
 * The "Report as bug" message shortcut (SPEC 5, Phase 2).
 *
 * Turns an existing Slack message into a bug report: the message text prefills
 * the summary and the steps, a permalink back to it is kept on the issue, and
 * the confirmation is posted as a reply in that message's thread - so the
 * conversation and the bug stay joined up.
 */
import type { App } from '@slack/bolt';
import { allowedChannelMentions, channelAllowed, type BugbotContext } from '../../context.js';
import { SHORTCUT } from '../actions.js';
import { buildBugModal, SUMMARY_MAX_LENGTH, type BugModalMetadata } from '../views/bugModal.js';

/** First line becomes the summary; the rest is a starting point for steps. */
export function prefillFromMessage(text: string | undefined): {
  summary?: string;
  steps?: string;
} {
  const clean = (text ?? '').trim();
  if (clean.length === 0) return {};

  const lines = clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const summary = lines[0]?.slice(0, SUMMARY_MAX_LENGTH);

  return {
    ...(summary ? { summary } : {}),
    // The reporter still has to turn this into real steps - but starting from
    // their own words beats starting from an empty box.
    steps: clean,
  };
}

export function registerReportBugShortcut(app: App, context: BugbotContext): void {
  app.shortcut(SHORTCUT.reportAsBug, async ({ shortcut, ack, client }) => {
    await ack();

    // Only message shortcuts carry a message; guard rather than cast blindly.
    if (shortcut.type !== 'message_action') {
      context.log.warn({ type: shortcut.type }, 'report_as_bug fired without a message');
      return;
    }

    const channelId = shortcut.channel?.id;
    const messageTs = shortcut.message_ts;

    if (!channelAllowed(context, channelId)) {
      await client.chat.postEphemeral({
        channel: channelId!,
        user: shortcut.user.id,
        text:
          `Reporting bugs is limited to ${allowedChannelMentions(context)} so they do not get ` +
          'lost. Please repost it there and try again.',
      });
      return;
    }

    const permalink = await context.notifier.permalink(channelId!, messageTs);

    // Reply in the message's existing thread if it has one, otherwise start a
    // thread on the message itself.
    const threadTs =
      (shortcut.message as { thread_ts?: string }).thread_ts ?? messageTs;

    const metadata: BugModalMetadata = {
      channelId: channelId!,
      threadTs,
      source: 'slack_shortcut',
      ...(permalink ? { permalink } : {}),
    };

    try {
      await client.views.open({
        trigger_id: shortcut.trigger_id,
        view: buildBugModal({
          metadata,
          prefill: prefillFromMessage((shortcut.message as { text?: string }).text),
        }),
      });
    } catch (error) {
      context.log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'could not open the bug modal from the shortcut',
      );
    }
  });
}
