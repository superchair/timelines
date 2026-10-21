/**
 * In-memory stand-in for Jira so the app can be demoed and tested without credentials
 * (AUTH_MODE=mock). Data is generated relative to today and edits persist until restart.
 * Projects and people here are fictional.
 */
import { addDays, startOfWeek, todayIso } from '../../shared/dates.js';
import type { BoardRef, UserRef } from '../../shared/types.js';
import type { FieldDef, JiraDataSource, RawIssue, SearchResult } from './source.js';

const START = 'customfield_10015';
const SPRINT = 'customfield_10020';
const TEAM = 'customfield_10001';

type Cat = 'new' | 'indeterminate' | 'done';
interface MockIssue {
  key: string;
  summary: string;
  type: 'Epic' | 'Story' | 'Task' | 'Bug';
  project: string;
  status: string;
  cat: Cat;
  parent?: string;
  start?: string;
  due?: string;
  team?: string;
  assignee?: string;
  sprintIds: number[];
  versions: string[];
  resolved?: string;
}

const PROJECTS: Record<string, string> = {
  IDP: 'Identity Platform',
  NTF: 'Notification Service',
  LNK: 'Link Shortener',
  PIPE: 'Build Pipelines',
  DLR: 'Dealer Portal',
};

const TEAMS: Record<string, string> = { platform: 'Platform Services', dealer: 'Dealer Experience' };
const PEOPLE: Record<string, string> = {
  jr: 'Jordan Reyes',
  sk: 'Sam Kowalski',
  pn: 'Priya Natarajan',
  mt: 'Morgan Tremblay',
  dl: 'Dana Li',
};

export class MockSource implements JiraDataSource {
  readonly siteUrl = 'https://example.atlassian.net';
  private issues = new Map<string, MockIssue>();
  private links: Array<{ id: string; blocker: string; blocked: string }> = [];
  private sprints: Array<{ id: number; name: string; state: string; boardId: number; start: string; end: string }> = [];
  private versions: Array<{ id: string; name: string; project: string; released: boolean; date: string }> = [];
  private nextLinkId = 20000;

  constructor(today = todayIso()) {
    this.seed(today);
  }

