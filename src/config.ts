/**
 * Environment configuration, validated once with zod.
 *
 * Design notes:
 * - No Jira IDs live here. Only names (project key, issue type, statuses).
 *   `src/jira/meta.ts` resolves names to IDs against the live site at boot, so
 *   a renamed status fails at startup with a clear message rather than silently
 *   mis-routing a bug later.
 * - Slack credentials are optional so that `npm run discover` can run with only
 *   the Jira block filled in. Use `requireSlack()` from any Slack code path.
 */
import { z } from 'zod';

/**
 * Drop keys whose value is blank.
 *
 * This matters more than it looks. A zod `.default()` only applies when the
 * value is `undefined` - a present-but-empty string defeats it. Every way
 * these variables actually get set produces empty strings freely: a `.env`
 * file with `KEY=`, and Vercel's "import from .env.example", which is exactly
 * how the first deployment ended up with thirty blank variables and no
 * defaults at all.
 *
 * Treating blank as absent is also just the honest reading: nobody sets a
 * variable to the empty string meaning "the empty string".
 */
export function withoutBlanks(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() === '') continue;
    out[key] = value;
  }
  return out;
}

const csv = z
  .string()
  .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean));

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

export const configSchema = z.object({
  // --- Jira: connection ---
  JIRA_BASE_URL: z
    .string()
    .url('must be a full URL, e.g. https://roarington.atlassian.net')
    .transform((u) => u.replace(/\/+$/, '')),
  JIRA_CLOUD_ID: z.string().uuid('must be the tenant UUID from /_edge/tenant_info'),
  JIRA_EMAIL: z.string().email(),
  JIRA_API_TOKEN: z.string().min(1),

  // --- Jira: where bugs live ---
  JIRA_PROJECT_KEY: z.string().min(1).default('SUP'),
  JIRA_BOARD_ID: z.coerce.number().int().positive(),
  JIRA_ISSUE_TYPE: z.string().min(1).default('Finding'),

  // --- Jira: workflow status names ---
  JIRA_STATUS_TRIAGE: z.string().min(1).default('Under Triage'),
  JIRA_STATUS_BACKLOG: z.string().min(1).default('To Do'),
  JIRA_STATUS_REJECTED: z.string().min(1).default('Rejected'),
  JIRA_STATUS_DUPLICATE: z.string().min(1).default('Duplicate'),
  JIRA_STATUS_CANNOT_REPRODUCE: z.string().min(1).default('Cannot Reproduce'),

  JIRA_SET_REAL_REPORTER: bool.default('true'),
  JIRA_WEBHOOK_SECRET: z.string().min(16).optional(),
  /**
   * Atlassian's published outbound ranges (SPEC 11). Empty disables the check
   * and leaves the secret path as the only gate - fine for a first deploy,
   * worth filling in from https://ip-ranges.atlassian.com/ afterwards.
   */
  JIRA_WEBHOOK_IP_ALLOWLIST: csv.default(''),

  // --- Slack (optional until Phase 1) ---
  SLACK_BOT_TOKEN: z.string().startsWith('xoxb-').optional(),
  SLACK_SIGNING_SECRET: z.string().min(1).optional(),
  SLACK_APP_TOKEN: z.string().startsWith('xapp-').optional(),
  SLACK_SOCKET_MODE: bool.default('false'),

  SLACK_DEFAULT_TRIAGER: z.string().min(1),
  SLACK_ANNOUNCE_CHANNEL: z.string().min(1),
  SLACK_DEV_CHANNEL: z.string().min(1),
  SLACK_BUG_CHANNEL_ALLOWLIST: csv.default(''),
  ESCALATION_MENTION: z.enum(['none', 'here', 'channel']).default('none'),

  // --- Runtime ---
  /**
   * Postgres connection string. On Vercel this must be the **pooled**
   * connection string (Neon's `-pooler` host), or concurrent invocations
   * exhaust the connection limit under any real load.
   */
  DATABASE_URL: z.string().url('must be a postgres:// connection string'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(50).default(5),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
});

export type Config = z.infer<typeof configSchema>;

/** Parse without side effects. Throws a ZodError. Used by tests. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse(withoutBlanks(env));
}

/** Render a ZodError as one human-readable block. */
export function formatConfigError(error: z.ZodError): string {
  const lines = error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
  return `Invalid environment configuration:\n${lines.join('\n')}\n\nSee .env.example.`;
}

/** An unusable environment. Carries the full report, not just the first fault. */
export class ConfigError extends Error {
  constructor(readonly zodError: z.ZodError) {
    super(formatConfigError(zodError));
    this.name = 'ConfigError';
  }
}

let cached: Config | undefined;

/**
 * Memoised config for application code.
 *
 * Throws rather than calling process.exit. Exiting is right for a server and
 * useless in a serverless function: the runtime reports only
 * FUNCTION_INVOCATION_FAILED and the reason is buried in the logs. Throwing
 * lets the caller decide - `src/index.ts` logs and exits, `api/index.ts`
 * serves 503 with the actual list of bad variables in the response body.
 */
export function getConfig(): Config {
  if (cached) return cached;
  try {
    cached = loadConfig();
    return cached;
  } catch (error) {
    if (error instanceof z.ZodError) throw new ConfigError(error);
    throw error;
  }
}

export class MissingSlackConfigError extends Error {}

/**
 * Slack credentials, asserted at the point of use. Phase 0 runs without them.
 */
export function requireSlack(config: Config): {
  botToken: string;
  signingSecret: string;
  appToken?: string;
} {
  const missing: string[] = [];
  if (!config.SLACK_BOT_TOKEN) missing.push('SLACK_BOT_TOKEN');
  if (!config.SLACK_SIGNING_SECRET) missing.push('SLACK_SIGNING_SECRET');
  if (config.SLACK_SOCKET_MODE && !config.SLACK_APP_TOKEN) missing.push('SLACK_APP_TOKEN');
  if (missing.length > 0) {
    throw new MissingSlackConfigError(
      `Slack is not configured. Missing: ${missing.join(', ')}. ` +
        `Fill these in .env (see .env.example) or unset SLACK_SOCKET_MODE.`,
    );
  }
  return {
    botToken: config.SLACK_BOT_TOKEN!,
    signingSecret: config.SLACK_SIGNING_SECRET!,
    appToken: config.SLACK_APP_TOKEN,
  };
}

/** True when Slack is fully configured, without throwing. */
export function hasSlackConfig(config: Config): boolean {
  try {
    requireSlack(config);
    return true;
  } catch {
    return false;
  }
}
