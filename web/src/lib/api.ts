import type {
  BoardRef,
  CreateDependencyRequest,
  MeResponse,
  ScopeRequest,
  TimelineResponse,
  UpdateDatesRequest,
} from '../../../shared/types';

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'X-Requested-With': 'timelines',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiRequestError(res.status, json.error ?? res.statusText, json.detail);
  return json as T;
}

export const api = {
  me: () => call<MeResponse>('GET', '/api/me'),
  selectSite: (cloudId: string) => call('POST', '/api/sites/select', { cloudId }),
  logout: () => call('POST', '/auth/logout'),
  boards: (q?: string) => call<BoardRef[]>('GET', `/api/boards${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  timeline: (scope: ScopeRequest, fresh = false) => {
    const p = new URLSearchParams({
      source: scope.source,
      value: scope.value,
      doneWithinDays: String(scope.doneWithinDays ?? 30),
    });
    if (fresh) p.set('fresh', '1');
    return call<TimelineResponse>('GET', `/api/timeline?${p}`);
  },
  updateDates: (key: string, body: UpdateDatesRequest) =>
    call('PATCH', `/api/issues/${encodeURIComponent(key)}/dates`, body),
  createDependency: (body: CreateDependencyRequest) => call('POST', '/api/dependencies', body),
  deleteDependency: (id: string) => call('DELETE', `/api/dependencies/${encodeURIComponent(id)}`),
};
