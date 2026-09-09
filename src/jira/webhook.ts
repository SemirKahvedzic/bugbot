/**
 * Jira webhook receiver (SPEC 7, SPEC 11).
 *
 * Jira does not sign its webhooks, so the endpoint is protected by three
 * independent checks:
 *
 *   1. a long random secret in the URL path,
 *   2. an optional IP allowlist of Atlassian's published ranges,
 *   3. rejection of any payload whose issue is not in the configured project.
 *
 * On top of that: a loop guard that ignores changes made by the service account
 * itself, and per-change idempotency, since Jira retries deliveries.
 */
import express, { type Request, type Response, type Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { applyRoute } from '../triage/apply.js';
import { decideRoute } from '../triage/route.js';
import { issueUrl } from '../format/slackBlocks.js';
import { postBugFeed } from '../slack/feed.js';
import type { BugbotContext } from '../context.js';
import type { Priority } from '../types.js';

/** How long two status changes must be apart to both produce a DM (SPEC 8). */
export const DIGEST_WINDOW_MS = 5 * 60 * 1000;

/**
 * Jira names two changelog fields `toString` and `valueOf`-adjacent things,
 * and `toString` collides with `Object.prototype.toString`. If an item arrives
 * without it, a plain property read yields the *inherited function*, zod
 * rejects it as "expected string, received function", and the whole payload is
 * dropped - losing the webhook.
 *
 * Rebuilding each item from its own enumerable keys removes the prototype from
 * the picture, so a missing `toString` reads as undefined like any other
 * absent field.
 */
const ownPropertiesOnly = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  // Object.create(null) matters: a plain {} literal would still inherit
  // Object.prototype.toString and reintroduce the very collision this avoids.
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(source)) out[key] = source[key];
  return out;
};

const changelogItemSchema = z.preprocess(
  ownPropertiesOnly,
  z.object({
    field: z.string().optional(),
    fieldId: z.string().optional(),
    from: z.string().nullish(),
    fromString: z.string().nullish(),
    to: z.string().nullish(),
    toString: z.string().nullish(),
  }),
);

export const webhookSchema = z.object({
  webhookEvent: z.string(),
  user: z
    .object({ accountId: z.string().optional(), displayName: z.string().optional() })
    .optional(),
  issue: z.object({
    id: z.string().optional(),
    key: z.string(),
    fields: z
      .object({
        summary: z.string().optional(),
        labels: z.array(z.string()).optional(),
        priority: z.object({ id: z.string().optional(), name: z.string().optional() }).nullish(),
        status: z.object({ id: z.string().optional(), name: z.string().optional() }).nullish(),
        issuetype: z.object({ id: z.string().optional(), name: z.string().optional() }).nullish(),
        reporter: z
          .object({
            accountId: z.string().optional(),
            emailAddress: z.string().optional(),
            displayName: z.string().optional(),
          })
          .nullish(),
        project: z.object({ key: z.string().optional() }).nullish(),
      })
      .optional(),
  }),
  changelog: z
    .object({ id: z.string().optional(), items: z.array(changelogItemSchema).default([]) })
    .nullish(),
});

export type WebhookPayload = z.infer<typeof webhookSchema>;

export interface StatusChange {
  fromStatus?: string;
  toStatus?: string;
}

/** The status transition in a changelog, if there was one. */
export function extractStatusChange(payload: WebhookPayload): StatusChange | undefined {
  const item = payload.changelog?.items.find(
    (entry) => entry.fieldId === 'status' || entry.field === 'status',
  );
  if (!item) return undefined;
  return {
    ...(item.fromString ? { fromStatus: item.fromString } : {}),
    ...(item.toString ? { toStatus: item.toString } : {}),
  };
}

/** Stable id for deduplicating a redelivered change. */
export function changeIdFor(payload: WebhookPayload): string {
  return payload.changelog?.id ?? `${payload.webhookEvent}:${payload.issue.key}`;
}

// --- IP allowlist ---------------------------------------------------------

/** Parse "203.0.113.0/24" and test an address against it. IPv4 only. */
export function ipv4InCidr(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split('/');
  if (!range) return false;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const toInt = (value: string): number | undefined => {
    const parts = value.split('.');
    if (parts.length !== 4) return undefined;
    let result = 0;
    for (const part of parts) {
      const octet = Number(part);
      if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined;
      result = (result << 8) | octet;
    }
    return result >>> 0;
  };

  const address = toInt(normaliseIp(ip));
  const network = toInt(range);
  if (address === undefined || network === undefined) return false;

  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (network & mask);
}

/** Node reports IPv4 clients behind a proxy as "::ffff:1.2.3.4". */
export function normaliseIp(ip: string): string {
  return ip.replace(/^::ffff:/i, '');
}

export function ipAllowed(ip: string | undefined, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  if (!ip) return false;
  const candidate = normaliseIp(ip);
  return allowlist.some((entry) =>
    entry.includes('/') ? ipv4InCidr(candidate, entry) : normaliseIp(entry) === candidate,
  );
}

