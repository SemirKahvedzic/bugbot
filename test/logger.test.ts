import { describe, expect, it } from 'vitest';
import { createLogger, REDACT_CENSOR } from '../src/logger.js';

/** Collect what pino actually writes, so we can assert on the raw line. */
function capture(): { lines: string[]; stream: { write(chunk: string): void } } {
  const lines: string[] = [];
  return {
    lines,
    stream: {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
  };
}

const SECRET = 'ATATT-super-secret-token-value';
const EMAIL = 'semir.kahvedzic@roarington.com';

describe('logger redaction (SPEC 11)', () => {
  it('redacts credentials and emails at the top level', () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: 'info', destination: stream });

    log.info({ token: SECRET, email: EMAIL, password: 'hunter2' }, 'attempted leak');

    const output = lines.join('');
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain(EMAIL);
    expect(output).not.toContain('hunter2');
    expect(output).toContain(REDACT_CENSOR);
    expect(output).toContain('attempted leak');
  });

  it('redacts one level deep, which is the shape we actually log', () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: 'info', destination: stream });

    log.info(
      {
        user: { accountId: '712020:abc', emailAddress: EMAIL, displayName: 'Semir' },
        req: { headers: { authorization: `Basic ${SECRET}` } },
      },
      'webhook received',
    );

    const output = lines.join('');
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain(EMAIL);
    // Non-sensitive context survives, otherwise the logs are useless.
    expect(output).toContain('712020:abc');
    expect(output).toContain('Semir');
  });

  it('redacts DM and comment bodies', () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: 'info', destination: stream });

    log.info({ channel: 'D123', text: 'private message content' }, 'dm sent');

    const output = lines.join('');
    expect(output).not.toContain('private message content');
    expect(output).toContain('D123');
  });

  it('redacts a whole config object if one is ever logged', () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: 'info', destination: stream });

    log.info(
      { config: { JIRA_API_TOKEN: SECRET, SLACK_BOT_TOKEN: 'xoxb-leak', JIRA_PROJECT_KEY: 'SUP' } },
      'boot config',
    );

    const output = lines.join('');
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain('xoxb-leak');
    expect(output).toContain('SUP');
  });
});
