/**
 * The dependency bundle every handler receives.
 *
 * One explicit object rather than module-level singletons, so a test can build
 * a context with fakes and drive a handler directly.
 */
import type { WebClient } from '@slack/web-api';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { Repo } from './db/repo.js';
import type { Identity } from './identity.js';
import type { JiraClient, JiraMyself } from './jira/client.js';
import type { Issues } from './jira/issues.js';
import type { JiraMeta } from './jira/meta.js';
import type { Notifier } from './slack/notify.js';
import type { Leaders } from './triage/leaders.js';

export interface BugbotContext {
  config: Config;
  log: Logger;
  db: Db;
  repo: Repo;
  jira: JiraClient;
  meta: JiraMeta;
  issues: Issues;
  slack: WebClient;
  notifier: Notifier;
  identity: Identity;
  leaders: Leaders;
  /** The service account. Phase 3's loop guard compares webhook actors to this. */
  serviceAccount: JiraMyself;
}

/** Is this channel allowed to run /bug? Empty allowlist means anywhere (SPEC 9.4). */
export function channelAllowed(context: BugbotContext, channelId: string | undefined): boolean {
  const allowlist = context.config.SLACK_BUG_CHANNEL_ALLOWLIST;
  if (allowlist.length === 0) return true;
  return Boolean(channelId && allowlist.includes(channelId));
}

/** Human-readable list of the allowed channels, for the refusal message. */
export function allowedChannelMentions(context: BugbotContext): string {
  return context.config.SLACK_BUG_CHANNEL_ALLOWLIST.map((id) => `<#${id}>`).join(' or ');
}
