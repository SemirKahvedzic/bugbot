/**
 * THE routing rules (SPEC 7), as a pure decision function plus a separate
 * executor.
 *
 * `decideRoute` touches nothing and is exhaustively unit tested; `applyRoute`
 * performs the Jira and Slack side effects. `/triage` buttons and the Jira
 * webhook both go through the same pair, so there is exactly one
 * implementation of the rules.
 *
 * Kanban amendment (decided in Phase 0): board 468 is a Kanban board and has
 * no sprints, so the `High`/`Highest` rows set the backlog status and apply
 * labels rather than calling the Agile sprint API. `routed_to` still records
 * `sprint` vs `backlog`, so the SPEC 8 metrics keep the distinction.
 */
import type { Priority } from '../types.js';

export type RouteDestination = 'backlog' | 'sprint' | 'closed';

export interface RouteStatusNames {
  backlog: string;
  rejected: string;
  duplicate: string;
  cannotReproduce: string;
}

export interface RouteDecision {
  destination: RouteDestination;
  /** Status to move the issue to, when routing should move it. */
  targetStatus?: string;
  addLabels: string[];
  /** Thread reply to the reporter about where their bug went. */
  notifyReporter: boolean;
  /** DM the application's team leader. */
  notifyLeader: boolean;
  /** Short note in the announce channel. */
  announce: boolean;
  /** Highest only: tag the reporter in the announce channel. */
  escalated: boolean;
  /** A resolution the reporter should hear about, with the triager's comment. */
  resolution?: 'rejected' | 'duplicate' | 'cannot_reproduce';
  /** Recorded in triage_events and shown in operator messages. */
  reason: string;
}

/** Priorities that go to the backlog rather than to the sprint lane. */
const BACKLOG_PRIORITIES = new Set<Priority>(['Lowest', 'Low', 'Medium']);

/**
 * Decide what happens to an issue that has just left the triage status.
 *
 * `priority` is the priority *at the moment of exit* (SPEC 7), read from the
 * webhook's issue snapshot rather than from anything cached.
 */
export function decideRoute(input: {
  toStatus: string;
  priority?: Priority;
  statuses: RouteStatusNames;
}): RouteDecision {
  const to = input.toStatus.trim().toLowerCase();
  const is = (name: string) => to === name.trim().toLowerCase();

  // Terminal statuses skip routing entirely: the bug is not going anywhere,
  // the reporter just needs to hear why (SPEC 7).
  if (is(input.statuses.rejected)) {
    return closed('rejected', 'triager rejected the report');
  }
  if (is(input.statuses.duplicate)) {
    return closed('duplicate', 'triager marked it a duplicate');
  }
  if (is(input.statuses.cannotReproduce)) {
    return closed('cannot_reproduce', 'triager could not reproduce it');
  }

  // Jira always carries a priority (SUP defaults to Medium), but be explicit
  // rather than crashing if a webhook ever arrives without one.
  const priority: Priority = input.priority ?? 'Medium';

  if (BACKLOG_PRIORITIES.has(priority)) {
    return {
      destination: 'backlog',
      targetStatus: input.statuses.backlog,
      addLabels: ['triaged:backlog'],
      notifyReporter: true,
      notifyLeader: false,
      announce: false,
      escalated: false,
      reason: `priority ${priority} goes to the backlog`,
    };
  }

  if (priority === 'High') {
    return {
      destination: 'sprint',
      targetStatus: input.statuses.backlog,
      addLabels: ['triaged:sprint', 'needs-lead-review'],
      notifyReporter: true,
      notifyLeader: true,
      announce: true,
      escalated: false,
      reason: 'priority High goes to the sprint lane and needs lead review',
    };
  }

  return {
    destination: 'sprint',
    targetStatus: input.statuses.backlog,
    addLabels: ['triaged:sprint', 'escalated'],
    notifyReporter: true,
    notifyLeader: true,
    announce: true,
    escalated: true,
    reason: 'priority Highest is escalated to the sprint lane',
  };
}

function closed(
  resolution: NonNullable<RouteDecision['resolution']>,
  reason: string,
): RouteDecision {
  return {
    destination: 'closed',
    addLabels: [],
    notifyReporter: true,
    notifyLeader: false,
    announce: false,
    escalated: false,
    resolution,
    reason,
  };
}

/** Does this status imply we should ask the reporter for more detail? */
export function resolutionAsksForMore(
  resolution: NonNullable<RouteDecision['resolution']>,
): boolean {
  return resolution === 'cannot_reproduce';
}

/** Human sentence for the reporter's DM or thread reply. */
export function describeResolution(
  resolution: NonNullable<RouteDecision['resolution']>,
): string {
  switch (resolution) {
    case 'rejected':
      return 'was rejected';
    case 'duplicate':
      return 'was closed as a duplicate';
    case 'cannot_reproduce':
      return 'could not be reproduced';
  }
}
