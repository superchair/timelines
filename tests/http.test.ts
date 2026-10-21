import { describe, expect, it, vi } from 'vitest';
import { createJiraHttp, JiraApiError } from '../server/jira/http';
import { JiraRestSource } from '../server/jira/source';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers });

describe('Jira HTTP client', () => {
  it('retries rate-limited requests using Retry-After', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(429, {}, { 'Retry-After': '0' }))
      .mockResolvedValueOnce(json(200, { ok: 1 }));
    const http = createJiraHttp({ baseUrl: 'https://x', siteUrl: 'https://x', getAuthorization: async () => 'Bearer t', fetchImpl });
    await expect(http.request('GET', '/a')).resolves.toEqual({ ok: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refreshes once on 401 then retries', async () => {
    let token = 'old';
    const fetchImpl = vi.fn(async (_u: URL, init: RequestInit) =>
      (init.headers as Record<string, string>).Authorization === 'Bearer new' ? json(200, { ok: 1 }) : json(401, {}),
    );
    const http = createJiraHttp({
      baseUrl: 'https://x', siteUrl: 'https://x', fetchImpl: fetchImpl as unknown as typeof fetch,
      getAuthorization: async () => `Bearer ${token}`,
      onUnauthorized: async () => { token = 'new'; return true; },
    });
    await expect(http.request('GET', '/a')).resolves.toEqual({ ok: 1 });
  });

  it('surfaces Jira error messages', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(400, { errors: { customfield_10015: 'Field cannot be set' } }));
    const http = createJiraHttp({ baseUrl: 'https://x', siteUrl: 'https://x', getAuthorization: async () => 'b', fetchImpl });
    const err = await http.request('PUT', '/i').catch((e) => e);
    expect(err).toBeInstanceOf(JiraApiError);
    expect(err.message).toContain('customfield_10015: Field cannot be set');
  });
});

describe('dependency link creation', () => {
  it('re-creates the link if Jira stored it reversed', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const http = {
      siteUrl: 'https://x',
      request: async (method: string, path: string, opts: { body?: unknown } = {}) => {
        calls.push({ method, path, body: opts.body });
        // Simulate Jira interpreting the payload the opposite way to what we expected.
        if (method === 'GET') return { fields: { issuelinks: [{ id: '55', type: { name: 'Blocks' }, inwardIssue: { key: 'B-2' } }] } };
        return undefined;
      },
    };
    await new JiraRestSource(http as never).createDependencyLink('A-1', 'B-2', 'Blocks');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /rest/api/3/issueLink',
      'GET /rest/api/3/issue/A-1',
      'DELETE /rest/api/3/issueLink/55',
      'POST /rest/api/3/issueLink',
    ]);
    expect(calls[3].body).toMatchObject({ inwardIssue: { key: 'B-2' }, outwardIssue: { key: 'A-1' } });
  });

  it('leaves a correctly stored link alone', async () => {
    const calls: string[] = [];
    const http = {
      siteUrl: 'https://x',
      request: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        if (method === 'GET') return { fields: { issuelinks: [{ id: '56', type: { name: 'Blocks' }, outwardIssue: { key: 'B-2' } }] } };
        return undefined;
      },
    };
    await new JiraRestSource(http as never).createDependencyLink('A-1', 'B-2', 'Blocks');
    expect(calls).toHaveLength(2);
  });
});
