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
import { missingFields, type BugReport, type Priority } from '../types.js';

/** "Application: world.roarington.com" as a bold-labelled bullet. */
function field(label: string, value: string, asCode = false): AdfNode {
  return paragraph(bold(`${label}: `), asCode ? code(value) : text(value));
}

function environmentBullets(report: BugReport): AdfNode {
  const device = report.deviceModel
    ? `${report.device} - ${report.deviceModel}`
    : report.device;

  // Only five of these are required, so a bullet is dropped rather than left
  // showing a blank. What was dropped is reported by the footer instead.
  const bullets: AdfNode[] = [
    field('Application', report.application),
    field('Environment', report.environment),
    field('Device', device),
  ];

  if (report.os) bullets.push(field('OS', report.os));
  if (report.browser) bullets.push(field('Browser', report.browser));
  if (report.viewport) bullets.push(field('Viewport', report.viewport, true));
  if (report.inputMethods?.length) {
    bullets.push(field('Input method', report.inputMethods.join(', ')));
  }

  return bulletList(bullets);
}

function reproductionBullets(report: BugReport): AdfNode {
  return bulletList([
    field('Frequency', report.frequency),
    field('Severity', report.severity),
  ]);
}

/**
 * Who to contact, in descending order of usefulness.
 *
 * Most bugs are filed by someone with no Jira account, so the Jira `Reporter`
 * field says "BugBot" and this line is the only record of the actual human.
 * The email is what lets a reader find them in Slack or Jira, so it is
 * included when we know it - a name alone is ambiguous, and a raw Slack id is
 * useless to a person.
 */
function describeReporter(report: BugReport): string {
  const { displayName, email, slackUserId } = report.reporter;
  if (displayName && email) return `${displayName} <${email}>`;
  if (displayName) return displayName;
  if (email) return email;
  if (slackUserId) return `Slack user ${slackUserId}`;
  return 'unknown';
}

function footer(report: BugReport): AdfNode[] {
  const how =
    report.source === 'slack_modal'
      ? 'via the Slack /bug form'
      : report.source === 'slack_shortcut'
        ? 'via the Slack "Report as bug" shortcut'
        : 'created directly in Jira';

  const parts: AdfNode[] = [bold('Reported by: '), text(`${describeReporter(report)} - ${how}`)];

  const links: AdfNode[] = [];
  if (report.slackThreadPermalink) {
    // The actionable one: replying here reaches the reporter and any file
    // posted is attached to this issue automatically.
    links.push(link('Slack thread (reply here to reach the reporter)', report.slackThreadPermalink));
  }
  if (report.slackMessagePermalink) {
    links.push(link('the message this was reported from', report.slackMessagePermalink));
  }

  const trailing: AdfNode[] = [];
  if (links.length > 0) {
    const withSeparators: AdfNode[] = [];
    links.forEach((node, index) => {
      if (index > 0) withSeparators.push(text('  •  '));
      withSeparators.push(node);
    });
    trailing.push(paragraph(...withSeparators));
  }

  // Name what the reporter left out. Whoever picks this up needs to know what
  // to ask for, and a bug that is missing five things should not look the same
  // as one that is complete.
  const missing = missingFields(report);
  if (missing.length > 0) {
    trailing.push(
      paragraph(bold('Not provided: '), text(`${missing.join(', ')}. Ask the reporter if needed.`)),
    );
  }

  return [rule(), paragraph(...parts), ...trailing, paragraph(text('Filed by BugBot.'))];
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

    // Expected is optional; for most bugs it is implied by the actual result,
    // and an empty heading is worse than no heading.
    ...(report.expected && report.expected.trim().length > 0
      ? [heading(3, 'Expected result'), ...paragraphs(report.expected)]
      : []),

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
  // Everything after the device is optional, so filter rather than assume.
  return [
    report.application,
    report.environment,
    device,
    report.browser,
    report.viewport,
    `${report.severity}/${report.frequency}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' | ');
}
