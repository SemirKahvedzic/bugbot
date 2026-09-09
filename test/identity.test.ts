import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Identity } from '../src/identity.js';
import { Repo } from '../src/db/repo.js';
import { createLogger } from '../src/logger.js';
import type { Db } from '../src/db/index.js';
import { makeTestDb } from './helpers/db.js';

let db: Db;
let repo: Repo;
const log = createLogger({ level: 'silent' });

function makeIdentity(overrides: {
  usersInfo?: ReturnType<typeof vi.fn>;
  lookupByEmail?: ReturnType<typeof vi.fn>;
  findAccountIdByEmail?: ReturnType<typeof vi.fn>;
} = {}) {
  const usersInfo =
    overrides.usersInfo ??
    vi.fn(async () => ({
      user: { profile: { real_name: 'Semir Kahvedzic', email: 'semir@roarington.com' } },
    }));

  const findAccountIdByEmail = overrides.findAccountIdByEmail ?? vi.fn(async () => 'acc-semir');

  const identity = new Identity({
    slack: {
      users: { info: usersInfo, lookupByEmail: overrides.lookupByEmail ?? vi.fn() },
    } as never,
    issues: { findAccountIdByEmail } as never,
    repo,
    log,
  });

  return { identity, usersInfo, findAccountIdByEmail };
}

beforeEach(async () => {
  db = await makeTestDb();
  repo = new Repo(db);
});

describe('Identity.forSlackUser', () => {
  it('resolves the name, email and Jira account, and caches them', async () => {
    const { identity } = makeIdentity();

    const who = await identity.forSlackUser('U1');

    expect(who).toMatchObject({
      slackUserId: 'U1',
      displayName: 'Semir Kahvedzic',
      email: 'semir@roarington.com',
      jiraAccountId: 'acc-semir',
    });

    const cached = await repo.userBySlackId('U1');
    expect(cached?.email).toBe('semir@roarington.com');
    expect(cached?.jira_account_id).toBe('acc-semir');
  });

  it('still returns the display name on later calls, once everything is cached', async () => {
    // The bug this guards: an early return on a warm cache skipped the Slack
    // profile read, so only someone's FIRST report carried their name. Every
    // one after that showed a bare email address in the Jira footer.
    const { identity } = makeIdentity();

    await identity.forSlackUser('U1');
    const second = await identity.forSlackUser('U1');

    expect(second.displayName).toBe('Semir Kahvedzic');
    expect(second.email).toBe('semir@roarington.com');
    expect(second.jiraAccountId).toBe('acc-semir');
  });

  it('does not repeat the Jira account search once it is cached', async () => {
    // The profile read is cheap; the Jira user search is the expensive one, so
    // that is the call the cache exists to avoid.
    const { identity, findAccountIdByEmail } = makeIdentity();

    await identity.forSlackUser('U1');
    await identity.forSlackUser('U1');
    await identity.forSlackUser('U1');

    expect(findAccountIdByEmail).toHaveBeenCalledTimes(1);
  });

  it('falls back through the profile name fields', async () => {
    const { identity } = makeIdentity({
      usersInfo: vi.fn(async () => ({ user: { name: 'semir', profile: {} } })),
    });
    expect((await identity.forSlackUser('U1')).displayName).toBe('semir');
  });

  it('files under the service account when no Jira account matches', async () => {
    const { identity } = makeIdentity({ findAccountIdByEmail: vi.fn(async () => undefined) });

    const who = await identity.forSlackUser('U1');
    expect(who.jiraAccountId).toBeUndefined();
    // The email is still cached, so the reporter is still identifiable.
    expect(who.email).toBe('semir@roarington.com');
    expect((await repo.userBySlackId('U1'))?.email).toBe('semir@roarington.com');
  });

  it('survives a Slack profile read that fails', async () => {
    const { identity } = makeIdentity({
      usersInfo: vi.fn(async () => {
        throw new Error('missing_scope');
      }),
    });

    const who = await identity.forSlackUser('U1');
    expect(who.slackUserId).toBe('U1');
    expect(who.displayName).toBeUndefined();
    // Nothing to cache, and nothing thrown: a failed lookup must never stop a
    // bug being filed (SPEC 4).
    expect(await repo.userBySlackId('U1')).toBeUndefined();
  });
});

describe('Identity.slackUserForJiraAccount', () => {
  it('finds a cached mapping by account id', async () => {
    await repo.upsertUserMap({ slackUserId: 'U1', jiraAccountId: 'acc-1', email: 'a@b.com' });
    const { identity } = makeIdentity();
    expect(await identity.slackUserForJiraAccount('acc-1')).toBe('U1');
  });

  it('learns the account id when only the email was known', async () => {
    await repo.upsertUserMap({ slackUserId: 'U1', email: 'a@b.com' });
    const { identity } = makeIdentity();

    expect(await identity.slackUserForJiraAccount('acc-new', 'a@b.com')).toBe('U1');
    expect((await repo.userBySlackId('U1'))?.jira_account_id).toBe('acc-new');
  });

  it('asks Slack when the email is new, and caches the result', async () => {
    const lookupByEmail = vi.fn(async () => ({ user: { id: 'U9' } }));
    const { identity } = makeIdentity({ lookupByEmail });

    expect(await identity.slackUserForJiraAccount('acc-9', 'new@roarington.com')).toBe('U9');
    expect(lookupByEmail).toHaveBeenCalledOnce();
    expect((await repo.userByJiraAccountId('acc-9'))?.slack_user_id).toBe('U9');
  });

  it('returns undefined without an email, and when Slack has nobody', async () => {
    const { identity } = makeIdentity({
      lookupByEmail: vi.fn(async () => {
        throw new Error('users_not_found');
      }),
    });

    expect(await identity.slackUserForJiraAccount('acc-x')).toBeUndefined();
    expect(await identity.slackUserForJiraAccount('acc-x', 'nobody@example.com')).toBeUndefined();
  });
});