  private seed(today: string) {
    const w = startOfWeek(today);
    const d = (n: number) => addDays(w, n);

    // Two-week sprints on the platform board, from 6 weeks ago to 10 weeks out.
    for (let i = -3; i <= 4; i++) {
      const start = d(i * 14);
      const end = d(i * 14 + 13);
      const state = end < today ? 'closed' : start <= today ? 'active' : 'future';
      this.sprints.push({ id: 500 + i + 3, name: `PLAT Sprint ${40 + i}`, state, boardId: 656, start, end });
    }
    const sprintAt = (day: number) =>
      this.sprints.filter((s) => s.start <= d(day) && s.end >= d(day)).map((s) => s.id);

    this.versions.push(
      { id: 'v1', name: '2026.Q4.1', project: 'IDP', released: false, date: d(20) },
      { id: 'v2', name: '2026.Q4.1', project: 'NTF', released: false, date: d(20) },
      { id: 'v3', name: '2026.Q4.1', project: 'LNK', released: false, date: d(20) },
      { id: 'v4', name: '2027.Q1.1', project: 'IDP', released: false, date: d(76) },
      { id: 'v5', name: 'Portal 3.0', project: 'DLR', released: false, date: d(48) },
    );

    const epic = (key: string, summary: string, team: string, start: number | null, due: number | null, cat: Cat, extra: Partial<MockIssue> = {}) => {
      this.issues.set(key, {
        key,
        summary,
        type: 'Epic',
        project: key.split('-')[0],
        status: cat === 'done' ? 'Done' : cat === 'indeterminate' ? 'In Progress' : 'To Do',
        cat,
        start: start === null ? undefined : d(start),
        due: due === null ? undefined : d(due),
        team,
        sprintIds: [],
        versions: [],
        resolved: cat === 'done' ? d(-3) : undefined,
        ...extra,
      });
    };
    const child = (key: string, parent: string, summary: string, at: number, cat: Cat, who: string, extra: Partial<MockIssue> = {}) => {
      const p = this.issues.get(parent)!;
      this.issues.set(key, {
        key,
        summary,
        type: 'Story',
        project: key.split('-')[0],
        status: cat === 'done' ? 'Done' : cat === 'indeterminate' ? 'In Progress' : 'To Do',
        cat,
        parent,
        team: p.team,
        assignee: who,
        sprintIds: sprintAt(at),
        versions: [],
        ...extra,
      });
    };

    epic('IDP-101', 'Passkey sign-in for dealer users', 'platform', -28, 24, 'indeterminate', { versions: ['v1'] });
    child('IDP-102', 'IDP-101', 'WebAuthn registration API', -20, 'done', 'jr');
    child('IDP-103', 'IDP-101', 'Passkey login flow', -2, 'indeterminate', 'jr');
    child('IDP-104', 'IDP-101', 'Account recovery with passkeys', 12, 'new', 'sk');
    child('IDP-105', 'IDP-101', 'Audit events for credential changes', 12, 'new', 'pn');

    epic('IDP-120', 'Service-to-service token exchange', 'platform', 10, 66, 'new', { versions: ['v4'] });
    child('IDP-121', 'IDP-120', 'Token exchange endpoint (RFC 8693)', 16, 'new', 'sk');
    child('IDP-122', 'IDP-120', 'Client SDK support', 30, 'new', 'pn');

    epic('NTF-40', 'Templated email + SMS delivery', 'platform', -40, 6, 'indeterminate', { versions: ['v2'] });
    child('NTF-41', 'NTF-40', 'Template rendering service', -34, 'done', 'mt');
    child('NTF-42', 'NTF-40', 'SMS provider failover', -6, 'indeterminate', 'mt');
    child('NTF-43', 'NTF-40', 'Delivery status webhooks', 2, 'new', 'dl');

    // No explicit dates: rolls up from child sprints.
    epic('NTF-55', 'Notification preferences centre', 'platform', null, null, 'new');
    child('NTF-56', 'NTF-55', 'Preferences data model', 16, 'new', 'dl');
    child('NTF-57', 'NTF-55', 'Preferences UI components', 30, 'new', 'mt');

    epic('LNK-12', 'Migrate link shortener to AWS', 'platform', -14, 38, 'indeterminate', { versions: ['v3'] });
    child('LNK-13', 'LNK-12', 'CDK stack for API Gateway + Lambda', -10, 'done', 'pn');
    child('LNK-14', 'LNK-12', 'DynamoDB table + data backfill', 2, 'indeterminate', 'pn');
    child('LNK-15', 'LNK-12', 'DNS cutover runbook', 30, 'new', 'jr');

    epic('PIPE-7', 'Jenkins shared library v2', 'platform', -56, -4, 'done');
    child('PIPE-8', 'PIPE-7', 'Pipeline stages as code', -48, 'done', 'sk', { resolved: d(-20) });
    child('PIPE-9', 'PIPE-7', 'Artifact signing', -20, 'done', 'sk', { resolved: d(-5) });

    epic('PIPE-20', 'Ephemeral preview environments', 'platform', 20, 80, 'new');
    child('PIPE-21', 'PIPE-20', 'Per-PR CDK deploy', 30, 'new', 'jr');

    epic('DLR-300', 'Portal 3.0 navigation redesign', 'dealer', -10, 46, 'indeterminate', { versions: ['v5'] });
    child('DLR-301', 'DLR-300', 'New navigation shell', 2, 'indeterminate', 'dl', { sprintIds: [] });
    child('DLR-302', 'DLR-300', 'Passkey sign-in screen', 30, 'new', 'dl', { sprintIds: [] });

    epic('DLR-320', 'Inventory photo upload revamp', 'dealer', null, 52, 'new');

    this.link('IDP-102', 'IDP-103');
    this.link('IDP-101', 'DLR-302');
    this.link('NTF-40', 'NTF-55');
    this.link('LNK-13', 'LNK-14');
    this.link('PIPE-7', 'PIPE-20');
    // A conflict: the blocked epic starts before its blocker ends.
    this.link('IDP-120', 'NTF-55');
  }

  private link(blocker: string, blocked: string) {
    const id = String(this.nextLinkId++);
    this.links.push({ id, blocker, blocked });
    return id;
  }

  private toRaw(i: MockIssue): RawIssue {
    const issuelinks = this.links.flatMap((l): Array<Record<string, unknown>> => {
      const type = { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };
      if (l.blocker === i.key) return [{ id: l.id, type, outwardIssue: { key: l.blocked } }];
      if (l.blocked === i.key) return [{ id: l.id, type, inwardIssue: { key: l.blocker } }];
      return [];
    });
    return {
      id: String(10000 + [...this.issues.keys()].indexOf(i.key)),
      key: i.key,
      fields: {
        summary: i.summary,
        status: { name: i.status, statusCategory: { key: i.cat } },
        issuetype: { name: i.type, hierarchyLevel: i.type === 'Epic' ? 1 : 0 },
        project: { key: i.project, name: PROJECTS[i.project] },
        parent: i.parent ? { key: i.parent } : undefined,
        duedate: i.due ?? null,
        [START]: i.start ?? null,
        [SPRINT]: this.sprints
          .filter((s) => i.sprintIds.includes(s.id))
          .map((s) => ({ id: s.id, name: s.name, state: s.state, boardId: s.boardId, startDate: `${s.start}T13:00:00.000Z`, endDate: `${s.end}T21:00:00.000Z` })),
        [TEAM]: i.team ? { id: `team-${i.team}`, name: TEAMS[i.team] } : null,
        assignee: i.assignee ? { accountId: `acc-${i.assignee}`, displayName: PEOPLE[i.assignee] } : null,
        fixVersions: this.versions
          .filter((v) => i.versions.includes(v.id))
          .map((v) => ({ id: v.id, name: v.name, released: v.released, releaseDate: v.date })),
        issuelinks,
        resolutiondate: i.resolved ?? null,
      },
    };
  }

