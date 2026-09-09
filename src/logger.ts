/**
 * Structured logging (SPEC 11): secrets and personal data are redacted by
 * default, so a careless `log.info({ payload })` cannot leak a token or a
 * reporter's email into the log stream.
 *
 * pino wildcards match exactly one level, so each sensitive key is listed both
 * at the top level and one level deep - which covers the shapes we actually
 * log ({ user: {...} }, { issue: {...} }, { req: {...} }).
 */
import pino, { type Logger } from 'pino';

export const REDACT_PATHS = [
  // Credentials.
  'token',
  'api_token',
  'apiToken',
  'password',
  'authorization',
  'secret',
  '*.token',
  '*.api_token',
  '*.apiToken',
  '*.password',
  '*.authorization',
  '*.secret',
  'headers.authorization',
  'headers.cookie',
  '*.headers.authorization',
  '*.headers.cookie',
  // Personal data.
  'email',
  'emailAddress',
  '*.email',
  '*.emailAddress',
  // Slack/Jira message bodies - DM and comment text is never worth logging.
  'text',
  '*.text',
  // Named env vars, in case a whole config object is ever logged.
  'JIRA_API_TOKEN',
  'JIRA_WEBHOOK_SECRET',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_APP_TOKEN',
  '*.JIRA_API_TOKEN',
  '*.JIRA_WEBHOOK_SECRET',
  '*.SLACK_BOT_TOKEN',
  '*.SLACK_SIGNING_SECRET',
  '*.SLACK_APP_TOKEN',
];

export const REDACT_CENSOR = '[redacted]';

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
  destination?: pino.DestinationStream;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const { level = 'info', pretty = false, destination } = options;

  const base: pino.LoggerOptions = {
    level,
    redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  if (destination) return pino(base, destination);

  if (pretty) {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    });
  }

  return pino(base);
}

let cached: Logger | undefined;

/** Application logger. Configured from env on first use. */
export function logger(): Logger {
  if (!cached) {
    cached = createLogger({
      level: process.env.LOG_LEVEL ?? 'info',
      pretty: process.env.NODE_ENV === 'development',
    });
  }
  return cached;
}
