import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JiraClient, JiraError } from '../src/jira/client.js';

const BASE = 'https://roarington.atlassian.net';
const EMAIL = 'bugbot@roarington.com';
const TOKEN = 'ATATT-super-secret-token-value';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** No wall-clock delay in tests, but record what the backoff asked for. */
function makeClient(overrides: Partial<ConstructorParameters<typeof JiraClient>[0]> = {}) {
  const slept: number[] = [];
  const client = new JiraClient({
    baseUrl: BASE,
    email: EMAIL,
    apiToken: TOKEN,
    backoffBaseMs: 10,
    sleep: async (ms) => {
      slept.push(ms);
    },
    ...overrides,
  });
  return { client, slept };
}

describe('JiraClient auth', () => {
  it('sends Basic auth built from email and token', async () => {
    let seen: string | null = null;
    server.use(
      http.get(`${BASE}/rest/api/3/myself`, ({ request }) => {
        seen = request.headers.get('authorization');
        return HttpResponse.json({ accountId: 'acc-1', displayName: 'BugBot', active: true });
      }),
    );

    const { client } = makeClient();
    const me = await client.get<{ accountId: string }>('/rest/api/3/myself');

    expect(me.accountId).toBe('acc-1');
    const expected = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`;
    expect(seen).toBe(expected);
  });

  it('appends query parameters and skips undefined ones', async () => {
    let url: string | undefined;
    server.use(
      http.get(`${BASE}/rest/api/3/mypermissions`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({ permissions: {} });
      }),
    );

    const { client } = makeClient();
    await client.get('/rest/api/3/mypermissions', {
      projectKey: 'SUP',
      permissions: 'CREATE_ISSUES',
      missing: undefined,
    });

    expect(url).toContain('projectKey=SUP');
    expect(url).toContain('permissions=CREATE_ISSUES');
    expect(url).not.toContain('missing');
  });
});

describe('JiraClient retries', () => {
  it('retries a 429 and honours Retry-After', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/rest/api/3/myself`, () => {
        calls += 1;
        if (calls === 1) {
          return new HttpResponse(JSON.stringify({ errorMessages: ['rate limited'] }), {
            status: 429,
            headers: { 'Retry-After': '2', 'Content-Type': 'application/json' },
          });
        }
        return HttpResponse.json({ accountId: 'acc-1' });
      }),
    );

    const { client, slept } = makeClient();
    const me = await client.get<{ accountId: string }>('/rest/api/3/myself');

    expect(me.accountId).toBe('acc-1');
    expect(calls).toBe(2);
    expect(slept).toEqual([2000]);
  });

  it('retries a 500 with exponential backoff', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/rest/api/3/myself`, () => {
        calls += 1;
        if (calls < 3) return new HttpResponse(null, { status: 503 });
        return HttpResponse.json({ accountId: 'acc-1' });
      }),
    );

    const { client, slept } = makeClient();
    await client.get('/rest/api/3/myself');

    expect(calls).toBe(3);
    expect(slept).toHaveLength(2);
    expect(slept[1]).toBeGreaterThan(slept[0]!);
  });

  it('gives up after maxAttempts and throws the last error', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/rest/api/3/myself`, () => {
        calls += 1;
        return new HttpResponse(JSON.stringify({ errorMessages: ['boom'] }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const { client } = makeClient({ maxAttempts: 2 });
    await expect(client.get('/rest/api/3/myself')).rejects.toThrow(JiraError);
    expect(calls).toBe(2);
  });

  it('never retries a 4xx - a bad request stays bad', async () => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/rest/api/3/issue`, () => {
        calls += 1;
        return new HttpResponse(
          JSON.stringify({ errors: { summary: 'Summary is required.' } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    const { client } = makeClient();
    await expect(client.post('/rest/api/3/issue', { fields: {} })).rejects.toThrow(
      /summary: Summary is required/,
    );
    expect(calls).toBe(1);
  });
});

describe('JiraError', () => {
  it('never carries the API token in its message or body', async () => {
    server.use(
      http.get(`${BASE}/rest/api/3/project/SUP`, () =>
        new HttpResponse(JSON.stringify({ errorMessages: ['No project could be found'] }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const { client } = makeClient();
    try {
      await client.get('/rest/api/3/project/SUP');
      expect.unreachable('should have thrown');
    } catch (error) {
      const jiraError = error as JiraError;
      expect(jiraError).toBeInstanceOf(JiraError);
      expect(jiraError.status).toBe(404);
      expect(jiraError.isNotFound).toBe(true);
      expect(jiraError.message).toContain('No project could be found');
      expect(jiraError.message).not.toContain(TOKEN);
      expect(JSON.stringify(jiraError.body)).not.toContain(TOKEN);
      // Guards against a future change that stashes the headers on the error.
      expect(JSON.stringify(Object.values(jiraError))).not.toContain(TOKEN);
    }
  });

  it('falls back to the status code when the body has no message', async () => {
    server.use(
      http.get(`${BASE}/rest/api/3/project/SUP`, () => new HttpResponse(null, { status: 403 })),
    );
    const { client } = makeClient();
    await expect(client.get('/rest/api/3/project/SUP')).rejects.toThrow(/HTTP 403/);
  });
});

describe('JiraClient response handling', () => {
  it('returns undefined for 204 No Content', async () => {
    server.use(
      http.post(`${BASE}/rest/api/3/issue/SUP-1/transitions`, () =>
        new HttpResponse(null, { status: 204 }),
      ),
    );
    const { client } = makeClient();
    await expect(
      client.post('/rest/api/3/issue/SUP-1/transitions', { transition: { id: '11' } }),
    ).resolves.toBeUndefined();
  });

  it('sets Content-Type only when there is a body', async () => {
    const seen: Array<string | null> = [];
    server.use(
      http.get(`${BASE}/rest/api/3/myself`, ({ request }) => {
        seen.push(request.headers.get('content-type'));
        return HttpResponse.json({ accountId: 'acc-1' });
      }),
      http.put(`${BASE}/rest/api/3/issue/SUP-1`, ({ request }) => {
        seen.push(request.headers.get('content-type'));
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { client } = makeClient();
    await client.get('/rest/api/3/myself');
    await client.put('/rest/api/3/issue/SUP-1', { fields: { labels: ['src:slack'] } });

    expect(seen[0]).toBeNull();
    expect(seen[1]).toContain('application/json');
  });

  it('reads the tenant cloud id from the unauthenticated edge endpoint', async () => {
    server.use(
      http.get(`${BASE}/_edge/tenant_info`, () =>
        HttpResponse.json({ cloudId: '57de5553-0941-4346-821f-c46f7dde06cc' }),
      ),
    );
    const { client } = makeClient();
    await expect(client.tenantInfo()).resolves.toEqual({
      cloudId: '57de5553-0941-4346-821f-c46f7dde06cc',
    });
  });
});
