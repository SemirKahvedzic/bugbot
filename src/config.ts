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
  DATABASE_PATH: z.string().min(1).default('/data/bugbot.db'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
});

export type Config = z.infer<typeof configSchema>;

/** Parse without side effects. Throws a ZodError. Used by tests. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse(env);
}

/** Render a ZodError as one human-readable block. */
export function formatConfigError(error: z.ZodError): string {
  const lines = error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
  return `Invalid environment configuration:\n${lines.join('\n')}\n\nSee .env.example.`;
}

let cached: Config | undefined;

/**
 * Memoised config for application code. Exits the process on invalid env -
 * booting half-configured is worse than not booting (SPEC 3, "fail fast").
 */
export function getConfig(): Config {
  if (cached) return cached;
  try {
    cached = loadConfig();
    return cached;
  } catch (error) {
    if (error instanceof z.ZodError) {
      process.stderr.write(`${formatConfigError(error)}\n`);
      process.exit(1);
    }
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
