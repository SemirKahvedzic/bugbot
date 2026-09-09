/**
 * Severity x Frequency -> suggested Jira priority (SPEC 6).
 *
 * This is a *suggestion*. It is set as the initial priority and stated in the
 * description as such, and the triager overrides it freely - SPEC 7 reads the
 * priority at the moment the issue leaves triage, not this value.
 *
 * Kept as a literal table rather than computed from scores: the whole point is
 * that a human can read the matrix in the spec, read it here, and see they
 * match.
 */
import type { Frequency, Priority, Severity } from '../types.js';

export const PRIORITY_MATRIX: Record<Severity, Record<Frequency, Priority>> = {
  Blocker: {
    Always: 'Highest',
    Sometimes: 'Highest',
    'Happened once': 'High',
  },
  Major: {
    Always: 'High',
    Sometimes: 'High',
    'Happened once': 'Medium',
  },
  Minor: {
    Always: 'Medium',
    Sometimes: 'Low',
    'Happened once': 'Low',
  },
  Cosmetic: {
    Always: 'Low',
    Sometimes: 'Low',
    'Happened once': 'Lowest',
  },
};

export function suggestPriority(severity: Severity, frequency: Frequency): Priority {
  return PRIORITY_MATRIX[severity][frequency];
}

/** One-line explanation, embedded in the issue description. */
export function explainSuggestion(severity: Severity, frequency: Frequency): string {
  const priority = suggestPriority(severity, frequency);
  return `${priority} (suggested from severity ${severity} x frequency ${frequency} - the triager may override this)`;
}
