/**
 * Resolves the configured Jira *names* to live IDs, once, at boot.
 *
 * SPEC 2 forbids hardcoded IDs. Names come from env; this module turns them
 * into IDs against the real site and throws a message naming what does exist
 * when one is missing - so a workflow rename breaks startup with an actionable
 * error instead of quietly mis-routing a bug at 2am.
 *
 * Transition IDs are deliberately absent: they are resolved per issue at call
 * time by matching the target status name, which survives workflow edits and
 * works even on an empty project where no transition has ever been observed.
 */
import type {
  JiraBoardConfiguration,
  JiraClient,
  JiraIssueTypeStatuses,
  JiraPriority,
  JiraProject,
  JiraTransition,
} from './client.js';

export class JiraMetaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JiraMetaError';
  }
}

export interface JiraMetaOptions {
  projectKey: string;
  issueTypeName: string;
  /** Read for its column order. Omitted, the workflow order is used instead. */
  boardId?: number;
}

const normalise = (value: string) => value.trim().toLowerCase();

export interface JiraMetaSnapshot {
  project: JiraProject;
  issueTypes: JiraIssueTypeStatuses[];
  priorities: JiraPriority[];
  /**
   * Status ids in the order the board lays its columns out, flattened across
   * columns. Absent when the board could not be read.
   */
  boardStatusIds?: string[];
}

export class JiraMeta {
  private snapshot?: JiraMetaSnapshot;

  constructor(
    private readonly client: JiraClient,
    private readonly options: JiraMetaOptions,
  ) {}

  /** Fetch project, per-issue-type statuses and the priority scheme. */
  async load(): Promise<JiraMetaSnapshot> {
    const { projectKey } = this.options;
    const [project, issueTypes, priorities] = await Promise.all([
      this.client.get<JiraProject>(`/rest/api/3/project/${encodeURIComponent(projectKey)}`),
      this.client.get<JiraIssueTypeStatuses[]>(
        `/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`,
      ),
      this.client.get<JiraPriority[]>('/rest/api/3/priority'),
    ]);
    const boardStatusIds = await this.loadBoardStatusIds();

    this.snapshot = {
      project,
      issueTypes,
      priorities,
      ...(boardStatusIds ? { boardStatusIds } : {}),
    };
    return this.snapshot;
  }

  /**
   * The board's column order, or undefined.
   *
   * Deliberately not fatal. Reading a board needs the Agile API and a board
   * the service account can see, and neither is required for any other part
   * of the service - so a failure here costs a nicely ordered menu, and must
   * not cost a boot.
   */
  private async loadBoardStatusIds(): Promise<string[] | undefined> {
    const { boardId } = this.options;
    if (boardId === undefined) return undefined;

    try {
      const board = await this.client.get<JiraBoardConfiguration>(
        `/rest/agile/1.0/board/${boardId}/configuration`,
      );
      const ids = (board.columnConfig?.columns ?? []).flatMap((column) =>
        (column.statuses ?? []).map((status) => status.id),
      );
      return ids.length > 0 ? ids : undefined;
    } catch {
      return undefined;
    }
  }

  private requireSnapshot(): JiraMetaSnapshot {
    if (!this.snapshot) {
      throw new JiraMetaError('JiraMeta.load() must be awaited before resolving names.');
    }
    return this.snapshot;
  }

  get projectId(): string {
    return this.requireSnapshot().project.id;
  }

  get projectKey(): string {
    return this.requireSnapshot().project.key;
  }

  /** The configured issue type, as it exists in this project. */
  private issueType(): JiraIssueTypeStatuses {
    const { issueTypes } = this.requireSnapshot();
    const wanted = normalise(this.options.issueTypeName);
    const match = issueTypes.find((type) => normalise(type.name) === wanted);
    if (!match) {
      const available = issueTypes.map((type) => type.name).join(', ');
      throw new JiraMetaError(
        `Issue type "${this.options.issueTypeName}" does not exist in project ` +
          `${this.options.projectKey}. Available: ${available || '(none)'}. ` +
          `Set JIRA_ISSUE_TYPE to one of these.`,
      );
    }
    return match;
  }

