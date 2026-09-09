import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadSlackFile, MAX_ATTACHMENT_BYTES, syncThreadFiles } from '../src/slack/files.js';
import { fixtureIssue, makeTestContext, type TestHarness } from './helpers/context.js';

let harness: TestHarness;

beforeEach(() => {
  harness = makeTestContext({ SLACK_BOT_TOKEN: 'xoxb-test' });
  harness.issuesByKey.set('SUP-1', fixtureIssue({ key: 'SUP-1' }));
  harness.repo.recordIssueReport({
    issueKey: 'SUP-1',
    slackUserId: 'U_REPORTER',
    slackChannelId: 'C_BUGS',
    intakeSource: 'slack_modal',
  });
  harness.repo.setThread('SUP-1', 'C_BUGS', '111.222');
});

const png = { id: 'F1', name: 'screenshot.png', mimetype: 'image/png', size: 2048 };

/** A fetch that returns bytes for any URL. */
function okFetch(body = 'binary-bytes', contentType = 'image/png') {
  return vi.fn(async () =>
    new Response(body, { status: 200, headers: { 'content-type': contentType } }),
  ) as unknown as typeof fetch;
}

describe('downloadSlackFile', () => {
  it('sends the bot token as a bearer token', async () => {
    const fetchImpl = okFetch();
    const result = await downloadSlackFile(
      { ...png, url_private_download: 'https://files.slack.com/f1' },
      'xoxb-test',
      fetchImpl,
    );

    expect('data' in result).toBe(true);
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[0]).toBe('https://files.slack.com/f1');
    expect((call?.[1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer xoxb-test',
    });
  });

  it('detects the sign-in page Slack returns when the scope is missing', async () => {
    const result = await downloadSlackFile(
      { ...png, url_private_download: 'https://files.slack.com/f1' },
      'xoxb-test',
      okFetch('<html>sign in</html>', 'text/html; charset=utf-8'),
    );
    expect(result).toEqual({ error: expect.stringContaining('files:read') });
  });

  it('reports an HTTP failure rather than attaching nothing silently', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
    const result = await downloadSlackFile(
      { ...png, url_private_download: 'https://files.slack.com/f1' },
      'xoxb-test',
      fetchImpl,
    );
    expect(result).toEqual({ error: 'download failed with HTTP 403' });
  });

  it('rejects an empty download', async () => {
    const result = await downloadSlackFile(
      { ...png, url_private_download: 'https://files.slack.com/f1' },
      'xoxb-test',
      okFetch(''),
    );
    expect(result).toEqual({ error: 'downloaded file was empty' });
  });

  it('falls back to url_private and complains when there is no URL at all', async () => {
    const fetchImpl = okFetch();
    await downloadSlackFile({ ...png, url_private: 'https://files.slack.com/p1' }, 't', fetchImpl);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      'https://files.slack.com/p1',
    );

    expect(await downloadSlackFile({ id: 'F2' }, 't', fetchImpl)).toEqual({
      error: 'file has no download URL',
    });
  });
});

describe('syncThreadFiles (SPEC 5, Phase 2)', () => {
  it('ignores files posted in a thread we do not own', async () => {
    const result = await syncThreadFiles(harness.context, {
      channelId: 'C_RANDOM',
      threadTs: '999.999',
      messageTs: '999.999',
      files: [png],
    });

    expect(result).toEqual({ attached: 0, skipped: 0 });
    expect(harness.jiraCalls).toHaveLength(0);
    // Nothing was even claimed, so a later real thread is unaffected.
    expect(harness.repo.claimNotification('attach:SUP-1:F1')).toBe(true);
  });

  it('refuses a file larger than Jira will take, and says so in the thread', async () => {
    const result = await syncThreadFiles(harness.context, {
      channelId: 'C_BUGS',
      threadTs: '111.222',
      messageTs: '111.333',
      files: [{ ...png, size: MAX_ATTACHMENT_BYTES + 1 }],
    });

    expect(result.attached).toBe(0);
    expect(result.skipped).toBe(1);
    expect(harness.jiraCalls.some((call) => call.op === 'attach')).toBe(false);

    const warning = harness.posts.find((post) => post.target === 'C_BUGS');
    expect(warning?.threadTs).toBe('111.222');
    expect(warning?.text).toMatch(/too large/i);
    expect(warning?.text).toContain('SUP-1');
  });

  it('claims each file once, so a redelivered event does not attach twice', async () => {
    expect(harness.repo.claimNotification('attach:SUP-1:F1')).toBe(true);

    // The claim is already taken, as it would be on a redelivery.
    const result = await syncThreadFiles(harness.context, {
      channelId: 'C_BUGS',
      threadTs: '111.222',
      messageTs: '111.333',
      files: [png],
    });

    expect(result.attached).toBe(0);
    expect(harness.jiraCalls.some((call) => call.op === 'attach')).toBe(false);
  });

  it('does nothing without a bot token instead of throwing', async () => {
    const noToken = makeTestContext();
    noToken.repo.recordIssueReport({
      issueKey: 'SUP-1',
      slackChannelId: 'C_BUGS',
      intakeSource: 'slack_modal',
    });
    noToken.repo.setThread('SUP-1', 'C_BUGS', '111.222');

    const result = await syncThreadFiles(noToken.context, {
      channelId: 'C_BUGS',
      threadTs: '111.222',
      messageTs: '111.333',
      files: [png],
    });

    expect(result).toEqual({ issueKey: 'SUP-1', attached: 0, skipped: 1 });
  });
});