  async myself(): Promise<UserRef> {
    return { accountId: 'acc-demo', displayName: 'Demo User' };
  }

  async listFields(): Promise<FieldDef[]> {
    return [
      { id: 'duedate', name: 'Due date', schema: { type: 'date', system: 'duedate' } },
      { id: START, name: 'Start date', custom: true, schema: { type: 'date', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:datepicker' } },
      { id: SPRINT, name: 'Sprint', custom: true, schema: { type: 'array', items: 'json', custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
      { id: TEAM, name: 'Team', custom: true, schema: { type: 'team', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:atlassian-team' } },
    ];
  }

  /** Understands just enough JQL for the queries this app generates. */
  async searchIssues(jql: string, _fields: string[], limit: number): Promise<SearchResult> {
    let list = [...this.issues.values()];
    const parentMatch = /parent in \(([^)]*)\)/i.exec(jql);
    if (parentMatch) {
      const keys = new Set(parentMatch[1].split(',').map((s) => s.trim()));
      list = list.filter((i) => i.parent && keys.has(i.parent));
    } else {
      if (/issuetype\s*=\s*Epic/i.test(jql)) list = list.filter((i) => i.type === 'Epic');
      const inMatch = /project\s+in\s*\(([^)]*)\)/i.exec(jql);
      const eqMatch = /project\s*=\s*"?([A-Z0-9]+)"?/i.exec(jql);
      const projects = inMatch
        ? inMatch[1].split(',').map((s) => s.trim().replace(/"/g, '').toUpperCase())
        : eqMatch
          ? [eqMatch[1].toUpperCase()]
          : null;
      if (projects) list = list.filter((i) => projects.includes(i.project));
      const doneMatch = /resolved\s*>=\s*-(\d+)d/i.exec(jql);
      if (doneMatch) {
        const cutoff = addDays(todayIso(), -Number(doneMatch[1]));
        list = list.filter((i) => i.cat !== 'done' || (i.resolved && i.resolved >= cutoff));
      }
    }
    return { issues: list.slice(0, limit).map((i) => this.toRaw(i)), truncated: list.length > limit };
  }

  async getBoardScope(boardId: number) {
    if (boardId === 656) return { name: 'Platform Services', jql: 'project in (IDP, NTF, LNK, PIPE) ORDER BY Rank ASC' };
    if (boardId === 700) return { name: 'Dealer Experience', jql: 'project = DLR ORDER BY Rank ASC' };
    throw Object.assign(new Error(`Board ${boardId} not found`), { status: 404 });
  }

  async getFilterScope(filterId: number) {
    if (filterId === 10001) return { name: 'All engineering', jql: 'project in (IDP, NTF, LNK, PIPE, DLR)' };
    throw Object.assign(new Error(`Filter ${filterId} not found`), { status: 404 });
  }

  async listBoards(query?: string): Promise<BoardRef[]> {
    const boards: BoardRef[] = [
      { id: 656, name: 'Platform Services', type: 'kanban', projectKey: 'IDP' },
      { id: 700, name: 'Dealer Experience', type: 'scrum', projectKey: 'DLR' },
    ];
    return query ? boards.filter((b) => b.name.toLowerCase().includes(query.toLowerCase())) : boards;
  }

  async updateIssueFields(key: string, fields: Record<string, unknown>) {
    const issue = this.issues.get(key);
    if (!issue) throw Object.assign(new Error(`Issue ${key} not found`), { status: 404 });
    if ('duedate' in fields) issue.due = (fields.duedate as string | null) ?? undefined;
    if (START in fields) issue.start = (fields[START] as string | null) ?? undefined;
  }

  async createDependencyLink(blockerKey: string, blockedKey: string) {
    if (!this.issues.has(blockerKey) || !this.issues.has(blockedKey)) {
      throw Object.assign(new Error('Issue not found'), { status: 404 });
    }
    this.link(blockerKey, blockedKey);
  }

  async deleteIssueLink(linkId: string) {
    this.links = this.links.filter((l) => l.id !== linkId);
  }
}
