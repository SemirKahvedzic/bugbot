/**
 * The intake form (SPEC 5), as a pure function so it can be unit tested without
 * Slack, plus the parser for what comes back.
 *
 * Block and action ids are declared once and shared by the builder and the
 * parser - a typo then breaks a test rather than a submission.
 */
import type { AnyBlock, ModalView, PlainTextOption } from '@slack/types';
import {
  APPLICATIONS,
  DEVICES,
  ENVIRONMENTS,
  FREQUENCIES,
  INPUT_METHODS,
  SEVERITIES,
  type Application,
  type BugReport,
  type Device,
  type Environment,
  type Frequency,
  type InputMethod,
  type IntakeSource,
  type Severity,
} from '../../types.js';

export const BUG_MODAL_CALLBACK_ID = 'bugbot_report';

/** block_id per field. The action_id is always `${blockId}_input`. */
export const FIELD = {
  summary: 'summary',
  application: 'application',
  environment: 'environment',
  device: 'device',
  deviceModel: 'device_model',
  os: 'os',
  browser: 'browser',
  viewport: 'viewport',
  inputMethods: 'input_methods',
  steps: 'steps',
  expected: 'expected',
  actual: 'actual',
  frequency: 'frequency',
  severity: 'severity',
  notes: 'notes',
} as const;

const actionId = (blockId: string) => `${blockId}_input`;

export const SUMMARY_MAX_LENGTH = 120;

/**
 * SPEC 5: "window size in px, e.g. 1440x900 - not screen size".
 *
 * Deliberately more forgiving than the regex in the spec: case-insensitive so
 * "800 X 600" is accepted, and `\s*` so extra spaces are too. Both are things
 * people actually type, and both normalise to the same stored value.
 */
export const VIEWPORT_PATTERN = /^(\d{3,4})\s*[x×]\s*(\d{3,4})$/i;

/** What each entry point carries through the modal round-trip. */
export interface BugModalMetadata {
  /** Channel the confirmation should be posted to. */
  channelId?: string;
  /** Thread to reply in, when opened from a message shortcut. */
  threadTs?: string;
  /** Permalink to the message the shortcut was used on. */
  permalink?: string;
  /** Which entry point opened the modal. */
  source?: IntakeSource;
}

export interface BugModalPrefill {
  summary?: string;
  steps?: string;
}

function option(value: string): PlainTextOption {
  return { text: { type: 'plain_text', text: value }, value };
}

function select(
  blockId: string,
  label: string,
  values: readonly string[],
  placeholder: string,
): AnyBlock {
  return {
    type: 'input',
    block_id: blockId,
    label: { type: 'plain_text', text: label },
    element: {
      type: 'static_select',
      action_id: actionId(blockId),
      placeholder: { type: 'plain_text', text: placeholder },
      options: values.map(option),
    },
  };
}

function textInput(
  blockId: string,
  label: string,
  options: {
    placeholder?: string;
    hint?: string;
    multiline?: boolean;
    optional?: boolean;
    maxLength?: number;
    initialValue?: string;
  } = {},
): AnyBlock {
  return {
    type: 'input',
    block_id: blockId,
    label: { type: 'plain_text', text: label },
    optional: options.optional ?? false,
    ...(options.hint ? { hint: { type: 'plain_text' as const, text: options.hint } } : {}),
    element: {
      type: 'plain_text_input',
      action_id: actionId(blockId),
      multiline: options.multiline ?? false,
      ...(options.maxLength ? { max_length: options.maxLength } : {}),
      ...(options.placeholder
        ? { placeholder: { type: 'plain_text' as const, text: options.placeholder } }
        : {}),
      ...(options.initialValue ? { initial_value: options.initialValue } : {}),
    },
  };
}

