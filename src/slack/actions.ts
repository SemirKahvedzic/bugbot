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
} as const;

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