  get issueTypeId(): string {
    return this.issueType().id;
  }

  get issueTypeName(): string {
    return this.issueType().name;
  }

  /** Status names reachable by the configured issue type, in Jira's order. */
  statusNames(): string[] {
    return this.issueType().statuses.map((status) => status.name);
  }

  /**
   * Status names in the order the board shows its columns.
   *
   * Not the same as workflow order, and the difference is visible on SUP: the
   * board puts Cannot Reproduce, Rejected and Duplicate between In Progress
   * and Ready for Validation, and nothing in the workflow says so. Only the
   * board configuration does.
   *
   * A status the board does not show is appended rather than dropped, so a
   * column missing from the board never makes a status unreachable.
   */
  statusNamesInBoardOrder(): string[] {
    const ids = this.requireSnapshot().boardStatusIds;
    const statuses = this.issueType().statuses;
    if (!ids) return this.statusNames();

    const nameById = new Map(statuses.map((status) => [status.id, status.name]));
    const onBoard = ids
      .map((id) => nameById.get(id))
      .filter((name): name is string => name !== undefined);

    const seen = new Set(onBoard);
    const offBoard = statuses.map((status) => status.name).filter((name) => !seen.has(name));

    return [...onBoard, ...offBoard];
  }

  statusId(name: string): string {
    const wanted = normalise(name);
    const match = this.issueType().statuses.find((status) => normalise(status.name) === wanted);
    if (!match) {
      throw new JiraMetaError(
        `Status "${name}" is not part of the ${this.issueTypeName} workflow in ` +
          `${this.options.projectKey}. Available: ${this.statusNames().join(', ') || '(none)'}.`,
      );
    }
    return match.id;
  }

  /** True when the status exists, for callers that want to degrade instead of throw. */
  hasStatus(name: string): boolean {
    const wanted = normalise(name);
    return this.issueType().statuses.some((status) => normalise(status.name) === wanted);
  }

  priorityNames(): string[] {
    return this.requireSnapshot().priorities.map((priority) => priority.name);
  }

  priorityId(name: string): string {
    const wanted = normalise(name);
    const match = this.requireSnapshot().priorities.find(
      (priority) => normalise(priority.name) === wanted,
    );
    if (!match) {
      throw new JiraMetaError(
        `Priority "${name}" does not exist on this site. ` +
          `Available: ${this.priorityNames().join(', ') || '(none)'}.`,
      );
    }
    return match.id;
  }

  /** Every transition currently offered on an issue. */
  async transitionsFor(issueKey: string): Promise<JiraTransition[]> {
    const response = await this.client.get<{ transitions: JiraTransition[] }>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    );
    return response.transitions ?? [];
  }

  /**
   * The transition that lands an issue in `targetStatusName`, resolved live.
   * Returns undefined when no such transition is available from the issue's
   * current status - callers decide whether that is fatal.
   */
  async findTransitionId(issueKey: string, targetStatusName: string): Promise<string | undefined> {
    const wanted = normalise(targetStatusName);
    const transitions = await this.transitionsFor(issueKey);
    return transitions.find((transition) => normalise(transition.to.name) === wanted)?.id;
  }
}

/**
 * Assert every configured status name exists, all at once, so startup reports
 * the full list of problems rather than the first one.
 */
export function assertStatusesExist(meta: JiraMeta, names: Record<string, string>): void {
  const missing = Object.entries(names).filter(([, name]) => !meta.hasStatus(name));
  if (missing.length === 0) return;
  const detail = missing.map(([key, name]) => `${key}="${name}"`).join(', ');
  throw new JiraMetaError(
    `These configured statuses are not in the ${meta.issueTypeName} workflow: ${detail}. ` +
      `The workflow offers: ${meta.statusNames().join(', ') || '(none)'}.`,
  );
}
