/**
 * Issue operations: create, transition, update, attach, search.
 *
 * Nothing here knows about Slack. It takes a BugReport and gives back an issue
 * key, so the same functions serve the modal, the shortcut and the /triage
 * buttons.
 */
import type { AdfDoc } from '../format/adf.js';
import { renderDescription } from '../format/description.js';
import type { JiraClient, JiraTransition, JiraUser } from './client.js';
import { JiraError } from './client.js';
import type { JiraMeta } from './meta.js';
import { buildLabels, type BugReport, type Priority } from '../types.js';

export interface CreatedIssue {
  id: string;
  key: string;
  self: string;
}

export interface IssueFields {
  summary?: string;
  status?: { id: string; name: string };
  priority?: { id: string; name: string } | null;
  labels?: string[];
  reporter?: { accountId: string; displayName?: string; emailAddress?: string } | null;
  assignee?: { accountId: string; displayName?: string } | null;
  issuetype?: { id: string; name: string };
  created?: string;
  updated?: string;
  project?: { key: string };
}

export interface Issue {
  id: string;
  key: string;
  fields: IssueFields;
}

export interface CreateBugOptions {
  /** Set the real human as Jira reporter. Requires MODIFY_REPORTER. */
  reporterAccountId?: string;
  /** Override the suggested priority. Defaults to the SPEC 6 suggestion. */
  priority?: Priority;
}

export class Issues {
  constructor(
    private readonly client: JiraClient,
    private readonly meta: JiraMeta,
  ) {}

  /**
   * Create the issue, then move it into the triage status.
   *
   * The create screen lands in the workflow's initial status (`To Do` on SUP),
   * so intake is always create-then-transition (SPEC 5). The transition is
   * resolved by target status name at call time; if it is unavailable the issue
   * still exists and the caller is told, because a filed bug in the wrong
   * status beats a lost bug report.
   */
  async createBug(
    report: BugReport,
    triageStatusName: string,
    options: CreateBugOptions = {},
  ): Promise<{ issue: CreatedIssue; priority: Priority; transitioned: boolean }> {
    const { adf, priority: suggested } = renderDescription(report);
    const priority = options.priority ?? suggested;
    const labels = buildLabels(report, priority);

    const fields: Record<string, unknown> = {
      project: { id: this.meta.projectId },
      issuetype: { id: this.meta.issueTypeId },
      summary: report.summary,
      description: adf,
      labels,
      priority: { id: this.meta.priorityId(priority) },
    };
    if (options.reporterAccountId) {
      fields.reporter = { id: options.reporterAccountId };
    }

    let issue: CreatedIssue;
    try {
      issue = await this.client.post<CreatedIssue>('/rest/api/3/issue', { fields });
    } catch (error) {
      // The most common cause is MODIFY_REPORTER being absent. Retry without
      // it rather than losing the report (SPEC 4: the fallback path).
      if (options.reporterAccountId && isReporterRejection(error)) {
        delete fields.reporter;
        issue = await this.client.post<CreatedIssue>('/rest/api/3/issue', { fields });
      } else {
        throw error;
      }
    }

    const transitioned = await this.transitionTo(issue.key, triageStatusName);
    return { issue, priority, transitioned };
  }

