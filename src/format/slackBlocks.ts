/**
 * Block Kit builders. Pure functions - no Slack client, no I/O - so the
 * rendering is unit tested and the handlers stay thin.
 */
import type { AnyBlock, HomeView } from '@slack/types';
import { ACTION } from '../slack/actions.js';
import { summariseForSlack } from './description.js';
import { parseLabels, type BugReport, type IntakeSource, type Priority } from '../types.js';

export function issueUrl(baseUrl: string, issueKey: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/browse/${issueKey}`;
}

const section = (text: string): AnyBlock => ({
  type: 'section',
  text: { type: 'mrkdwn', text },
});

const context = (text: string): AnyBlock => ({
  type: 'context',
  elements: [{ type: 'mrkdwn', text }],
});

/** Confirmation posted where /bug was run (SPEC 5). */
export function intakeConfirmationBlocks(input: {
  issueKey: string;
  issueUrl: string;
  report: BugReport;
  priority: Priority;
  reporterSlackId?: string;
  transitioned: boolean;
  triageStatusName: string;
}): AnyBlock[] {
  const who = input.reporterSlackId ? `<@${input.reporterSlackId}>` : 'someone';
  const blocks: AnyBlock[] = [
    section(
      `:beetle: *<${input.issueUrl}|${input.issueKey}>* — ${escape(input.report.summary)}\n` +
        `Filed by ${who}.`,
    ),
    context(
      `${escape(summariseForSlack(input.report))}  •  suggested priority *${input.priority}*`,
    ),
  ];

  if (!input.transitioned) {
    blocks.push(
      section(
        `:warning: I could not move it to *${input.triageStatusName}* — the workflow offered no ` +
          `transition there. The issue exists and is safe; it just needs moving by hand.`,
      ),
    );
  }

  blocks.push(
    section(
      ':camera_with_flash: *Reply in this thread with screenshots or a video* and I will attach ' +
        'them to the issue.',
    ),
  );

  return blocks;
}

export interface BugFeedInput {
  issueKey: string;
  issueUrl: string;
  summary: string;
  status?: string;
  priority?: string;
  /** Jira labels; the only place the QA fields live (SPEC 9.3). */
  labels?: string[];
  reporterSlackId?: string;
  reporterName?: string;
  source: IntakeSource;
  /** Present only when the bug came through the form. */
  report?: BugReport;
}

/**
 * The feed card: one message per new bug, whichever way it arrived.
 *
 * Both intake paths render through this so the feed is uniform. A bug filed in
 * Jira without the form simply has less to show - and the card says so
 * explicitly, because making that gap visible is the point of having a single
 * funnel at all.
 */
export function bugFeedBlocks(input: BugFeedInput): AnyBlock[] {
  const parsed = parseLabels(input.labels);

  const how =
    input.source === 'jira_native'
      ? 'created directly in Jira'
      : input.source === 'slack_shortcut'
        ? 'via the "Report as bug" shortcut'
        : 'via the /bug form';

  const who = input.reporterSlackId
    ? `<@${input.reporterSlackId}>`
    : input.reporterName
      ? escape(input.reporterName)
      : 'unknown reporter';

  // `who` is either a mention or already escaped, so it is joined as-is;
  // everything else coming from Jira is escaped here.
  const contextParts = [
    input.priority ? escape(input.priority) : undefined,
    input.status ? escape(input.status) : undefined,
    how,
    `reported by ${who}`,
  ].filter((part): part is string => Boolean(part));

  const blocks: AnyBlock[] = [
    section(
      `:beetle: *<${input.issueUrl}|${input.issueKey}>*  ${escape(truncate(input.summary, 150))}`,
    ),
    context(contextParts.join('  •  ')),
  ];

  const report = input.report;
  if (report) {
    const device = report.deviceModel
      ? `${report.device} (${report.deviceModel})`
      : report.device;

    blocks.push(
      section(
        `*Environment*  ${escape(
          [
            report.application,
            report.environment,
            device,
            report.os,
            report.browser,
            report.viewport,
            report.inputMethods.join('/'),
          ]
            .filter(Boolean)
            .join(' · '),
        )}`,
      ),
      section(
        `*Severity*  ${escape(report.severity)}, happens ${escape(report.frequency.toLowerCase())}\n` +
          `*Expected*  ${escape(truncate(report.expected, 300))}\n` +
          `*Actual*  ${escape(truncate(report.actual, 300))}`,
      ),
    );
    return blocks;
  }

  // No form behind it. Show whatever the labels carry, then say what is missing.
  const fromLabels = [parsed.app, parsed.env, parsed.dev, parsed.sev, parsed.freq].filter(Boolean);
  if (fromLabels.length > 0) {
    blocks.push(section(`*Labelled*  ${escape(fromLabels.join(' · '))}`));
  }

  blocks.push(
    section(
      ':warning: Filed without the QA form, so there is no device, viewport, steps or expected ' +
        'versus actual. Ask the reporter for them, or point them at `/bug` next time.',
    ),
  );

  return blocks;
}

export interface IssueSummaryLine {
  key: string;
  summary: string;
  status: string;
  priority?: string;
  updated?: string;
  /** Carried so App Home cards can show the QA fields (SPEC 9.3: labels). */
  labels?: string[];
  created?: string;
  assigneeName?: string;
}

/**
 * A dot per status category, so a column of cards is scannable without
 * reading. Matched on the name rather than the id because the names are
 * config and the ids are not.
 */
export function statusEmoji(status: string): string {
  const s = status.toLowerCase();
  if (/under triage/.test(s)) return ':large_yellow_circle:';
  if (/in progress|in review|in qa/.test(s)) return ':large_blue_circle:';
  if (/ready for validation|ready/.test(s)) return ':large_purple_circle:';
  if (/rejected|duplicate|cannot reproduce/.test(s)) return ':white_circle:';
  if (/done/.test(s)) return ':white_check_mark:';
  return ':black_circle:';
}

/**
 * "3 days ago". Deliberately coarse: on a bug list the difference between
 * 71 and 73 hours never matters, but "3 days" versus "3 weeks" always does.
 */
export function relativeTime(iso: string | undefined, now = Date.now()): string | undefined {
  if (!iso) return undefined;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return undefined;

  const seconds = Math.round((now - then) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 90) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${weeks} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

/**
 * One bug as a card: a titled section with a link out, then a metadata line.
 *
 * Used on App Home, where there is room to browse. `/mybugs` keeps the compact
 * list - it is a quick peek in an ephemeral message, and twenty cards there
 * would bury the answer rather than show it.
 */
export function bugCardBlocks(baseUrl: string, issue: IssueSummaryLine): AnyBlock[] {
  const parsed = parseLabels(issue.labels);
  const url = issueUrl(baseUrl, issue.key);

  const detail = [parsed.app, parsed.env, parsed.dev].filter(Boolean).join(' · ');
  const quality = [parsed.sev && `severity ${parsed.sev}`, parsed.freq && `happens ${parsed.freq}`]
    .filter(Boolean)
    .join(', ');

  const meta = [
    issue.priority ? `*${escape(issue.priority)}*` : undefined,
    detail ? escape(detail) : undefined,
    quality ? escape(quality) : undefined,
    issue.assigneeName ? `assigned to ${escape(issue.assigneeName)}` : 'unassigned',
    relativeTime(issue.created) ? `filed ${relativeTime(issue.created)}` : undefined,
  ].filter(Boolean);

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `${statusEmoji(issue.status)}  *<${url}|${issue.key}>*  ${escape(issue.status)}\n` +
          escape(truncate(issue.summary, 200)),
      },
      accessory: {
        type: 'button',
        action_id: ACTION.openIssue,
        text: { type: 'plain_text', text: 'Open' },
        url,
      },
    },
    context(meta.join('  •  ')),
    { type: 'divider' },
  ];
}

const STATUS_BUCKETS: Array<{ label: string; matches: (status: string) => boolean }> = [
  { label: 'Under Triage', matches: (s) => /under triage/i.test(s) },
  { label: 'In Progress', matches: (s) => /in progress|in review|in qa/i.test(s) },
  { label: 'Ready for Validation', matches: (s) => /ready for validation|ready/i.test(s) },
  {
    label: 'Closed',
    matches: (s) => /done|rejected|duplicate|cannot reproduce/i.test(s),
  },
];

/** Group issues into the four SPEC 8 buckets, preserving input order. */
export function bucketIssues(
  issues: IssueSummaryLine[],
): Array<{ label: string; issues: IssueSummaryLine[] }> {
  const buckets = STATUS_BUCKETS.map((bucket) => ({ label: bucket.label, issues: [] as IssueSummaryLine[] }));
  const other: IssueSummaryLine[] = [];

  for (const issue of issues) {
    const index = STATUS_BUCKETS.findIndex((bucket) => bucket.matches(issue.status));
    if (index === -1) other.push(issue);
    else buckets[index]!.issues.push(issue);
  }

  if (other.length > 0) buckets.push({ label: 'Other', issues: other });
  return buckets.filter((bucket) => bucket.issues.length > 0);
}

function issueLine(baseUrl: string, issue: IssueSummaryLine): string {
  const priority = issue.priority ? ` _${issue.priority}_` : '';
  return `• <${issueUrl(baseUrl, issue.key)}|${issue.key}>${priority} ${escape(truncate(issue.summary, 90))}`;
}

/** `/mybugs` and the App Home body share this (SPEC 8). */
export function myBugsBlocks(input: {
  baseUrl: string;
  issues: IssueSummaryLine[];
  jqlUrl: string;
  limit: number;
}): AnyBlock[] {
  if (input.issues.length === 0) {
    return [
      section("You have not reported any bugs yet. Run `/bug` and I will keep track of them here."),
    ];
  }

  const blocks: AnyBlock[] = [];
  const shown = input.issues.slice(0, input.limit);

  for (const bucket of bucketIssues(shown)) {
    blocks.push(section(`*${bucket.label}* (${bucket.issues.length})`));
    blocks.push(
      section(bucket.issues.map((issue) => issueLine(input.baseUrl, issue)).join('\n')),
    );
  }

  const footer =
    input.issues.length > input.limit
      ? `Showing ${shown.length} of ${input.issues.length}. <${input.jqlUrl}|View all in Jira>`
      : `<${input.jqlUrl}|View all in Jira>`;
  blocks.push(context(footer));

  return blocks;
}

/**
 * Slack rejects a view over 100 blocks outright, which would leave App Home
 * blank rather than truncated. Each card is three blocks, so this keeps the
 * total well under the cap however high the caller's limit is set.
 */
export const HOME_MAX_CARDS = 25;

export function homeView(input: {
  baseUrl: string;
  issues: IssueSummaryLine[];
  jqlUrl: string;
  limit: number;
}): HomeView {
  const blocks: AnyBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Your bug reports' } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: ACTION.homeFileBug,
          style: 'primary',
          text: { type: 'plain_text', text: 'Report a bug' },
        },
        {
          type: 'button',
          action_id: ACTION.homeRefresh,
          text: { type: 'plain_text', text: 'Refresh' },
        },
      ],
    },
  ];

  if (input.issues.length === 0) {
    blocks.push(
      section(
        'You have not reported any bugs yet. Hit *Report a bug*, or run `/bug` in a channel, and ' +
          'they will show up here.',
      ),
    );
    return { type: 'home', blocks };
  }

  const shown = input.issues.slice(0, Math.min(input.limit, HOME_MAX_CARDS));
  const buckets = bucketIssues(shown);

  // Counts first, so the shape of the queue is visible before any scrolling.
  blocks.push(
    context(buckets.map((bucket) => `${bucket.label} *${bucket.issues.length}*`).join('  •  ')),
    { type: 'divider' },
  );

  for (const bucket of buckets) {
    blocks.push(section(`*${bucket.label}*`));
    for (const issue of bucket.issues) {
      blocks.push(...bugCardBlocks(input.baseUrl, issue));
    }
  }

  blocks.push(
    context(
      input.issues.length > shown.length
        ? `Showing ${shown.length} of ${input.issues.length}. <${input.jqlUrl}|View all in Jira>`
        : `<${input.jqlUrl}|View all in Jira>`,
    ),
  );

  return { type: 'home', blocks };
}

/** The `/triage` queue, one actionable row per bug (SPEC 7). */
export function triageQueueBlocks(input: {
  baseUrl: string;
  issues: IssueSummaryLine[];
  triageStatusName: string;
}): AnyBlock[] {
  if (input.issues.length === 0) {
    return [section(`:tada: Nothing in *${input.triageStatusName}*. The queue is empty.`)];
  }

  const blocks: AnyBlock[] = [
    section(`*${input.issues.length}* bug(s) in *${input.triageStatusName}*`),
  ];

  for (const issue of input.issues) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `<${issueUrl(input.baseUrl, issue.key)}|${issue.key}> ${escape(truncate(issue.summary, 120))}` +
          (issue.priority ? `\n_currently ${issue.priority}_` : ''),
      },
    });
    blocks.push({
      type: 'actions',
      block_id: `triage_${issue.key}`,
      elements: [
        {
          type: 'button',
          action_id: ACTION.triageBacklog,
          text: { type: 'plain_text', text: 'Backlog' },
          value: issue.key,
        },
        {
          type: 'button',
          action_id: ACTION.triageSprint,
          style: 'primary',
          text: { type: 'plain_text', text: 'Sprint' },
          value: issue.key,
        },
        {
          type: 'button',
          action_id: ACTION.triageNeedInfo,
          text: { type: 'plain_text', text: 'Need info' },
          value: issue.key,
        },
        {
          type: 'button',
          action_id: ACTION.triageDuplicate,
          style: 'danger',
          text: { type: 'plain_text', text: 'Duplicate' },
          value: issue.key,
        },
      ],
    });
  }

  return blocks;
}

/** DM to the team leader when a bug is routed at High or above (SPEC 7). */
export function leaderDmBlocks(input: {
  issueKey: string;
  issueUrl: string;
  summary: string;
  priority: string;
  application?: string;
  reporterSlackId?: string;
  escalated: boolean;
}): AnyBlock[] {
  const heading = input.escalated
    ? `:rotating_light: *Escalated: ${input.priority}*`
    : `:inbox_tray: *Triaged to sprint: ${input.priority}*`;

  return [
    section(`${heading}\n<${input.issueUrl}|${input.issueKey}> ${escape(input.summary)}`),
    context(
      [
        input.application ? `app *${escape(input.application)}*` : undefined,
        input.reporterSlackId ? `reported by <@${input.reporterSlackId}>` : undefined,
      ]
        .filter(Boolean)
        .join('  •  ') || 'no further context',
    ),
    {
      type: 'actions',
      block_id: `leader_${input.issueKey}`,
      elements: [
        {
          type: 'button',
          action_id: ACTION.leaderApprove,
          style: 'primary',
          text: { type: 'plain_text', text: 'Approve' },
          value: input.issueKey,
        },
        {
          type: 'button',
          action_id: ACTION.leaderReassign,
          text: { type: 'plain_text', text: 'Reassign' },
          value: input.issueKey,
        },
      ],
    },
  ];
}

/** Slack mrkdwn escaping: only these three characters are special. */
export function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
