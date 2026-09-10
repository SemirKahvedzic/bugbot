/**
 * Thin typed Jira REST wrapper (SPEC 3). No SDK.
 *
 * Uses the global `fetch` (Node's built-in undici) rather than `undici.request`
 * so that msw can intercept it in tests - `undici.request` bypasses the
 * interceptors msw installs.
 */

export interface JiraClientOptions {
  baseUrl: string;
  email: string;
  apiToken: string;
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Injected for tests, so retry backoff costs no wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
  /** Base backoff in ms. Default 300. */
  backoffBaseMs?: number;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Extra headers. Authorization is always set by the client. */
  headers?: Record<string, string>;
}

/**
 * A failed Jira call. Deliberately carries no request headers, so logging or
 * stringifying it can never expose the API token.
 */
export class JiraError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly messages: string[],
    readonly body?: unknown,
  ) {
    const detail = messages.length > 0 ? messages.join('; ') : `HTTP ${status}`;
    super(`Jira ${method} ${path} failed (${status}): ${detail}`);
    this.name = 'JiraError';
  }

  /** 404 on a specific resource is often expected; 5xx never is. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Pull the human-readable bits out of Jira's several error body shapes. */
function extractMessages(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const record = body as Record<string, unknown>;
  const out: string[] = [];
  if (Array.isArray(record.errorMessages)) out.push(...record.errorMessages.map(String));
  if (record.errors && typeof record.errors === 'object') {
    for (const [field, message] of Object.entries(record.errors as Record<string, unknown>)) {
      out.push(`${field}: ${String(message)}`);
    }
  }
  if (typeof record.message === 'string') out.push(record.message);
  return out;
}

export class JiraClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backoffBaseMs: number;

  constructor(options: JiraClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    const credentials = `${options.email}:${options.apiToken}`;
    this.authHeader = `Basic ${Buffer.from(credentials).toString('base64')}`;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.backoffBaseMs = options.backoffBaseMs ?? 300;
  }

  private url(path: string, query?: RequestOptions['query']): string {
    const url = new URL(path.startsWith('/') ? path : `/${path}`, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /** How long to wait before the next attempt, honouring Retry-After. */
  private delayFor(attempt: number, retryAfter: string | null): number {
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30000);
    }
    const exponential = this.backoffBaseMs * 2 ** (attempt - 1);
    return exponential + Math.random() * this.backoffBaseMs;
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.url(path, options.query);
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: 'application/json',
      ...options.headers,
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    let lastError: JiraError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        if (text.length === 0) return undefined as T;
        return JSON.parse(text) as T;
      }

      const raw = await response.text().catch(() => '');
      let parsed: unknown;
      try {
        parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        parsed = raw.slice(0, 500);
      }
      const messages = extractMessages(parsed);
      if (messages.length === 0 && typeof parsed === 'string' && parsed.length > 0) {
        messages.push(parsed);
      }
      lastError = new JiraError(response.status, method, path, messages, parsed);

      if (!isRetryable(response.status) || attempt === this.maxAttempts) throw lastError;

      await this.sleep(this.delayFor(attempt, response.headers.get('retry-after')));
    }

    throw lastError ?? new JiraError(0, method, path, ['request failed with no response']);
  }

  get<T>(path: string, query?: RequestOptions['query']): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  post<T>(path: string, body?: unknown, query?: RequestOptions['query']): Promise<T> {
    return this.request<T>('POST', path, { body, query });
  }

  put<T>(path: string, body?: unknown, query?: RequestOptions['query']): Promise<T> {
    return this.request<T>('PUT', path, { body, query });
  }

  /** Jira answers a successful DELETE with 204 and no body, hence `Promise<void>`. */
  delete(path: string, query?: RequestOptions['query']): Promise<void> {
    return this.request<void>('DELETE', path, { query });
  }

  /**
   * Multipart upload, for attachments.
   *
   * `Content-Type` is deliberately not set - fetch has to generate it with the
   * multipart boundary. `X-Atlassian-Token: no-check` is Jira's required opt
   * out of its XSRF check on this endpoint; without it the call is rejected.
   */
  async postForm<T>(path: string, form: FormData): Promise<T> {
    const url = this.url(path);
    let lastError: JiraError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: this.authHeader,
          Accept: 'application/json',
          'X-Atlassian-Token': 'no-check',
        },
        body: form,
      });

      if (response.ok) {
        const text = await response.text();
        return (text.length > 0 ? JSON.parse(text) : undefined) as T;
      }

      const raw = await response.text().catch(() => '');
      let parsed: unknown;
      try {
        parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        parsed = raw.slice(0, 500);
      }
      lastError = new JiraError(response.status, 'POST', path, extractMessages(parsed), parsed);

      if (!isRetryable(response.status) || attempt === this.maxAttempts) throw lastError;
      await this.sleep(this.delayFor(attempt, response.headers.get('retry-after')));
    }

    throw lastError ?? new JiraError(0, 'POST', path, ['upload failed with no response']);
  }

  /**
   * The tenant's cloud ID. Unauthenticated site endpoint, so it is the one
   * value we can verify before we know the credentials work (SPEC 2).
   */
  async tenantInfo(): Promise<{ cloudId: string }> {
    const response = await this.fetchImpl(this.url('/_edge/tenant_info'), {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new JiraError(response.status, 'GET', '/_edge/tenant_info', [
        'could not read tenant info',
      ]);
    }
    return (await response.json()) as { cloudId: string };
  }
}

/** Types for the endpoints Phase 0 touches. */

export interface JiraMyself {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  active: boolean;
}

export interface JiraStatusRef {
  id: string;
  name: string;
  statusCategory?: { id: number; key: string; name: string };
}

export interface JiraIssueTypeStatuses {
  id: string;
  name: string;
  subtask: boolean;
  statuses: JiraStatusRef[];
}

/**
 * Board configuration. Only the column order is read: a column holds status
 * *ids*, and the column's own name is a board label that need not match any
 * status, so the ids are what gets mapped back to names.
 */
export interface JiraBoardConfiguration {
  id: number;
  name: string;
  columnConfig?: {
    columns?: Array<{ name: string; statuses?: Array<{ id: string }> }>;
  };
}

export interface JiraPriority {
  id: string;
  name: string;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  style?: string;
  simplified?: boolean;
  projectTypeKey?: string;
}

export interface JiraTransition {
  id: string;
  name: string;
  to: JiraStatusRef;
  isAvailable?: boolean;
}

export interface JiraField {
  id: string;
  key?: string;
  name: string;
  custom: boolean;
  schema?: { type?: string; custom?: string; customId?: number };
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  active: boolean;
  accountType?: string;
}

export interface AgileBoard {
  id: number;
  name: string;
  type: string;
  location?: { projectKey?: string; projectId?: number };
}

export interface AgileSprint {
  id: number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
  originBoardId?: number;
}
