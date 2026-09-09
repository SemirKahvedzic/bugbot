/**
 * `/bugstats` (SPEC 8, Phase 5): the weekly digest.
 *
 * Run on demand rather than on a timer. An in-process weekly schedule would
 * silently skip a week whenever the machine restarted; a cron job that calls
 * this - or someone typing it on a Monday - is honest about when it ran.
 * README explains how to schedule it if you want that.
 */
import type { App } from '@slack/bolt';
import type { AnyBlock } from '@slack/types';
import { escape } from '../../format/slackBlocks.js';
import { Leaders } from '../../triage/leaders.js';
import { keepAlive } from '../../runtime.js';
import { COMMAND } from '../actions.js';
import type { BugbotContext } from '../../context.js';

export interface Stats {
  since: string;
  days: number;
  total: number;
  byApplication: Array<{ application: string; count: number }>;
  bySeverity: Array<{ severity: string; count: number }>;
  routing: Array<{ routedTo: string; count: number }>;
  medianTriageMs?: number;
  topReporters: Array<{ slackUserId: string; count: number }>;
}

function tally(values: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export async function collectStats(context: BugbotContext, days = 7): Promise<Stats> {
  const { config, repo, issues } = context;
  const since = new Date(Date.now() - days * 86_400_000);
  const sinceIso = since.toISOString();

  const created = await issues.search(
    `project = ${config.JIRA_PROJECT_KEY} AND created >= -${days}d ORDER BY created DESC`,
    { maxResults: 100, fields: ['summary', 'labels', 'status', 'priority', 'created'] },
  );

  const applications = created
    .map((issue) => Leaders.applicationFromLabels(issue.fields.labels))
    .filter((value): value is string => Boolean(value));

  const severities = created
    .flatMap((issue) => issue.fields.labels ?? [])
    .filter((label) => label.startsWith('sev:'))
    .map((label) => label.slice('sev:'.length));

  const [medianTriageMs, routing, topReporters] = await Promise.all([
    repo.medianTimeInTriageMs(sinceIso),
    repo.routingSplitSince(sinceIso),
    repo.topReportersSince(sinceIso, 3),
  ]);

  return {
    since: sinceIso,
    days,
    total: created.length,
    byApplication: tally(applications).map(([application, count]) => ({ application, count })),
    bySeverity: tally(severities).map(([severity, count]) => ({ severity, count })),
    routing: routing.map((row) => ({ routedTo: row.routed_to, count: row.count })),
    ...(medianTriageMs !== undefined ? { medianTriageMs } : {}),
    topReporters: topReporters.map((row) => ({
      slackUserId: row.slack_user_id,
      count: row.count,
    })),
  };
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function statsBlocks(stats: Stats): AnyBlock[] {
  const lines: string[] = [];

  lines.push(`*${stats.total}* bug(s) filed in the last ${stats.days} days.`);

  if (stats.byApplication.length > 0) {
    lines.push(
      '',
      '*By application*',
      ...stats.byApplication.map((row) => `• ${escape(row.application)} — ${row.count}`),
    );
  }

  if (stats.bySeverity.length > 0) {
    lines.push(
      '',
      '*By severity*',
      stats.bySeverity.map((row) => `${escape(row.severity)} ${row.count}`).join('  •  '),
    );
  }

  const backlog = stats.routing.find((row) => row.routedTo === 'backlog')?.count ?? 0;
  const sprint = stats.routing.find((row) => row.routedTo === 'sprint')?.count ?? 0;
  const closed = stats.routing.find((row) => row.routedTo === 'closed')?.count ?? 0;
  // Moves made by hand from App Home, as opposed to by a routing rule. Only
  // shown when there are any, so the line does not read as a reproach.
  const manual = stats.routing.find((row) => row.routedTo === 'manual')?.count ?? 0;
  lines.push(
    '',
    '*Triage outcomes*',
    `backlog ${backlog}  •  sprint lane ${sprint}  •  closed without work ${closed}` +
      (manual > 0 ? `  •  moved by hand ${manual}` : ''),
  );

  lines.push(
    '',
    stats.medianTriageMs === undefined
      ? '_Nothing was triaged in this window, so there is no median time in triage._'
      : `*Median time in triage:* ${formatDuration(stats.medianTriageMs)}`,
  );

  if (stats.topReporters.length > 0) {
    lines.push(
      '',
      '*Top reporters*',
      stats.topReporters.map((row) => `<@${row.slackUserId}> (${row.count})`).join('  •  '),
    );
  }

  return [
    { type: 'section', text: { type: 'mrkdwn', text: ':bar_chart: *BugBot weekly digest*' } },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
  ];
}

export function registerBugStatsCommand(app: App, context: BugbotContext): void {
  app.command(COMMAND.bugStats, async ({ command, ack, respond }) => {
    await ack();
    // Reading a week of issues out of Jira is well past the three second
    // budget, so answer through response_url in the background.
    keepAlive(reportStats(context, command.text ?? '', respond), 'bugstats');
  });
}

type Respond = (message: Record<string, unknown>) => Promise<unknown>;

/** Collect the numbers and answer. Split out so the handler can ack at once. */
async function reportStats(
  context: BugbotContext,
  commandText: string,
  respond: Respond,
): Promise<void> {
  let stats: Stats;
  try {
    stats = await collectStats(context);
  } catch (error) {
    context.log.error(
      { err: error instanceof Error ? error.message : String(error) },
      'could not collect stats',
    );
    await respond({ response_type: 'ephemeral', text: 'I could not read the numbers from Jira.' });
    return;
  }

  const blocks = statsBlocks(stats);

  // "post" publishes to the announce channel; anything else stays private.
  if (commandText.trim().toLowerCase() === 'post') {
    const result = await context.notifier.post({
      channel: context.config.SLACK_ANNOUNCE_CHANNEL,
      fallback: `BugBot weekly digest: ${stats.total} bugs`,
      blocks,
    });
    await respond({
      response_type: 'ephemeral',
      text: result.ok
        ? `Posted to <#${context.config.SLACK_ANNOUNCE_CHANNEL}>.`
        : 'I could not post to the announce channel.',
    });
    return;
  }

  await respond({
    response_type: 'ephemeral',
    text: `BugBot digest: ${stats.total} bugs in ${stats.days} days.`,
    blocks: [
      ...blocks,
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: 'Run `/bugstats post` to share this in the channel.' },
        ],
      },
    ],
  });
}
