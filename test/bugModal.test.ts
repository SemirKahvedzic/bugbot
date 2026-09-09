import { describe, expect, it } from 'vitest';
import {
  BUG_MODAL_CALLBACK_ID,
  buildBugModal,
  FIELD,
  parseBugModalSubmission,
  parseMetadata,
  SUMMARY_MAX_LENGTH,
  type SubmittedView,
} from '../src/slack/views/bugModal.js';
import { prefillFromMessage } from '../src/slack/shortcuts/reportBug.js';
import { APPLICATIONS, DEVICES, ENVIRONMENTS, FREQUENCIES, INPUT_METHODS, SEVERITIES } from '../src/types.js';

/** Build a submission payload the way Slack would send one. */
function submission(overrides: Record<string, unknown> = {}, metadata = {}): SubmittedView {
  const text = (value: string) => ({ value });
  const pick = (value: string) => ({ selected_option: { value } });
  const picks = (...values: string[]) => ({
    selected_options: values.map((value) => ({ value })),
  });

  const values: Record<string, Record<string, unknown>> = {
    [FIELD.summary]: { [`${FIELD.summary}_input`]: text('Brake lights lag') },
    [FIELD.application]: { [`${FIELD.application}_input`]: pick('world.roarington.com') },
    [FIELD.environment]: { [`${FIELD.environment}_input`]: pick('Production') },
    [FIELD.device]: { [`${FIELD.device}_input`]: pick('Phone') },
    [FIELD.deviceModel]: { [`${FIELD.deviceModel}_input`]: text('iPhone 15 Pro') },
    [FIELD.os]: { [`${FIELD.os}_input`]: text('iOS 18.2') },
    [FIELD.browser]: { [`${FIELD.browser}_input`]: text('Safari 18') },
    [FIELD.viewport]: { [`${FIELD.viewport}_input`]: text('390x844') },
    [FIELD.inputMethods]: { [`${FIELD.inputMethods}_input`]: picks('Touch') },
    [FIELD.steps]: { [`${FIELD.steps}_input`]: text('1. Drive\n2. Brake') },
    [FIELD.expected]: { [`${FIELD.expected}_input`]: text('Lights on') },
    [FIELD.actual]: { [`${FIELD.actual}_input`]: text('Lights late') },
    [FIELD.frequency]: { [`${FIELD.frequency}_input`]: pick('Always') },
    [FIELD.severity]: { [`${FIELD.severity}_input`]: pick('Major') },
    [FIELD.notes]: { [`${FIELD.notes}_input`]: text('') },
  };

  for (const [blockId, value] of Object.entries(overrides)) {
    values[blockId] = { [`${blockId}_input`]: value as Record<string, unknown> };
  }

  return {
    private_metadata: JSON.stringify(metadata),
    state: { values } as SubmittedView['state']['values'] extends never ? never : never,
  } as unknown as SubmittedView;
}

