/**
 * Per-application team leader lookup (SPEC 9.2).
 *
 * Loaded from config/leaders.json when present. The file is optional: with no
 * file, or no entry for an application, everything falls back to the default
 * triager from env, so routing never silently fails to notify anyone.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Logger } from 'pino';

const leaderSchema = z.object({
  slack: z.string().default(''),
  jira: z.string().default(''),
});

const leadersFileSchema = z.object({
  default: leaderSchema.optional(),
  applications: z.record(z.string(), leaderSchema).default({}),
});

export interface Leader {
  slackUserId?: string;
  jiraAccountId?: string;
}

export interface LeadersOptions {
  /** Path to config/leaders.json. Absent file is fine. */
  path?: string;
  /** Used when the file has no default and no application entry. */
  fallbackSlackUserId: string;
  log: Logger;
}

export class Leaders {
  private readonly byApplication = new Map<string, Leader>();
  private readonly fallback: Leader;

  constructor(options: LeadersOptions) {
    this.fallback = { slackUserId: options.fallbackSlackUserId };

    if (!options.path) return;

    let parsed: z.infer<typeof leadersFileSchema>;
    try {
      const raw = JSON.parse(readFileSync(options.path, 'utf8')) as unknown;
      parsed = leadersFileSchema.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // ENOENT is the expected state until someone fills the file in.
      if (/ENOENT/.test(message)) {
        options.log.info(
          { path: options.path },
          'no leaders config - every escalation goes to the default triager',
        );
      } else {
        options.log.warn(
          { path: options.path, err: message },
          'could not read leaders config - falling back to the default triager',
        );
      }
      return;
    }

    if (parsed.default?.slack) {
      this.fallback = toLeader(parsed.default);
    }
    for (const [application, leader] of Object.entries(parsed.applications)) {
      if (leader.slack || leader.jira) this.byApplication.set(application.toLowerCase(), toLeader(leader));
    }

    options.log.info(
      { applications: [...this.byApplication.keys()] },
      'leaders config loaded',
    );
  }

  /** The leader for an application, or the fallback. Never undefined. */
  forApplication(application: string | undefined): Leader {
    if (!application) return this.fallback;
    return this.byApplication.get(application.toLowerCase()) ?? this.fallback;
  }

  /**
   * The application an issue belongs to, read back from its `app:` label -
   * labels are the only place SPEC 9.3 lets us store it without custom fields.
   */
  static applicationFromLabels(labels: string[] | undefined): string | undefined {
    const label = labels?.find((value) => value.startsWith('app:'));
    return label?.slice('app:'.length);
  }
}

function toLeader(input: { slack: string; jira: string }): Leader {
  return {
    ...(input.slack ? { slackUserId: input.slack } : {}),
    ...(input.jira ? { jiraAccountId: input.jira } : {}),
  };
}
