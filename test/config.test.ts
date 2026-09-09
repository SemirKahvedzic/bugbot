import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ConfigError,
  formatConfigError,
  hasSlackConfig,
  loadConfig,
  MissingSlackConfigError,
  requireSlack,
  withoutBlanks,
} from '../src/config.js';

/** The smallest env that should boot: the Jira block plus Slack identifiers. */
const baseEnv = {
  DATABASE_URL: 'postgresql://user:pass@host.neon.tech/neondb?sslmode=require',
  JIRA_BASE_URL: 'https://roarington.atlassian.net',
  JIRA_CLOUD_ID: '57de5553-0941-4346-821f-c46f7dde06cc',
  JIRA_EMAIL: 'bugbot@roarington.com',
  JIRA_API_TOKEN: 'test-token',
  JIRA_BOARD_ID: '468',
  SLACK_DEFAULT_TRIAGER: 'U08HVG0H2EL',
  SLACK_ANNOUNCE_CHANNEL: 'C0AU6L9FPME',
  SLACK_DEV_CHANNEL: 'C0AT37C7PFY',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const config = loadConfig({ ...baseEnv });
    expect(config.DATABASE_POOL_MAX).toBe(5);
    expect(config.JIRA_PROJECT_KEY).toBe('SUP');
    expect(config.JIRA_ISSUE_TYPE).toBe('Finding');
    expect(config.JIRA_STATUS_TRIAGE).toBe('Under Triage');
    expect(config.JIRA_STATUS_BACKLOG).toBe('To Do');
    expect(config.JIRA_SET_REAL_REPORTER).toBe(true);
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.ESCALATION_MENTION).toBe('none');
  });

  it('coerces numeric and boolean env strings', () => {
    const config = loadConfig({
      ...baseEnv,
      JIRA_BOARD_ID: '468',
      PORT: '8080',
      JIRA_SET_REAL_REPORTER: 'false',
      SLACK_SOCKET_MODE: 'true',
    });
    expect(config.JIRA_BOARD_ID).toBe(468);
    expect(config.PORT).toBe(8080);
    expect(config.JIRA_SET_REAL_REPORTER).toBe(false);
    expect(config.SLACK_SOCKET_MODE).toBe(true);
  });

  it('splits the channel allowlist into ids', () => {
    const config = loadConfig({
      ...baseEnv,
      SLACK_BUG_CHANNEL_ALLOWLIST: 'C0AU6L9FPME, C0AT37C7PFY ,',
    });
    expect(config.SLACK_BUG_CHANNEL_ALLOWLIST).toEqual(['C0AU6L9FPME', 'C0AT37C7PFY']);
  });

  it('treats an empty allowlist as "allow anywhere"', () => {
    const config = loadConfig({ ...baseEnv, SLACK_BUG_CHANNEL_ALLOWLIST: '' });
    expect(config.SLACK_BUG_CHANNEL_ALLOWLIST).toEqual([]);
  });

  it('rejects a missing database URL - there is nowhere to record anything', () => {
    const env = { ...baseEnv } as Record<string, string | undefined>;
    delete env.DATABASE_URL;
    expect(() => loadConfig(env)).toThrow(z.ZodError);
  });

  it('rejects a missing API token', () => {
    const env = { ...baseEnv } as Record<string, string | undefined>;
    delete env.JIRA_API_TOKEN;
    expect(() => loadConfig(env)).toThrow(z.ZodError);
  });

  it('rejects a base URL that is not a URL', () => {
    expect(() => loadConfig({ ...baseEnv, JIRA_BASE_URL: 'roarington.atlassian.net' })).toThrow(
      z.ZodError,
    );
  });

  it('rejects a cloud id that is not a uuid', () => {
    expect(() => loadConfig({ ...baseEnv, JIRA_CLOUD_ID: 'not-a-uuid' })).toThrow(z.ZodError);
  });

  it('strips a trailing slash from the base URL so path joins stay predictable', () => {
    const config = loadConfig({
      ...baseEnv,
      JIRA_BASE_URL: 'https://roarington.atlassian.net/',
    });
    expect(config.JIRA_BASE_URL).toBe('https://roarington.atlassian.net');
  });

  it('rejects a webhook secret that is too short to be worth having', () => {
    expect(() => loadConfig({ ...baseEnv, JIRA_WEBHOOK_SECRET: 'short' })).toThrow(z.ZodError);
  });
});

