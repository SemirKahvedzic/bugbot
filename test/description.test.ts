import { describe, expect, it } from 'vitest';
import { numberedSteps, paragraphs } from '../src/format/adf.js';
import { renderDescription, summariseForSlack } from '../src/format/description.js';
import { buildLabels, deviceClass, slugify, type BugReport } from '../src/types.js';

const baseReport: BugReport = {
  summary: 'Brake lights lag behind the pedal',
  application: 'world.roarington.com',
  environment: 'Production',
  device: 'Phone',
  deviceModel: 'iPhone 15 Pro',
  os: 'iOS 18.2',
  browser: 'Safari 18',
  viewport: '390x844',
  inputMethods: ['Touch'],
  steps: '1. Drive to the ring\n2) Brake hard\n- Watch the lights',
  expected: 'Lights come on immediately',
  actual: 'Lights come on about a second late',
  frequency: 'Always',
  severity: 'Major',
  reporter: { slackUserId: 'U08HVG0H2EL', displayName: 'Semir Kahvedzic' },
  source: 'slack_modal',
};

/** Collect every text node, so assertions do not depend on ADF nesting. */
function allText(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  const current = node as { text?: string; content?: unknown[] };
  const here = typeof current.text === 'string' ? [current.text] : [];
  const children = Array.isArray(current.content) ? current.content.flatMap(allText) : [];
  return [...here, ...children];
}

function nodeTypes(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  const current = node as { type?: string; content?: unknown[] };
  const here = current.type ? [current.type] : [];
  const children = Array.isArray(current.content) ? current.content.flatMap(nodeTypes) : [];
  return [...here, ...children];
}

describe('renderDescription', () => {
  it('produces a valid ADF document envelope', () => {
    const { adf } = renderDescription(baseReport);
    expect(adf.type).toBe('doc');
    expect(adf.version).toBe(1);
    expect(Array.isArray(adf.content)).toBe(true);
    expect(adf.content.length).toBeGreaterThan(0);
  });

  it('includes every environment field QA needs to reproduce', () => {
    const text = allText(renderDescription(baseReport).adf).join('\n');
    expect(text).toContain('world.roarington.com');
    expect(text).toContain('Production');
    expect(text).toContain('iPhone 15 Pro');
    expect(text).toContain('iOS 18.2');
    expect(text).toContain('Safari 18');
    expect(text).toContain('390x844');
    expect(text).toContain('Touch');
  });

  it('has the expected section headings, in order', () => {
    const { adf } = renderDescription(baseReport);
    const headings = adf.content
      .filter((node) => node.type === 'heading')
      .flatMap((node) => allText(node));
    expect(headings).toEqual([
      'Environment',
      'Steps to reproduce',
      'Expected result',
      'Actual result',
      'Reproduction',
    ]);
  });

  it('renumbers steps the reporter numbered by hand', () => {
    const { adf } = renderDescription(baseReport);
    const text = allText(adf);
    // The reporter typed "1.", "2)" and "- "; none of that should survive.
    expect(text).toContain('Drive to the ring');
    expect(text).toContain('Brake hard');
    expect(text).toContain('Watch the lights');
    expect(text.some((line) => line.startsWith('1.'))).toBe(false);
    expect(text.some((line) => line.startsWith('- '))).toBe(false);
    expect(nodeTypes(adf)).toContain('orderedList');
  });

  it('states the suggested priority and returns the same value', () => {
    const { adf, priority } = renderDescription(baseReport);
    expect(priority).toBe('High'); // Major x Always
    const text = allText(adf).join(' ');
    expect(text).toContain('High');
    expect(text).toMatch(/suggested/i);
  });

  it('records the human reporter, since the issue is filed by a service account', () => {
    const text = allText(renderDescription(baseReport).adf).join(' ');
    expect(text).toContain('Semir Kahvedzic');
    expect(text).toMatch(/Slack \/bug form/);
  });

  it('links back to the original message for the shortcut path', () => {
    const { adf } = renderDescription({
      ...baseReport,
      source: 'slack_shortcut',
      slackMessagePermalink: 'https://roarington.slack.com/archives/C1/p1',
    });
    const text = allText(adf).join(' ');
    expect(text).toContain('the message this was reported from');
    expect(JSON.stringify(adf)).toContain('https://roarington.slack.com/archives/C1/p1');
    expect(text).toMatch(/shortcut/);
  });

  it('omits the notes section when there are no notes', () => {
    const withoutNotes = allText(renderDescription(baseReport).adf).join(' ');
    expect(withoutNotes).not.toContain('Extra notes');

    const withNotes = allText(
      renderDescription({ ...baseReport, notes: 'Console: TypeError' }).adf,
    ).join(' ');
    expect(withNotes).toContain('Extra notes');
    expect(withNotes).toContain('Console: TypeError');
  });

  it('renders identically whichever path filed it, apart from the footer', () => {
    const fromSlack = renderDescription(baseReport).adf;
    const fromJira = renderDescription({ ...baseReport, source: 'jira_native' }).adf;

    const strip = (doc: typeof fromSlack) =>
      JSON.stringify(doc.content.slice(0, doc.content.findIndex((n) => n.type === 'rule')));

    expect(strip(fromSlack)).toBe(strip(fromJira));
    expect(allText(fromJira).join(' ')).toContain('created directly in Jira');
  });

  it('survives a device with no model', () => {
    const report = { ...baseReport };
    delete report.deviceModel;
    const text = allText(renderDescription(report).adf).join(' ');
    expect(text).toContain('Phone');
  });
});