describe('buildBugModal', () => {
  const view = buildBugModal();

  it('is a modal Slack will accept', () => {
    expect(view.type).toBe('modal');
    expect(view.callback_id).toBe(BUG_MODAL_CALLBACK_ID);
    expect(view.submit).toBeDefined();
    // Slack rejects titles over 24 characters.
    expect(view.title.text.length).toBeLessThanOrEqual(24);
    expect(view.blocks.length).toBeLessThanOrEqual(100);
  });

  it('asks for every field in the SPEC 5 table', () => {
    const blockIds = view.blocks.map((block) => (block as { block_id?: string }).block_id);
    for (const field of Object.values(FIELD)) {
      expect(blockIds).toContain(field);
    }
  });

  it('requires exactly the eight fields a bug cannot be worked without', () => {
    // Filing has to be quick, so only these are mandatory: enough to
    // reproduce, plus what the SPEC 6 priority matrix needs.
    const required = view.blocks
      .filter((block) => block.type === 'input')
      .filter((block) => (block as { optional?: boolean }).optional !== true)
      .map((block) => (block as { block_id?: string }).block_id);

    expect(required.sort()).toEqual(
      [
        FIELD.summary,
        FIELD.application,
        FIELD.environment,
        FIELD.device,
        FIELD.steps,
        FIELD.actual,
        FIELD.frequency,
        FIELD.severity,
      ].sort(),
    );
  });

  it('marks the rest optional', () => {
    const optional = view.blocks
      .filter((block) => (block as { optional?: boolean }).optional === true)
      .map((block) => (block as { block_id?: string }).block_id);

    expect(optional.sort()).toEqual(
      [
        FIELD.deviceModel,
        FIELD.os,
        FIELD.browser,
        FIELD.viewport,
        FIELD.inputMethods,
        FIELD.expected,
        FIELD.notes,
      ].sort(),
    );
  });

  it('offers exactly the configured options, so the parser cannot drift', () => {
    const optionsFor = (blockId: string) => {
      const block = view.blocks.find((b) => (b as { block_id?: string }).block_id === blockId) as {
        element?: { options?: Array<{ value: string }> };
      };
      return block.element?.options?.map((option) => option.value);
    };

    expect(optionsFor(FIELD.application)).toEqual([...APPLICATIONS]);
    expect(optionsFor(FIELD.environment)).toEqual([...ENVIRONMENTS]);
    expect(optionsFor(FIELD.device)).toEqual([...DEVICES]);
    expect(optionsFor(FIELD.frequency)).toEqual([...FREQUENCIES]);
    expect(optionsFor(FIELD.severity)).toEqual([...SEVERITIES]);
    expect(optionsFor(FIELD.inputMethods)).toEqual([...INPUT_METHODS]);
  });

  it('caps the summary at the documented length', () => {
    const block = view.blocks.find((b) => (b as { block_id?: string }).block_id === FIELD.summary) as {
      element?: { max_length?: number };
    };
    expect(block.element?.max_length).toBe(SUMMARY_MAX_LENGTH);
  });

  it('spells out that viewport means window size, not screen size', () => {
    const block = view.blocks.find((b) => (b as { block_id?: string }).block_id === FIELD.viewport) as {
      hint?: { text: string };
    };
    expect(block.hint?.text).toMatch(/not screen size/i);
  });

  it('round-trips metadata through private_metadata', () => {
    const withMeta = buildBugModal({
      metadata: { channelId: 'C1', threadTs: '123.456', source: 'slack_shortcut' },
    });
    expect(parseMetadata({ private_metadata: withMeta.private_metadata, state: { values: {} } })).toEqual(
      { channelId: 'C1', threadTs: '123.456', source: 'slack_shortcut' },
    );
  });

  it('prefills the summary and steps when asked', () => {
    const prefilled = buildBugModal({ prefill: { summary: 'Hello', steps: 'Step one' } });
    const initial = (blockId: string) => {
      const block = prefilled.blocks.find(
        (b) => (b as { block_id?: string }).block_id === blockId,
      ) as { element?: { initial_value?: string } };
      return block.element?.initial_value;
    };
    expect(initial(FIELD.summary)).toBe('Hello');
    expect(initial(FIELD.steps)).toBe('Step one');
  });
});