/** Constant-time secret comparison, so the path cannot be probed by timing. */
export function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// --- Dispatch -------------------------------------------------------------

export interface HandleResult {
  action:
    | 'routed'
    | 'status_dm'
    | 'created'
    | 'ignored_self'
    | 'ignored_project'
    | 'ignored_type'
    | 'ignored_no_status_change'
    | 'ignored_duplicate'
    | 'ignored_not_triage_exit';
  issueKey?: string;
}

/**
 * Decide what a payload means and act on it.
 *
 * Exported separately from the HTTP layer so the whole dispatch can be tested
 * by replaying real payloads, including replaying the same one twice.
 */
export async function handleWebhook(
  context: BugbotContext,
  payload: WebhookPayload,
): Promise<HandleResult> {
  const { config, log, repo, identity, serviceAccount } = context;
  const issueKey = payload.issue.key;
  const fields = payload.issue.fields;

  // 1. Project guard (SPEC 11). The key prefix is checked too, because a
  //    payload can arrive without the project field expanded.
  const projectKey = fields?.project?.key ?? issueKey.split('-')[0];
  if (projectKey !== config.JIRA_PROJECT_KEY) {
    log.warn({ issueKey, projectKey }, 'webhook for another project - rejected');
    return { action: 'ignored_project', issueKey };
  }

  // 2. Loop guard: our own writes trigger webhooks too.
  if (payload.user?.accountId && payload.user.accountId === serviceAccount.accountId) {
    log.debug({ issueKey }, 'change made by the service account - ignoring');
    return { action: 'ignored_self', issueKey };
  }

  // 3. Issue type guard.
  const issueTypeName = fields?.issuetype?.name;
  if (issueTypeName && issueTypeName.toLowerCase() !== config.JIRA_ISSUE_TYPE.toLowerCase()) {
    return { action: 'ignored_type', issueKey };
  }

  const changeId = changeIdFor(payload);

  if (payload.webhookEvent === 'jira:issue_created') {
    return handleCreated(context, payload, issueKey);
  }

  const change = extractStatusChange(payload);
  if (!change?.toStatus) {
    return { action: 'ignored_no_status_change', issueKey };
  }

  const priority = normalisePriority(fields?.priority?.name);
  const summary = fields?.summary ?? issueKey;
  const leftTriage =
    change.fromStatus?.trim().toLowerCase() === config.JIRA_STATUS_TRIAGE.trim().toLowerCase();

  if (leftTriage) {
    // The one change that drives routing (SPEC 7).
    if (!(await repo.claimNotification(`route:${issueKey}:${changeId}`))) {
      log.info({ issueKey, changeId }, 'routing already applied for this change - ignoring replay');
      return { action: 'ignored_duplicate', issueKey };
    }

    const decision = decideRoute({
      toStatus: change.toStatus,
      ...(priority ? { priority } : {}),
      statuses: {
        backlog: config.JIRA_STATUS_BACKLOG,
        rejected: config.JIRA_STATUS_REJECTED,
        duplicate: config.JIRA_STATUS_DUPLICATE,
        cannotReproduce: config.JIRA_STATUS_CANNOT_REPRODUCE,
      },
    });

    await applyRoute(context, {
      issueKey,
      decision,
      ...(priority ? { priority } : {}),
      ...(change.fromStatus ? { fromStatus: change.fromStatus } : {}),
      toStatus: change.toStatus,
      ...(payload.user?.accountId ? { actorAccountId: payload.user.accountId } : {}),
      changeId,
      ...(fields?.labels ? { labels: fields.labels } : {}),
      summary,
    });

    return { action: 'routed', issueKey };
  }

  // Any other status change: keep the reporter informed (SPEC 8), digested so
  // a burst of edits produces one message.
  const report = await repo.getIssueReport(issueKey);
  const slackUserId = report?.slack_user_id ?? undefined;
  if (!slackUserId) return { action: 'ignored_not_triage_exit', issueKey };

  if (!(await repo.claimNotification(`status:${issueKey}:${changeId}`))) {
    return { action: 'ignored_duplicate', issueKey };
  }
  if (!(await repo.claimDigest(`digest:${issueKey}`, DIGEST_WINDOW_MS))) {
    log.debug({ issueKey }, 'inside the digest window - not sending another DM');
    return { action: 'ignored_duplicate', issueKey };
  }

  const url = issueUrl(config.JIRA_BASE_URL, issueKey);
  await context.notifier.dm({
    userId: slackUserId,
    fallback: `${issueKey} is now ${change.toStatus}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `<${url}|${issueKey}> moved to *${change.toStatus}*` +
            (change.fromStatus ? ` (was ${change.fromStatus})` : '') +
            `\n${summary}`,
        },
      },
    ],
  });

  // Keep identity fresh while we are here.
  void identity;

  return { action: 'status_dm', issueKey };
}

/**
 * A bug created directly in Jira. Funnel it the same way (SPEC 1): record it,
 * label its origin, move it into triage, and learn who reported it so they get
 * the same notifications a Slack reporter would.
 */
async function handleCreated(
  context: BugbotContext,
  payload: WebhookPayload,
  issueKey: string,
): Promise<HandleResult> {
  const { config, log, repo, issues, identity } = context;
  const fields = payload.issue.fields;

  if (!(await repo.claimNotification(`created:${issueKey}`))) {
    return { action: 'ignored_duplicate', issueKey };
  }

  const reporterAccountId = fields?.reporter?.accountId;
  const reporterEmail = fields?.reporter?.emailAddress;

  let slackUserId: string | undefined;
  if (reporterAccountId) {
    slackUserId = await identity.slackUserForJiraAccount(reporterAccountId, reporterEmail);
  }

  await repo.recordIssueReport({
    issueKey,
    ...(slackUserId ? { slackUserId } : {}),
    intakeSource: 'jira_native',
  });

  try {
    await issues.addLabels(issueKey, ['src:jira']);
  } catch (error) {
    log.warn(
      { issueKey, err: error instanceof Error ? error.message : String(error) },
      'could not label a Jira-native bug',
    );
  }

  const currentStatus = fields?.status?.name;
  const alreadyInTriage =
    currentStatus?.trim().toLowerCase() === config.JIRA_STATUS_TRIAGE.trim().toLowerCase();

  let moved = false;
  if (!alreadyInTriage) {
    moved = await issues.transitionTo(issueKey, config.JIRA_STATUS_TRIAGE);
    if (!moved) {
      log.warn(
        { issueKey, currentStatus },
        'could not move a Jira-native bug into triage - no transition available',
      );
    }
  }

  // Same feed as the Slack path, so the channel shows the whole intake rather
  // than only the half that came through the form (SPEC 1, "a single funnel").
  await postBugFeed(context, {
    issueKey,
    summary: fields?.summary ?? issueKey,
    source: 'jira_native',
    // Where it actually is, not where we hoped to put it.
    ...(alreadyInTriage || moved
      ? { status: config.JIRA_STATUS_TRIAGE }
      : currentStatus
        ? { status: currentStatus }
        : {}),
    ...(fields?.priority?.name ? { priority: fields.priority.name } : {}),
    // Read after the label write above, so `src:jira` is included.
    labels: [...(fields?.labels ?? []), 'src:jira'],
    ...(slackUserId ? { reporterSlackId: slackUserId } : {}),
    ...(fields?.reporter?.displayName ? { reporterName: fields.reporter.displayName } : {}),
  });

  log.info({ issueKey, slackUserId: Boolean(slackUserId), moved }, 'funnelled a Jira-native bug');
  return { action: 'created', issueKey };
}

function normalisePriority(name: string | undefined): Priority | undefined {
  if (!name) return undefined;
  const match = (['Highest', 'High', 'Medium', 'Low', 'Lowest'] as const).find(
    (value) => value.toLowerCase() === name.trim().toLowerCase(),
  );
  return match;
}

// --- HTTP layer -----------------------------------------------------------

/**
 * Router mounted at /jira. The secret is a path segment, so it never appears
 * in a query string that a proxy might log.
 */
export function createJiraWebhookRouter(context: BugbotContext): Router {
  const router = express.Router();
  const { config, log } = context;

  // JSON parsing is scoped to this route only: a global body parser would eat
  // the raw body Slack signature verification needs (SPEC 11).
  router.post(
    '/webhook/:secret',
    express.json({ limit: '1mb' }),
    (request: Request, response: Response) => {
      if (!config.JIRA_WEBHOOK_SECRET) {
        log.error('Jira webhook received but JIRA_WEBHOOK_SECRET is not set - rejecting');
        response.status(503).json({ ok: false });
        return;
      }

      // Express 5 types a route param as possibly repeated; only a single
      // value can ever be a valid secret.
      const provided = request.params.secret;
      if (typeof provided !== 'string' || !secretMatches(provided, config.JIRA_WEBHOOK_SECRET)) {
        log.warn({ ip: request.ip }, 'Jira webhook with a bad secret - rejected');
        response.status(404).json({ ok: false });
        return;
      }

      if (!ipAllowed(request.ip, config.JIRA_WEBHOOK_IP_ALLOWLIST)) {
        log.warn({ ip: request.ip }, 'Jira webhook from an address outside the allowlist');
        response.status(403).json({ ok: false });
        return;
      }

      const parsed = webhookSchema.safeParse(request.body);
      if (!parsed.success) {
        log.warn({ issues: parsed.error.issues.length }, 'unparseable Jira webhook payload');
        response.status(400).json({ ok: false });
        return;
      }

      // Answer immediately: Jira times deliveries out and then retries, which
      // would turn slow processing into duplicate work.
      response.status(200).json({ ok: true });

      void handleWebhook(context, parsed.data)
        .then((result) => {
          log.debug({ ...result }, 'webhook handled');
        })
        .catch((error: unknown) => {
          log.error(
            {
              issueKey: parsed.data.issue.key,
              err: error instanceof Error ? error.message : String(error),
            },
            'webhook handling failed',
          );
        });
    },
  );

  return router;
}
