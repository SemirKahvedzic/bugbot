/**
 * Per-application team leader lookup (SPEC 9.2).
 *
 * Configured through one environment variable rather than a file. The file
 * version could not work on Vercel: `config/leaders.json` was gitignored, the
 * deployment is built from the repo, so the file was never there and every
 * escalation silently went to the default triager. An environment variable is
 * also simply easier to edit than a committed file.
 *
 * Format - `application=slackUserId`, comma separated:
 *
 *   BUGBOT_LEADERS=world.roarington.com=U123ABC,drive.roarington.com=U456DEF
 *
 * The application is the slugified name, which is exactly what the `app:`
 * label on the issue carries. `default=U789` overrides the fallback;
 * otherwise `SLACK_DEFAULT_TRIAGER` is the fallback.
 *
 * Only a Slack id is configured. An earlier version also took a Jira
 * accountId, which nothing ever read - routing DMs the leader, it does not
 * assign the issue - so it was a field people would fill in that did nothing.
 */
import type { Logger } from 'pino';
import { APPLICATIONS, slugify } from '../types.js';

export interface Leader {
  slackUserId?: string;
}

export interface LeadersOptions {
  /** Raw value of BUGBOT_LEADERS. Absent or empty is fine. */
  config?: string;
  /** Used for any application with no entry of its own. */
  fallbackSlackUserId: string;
  log: Logger;
}

export interface ParsedLeaders {
  byApplication: Map<string, string>;
  /** `default=U123` in the config, if given. */
  fallback?: string;
  /** Entries that could not be used, with the reason. */
  problems: string[];
}

const DEFAULT_KEY = 'default';

/** Every key the config may use: the app labels, plus `default`. */
export function validLeaderKeys(): string[] {
  return [...APPLICATIONS.map(slugify), DEFAULT_KEY];
}

/**
 * Parse the environment format.
 *
 * Unknown application keys are reported rather than ignored. A typo there
 * cannot fail loudly on its own - the lookup just misses and falls back - so
 * whoever set it would see escalations going to the wrong person with nothing
 * in the logs to explain it.
 */
export function parseLeaders(config: string | undefined): ParsedLeaders {
  const byApplication = new Map<string, string>();
  const problems: string[] = [];
  let fallback: string | undefined;

  const valid = new Set(validLeaderKeys());

  for (const entry of (config ?? '').split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;

    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      problems.push(`"${trimmed}" is not application=slackUserId`);
      continue;
    }

    const application = trimmed.slice(0, separator).trim().toLowerCase();
    const slackUserId = trimmed.slice(separator + 1).trim();

    if (slackUserId.length === 0) {
      problems.push(`"${application}" has no Slack user id`);
      continue;
    }
    if (!valid.has(application)) {
      problems.push(
        `"${application}" is not a known application - expected one of ${validLeaderKeys().join(', ')}`,
      );
      continue;
    }

    if (application === DEFAULT_KEY) fallback = slackUserId;
    else byApplication.set(application, slackUserId);
  }

  return { byApplication, ...(fallback ? { fallback } : {}), problems };
}

export class Leaders {
  private readonly byApplication: Map<string, string>;
  private readonly fallback: Leader;

  constructor(options: LeadersOptions) {
    const parsed = parseLeaders(options.config);

    this.byApplication = parsed.byApplication;
    this.fallback = { slackUserId: parsed.fallback ?? options.fallbackSlackUserId };

    for (const problem of parsed.problems) {
      options.log.warn({ problem }, 'ignoring a BUGBOT_LEADERS entry');
    }

    if (parsed.byApplication.size === 0 && !parsed.fallback) {
      options.log.info(
        { fallback: this.fallback.slackUserId },
        'no per-application leaders configured - every escalation goes to the default triager',
      );
    } else {
      options.log.info(
        { applications: [...parsed.byApplication.keys()], hasDefault: Boolean(parsed.fallback) },
        'team leaders configured',
      );
    }
  }

  /** The leader for an application, or the fallback. Never undefined. */
  forApplication(application: string | undefined): Leader {
    if (!application) return this.fallback;
    const slackUserId = this.byApplication.get(application.toLowerCase());
    return slackUserId ? { slackUserId } : this.fallback;
  }

  /** Every application that has a leader of its own. */
  configuredApplications(): string[] {
    return [...this.byApplication.keys()];
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