export function buildBugModal(
  options: { metadata?: BugModalMetadata; prefill?: BugModalPrefill } = {},
): ModalView {
  const { metadata = {}, prefill = {} } = options;

  const blocks: AnyBlock[] = [
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Everything here is what QA needs to reproduce the bug without asking you again. It takes a minute.',
        },
      ],
    },
    textInput(FIELD.summary, 'Summary', {
      placeholder: 'One line - what is broken?',
      maxLength: SUMMARY_MAX_LENGTH,
      initialValue: prefill.summary,
    }),
    select(FIELD.application, 'Application', APPLICATIONS, 'Pick the application'),
    select(FIELD.environment, 'Environment', ENVIRONMENTS, 'Pick the environment'),
    select(FIELD.device, 'Device', DEVICES, 'Pick the device type'),
    textInput(FIELD.deviceModel, 'Device model', {
      placeholder: 'e.g. iPhone 15 Pro, MacBook Air M2, Steam Deck',
      optional: true,
    }),
    textInput(FIELD.os, 'OS and version', {
      placeholder: 'e.g. Android 15, iOS 18.2, Windows 11',
    }),
    textInput(FIELD.browser, 'Browser and version', {
      placeholder: 'e.g. Chrome 141',
    }),
    textInput(FIELD.viewport, 'Viewport size', {
      placeholder: '1440x900',
      hint: 'Window size in px, not screen size. In the browser console: innerWidth x innerHeight.',
    }),
    {
      type: 'input',
      block_id: FIELD.inputMethods,
      label: { type: 'plain_text', text: 'Input method' },
      element: {
        type: 'multi_static_select',
        action_id: actionId(FIELD.inputMethods),
        placeholder: { type: 'plain_text', text: 'How were you interacting?' },
        options: INPUT_METHODS.map(option),
      },
    },
    textInput(FIELD.steps, 'Steps to reproduce', {
      multiline: true,
      placeholder: '1. Open ...\n2. Click ...\n3. Notice ...',
      hint: 'One step per line. Numbering is added for you.',
      initialValue: prefill.steps,
    }),
    textInput(FIELD.expected, 'Expected result', {
      multiline: true,
      placeholder: 'What should have happened?',
    }),
    textInput(FIELD.actual, 'Actual result', {
      multiline: true,
      placeholder: 'What happened instead?',
    }),
    select(FIELD.frequency, 'Frequency', FREQUENCIES, 'How often does it happen?'),
    select(FIELD.severity, 'Severity', SEVERITIES, 'How bad is it?'),
    textInput(FIELD.notes, 'Extra notes or links', {
      multiline: true,
      optional: true,
      placeholder: 'Stream session, console errors, anything else worth knowing',
    }),
  ];

  return {
    type: 'modal',
    callback_id: BUG_MODAL_CALLBACK_ID,
    // Max 24 characters.
    title: { type: 'plain_text', text: 'Report a bug' },
    submit: { type: 'plain_text', text: 'File it' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: JSON.stringify(metadata),
    blocks,
  };
}

/** Slack's view_submission state, narrowed to the bits we read. */
interface ViewStateValue {
  value?: string | null;
  selected_option?: { value: string } | null;
  selected_options?: Array<{ value: string }> | null;
}

export interface SubmittedView {
  private_metadata?: string;
  state: { values: Record<string, Record<string, ViewStateValue>> };
}

function raw(view: SubmittedView, blockId: string): ViewStateValue | undefined {
  return view.state?.values?.[blockId]?.[actionId(blockId)];
}

function str(view: SubmittedView, blockId: string): string {
  return (raw(view, blockId)?.value ?? '').trim();
}

function selected(view: SubmittedView, blockId: string): string {
  return raw(view, blockId)?.selected_option?.value ?? '';
}

function multi(view: SubmittedView, blockId: string): string[] {
  return (raw(view, blockId)?.selected_options ?? []).map((o) => o.value);
}

export function parseMetadata(view: SubmittedView): BugModalMetadata {
  if (!view.private_metadata) return {};
  try {
    return JSON.parse(view.private_metadata) as BugModalMetadata;
  } catch {
    // Never let a malformed round-trip lose the whole report.
    return {};
  }
}