  /**
   * Move an issue to a named status.
   *
   * Returns false when the workflow offers no transition there from the issue's
   * current status - which is a real possibility on SUP, whose transitions are
   * restricted rather than global. Callers must handle false, never ignore it.
   */
  async transitionTo(issueKey: string, statusName: string): Promise<boolean> {
    const transitionId = await this.meta.findTransitionId(issueKey, statusName);
    if (!transitionId) return false;
    await this.client.post(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
      transition: { id: transitionId },
    });
    return true;
  }

  transitionsFor(issueKey: string): Promise<JiraTransition[]> {
    return this.meta.transitionsFor(issueKey);
  }

  async setPriority(issueKey: string, priority: Priority): Promise<void> {
    await this.client.put(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      fields: { priority: { id: this.meta.priorityId(priority) } },
    });
  }

  /** Add labels without touching the ones already there. */
  async addLabels(issueKey: string, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.client.put(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      update: { labels: labels.map((label) => ({ add: label })) },
    });
  }

  async removeLabels(issueKey: string, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.client.put(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      update: { labels: labels.map((label) => ({ remove: label })) },
    });
  }

  async setDescription(issueKey: string, adf: AdfDoc): Promise<void> {
    await this.client.put(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      fields: { description: adf },
    });
  }

  async addComment(issueKey: string, body: AdfDoc): Promise<void> {
    await this.client.post(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, { body });
  }

  async getIssue(issueKey: string, fields = DEFAULT_FIELDS): Promise<Issue> {
    return this.client.get<Issue>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      fields: fields.join(','),
    });
  }

  /** The most recent comment body as plain text, for the rejection DM (SPEC 7). */
  async lastCommentText(issueKey: string): Promise<string | undefined> {
    const response = await this.client.get<{
      comments: Array<{ body?: unknown; author?: { displayName?: string } }>;
    }>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      orderBy: '-created',
      maxResults: 1,
    });
    const comment = response.comments?.[0];
    if (!comment) return undefined;
    const text = adfToText(comment.body);
    return text.length > 0 ? text : undefined;
  }

  async attach(
    issueKey: string,
    file: { filename: string; data: ArrayBuffer | Uint8Array; contentType?: string },
  ): Promise<Array<{ id: string; filename: string }>> {
    const form = new FormData();
    const bytes = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    const blob = new Blob([bytes], { type: file.contentType ?? 'application/octet-stream' });
    form.append('file', blob, file.filename);
    return this.client.postForm<Array<{ id: string; filename: string }>>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`,
      form,
    );
  }

  /** JQL search. Uses the current /search/jql endpoint (SPEC 3). */
  async search(
    jql: string,
    options: { maxResults?: number; fields?: string[] } = {},
  ): Promise<Issue[]> {
    const response = await this.client.post<{ issues?: Issue[] }>('/rest/api/3/search/jql', {
      jql,
      maxResults: options.maxResults ?? 50,
      fields: options.fields ?? DEFAULT_FIELDS,
    });
    return response.issues ?? [];
  }

  /**
   * Jira accountId for an email address.
   *
   * Returns undefined rather than throwing when the site hides email addresses
   * - SPEC 4 says a bug with no identity mapping must still funnel correctly.
   */
  async findAccountIdByEmail(email: string): Promise<string | undefined> {
    try {
      const users = await this.client.get<JiraUser[]>('/rest/api/3/user/search', { query: email });
      const match = users.find(
        (user) => user.emailAddress?.toLowerCase() === email.toLowerCase() && user.active,
      );
      return match?.accountId;
    } catch {
      return undefined;
    }
  }
}

export const DEFAULT_FIELDS = [
  'summary',
  'status',
  'priority',
  'labels',
  'reporter',
  'assignee',
  'issuetype',
  'created',
  'updated',
];

/** Did Jira reject the call specifically because of the reporter field? */
function isReporterRejection(error: unknown): boolean {
  if (!(error instanceof JiraError)) return false;
  if (error.status !== 400 && error.status !== 403) return false;
  return error.messages.some((message) => /reporter/i.test(message));
}

/** Flatten an ADF document to plain text. Good enough for a Slack DM. */
export function adfToText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const current = node as { type?: string; text?: string; content?: unknown[] };
  if (typeof current.text === 'string') return current.text;
  if (!Array.isArray(current.content)) return '';
  const parts = current.content.map((child) => adfToText(child)).filter(Boolean);
  // Block-level nodes become separate lines; inline nodes run together.
  const separator = BLOCK_TYPES.has(current.type ?? '') ? '\n' : '';
  return parts.join(separator || ' ').replace(/\s*\n\s*/g, '\n').trim();
}

const BLOCK_TYPES = new Set([
  'doc',
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'panel',
  'codeBlock',
]);
