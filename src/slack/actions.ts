/** Interaction ids, shared by the block builders and the handlers. */

export const ACTION = {
  triageBacklog: 'triage_backlog',
  triageSprint: 'triage_sprint',
  triageNeedInfo: 'triage_need_info',
  triageDuplicate: 'triage_duplicate',
  leaderApprove: 'leader_approve',
  leaderReassign: 'leader_reassign',
  homeRefresh: 'home_refresh',
  homeFileBug: 'home_file_bug',
  /**
   * A link button on an App Home card. Slack sends an interaction even for a
   * pure URL button, so it needs a handler that does nothing but acknowledge -
   * otherwise every click logs an unhandled request.
   */
  openIssue: 'open_issue',
  /** The "Move to..." menu on an App Home card. */
  moveIssue: 'move_issue',
} as const;

/**
 * A Slack option carries one string, and a move needs two things: which issue
 * and which status. They travel joined by "::" - a separator no Jira status
 * name or issue key contains.
 */
export function moveValue(issueKey: string, statusName: string): string {
  return `${issueKey}::${statusName}`;
}

export function parseMoveValue(
  value: string,
): { issueKey: string; statusName: string } | undefined {
  const at = value.indexOf('::');
  if (at <= 0) return undefined;
  const issueKey = value.slice(0, at);
  const statusName = value.slice(at + 2);
  return statusName ? { issueKey, statusName } : undefined;
}

export const SHORTCUT = {
  reportAsBug: 'report_as_bug',
} as const;

export const COMMAND = {
  bug: '/bug',
  myBugs: '/mybugs',
  triage: '/triage',
  bugStats: '/bugstats',
} as const;

/** Priority each /triage button assigns before routing (SPEC 7). */
export const TRIAGE_BUTTON_PRIORITY = {
  [ACTION.triageBacklog]: 'Low',
  [ACTION.triageSprint]: 'High',
} as const;
