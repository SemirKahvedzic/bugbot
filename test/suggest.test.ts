import { describe, expect, it } from 'vitest';
import { explainSuggestion, PRIORITY_MATRIX, suggestPriority } from '../src/triage/suggest.js';
import { FREQUENCIES, SEVERITIES, type Frequency, type Priority, type Severity } from '../src/types.js';

/**
 * The SPEC 6 table, transcribed independently of the implementation. If these
 * two ever disagree, one of them is a typo and the test says which cell.
 */
const EXPECTED: Array<[Severity, Frequency, Priority]> = [
  ['Blocker', 'Always', 'Highest'],
  ['Blocker', 'Sometimes', 'Highest'],
  ['Blocker', 'Happened once', 'High'],
  ['Major', 'Always', 'High'],
  ['Major', 'Sometimes', 'High'],
  ['Major', 'Happened once', 'Medium'],
  ['Minor', 'Always', 'Medium'],
  ['Minor', 'Sometimes', 'Low'],
  ['Minor', 'Happened once', 'Low'],
  ['Cosmetic', 'Always', 'Low'],
  ['Cosmetic', 'Sometimes', 'Low'],
  ['Cosmetic', 'Happened once', 'Lowest'],
];

describe('suggestPriority (SPEC 6)', () => {
  it.each(EXPECTED)('%s x %s -> %s', (severity, frequency, expected) => {
    expect(suggestPriority(severity, frequency)).toBe(expected);
  });

  it('covers every severity and frequency combination', () => {
    expect(EXPECTED).toHaveLength(SEVERITIES.length * FREQUENCIES.length);
    for (const severity of SEVERITIES) {
      for (const frequency of FREQUENCIES) {
        expect(PRIORITY_MATRIX[severity][frequency]).toBeDefined();
      }
    }
  });

  it('never suggests a priority outside Jira\'s five', () => {
    const valid = new Set(['Highest', 'High', 'Medium', 'Low', 'Lowest']);
    for (const severity of SEVERITIES) {
      for (const frequency of FREQUENCIES) {
        expect(valid.has(suggestPriority(severity, frequency))).toBe(true);
      }
    }
  });

  it('is monotonic: a rarer bug is never suggested as more urgent', () => {
    const rank: Record<Priority, number> = { Highest: 5, High: 4, Medium: 3, Low: 2, Lowest: 1 };
    for (const severity of SEVERITIES) {
      const always = rank[suggestPriority(severity, 'Always')];
      const sometimes = rank[suggestPriority(severity, 'Sometimes')];
      const once = rank[suggestPriority(severity, 'Happened once')];
      expect(always).toBeGreaterThanOrEqual(sometimes);
      expect(sometimes).toBeGreaterThanOrEqual(once);
    }
  });

  it('is monotonic: a less severe bug is never suggested as more urgent', () => {
    const rank: Record<Priority, number> = { Highest: 5, High: 4, Medium: 3, Low: 2, Lowest: 1 };
    for (const frequency of FREQUENCIES) {
      const ranked = SEVERITIES.map((severity) => rank[suggestPriority(severity, frequency)]);
      // SEVERITIES is ordered Blocker -> Cosmetic, so this must be descending.
      for (let i = 1; i < ranked.length; i += 1) {
        expect(ranked[i - 1]!).toBeGreaterThanOrEqual(ranked[i]!);
      }
    }
  });
});

describe('explainSuggestion', () => {
  it('states the priority, the inputs, and that it can be overridden', () => {
    const text = explainSuggestion('Blocker', 'Always');
    expect(text).toContain('Highest');
    expect(text).toContain('Blocker');
    expect(text).toContain('Always');
    expect(text).toMatch(/override/i);
  });
});
