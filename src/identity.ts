/**
 * Slack <-> Jira identity mapping (SPEC 4) - the one genuinely tricky part.
 *
 * Every issue is created by a single Jira service account, so the human has to
 * be tracked separately. Both directions are resolved lazily and cached in
 * `user_map`:
 *
 *   Slack user -> email -> Jira accountId   (so we can set the real reporter)
 *   Jira email -> Slack user                (so Jira-native bugs get DMs)
 *
 * Every function returns undefined rather than throwing. A failed lookup must
 * never stop a bug being filed; it only costs that reporter their DMs.
 */
import type { WebClient } from '@slack/web-api';
import type { Logger } from 'pino';
import type { Repo } from './db/repo.js';
import type { Issues } from './jira/issues.js';

export interface IdentityDeps {
  slack: WebClient;
  issues: Issues;
  repo: Repo;
  log: Logger;
}

export interface SlackIdentity {
  slackUserId: string;
  displayName?: string;
  email?: string;
  jiraAccountId?: string;
}

export class Identity {
  constructor(private readonly deps: IdentityDeps) {}

  /**
   * Everything we can find out about a Slack user, cache-first.
   *
   * `users:read.email` is what makes the Jira half possible; without it we
   * still get a display name, which is enough for the description footer.
   */
  async forSlackUser(slackUserId: string): Promise<SlackIdentity> {
    const cached = await this.deps.repo.userBySlackId(slackUserId);
    if (cached?.jira_account_id && cached.email) {
      return {
        slackUserId,
        email: cached.email,
        jiraAccountId: cached.jira_account_id,
      };
    }

    const identity: SlackIdentity = { slackUserId, email: cached?.email ?? undefined };
    if (cached?.jira_account_id) identity.jiraAccountId = cached.jira_account_id;

    try {
      const profile = await this.deps.slack.users.info({ user: slackUserId });
      identity.displayName =
        profile.user?.profile?.real_name ?? profile.user?.real_name ?? profile.user?.name;
      identity.email = identity.email ?? profile.user?.profile?.email;
    } catch (error) {
      this.deps.log.warn(
        { slackUserId, err: describe(error) },
        'could not read Slack profile - continuing without it',
      );
    }

    if (!identity.jiraAccountId && identity.email) {
      identity.jiraAccountId = await this.deps.issues.findAccountIdByEmail(identity.email);
      if (!identity.jiraAccountId) {
        this.deps.log.info(
          { slackUserId },
          'no Jira account matches this Slack user - filing under the service account',
        );
      }
    }

    if (identity.email || identity.jiraAccountId) {
      await this.deps.repo.upsertUserMap({
        slackUserId,
        ...(identity.email ? { email: identity.email } : {}),
        ...(identity.jiraAccountId ? { jiraAccountId: identity.jiraAccountId } : {}),
      });
    }

    return identity;
  }

  /**
   * The Slack user behind a Jira account, for bugs created natively in Jira.
   * Needs an email address on the Jira side; Jira sites can hide those.
   */
  async slackUserForJiraAccount(
    accountId: string,
    email?: string,
  ): Promise<string | undefined> {
    const byAccount = await this.deps.repo.userByJiraAccountId(accountId);
    if (byAccount) return byAccount.slack_user_id;

    if (!email) return undefined;

    const byEmail = await this.deps.repo.userByEmail(email);
    if (byEmail) {
      // Learn the accountId for next time.
      await this.deps.repo.upsertUserMap({ slackUserId: byEmail.slack_user_id, jiraAccountId: accountId });
      return byEmail.slack_user_id;
    }

    try {
      const found = await this.deps.slack.users.lookupByEmail({ email });
      const slackUserId = found.user?.id;
      if (!slackUserId) return undefined;
      await this.deps.repo.upsertUserMap({ slackUserId, jiraAccountId: accountId, email });
      return slackUserId;
    } catch (error) {
      // users_not_found is the normal answer for contractors and bots.
      this.deps.log.info(
        { accountId, err: describe(error) },
        'no Slack user for this Jira account - no DMs for them',
      );
      return undefined;
    }
  }

  /** Display name only, for rendering. Never throws. */
  async displayName(slackUserId: string): Promise<string> {
    try {
      const profile = await this.deps.slack.users.info({ user: slackUserId });
      return (
        profile.user?.profile?.real_name ??
        profile.user?.real_name ??
        profile.user?.name ??
        slackUserId
      );
    } catch {
      return slackUserId;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
