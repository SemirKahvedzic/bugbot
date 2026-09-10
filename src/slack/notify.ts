/**
 * Every outbound Slack call, in one place (SPEC 10).
 *
 * Deduplication lives in the caller, against the `notifications` table - this
 * module just sends. Failures are logged and swallowed by default: a Slack
 * outage must not roll back a Jira issue that was already created.
 *
 * Message text is never logged (SPEC 11); only the destination and the outcome.
 */
import type { WebClient } from '@slack/web-api';
import type { AnyBlock, HomeView } from '@slack/types';
import type { Logger } from 'pino';

export interface PostResult {
  ok: boolean;
  channel?: string;
  ts?: string;
}

export class Notifier {
  constructor(
    private readonly slack: WebClient,
    private readonly log: Logger,
  ) {}

  /**
   * Post to a channel, optionally threaded.
   * `fallback` is the notification text shown in the sidebar and on mobile.
   */
  async post(input: {
    channel: string;
    fallback: string;
    blocks?: AnyBlock[];
    threadTs?: string;
    unfurl?: boolean;
  }): Promise<PostResult> {
    try {
      const response = await this.slack.chat.postMessage({
        channel: input.channel,
        text: input.fallback,
        ...(input.blocks ? { blocks: input.blocks } : {}),
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
        unfurl_links: input.unfurl ?? false,
        unfurl_media: input.unfurl ?? false,
      });
      return { ok: true, channel: response.channel, ts: response.ts };
    } catch (error) {
      this.log.error(
        { channel: input.channel, threaded: Boolean(input.threadTs), err: describe(error) },
        'Slack post failed',
      );
      return { ok: false };
    }
  }

  /** DM a user. `channel` may be a user id when the bot has im:write. */
  async dm(input: {
    userId: string;
    fallback: string;
    blocks?: AnyBlock[];
  }): Promise<PostResult> {
    return this.post({ channel: input.userId, fallback: input.fallback, blocks: input.blocks });
  }

  /**
   * Delete a message BugBot posted.
   *
   * `message_not_found` counts as success: somebody deleting the card by hand
   * leaves exactly the state this call was asking for. `cant_delete_message`
   * does not - that is a message we did not post, and the caller is told so it
   * can stop trying.
   */
  async deleteMessage(input: { channel: string; ts: string }): Promise<boolean> {
    try {
      await this.slack.chat.delete({ channel: input.channel, ts: input.ts });
      return true;
    } catch (error) {
      const message = describe(error);
      if (/message_not_found|channel_not_found/.test(message)) return true;
      this.log.warn({ channel: input.channel, err: message }, 'could not delete the message');
      return false;
    }
  }

  async react(input: { channel: string; ts: string; name: string }): Promise<boolean> {
    try {
      await this.slack.reactions.add({ channel: input.channel, timestamp: input.ts, name: input.name });
      return true;
    } catch (error) {
      // already_reacted is expected on a webhook redelivery.
      const message = describe(error);
      if (/already_reacted/.test(message)) return true;
      this.log.warn({ channel: input.channel, err: message }, 'could not add reaction');
      return false;
    }
  }

  async publishHome(userId: string, view: HomeView): Promise<boolean> {
    try {
      await this.slack.views.publish({ user_id: userId, view });
      return true;
    } catch (error) {
      this.log.error({ userId, err: describe(error) }, 'could not publish App Home');
      return false;
    }
  }

  /** Permalink to a message, used to link a Slack thread from Jira. */
  async permalink(channel: string, ts: string): Promise<string | undefined> {
    try {
      const response = await this.slack.chat.getPermalink({ channel, message_ts: ts });
      return response.permalink;
    } catch (error) {
      this.log.warn({ channel, err: describe(error) }, 'could not build permalink');
      return undefined;
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
