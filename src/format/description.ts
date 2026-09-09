/**
 * The one place a bug description is rendered (SPEC 5).
 *
 * Both intake paths go through this, so a bug filed from Slack and a bug filed
 * natively in Jira look identical - which is the whole point of the "single
 * funnel". Phase 3's backfill re-renders Jira-native bugs through the same
 * template.
 */
import {
  bold,
  bulletList,
  code,
  doc,
  heading,
  link,
  numberedSteps,
  panel,
  paragraph,
  paragraphs,
  rule,
  text,
  type AdfDoc,
  type AdfNode,
} from './adf.js';
import { explainSuggestion, suggestPriority } from '../triage/suggest.js';
import type { BugReport, Priority } from '../types.js';

/** "Application: world.roarington.com" as a bold-labelled bullet. */
function field(label: string, value: string, asCode = false): AdfNode {
  return paragraph(bold(`${label}: `), asCode ? code(value) : text(value));
}

function environmentBullets(report: BugReport): AdfNode {
  const device = report.deviceModel
    ? `${report.device} - ${report.deviceModel}`
    : report.device;

  return bulletList([
    field('Application', report.application),
    field('Environment', report.environment),
    field('Device', device),
    field('OS', report.os),
    field('Browser', report.browser),
    field('Viewport', report.viewport, true),
    field('Input method', report.inputMethods.join(', ') || '-'),
  ]);
}

function reproductionBullets(report: BugReport): AdfNode {
  return bulletList([
    field('Frequency', report.frequency),
    field('Severity', report.severity),
  ]);
}

/**
 * Provenance footer. The human reporter is recorded here as well as in the
 * database, because SPEC 4 files everything under one service account - without
 * this line a reader cannot tell who actually hit the bug.
 */
function footer(report: BugReport): AdfNode[] {
  const who = report.reporter.displayName ?? report.reporter.slackUserId ?? 'unknown';
  const how =
    report.source === 'slack_modal'
      ? 'via the Slack /bug form'
      : report.source === 'slack_shortcut'
        ? 'via the Slack "Report as bug" shortcut'
        : 'created directly in Jira';

  const parts: AdfNode[] = [bold('Reported by: '), text(`${who} - ${how}`)];
  if (report.slackMessagePermalink) {
    parts.push(text(' - '), link('original Slack message', report.slackMessagePermalink));
  }

  return [rule(), paragraph(...parts), paragraph(text('Filed by BugBot.'))];
}

export interface RenderedDescription {
  adf: AdfDoc;
  priority: Priority;
}

/** The normalised description, plus the priority it suggests. */
export function renderDescription(report: BugReport): RenderedDescription {
  const priority = suggestPriority(report.severity, report.frequency);

  const adf = doc(
    heading(3, 'Environment'),
    environmentBullets(report),

    heading(3, 'Steps to reproduce'),
    numberedSteps(report.steps),

    heading(3, 'Expected result'),
    ...paragraphs(report.expected),

    heading(3, 'Actual result'),
    ...paragraphs(report.actual),

    heading(3, 'Reproduction'),
    reproductionBullets(report),

    panel(
      'info',
      paragraph(
        bold('Suggested priority: '),
        text(explainSuggestion(report.severity, report.frequency)),
      ),
    ),

    ...(report.notes && report.notes.trim().length > 0
      ? [heading(3, 'Extra notes'), ...paragraphs(report.notes)]
      : []),

    ...footer(report),
  );

  return { adf, priority };
}

/**
 * Compact one-line summary for Slack messages and `/mybugs` rows - the same
 * facts, small enough to scan.
 */
export function summariseForSlack(report: BugReport): string {
  const device = report.deviceModel ? `${report.device}/${report.deviceModel}` : report.device;
  return [
    report.application,
    report.environment,
    device,
    report.browser,
    report.viewport,
    `${report.severity}/${report.frequency}`,
  ]
    .filter(Boolean)
    .join(' | ');
}
