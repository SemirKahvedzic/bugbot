/**
 * Attachment sync (SPEC 5, Phase 2).
 *
 * When someone posts a file in the confirmation thread of a bug we filed, the
 * file is downloaded with the bot token and attached to the Jira issue, then
 * the Slack message gets a check mark so the reporter can see it worked.
 *
 * Everything is keyed on the stored `slack_thread_ts`, so files posted anywhere
 * else are ignored before anything is downloaded or stored.
 */
import type { App } from '@slack/bolt';
import type { BugbotContext } from '../context.js';

/** Jira Cloud's default per-file limit is 10MB; leave headroom and be explicit. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
}

/**
 * Download a Slack-hosted file. Slack requires the bot token as a bearer
 * token; without it the CDN returns an HTML sign-in page rather than an error,
 * which is why the content type is checked.
 */
export async function downloadSlackFile(
  file: SlackFile,
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ data: Uint8Array; contentType: string } | { error: string }> {
  const url = file.url_private_download ?? file.url_private;
  if (!url) return { error: 'file has no download URL' };

  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${botToken}` } });
  if (!response.ok) return { error: `download failed with HTTP ${response.status}` };

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    return { error: 'Slack returned a sign-in page - the bot may lack files:read' };
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) return { error: 'downloaded file was empty' };

  return { data: new Uint8Array(buffer), contentType: contentType || 'application/octet-stream' };
}

export interface SyncFilesInput {
  channelId: string;
  threadTs: string;
  messageTs: string;
  files: SlackFile[];
}

/** Attach every file in a message to the issue that owns its thread. */
export async function syncThreadFiles(
  context: BugbotContext,
  input: SyncFilesInput,
): Promise<{ issueKey?: string; attached: number; skipped: number }> {
  const { repo, issues, notifier, log, config } = context;

  const report = repo.findByThread(input.channelId, input.threadTs);
  if (!report) return { attached: 0, skipped: 0 };

  const botToken = config.SLACK_BOT_TOKEN;
  if (!botToken) {
    log.warn('cannot download Slack files without SLACK_BOT_TOKEN');
    return { issueKey: report.issue_key, attached: 0, skipped: input.files.length };
  }

  let attached = 0;
  let skipped = 0;

  for (const file of input.files) {
    // A redelivered event must not attach the same file twice.
    if (!repo.claimNotification(`attach:${report.issue_key}:${file.id}`)) {
      log.debug({ issueKey: report.issue_key, fileId: file.id }, 'file already attached, skipping');
      continue;
    }

    const filename = file.name ?? file.title ?? `${file.id}`;

    if (file.size !== undefined && file.size > MAX_ATTACHMENT_BYTES) {
      skipped += 1;
      log.warn(
        { issueKey: report.issue_key, fileId: file.id, size: file.size },
        'file is too large for a Jira attachment',
      );
      await notifier.post({
        channel: input.channelId,
        threadTs: input.threadTs,
        fallback: `${filename} is too large to attach`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                `:warning: \`${filename}\` is larger than ` +
                `${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB, so I did not attach it to ` +
                `${report.issue_key}. Please link it instead.`,
            },
          },
        ],
      });
      continue;
    }

    const downloaded = await downloadSlackFile(file, botToken);
    if ('error' in downloaded) {
      skipped += 1;
      log.warn(
        { issueKey: report.issue_key, fileId: file.id, err: downloaded.error },
        'could not download a Slack file',
      );
      continue;
    }

    try {
      await issues.attach(report.issue_key, {
        filename,
        data: downloaded.data,
        contentType: file.mimetype ?? downloaded.contentType,
      });
      attached += 1;
      log.info({ issueKey: report.issue_key, filename }, 'attached a file to the issue');
    } catch (error) {
      skipped += 1;
      log.error(
        {
          issueKey: report.issue_key,
          fileId: file.id,
          err: error instanceof Error ? error.message : String(error),
        },
        'could not attach a file to Jira',
      );
    }
  }

  if (attached > 0) {
    await notifier.react({ channel: input.channelId, ts: input.messageTs, name: 'white_check_mark' });
  }

  return { issueKey: report.issue_key, attached, skipped };
}

export function registerFileSync(app: App, context: BugbotContext): void {
  app.event('message', async ({ event }) => {
    const message = event as {
      subtype?: string;
      channel?: string;
      ts?: string;
      thread_ts?: string;
      bot_id?: string;
      files?: SlackFile[];
    };

    // Only threaded file shares from humans are of any interest.
    if (message.bot_id) return;
    if (!message.files || message.files.length === 0) return;
    if (!message.channel || !message.ts || !message.thread_ts) return;

    try {
      await syncThreadFiles(context, {
        channelId: message.channel,
        threadTs: message.thread_ts,
        messageTs: message.ts,
        files: message.files,
      });
    } catch (error) {
      context.log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'attachment sync failed',
      );
    }
  });
}