describe('renderDescription with only the required fields', () => {
  const sparse: BugReport = {
    summary: 'Camera clips through the wall',
    application: 'world.roarington.com',
    environment: 'Production',
    device: 'Phone',
    steps: '1. Drive into the wall',
    actual: 'The camera goes through it',
    frequency: 'Sometimes',
    severity: 'Minor',
    reporter: { displayName: 'Semir' },
    source: 'slack_modal',
  };

  it('omits the bullets that were not filled in, rather than showing blanks', () => {
    const { adf } = renderDescription(sparse);
    const text = allText(adf).join('\n');

    expect(text).toContain('Application: ');
    expect(text).toContain('Device: ');
    expect(text).not.toContain('OS: ');
    expect(text).not.toContain('Browser: ');
    expect(text).not.toContain('Viewport: ');
    expect(text).not.toContain('Input method: ');
  });

  it('drops the Expected heading entirely when there is no expected result', () => {
    const { adf } = renderDescription(sparse);
    const headings = adf.content
      .filter((node) => node.type === 'heading')
      .flatMap((node) => allText(node));

    expect(headings).toEqual([
      'Environment',
      'Steps to reproduce',
      'Actual result',
      'Reproduction',
    ]);
  });

  it('names what was not provided, so the reader knows what to ask for', () => {
    const text = allText(renderDescription(sparse).adf).join(' ');

    expect(text).toContain('Not provided:');
    expect(text).toContain('OS');
    expect(text).toContain('browser');
    expect(text).toContain('viewport');
    expect(text).toContain('input method');
    expect(text).toContain('expected result');
    // A phone with no model given is worth chasing.
    expect(text).toContain('device model');
  });

  it('says nothing about missing fields when the form was filled in', () => {
    expect(allText(renderDescription(baseReport).adf).join(' ')).not.toContain('Not provided:');
  });

  it('does not chase a device model where it would not help', () => {
    const desktop = allText(
      renderDescription({ ...sparse, device: 'Desktop' }).adf,
    ).join(' ');
    expect(desktop).not.toContain('device model');
    // The rest is still listed.
    expect(desktop).toContain('viewport');
  });

  it('still suggests a priority, because severity and frequency stay required', () => {
    const { priority } = renderDescription(sparse);
    expect(priority).toBe('Low'); // Minor x Sometimes
  });
});

describe('adf helpers', () => {
  it('splits multi-line text into one paragraph per line', () => {
    const nodes = paragraphs('first\n\nsecond\nthird');
    expect(nodes).toHaveLength(3);
    expect(allText(nodes[0])).toEqual(['first']);
    expect(allText(nodes[2])).toEqual(['third']);
  });

  it('never emits an empty block for empty input', () => {
    expect(paragraphs('')).toHaveLength(1);
    expect(allText(numberedSteps(''))).toEqual(['(no steps given)']);
  });

  it('strips bullet and number prefixes from steps', () => {
    const text = allText(numberedSteps('* one\n2. two\n3) three\n• four'));
    expect(text).toEqual(['one', 'two', 'three', 'four']);
  });
});

describe('labels (SPEC 5)', () => {
  it('builds the documented label set', () => {
    expect(buildLabels(baseReport, 'High')).toEqual([
      'src:slack',
      'app:world.roarington.com',
      'env:production',
      'dev:phone',
      'sev:major',
      'freq:always',
      'prio-suggested:high',
    ]);
  });

  it('marks Jira-native bugs with a different source label', () => {
    const labels = buildLabels({ ...baseReport, source: 'jira_native' }, 'Low');
    expect(labels[0]).toBe('src:jira');
  });

  it('never produces a label with whitespace, which Jira rejects', () => {
    const labels = buildLabels(
      { ...baseReport, application: 'Media/editorial', frequency: 'Happened once', device: 'TV/console' },
      'Lowest',
    );
    for (const label of labels) expect(label).not.toMatch(/\s/);
    expect(labels).toContain('app:media-editorial');
    expect(labels).toContain('freq:happened-once');
    expect(labels).toContain('dev:tv');
  });

  it('groups laptops with desktops, because the bug is the same shape', () => {
    expect(deviceClass('Laptop')).toBe('desktop');
    expect(deviceClass('Desktop')).toBe('desktop');
    expect(deviceClass('Tablet')).toBe('tablet');
  });

  it('slugifies predictably', () => {
    expect(slugify('world.roarington.com')).toBe('world.roarington.com');
    expect(slugify('Car Studio')).toBe('car-studio');
    expect(slugify('  Gamepad/joystick ')).toBe('gamepad-joystick');
  });
});

describe('summariseForSlack', () => {
  it('fits the facts on one line', () => {
    const line = summariseForSlack(baseReport);
    expect(line).toContain('world.roarington.com');
    expect(line).toContain('390x844');
    expect(line).toContain('Major/Always');
    expect(line).not.toContain('\n');
  });
});
