/**
 * Block Kit builders. Pure functions - no Slack client, no I/O - so the
 * rendering is unit tested and the handlers stay thin.
 */
import type { AnyBlock, HomeView } from '@slack/types';
import { ACTION } from '../slack/actions.js';
import { summariseForSlack } from './description.js';
import type { BugReport, Priority } from '../types.js';

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

export interface IssueSummaryLine {
  key: string;
  summary: string;
  status: string;
  priority?: string;
  updated?: string;
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
  forHome?: boolean;
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

export function homeView(input: {
  baseUrl: string;
  issues: IssueSummaryLine[];
  jqlUrl: string;
  limit: number;
}): HomeView {
  return {
    type: 'home',
    blocks: [
      section('*Your bug reports*'),
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
      { type: 'divider' },
      ...myBugsBlocks({ ...input, forHome: true }),
    ],
  };
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