describe('blank values are treated as absent', () => {
  /**
   * The first Vercel deployment imported all thirty keys from .env.example
   * with empty values. A zod .default() only fires on undefined, so every
   * default was defeated at once and the function failed to boot.
   */
  it('lets defaults apply when a variable is present but empty', () => {
    const config = loadConfig({
      ...baseEnv,
      JIRA_PROJECT_KEY: '',
      JIRA_ISSUE_TYPE: '',
      JIRA_STATUS_TRIAGE: '',
      JIRA_SET_REAL_REPORTER: '',
      ESCALATION_MENTION: '',
      DATABASE_POOL_MAX: '',
      LOG_LEVEL: '',
    });

    expect(config.JIRA_PROJECT_KEY).toBe('SUP');
    expect(config.JIRA_ISSUE_TYPE).toBe('Finding');
    expect(config.JIRA_STATUS_TRIAGE).toBe('Under Triage');
    expect(config.JIRA_SET_REAL_REPORTER).toBe(true);
    expect(config.ESCALATION_MENTION).toBe('none');
    expect(config.DATABASE_POOL_MAX).toBe(5);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('treats an empty optional credential as absent, not as a bad value', () => {
    const config = loadConfig({
      ...baseEnv,
      SLACK_BOT_TOKEN: '',
      SLACK_SIGNING_SECRET: '',
      SLACK_APP_TOKEN: '',
      JIRA_WEBHOOK_SECRET: '',
    });

    expect(config.SLACK_BOT_TOKEN).toBeUndefined();
    expect(config.JIRA_WEBHOOK_SECRET).toBeUndefined();
    expect(hasSlackConfig(config)).toBe(false);
  });

  it('treats whitespace as empty too', () => {
    const config = loadConfig({ ...baseEnv, JIRA_PROJECT_KEY: '   ' });
    expect(config.JIRA_PROJECT_KEY).toBe('SUP');
  });

  it('still rejects a required variable that is empty', () => {
    // Blank is absent, and absent is still fatal for these.
    expect(() => loadConfig({ ...baseEnv, DATABASE_URL: '' })).toThrow(z.ZodError);
    expect(() => loadConfig({ ...baseEnv, JIRA_API_TOKEN: '' })).toThrow(z.ZodError);
  });

  it('does not strip a legitimately meaningful value', () => {
    const config = loadConfig({ ...baseEnv, JIRA_PROJECT_KEY: 'SOFT', LOG_LEVEL: 'debug' });
    expect(config.JIRA_PROJECT_KEY).toBe('SOFT');
    expect(config.LOG_LEVEL).toBe('debug');
  });
});

describe('withoutBlanks', () => {
  it('drops blank keys and keeps everything else', () => {
    expect(withoutBlanks({ a: 'x', b: '', c: '  ', d: 'y' })).toEqual({ a: 'x', d: 'y' });
  });

  it('leaves the original object alone', () => {
    const env = { a: '', b: 'x' };
    withoutBlanks(env);
    expect(env).toEqual({ a: '', b: 'x' });
  });
});

describe('getConfig', () => {
  it('throws a ConfigError listing every fault, rather than exiting', () => {
    // process.exit in a serverless function surfaces only as
    // FUNCTION_INVOCATION_FAILED, with the reason buried in the logs.
    const error = new z.ZodError([
      { code: 'custom', path: ['DATABASE_URL'], message: 'Required' },
      { code: 'custom', path: ['JIRA_API_TOKEN'], message: 'Required' },
    ]);
    const configError = new ConfigError(error);

    expect(configError).toBeInstanceOf(Error);
    expect(configError.name).toBe('ConfigError');
    expect(configError.message).toContain('DATABASE_URL');
    expect(configError.message).toContain('JIRA_API_TOKEN');
    expect(configError.message).toContain('.env.example');
  });
});

describe('formatConfigError', () => {
  it('names every offending key in one block', () => {
    const env = { ...baseEnv } as Record<string, string | undefined>;
    delete env.JIRA_API_TOKEN;
    delete env.JIRA_EMAIL;
    try {
      loadConfig(env);
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = formatConfigError(error as z.ZodError);
      expect(message).toContain('JIRA_API_TOKEN');
      expect(message).toContain('JIRA_EMAIL');
      expect(message).toContain('.env.example');
    }
  });
});

describe('requireSlack', () => {
  it('throws naming exactly what is missing', () => {
    const config = loadConfig({ ...baseEnv });
    expect(() => requireSlack(config)).toThrow(MissingSlackConfigError);
    expect(() => requireSlack(config)).toThrow(/SLACK_BOT_TOKEN/);
    expect(() => requireSlack(config)).toThrow(/SLACK_SIGNING_SECRET/);
  });

  it('returns the credentials once they are present', () => {
    const config = loadConfig({
      ...baseEnv,
      SLACK_BOT_TOKEN: 'xoxb-abc',
      SLACK_SIGNING_SECRET: 'sekret',
    });
    expect(requireSlack(config)).toMatchObject({
      botToken: 'xoxb-abc',
      signingSecret: 'sekret',
    });
    expect(hasSlackConfig(config)).toBe(true);
  });

  it('additionally demands an app token in socket mode', () => {
    const config = loadConfig({
      ...baseEnv,
      SLACK_BOT_TOKEN: 'xoxb-abc',
      SLACK_SIGNING_SECRET: 'sekret',
      SLACK_SOCKET_MODE: 'true',
    });
    expect(() => requireSlack(config)).toThrow(/SLACK_APP_TOKEN/);
  });

  it('reports Slack as unconfigured in Phase 0 without throwing', () => {
    expect(hasSlackConfig(loadConfig({ ...baseEnv }))).toBe(false);
  });
});
