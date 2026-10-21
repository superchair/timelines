/** Minimal Jira Cloud REST client with retry/backoff for rate limits. */

export class JiraApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'JiraApiError';
  }
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

export interface JiraHttp {
  /** Browsable site URL, e.g. https://example.atlassian.net (used to build work item links). */
  readonly siteUrl: string;
  request<T>(method: string, path: string, opts?: RequestOptions): Promise<T>;
}

export interface JiraHttpOptions {
  /** API base, e.g. https://api.atlassian.com/ex/jira/{cloudId} or https://example.atlassian.net */
  baseUrl: string;
  siteUrl: string;
  getAuthorization: () => Promise<string>;
  /** Called once on a 401; return true if credentials were refreshed and the request should be retried. */
  onUnauthorized?: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function describeJiraError(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as { errorMessages?: string[]; errors?: Record<string, string>; message?: string };
  const parts = [
    ...(b.errorMessages ?? []),
    ...Object.entries(b.errors ?? {}).map(([field, msg]) => `${field}: ${msg}`),
  ];
  if (b.message) parts.push(b.message);
  return parts.length ? parts.join('; ') : undefined;
}

export function createJiraHttp(opts: JiraHttpOptions): JiraHttp {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? 3;

  async function request<T>(method: string, path: string, ro: RequestOptions = {}): Promise<T> {
    const url = new URL(opts.baseUrl.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(ro.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: await opts.getAuthorization(),
          Accept: 'application/json',
          ...(ro.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: ro.body !== undefined ? JSON.stringify(ro.body) : undefined,
      });

      if (res.status === 401 && !refreshed && opts.onUnauthorized) {
        refreshed = true;
        if (await opts.onUnauthorized()) continue;
      }

      if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get('Retry-After'));
        const base = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
        await sleep(Math.min(base, 10_000) + Math.random() * 250);
        continue;
      }

      const text = await res.text();
      let body: unknown = undefined;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      if (!res.ok) {
        const detail = describeJiraError(body) ?? (typeof body === 'string' ? body.slice(0, 300) : res.statusText);
        throw new JiraApiError(res.status, `Jira ${method} ${path} failed (${res.status}): ${detail}`, body);
      }
      return body as T;
    }
  }

  return { siteUrl: opts.siteUrl.replace(/\/$/, ''), request };
}
