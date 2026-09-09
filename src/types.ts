/**
 * The shape of a bug report, shared by every path that produces or consumes one:
 * the Slack modal, the description renderer, the label builder and the Jira client.
 *
 * The option lists are the single source of truth - the modal renders them, and
 * the submission parser validates against them.
 */

export const APPLICATIONS = [
  'world.roarington.com',
  'dreamland.roarington.com',
  'Car Studio',
  'Media/editorial',
  'Other',
] as const;

export const ENVIRONMENTS = ['Production', 'Staging', 'Local'] as const;

export const DEVICES = ['Desktop', 'Laptop', 'Tablet', 'Phone', 'TV/console'] as const;

export const INPUT_METHODS = ['Mouse', 'Touch', 'Keyboard', 'Gamepad/joystick'] as const;

export const FREQUENCIES = ['Always', 'Sometimes', 'Happened once'] as const;

export const SEVERITIES = ['Blocker', 'Major', 'Minor', 'Cosmetic'] as const;

export type Application = (typeof APPLICATIONS)[number];
export type Environment = (typeof ENVIRONMENTS)[number];
export type Device = (typeof DEVICES)[number];
export type InputMethod = (typeof INPUT_METHODS)[number];
export type Frequency = (typeof FREQUENCIES)[number];
export type Severity = (typeof SEVERITIES)[number];

/** Jira's five priority names, highest first. */
export const PRIORITIES = ['Highest', 'High', 'Medium', 'Low', 'Lowest'] as const;
export type Priority = (typeof PRIORITIES)[number];

export type IntakeSource = 'slack_modal' | 'slack_shortcut' | 'jira_native';

export interface Reporter {
  slackUserId?: string;
  displayName?: string;
  email?: string;
  jiraAccountId?: string;
}

export interface BugReport {
  summary: string;
  application: Application;
  environment: Environment;
  device: Device;
  /** Free-text model, e.g. "iPhone 15 Pro" or "Steam Deck". */
  deviceModel?: string;
  os: string;
  browser: string;
  /** Normalised to "1440x900" by the submission parser. */
  viewport: string;
  inputMethods: InputMethod[];
  steps: string;
  expected: string;
  actual: string;
  frequency: Frequency;
  severity: Severity;
  notes?: string;
  reporter: Reporter;
  source: IntakeSource;
  /** Where /bug was run, or where the shortcut's message lives. */
  slackChannelId?: string;
  /** Permalink to the message a "Report as bug" shortcut was used on. */
  slackMessagePermalink?: string;
}

/**
 * Jira labels cannot contain whitespace. Lowercase, collapse anything that is
 * not a letter, digit or dot into a single dash.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/**
 * Device class, coarser than the model, for the `dev:` label - so you can find
 * "everything broken on a phone" without knowing every model string.
 */
export function deviceClass(device: Device): string {
  switch (device) {
    case 'Desktop':
    case 'Laptop':
      return 'desktop';
    case 'Tablet':
      return 'tablet';
    case 'Phone':
      return 'phone';
    case 'TV/console':
      return 'tv';
  }
}

/** The SPEC 5 label set, in a stable order. */
export function buildLabels(report: BugReport, priority: Priority): string[] {
  const sourceLabel = report.source === 'jira_native' ? 'src:jira' : 'src:slack';
  return [
    sourceLabel,
    `app:${slugify(report.application)}`,
    `env:${slugify(report.environment)}`,
    `dev:${deviceClass(report.device)}`,
    `sev:${slugify(report.severity)}`,
    `freq:${slugify(report.frequency)}`,
    `prio-suggested:${slugify(priority)}`,
  ];
}