export type ParseResult =
  | { ok: true; report: Omit<BugReport, 'reporter' | 'source'>; metadata: BugModalMetadata }
  | { ok: false; errors: Record<string, string> };

/**
 * Validate and normalise a submission.
 *
 * Slack enforces "required" on input blocks itself, so this catches the things
 * it cannot: the viewport format, and values that are not in our option lists
 * (which would mean the modal and this parser have drifted apart).
 */
export function parseBugModalSubmission(view: SubmittedView): ParseResult {
  const errors: Record<string, string> = {};

  const summary = str(view, FIELD.summary);
  if (summary.length === 0) {
    errors[FIELD.summary] = 'Give it a one-line summary.';
  } else if (summary.length > SUMMARY_MAX_LENGTH) {
    errors[FIELD.summary] = `Keep it under ${SUMMARY_MAX_LENGTH} characters.`;
  }

  const rawViewport = str(view, FIELD.viewport);
  const viewportMatch = VIEWPORT_PATTERN.exec(rawViewport);
  if (!viewportMatch) {
    errors[FIELD.viewport] =
      'Use width x height in pixels, e.g. 1440x900. This is the window size, not the screen size.';
  }

  const application = selected(view, FIELD.application);
  if (!APPLICATIONS.includes(application as Application)) {
    errors[FIELD.application] = 'Pick an application from the list.';
  }

  const environment = selected(view, FIELD.environment);
  if (!ENVIRONMENTS.includes(environment as Environment)) {
    errors[FIELD.environment] = 'Pick an environment from the list.';
  }

  const device = selected(view, FIELD.device);
  if (!DEVICES.includes(device as Device)) {
    errors[FIELD.device] = 'Pick a device from the list.';
  }

  const frequency = selected(view, FIELD.frequency);
  if (!FREQUENCIES.includes(frequency as Frequency)) {
    errors[FIELD.frequency] = 'Pick how often it happens.';
  }

  const severity = selected(view, FIELD.severity);
  if (!SEVERITIES.includes(severity as Severity)) {
    errors[FIELD.severity] = 'Pick a severity.';
  }

  const inputMethods = multi(view, FIELD.inputMethods).filter((value): value is InputMethod =>
    INPUT_METHODS.includes(value as InputMethod),
  );
  if (inputMethods.length === 0) {
    errors[FIELD.inputMethods] = 'Pick at least one input method.';
  }

  const steps = str(view, FIELD.steps);
  if (steps.length === 0) errors[FIELD.steps] = 'Steps to reproduce are the whole point.';

  const expected = str(view, FIELD.expected);
  if (expected.length === 0) errors[FIELD.expected] = 'What should have happened?';

  const actual = str(view, FIELD.actual);
  if (actual.length === 0) errors[FIELD.actual] = 'What happened instead?';

  const os = str(view, FIELD.os);
  if (os.length === 0) errors[FIELD.os] = 'OS and version, e.g. Windows 11.';

  const browser = str(view, FIELD.browser);
  if (browser.length === 0) errors[FIELD.browser] = 'Browser and version, e.g. Chrome 141.';

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const deviceModel = str(view, FIELD.deviceModel);
  const notes = str(view, FIELD.notes);

  return {
    ok: true,
    metadata: parseMetadata(view),
    report: {
      summary,
      application: application as Application,
      environment: environment as Environment,
      device: device as Device,
      ...(deviceModel ? { deviceModel } : {}),
      os,
      browser,
      // Normalised, so "1440 x 900" and "1440x900" end up identical in Jira.
      viewport: `${viewportMatch![1]}x${viewportMatch![2]}`,
      inputMethods,
      steps,
      expected,
      actual,
      frequency: frequency as Frequency,
      severity: severity as Severity,
      ...(notes ? { notes } : {}),
    },
  };
}
