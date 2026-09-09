import { describe, expect, it } from 'vitest';
import { decideRoute, describeResolution, resolutionAsksForMore } from '../src/triage/route.js';
import { PRIORITIES, type Priority } from '../src/types.js';

/** The real SUP status names. */
const STATUSES = {
  backlog: 'To Do',
  rejected: 'Rejected',
  duplicate: 'Duplicate',
  cannotReproduce: 'Cannot Reproduce',
};

const route = (priority: Priority | undefined, toStatus = 'In Progress') =>
  decideRoute({ toStatus, ...(priority ? { priority } : {}), statuses: STATUSES });

describe('decideRoute: the five priority paths (SPEC 7)', () => {
  it.each(['Lowest', 'Low', 'Medium'] as Priority[])('%s goes to the backlog', (priority) => {
    const decision = route(priority);
    expect(decision.destination).toBe('backlog');
    expect(decision.targetStatus).toBe('To Do');
    expect(decision.addLabels).toEqual(['triaged:backlog']);
    expect(decision.notifyReporter).toBe(true);
    expect(decision.notifyLeader).toBe(false);
    expect(decision.announce).toBe(false);
    expect(decision.escalated).toBe(false);
  });

  it('High goes to the sprint lane and asks for lead review', () => {
    const decision = route('High');
    expect(decision.destination).toBe('sprint');
    expect(decision.targetStatus).toBe('To Do');
    expect(decision.addLabels).toEqual(['triaged:sprint', 'needs-lead-review']);
    expect(decision.notifyLeader).toBe(true);
    expect(decision.announce).toBe(true);
    expect(decision.escalated).toBe(false);
  });

  it('Highest is escalated', () => {
    const decision = route('Highest');
    expect(decision.destination).toBe('sprint');
    expect(decision.addLabels).toEqual(['triaged:sprint', 'escalated']);
    expect(decision.notifyLeader).toBe(true);
    expect(decision.announce).toBe(true);
    expect(decision.escalated).toBe(true);
  });

  it('covers every priority Jira can give us', () => {
    for (const priority of PRIORITIES) {
      const decision = route(priority);
      expect(['backlog', 'sprint']).toContain(decision.destination);
      expect(decision.reason).toBeTruthy();
    }
  });

  it('treats a missing priority as Medium rather than crashing', () => {
    const decision = route(undefined);
    expect(decision.destination).toBe('backlog');
    expect(decision.addLabels).toEqual(['triaged:backlog']);
  });
});

describe('decideRoute: terminal statuses skip routing (SPEC 7)', () => {
  it.each([
    ['Rejected', 'rejected'],
    ['Duplicate', 'duplicate'],
    ['Cannot Reproduce', 'cannot_reproduce'],
  ])('%s produces a resolution, not a route', (status, resolution) => {
    const decision = decideRoute({
      toStatus: status,
      priority: 'Highest',
      statuses: STATUSES,
    });
    expect(decision.destination).toBe('closed');
    expect(decision.resolution).toBe(resolution);
    // No move, no labels, nobody but the reporter is told.
    expect(decision.targetStatus).toBeUndefined();
    expect(decision.addLabels).toEqual([]);
    expect(decision.notifyReporter).toBe(true);
    expect(decision.notifyLeader).toBe(false);
    expect(decision.announce).toBe(false);
  });

  it('ignores priority entirely for a terminal status', () => {
    for (const priority of PRIORITIES) {
      const decision = decideRoute({ toStatus: 'Rejected', priority, statuses: STATUSES });
      expect(decision.destination).toBe('closed');
      expect(decision.notifyLeader).toBe(false);
    }
  });

  it('matches status names case- and whitespace-insensitively', () => {
    for (const variant of ['cannot reproduce', '  Cannot Reproduce  ', 'CANNOT REPRODUCE']) {
      expect(decideRoute({ toStatus: variant, statuses: STATUSES }).destination).toBe('closed');
    }
  });

  it('respects renamed statuses from config rather than hardcoding them', () => {
    const decision = decideRoute({
      toStatus: 'Wont Fix',
      priority: 'High',
      statuses: { ...STATUSES, rejected: 'Wont Fix' },
    });
    expect(decision.destination).toBe('closed');
    expect(decision.resolution).toBe('rejected');
  });
});

describe('decideRoute is pure', () => {
  it('returns a fresh label array each time, so callers can push to it', () => {
    const first = route('High');
    first.addLabels.push('needs-manual-move');
    const second = route('High');
    expect(second.addLabels).toEqual(['triaged:sprint', 'needs-lead-review']);
  });
});

describe('resolution helpers', () => {
  it('only asks for more information where the status implies it', () => {
    expect(resolutionAsksForMore('cannot_reproduce')).toBe(true);
    expect(resolutionAsksForMore('rejected')).toBe(false);
    expect(resolutionAsksForMore('duplicate')).toBe(false);
  });

  it('describes each resolution in plain words', () => {
    expect(describeResolution('rejected')).toBe('was rejected');
    expect(describeResolution('duplicate')).toContain('duplicate');
    expect(describeResolution('cannot_reproduce')).toContain('reproduce');
  });
});