describe('parseBugModalSubmission', () => {
  it('accepts a complete submission and normalises it', () => {
    const result = parseBugModalSubmission(submission({}, { channelId: 'C0AU6L9FPME' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.report.summary).toBe('Brake lights lag');
    expect(result.report.application).toBe('world.roarington.com');
    expect(result.report.viewport).toBe('390x844');
    expect(result.report.inputMethods).toEqual(['Touch']);
    expect(result.report.deviceModel).toBe('iPhone 15 Pro');
    expect(result.metadata.channelId).toBe('C0AU6L9FPME');
  });

  it('omits optional fields rather than storing empty strings', () => {
    const result = parseBugModalSubmission(submission());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.notes).toBeUndefined();
  });

  it.each([
    ['1440 x 900', '1440x900'],
    ['1440x900', '1440x900'],
    ['390×844', '390x844'],
    ['800 X 600', '800x600'],
  ])('normalises viewport %s to %s', (input, expected) => {
    const result = parseBugModalSubmission(submission({ [FIELD.viewport]: { value: input } }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.report.viewport).toBe(expected);
  });

  it.each(['1440', 'big', '14400x900000', 'x900', '90x90'])(
    'rejects viewport %s with a field-level error',
    (input) => {
      const result = parseBugModalSubmission(submission({ [FIELD.viewport]: { value: input } }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors[FIELD.viewport]).toMatch(/1440x900/);
    },
  );

  it('rejects an option that is not in our list, which would mean a drifted modal', () => {
    const result = parseBugModalSubmission(
      submission({ [FIELD.application]: { selected_option: { value: 'shop.example.com' } } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[FIELD.application]).toBeDefined();
  });

  it('accepts a submission with only the eight required fields', () => {
    const result = parseBugModalSubmission(
      submission({
        [FIELD.deviceModel]: { value: '' },
        [FIELD.os]: { value: '' },
        [FIELD.browser]: { value: '' },
        [FIELD.viewport]: { value: '' },
        [FIELD.inputMethods]: { selected_options: [] },
        [FIELD.expected]: { value: '' },
        [FIELD.notes]: { value: '' },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Absent rather than empty strings, so every renderer can just test truthiness.
    expect(result.report.os).toBeUndefined();
    expect(result.report.browser).toBeUndefined();
    expect(result.report.viewport).toBeUndefined();
    expect(result.report.inputMethods).toBeUndefined();
    expect(result.report.expected).toBeUndefined();
    expect(result.report.summary).toBe('Brake lights lag');
    expect(result.report.actual).toBe('Lights late');
  });

  it('accepts an empty viewport but still rejects a malformed one', () => {
    // A malformed viewport is worse than none: it looks like data.
    expect(parseBugModalSubmission(submission({ [FIELD.viewport]: { value: '' } })).ok).toBe(true);

    const bad = parseBugModalSubmission(submission({ [FIELD.viewport]: { value: 'huge' } }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[FIELD.viewport]).toMatch(/1440x900/);
  });

  it.each([FIELD.steps, FIELD.actual])('requires %s', (field) => {
    const result = parseBugModalSubmission(submission({ [field]: { value: '   ' } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[field]).toBeDefined();
  });

  it.each([FIELD.os, FIELD.browser, FIELD.expected, FIELD.deviceModel, FIELD.notes])(
    'does not require %s',
    (field) => {
      expect(parseBugModalSubmission(submission({ [field]: { value: '   ' } })).ok).toBe(true);
    },
  );

  it('reports every problem at once, not just the first', () => {
    const result = parseBugModalSubmission(
      submission({
        [FIELD.summary]: { value: '' },
        [FIELD.viewport]: { value: 'nope' },
        [FIELD.steps]: { value: '' },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(
      [FIELD.summary, FIELD.viewport, FIELD.steps].sort(),
    );
  });

  it('still rejects an option that is not in our list', () => {
    // Optional means "may be blank", not "may be anything".
    const result = parseBugModalSubmission(
      submission({ [FIELD.inputMethods]: { selected_options: [{ value: 'Telepathy' }] } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.report.inputMethods).toBeUndefined();
  });

  it('survives malformed private_metadata instead of losing the report', () => {
    const view = submission();
    view.private_metadata = 'not json';
    const result = parseBugModalSubmission(view);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.metadata).toEqual({});
  });
});

describe('prefillFromMessage (shortcut)', () => {
  it('uses the first line as the summary and the whole message as steps', () => {
    const prefill = prefillFromMessage('Brakes are broken\nHappens every lap');
    expect(prefill.summary).toBe('Brakes are broken');
    expect(prefill.steps).toContain('Happens every lap');
  });

  it('truncates a very long first line to the summary limit', () => {
    const prefill = prefillFromMessage('x'.repeat(400));
    expect(prefill.summary?.length).toBe(SUMMARY_MAX_LENGTH);
  });

  it('returns nothing for an empty message', () => {
    expect(prefillFromMessage('   ')).toEqual({});
    expect(prefillFromMessage(undefined)).toEqual({});
  });
});
