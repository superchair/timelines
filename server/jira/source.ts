import type { BoardRef, UserRef } from '../../shared/types.js';
import type { JiraHttp } from './http.js';

export interface RawIssue {
  id: string;
  key: string;
  // Jira field payloads are loosely typed; normalisation happens in timeline.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fields: Record<string, any>;
}

export interface FieldDef {
  id: string;
  name: string;
  custom?: boolean;
  schema?: { type?: string; custom?: string; items?: string; system?: string };
}

export interface SearchResult {
  issues: RawIssue[];
  truncated: boolean;
}

/**
 * Everything the timeline needs from Jira. Implemented against the real REST APIs
 * (JiraRestSource) and an in-memory fixture (MockSource) for demos and tests.
 */
export interface JiraDataSource {
  readonly siteUrl: string;
  myself(): Promise<UserRef>;
  listFields(): Promise<FieldDef[]>;
  searchIssues(jql: string, fields: string[], limit: number): Promise<SearchResult>;
  getBoardScope(boardId: number): Promise<{ jql: string; name: string }>;
  getFilterScope(filterId: number): Promise<{ jql: string; name: string }>;
  listBoards(query?: string): Promise<BoardRef[]>;
  updateIssueFields(key: string, fields: Record<string, unknown>): Promise<void>;
  /** Creates "<blockerKey> blocks <blockedKey>" using the given link type. */
  createDependencyLink(blockerKey: string, blockedKey: string, linkTypeName: string): Promise<void>;
  deleteIssueLink(linkId: string): Promise<void>;
}

const PAGE_SIZE = 100;

export class JiraRestSource implements JiraDataSource {
  constructor(private readonly http: JiraHttp) {}

  get siteUrl() {
    return this.http.siteUrl;
  }

  async myself(): Promise<UserRef> {
    const me = await this.http.request<{
      accountId: string;
      displayName: string;
      avatarUrls?: Record<string, string>;
    }>('GET', '/rest/api/3/myself');
    return { accountId: me.accountId, displayName: me.displayName, avatarUrl: me.avatarUrls?.['48x48'] };
  }

  listFields(): Promise<FieldDef[]> {
    return this.http.request<FieldDef[]>('GET', '/rest/api/3/field');
  }

  async searchIssues(jql: string, fields: string[], limit: number): Promise<SearchResult> {
    const issues: RawIssue[] = [];
    let nextPageToken: string | undefined;
    for (;;) {
      const page = await this.http.request<{ issues: RawIssue[]; nextPageToken?: string; isLast?: boolean }>(
        'POST',
        '/rest/api/3/search/jql',
        { body: { jql, fields, maxResults: PAGE_SIZE, nextPageToken } },
      );
      issues.push(...(page.issues ?? []));
      if (issues.length >= limit) {
        return { issues: issues.slice(0, limit), truncated: Boolean(page.nextPageToken) || issues.length > limit };
      }
      if (page.isLast !== false || !page.nextPageToken) break;
      nextPageToken = page.nextPageToken;
    }
    return { issues, truncated: false };
  }

  async getBoardScope(boardId: number) {
    const config = await this.http.request<{ name: string; filter: { id: string } }>(
      'GET',
      `/rest/agile/1.0/board/${boardId}/configuration`,
    );
    const filter = await this.getFilterScope(Number(config.filter.id));
    return { jql: filter.jql, name: config.name };
  }

  async getFilterScope(filterId: number) {
    const filter = await this.http.request<{ jql: string; name: string }>('GET', `/rest/api/3/filter/${filterId}`);
    return { jql: filter.jql, name: filter.name };
  }

  async listBoards(query?: string): Promise<BoardRef[]> {
    const res = await this.http.request<{
      values: Array<{ id: number; name: string; type: string; location?: { projectKey?: string } }>;
    }>('GET', '/rest/agile/1.0/board', { query: { name: query || undefined, maxResults: 50 } });
    return res.values.map((b) => ({ id: b.id, name: b.name, type: b.type, projectKey: b.location?.projectKey }));
  }

  async updateIssueFields(key: string, fields: Record<string, unknown>) {
    await this.http.request('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}`, {
      body: { fields },
    });
  }

  async createDependencyLink(blockerKey: string, blockedKey: string, linkTypeName: string) {
    // Jira's create-link payload is easy to get backwards: the issue sent as `inwardIssue`
    // is the one that receives the type's *outward* description ("blocks"). Because this is a
    // common source of reversed dependencies, we read the link back and fix it if Jira stored
    // it the other way round.
    const post = (inward: string, outward: string) =>
      this.http.request('POST', '/rest/api/3/issueLink', {
        body: { type: { name: linkTypeName }, inwardIssue: { key: inward }, outwardIssue: { key: outward } },
      });

    await post(blockerKey, blockedKey);

    const issue = await this.http.request<RawIssue>('GET', `/rest/api/3/issue/${encodeURIComponent(blockerKey)}`, {
      query: { fields: 'issuelinks' },
    });
    const links: Array<{ id: string; type?: { name?: string }; outwardIssue?: { key: string }; inwardIssue?: { key: string } }> =
      issue.fields.issuelinks ?? [];
    const sameType = links.filter((l) => l.type?.name === linkTypeName);
    const correct = sameType.some((l) => l.outwardIssue?.key === blockedKey);
    const reversed = sameType.find((l) => l.inwardIssue?.key === blockedKey);
    if (!correct && reversed) {
      await this.deleteIssueLink(reversed.id);
      await post(blockedKey, blockerKey);
    }
  }

  async deleteIssueLink(linkId: string) {
    await this.http.request('DELETE', `/rest/api/3/issueLink/${encodeURIComponent(linkId)}`);
  }
}
