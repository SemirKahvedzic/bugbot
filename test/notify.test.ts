import { describe, expect, it } from 'vitest';
import type { WebClient } from '@slack/web-api';
import type { AnyBlock } from '@slack/types';
import { Notifier } from '../src/slack/notify.js';

/** A WebClient that records the one call the Notifier makes. */
function fakeSlack() {
  const calls: Array<Record<string, unknown>> = [];
  const slack = {
    chat: {
      async postMessage(args: Record<string, unknown>) {
        calls.push(args);
        return { ok: true, channel: args['channel'], ts: '1.2' };
      },
    },
  } as unknown as WebClient;
  return { slack, calls };
}

const quiet = { error: () => undefined, warn: () => undefined } as unknown as ConstructorParameters<
  typeof Notifier
>[1];

const blocks: AnyBlock[] = [{ type: 'section', text: { type: 'mrkdwn', text: 'hi' } }];

describe('Notifier.post', () => {
  it('posts blocks on the message itself, with the fallback as text', async () => {
    const { slack, calls } = fakeSlack();
    await new Notifier(slack, quiet).post({ channel: 'C1', fallback: 'fb', blocks });

    expect(calls[0]).toMatchObject({ channel: 'C1', text: 'fb', blocks });
    expect(calls[0]).not.toHaveProperty('attachments');
  });

  it('wraps the blocks in one coloured attachment when given a colour', async () => {
    const { slack, calls } = fakeSlack();
    await new Notifier(slack, quiet).post({
      channel: 'C1',
      fallback: 'fb',
      blocks,
      color: '#E01E5A',
    });

    expect(calls[0]).toMatchObject({
      channel: 'C1',
      attachments: [{ color: '#E01E5A', fallback: 'fb', blocks }],
    });
    // No top-level text: with attachments and no blocks Slack would render it
    // as a line above the card. The attachment's fallback is the notification.
    expect(calls[0]).not.toHaveProperty('text');
    expect(calls[0]).not.toHaveProperty('blocks');
  });

  it('ignores the colour when there are no blocks to put in the attachment', async () => {
    const { slack, calls } = fakeSlack();
    await new Notifier(slack, quiet).post({ channel: 'C1', fallback: 'fb', color: '#E01E5A' });

    expect(calls[0]).toMatchObject({ text: 'fb' });
    expect(calls[0]).not.toHaveProperty('attachments');
  });
});
