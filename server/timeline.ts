import { maxDate, minDate, toIsoDate } from '../shared/dates.js';
import type {
  DateSource,
  Dependency,
  Progress,
  ReleaseMarker,
  SprintMarker,
  SprintRef,
  StatusCategory,
  TeamRef,
  TimelineItem,
  TimelineResponse,
  VersionRef,
} from '../shared/types.js';
import type { FieldDef, JiraDataSource, RawIssue } from './jira/source.js';

export interface FieldMap {
  startDate?: string;
  sprint?: string;
  team?: string;
}

export interface TimelineOptions {
  epicClause: string;
  dependencyLinkTypes: string[];
  maxEpics: number;
  maxChildren: number;
  doneWithinDays: number;
}

const SPRINT_TYPE = 'com.pyxis.greenhopper.jira:gh-sprint';
const TEAM_TYPE = 'com.atlassian.jira.plugin.system.customfieldtypes:atlassian-team';
const DATE_TYPE = 'com.atlassian.jira.plugin.system.customfieldtypes:datepicker';

/** Finds the site-specific custom field IDs the timeline relies on. */
export function resolveFields(defs: FieldDef[], overrides: FieldMap = {}): FieldMap {
  const byCustom = (type: string) => defs.filter((f) => f.schema?.custom === type);
  const startCandidates = byCustom(DATE_TYPE);
  const start =
    startCandidates.find((f) => f.name === 'Start date') ??
    startCandidates.find((f) => /^start date$/i.test(f.name.trim())) ??
    startCandidates.find((f) => /start/i.test(f.name));
  const sprint = byCustom(SPRINT_TYPE)[0];
  const team = byCustom(TEAM_TYPE).find((f) => f.name === 'Team') ?? byCustom(TEAM_TYPE)[0];
  return {
    startDate: overrides.startDate || start?.id,
    sprint: overrides.sprint || sprint?.id,
    team: overrides.team || team?.id,
  };
}

/** Removes a trailing ORDER BY so the JQL can be wrapped in parentheses. */
export function stripOrderBy(jql: string): string {
  // ORDER BY can't appear inside a quoted string in practice for filters; be conservative and
  // only strip the last top-level occurrence outside quotes.
  let inQuote: string | null = null;
  let cut = -1;
  for (let i = 0; i < jql.length; i++) {
    const ch = jql[i];
    if (inQuote) {
      if (ch === '\\') i++;
      else if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (/^order\s+by\b/i.test(jql.slice(i)) && (i === 0 || /\s|\)/.test(jql[i - 1]))) cut = i;
  }
  return (cut >= 0 ? jql.slice(0, cut) : jql).trim();
}

export function buildEpicJql(scopeJql: string, epicClause: string, doneWithinDays: number): string {
  const base = stripOrderBy(scopeJql);
  const parts = [base ? `(${base})` : '', `(${epicClause})`];
  if (doneWithinDays >= 0) {
    parts.push(`(statusCategory != Done OR resolved >= -${Math.floor(doneWithinDays)}d)`);
  }
  return `${parts.filter(Boolean).join(' AND ')} ORDER BY Rank ASC`;
}

export function buildChildrenJql(parentKeys: string[]): string {
  return `parent in (${parentKeys.join(', ')}) ORDER BY Rank ASC`;
}

export function searchFields(fm: FieldMap): string[] {
  return [
    'summary',
    'status',
    'issuetype',
    'project',
    'parent',
    'duedate',
    'issuelinks',
    'fixVersions',
    'assignee',
    'resolutiondate',
    fm.startDate,
    fm.sprint,
    fm.team,
  ].filter((f): f is string => Boolean(f));
}

function statusCategoryOf(raw: RawIssue): StatusCategory {
  const key = raw.fields.status?.statusCategory?.key;
  return key === 'done' || key === 'indeterminate' ? key : 'new';
}

function teamOf(value: unknown): TeamRef | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return { id: value, name: value };
  const v = value as { id?: string; name?: string; title?: string };
  if (!v.id) return undefined;
  return { id: String(v.id), name: v.name ?? v.title ?? String(v.id) };
}

function sprintsOf(value: unknown): SprintRef[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object')
    .map((s) => ({
      id: Number(s.id),
      name: String(s.name ?? ''),
      state: String(s.state ?? ''),
      boardId: s.boardId !== undefined ? Number(s.boardId) : undefined,
      start: toIsoDate(s.startDate),
      end: toIsoDate(s.endDate),
    }));
}

function versionsOf(value: unknown, projectKey: string): VersionRef[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => ({
    id: String(v.id),
    name: String(v.name),
    projectKey,
    released: Boolean(v.released),
    releaseDate: toIsoDate(v.releaseDate),
  }));
}

export function normaliseIssue(raw: RawIssue, fm: FieldMap, siteUrl: string): TimelineItem {
  const f = raw.fields;
  const projectKey: string = f.project?.key ?? raw.key.split('-')[0];
  return {
    key: raw.key,
    id: raw.id,
    summary: f.summary ?? '',
    url: `${siteUrl}/browse/${raw.key}`,
    projectKey,
    projectName: f.project?.name ?? projectKey,
    issueType: f.issuetype?.name ?? 'Work item',
    issueTypeIconUrl: f.issuetype?.iconUrl,
    hierarchyLevel: typeof f.issuetype?.hierarchyLevel === 'number' ? f.issuetype.hierarchyLevel : 0,
    status: f.status?.name ?? '',
    statusCategory: statusCategoryOf(raw),
    parentKey: f.parent?.key,
    start: fm.startDate ? toIsoDate(f[fm.startDate]) : undefined,
    due: toIsoDate(f.duedate),
    dateSource: 'none',
    assignee: f.assignee
      ? {
          accountId: f.assignee.accountId,
          displayName: f.assignee.displayName,
          avatarUrl: f.assignee.avatarUrls?.['24x24'],
        }
      : undefined,
    team: fm.team ? teamOf(f[fm.team]) : undefined,
    sprints: fm.sprint ? sprintsOf(f[fm.sprint]) : [],
    fixVersions: versionsOf(f.fixVersions, projectKey),
    childKeys: [],
  };
}

interface Candidate {
  start?: string;
  end?: string;
  source: DateSource;
}

/** Fills effectiveStart/effectiveEnd: explicit dates win, then child rollup, sprints, then release dates. */
export function computeEffectiveDates(item: TimelineItem, children: TimelineItem[]): void {
  let start = item.start;
  let end = item.due;
  let source: DateSource = start && end ? 'explicit' : 'none';

  if (!start || !end) {
    const candidates: Candidate[] = [
      {
        source: 'children',
        start: minDate(children.map((c) => c.effectiveStart)),
        end: maxDate(children.map((c) => c.effectiveEnd)),
      },
      {
        source: 'sprint',
        start: minDate(item.sprints.map((s) => s.start)),
        end: maxDate(item.sprints.map((s) => s.end)),
      },
      {
        source: 'version',
        start: undefined,
        end: maxDate(item.fixVersions.map((v) => v.releaseDate)),
      },
    ];
    for (const c of candidates) {
      if (start && end) break;
      const fillsStart = !start && c.start;
      const fillsEnd = !end && c.end;
      if (fillsStart) start = c.start;
      if (fillsEnd) end = c.end;
      if ((fillsStart || fillsEnd) && source === 'none') source = c.source;
    }
    if (source === 'none' && (start || end)) source = 'explicit';
  }

  if (start && !end) end = start;
  if (end && !start) start = end;
  if (start && end && start > end) end = start;

  item.effectiveStart = start;
  item.effectiveEnd = end;
  item.dateSource = start ? source : 'none';
}

export function computeProgress(children: TimelineItem[]): Progress {
  const p: Progress = { todo: 0, inProgress: 0, done: 0, total: children.length };
  for (const c of children) {
    if (c.statusCategory === 'done') p.done++;
    else if (c.statusCategory === 'indeterminate') p.inProgress++;
    else p.todo++;
  }
  return p;
}

export function extractDependencies(raws: RawIssue[], linkTypes: string[], keys: Set<string>): Dependency[] {
  const wanted = new Set(linkTypes.map((t) => t.toLowerCase()));
  const out = new Map<string, Dependency>();
  for (const raw of raws) {
    for (const link of raw.fields.issuelinks ?? []) {
      const type: string = link.type?.name ?? '';
      if (!wanted.has(type.toLowerCase())) continue;
      // On a read, `outwardIssue` means "this issue <outward description> outwardIssue" (e.g. blocks).
      const dep: Dependency | undefined = link.outwardIssue
        ? { id: String(link.id), fromKey: raw.key, toKey: link.outwardIssue.key, type }
        : link.inwardIssue
          ? { id: String(link.id), fromKey: link.inwardIssue.key, toKey: raw.key, type }
          : undefined;
      if (dep && keys.has(dep.fromKey) && keys.has(dep.toKey)) out.set(dep.id, dep);
    }
  }
  return [...out.values()];
}

export function collectMarkers(items: TimelineItem[]): { sprints: SprintMarker[]; releases: ReleaseMarker[] } {
  const sprints = new Map<number, SprintMarker>();
  const releases = new Map<string, ReleaseMarker>();
  for (const item of items) {
    for (const s of item.sprints) {
      if (s.start && s.end && !sprints.has(s.id)) {
        sprints.set(s.id, { id: s.id, name: s.name, state: s.state, boardId: s.boardId, start: s.start, end: s.end });
      }
    }
    for (const v of item.fixVersions) {
      if (!v.releaseDate) continue;
      const k = `${v.name}|${v.releaseDate}`;
      const existing = releases.get(k);
      if (existing) {
        if (!existing.projects.includes(v.projectKey)) existing.projects.push(v.projectKey);
        existing.released = existing.released && v.released;
      } else {
        releases.set(k, { name: v.name, date: v.releaseDate, released: v.released, projects: [v.projectKey] });
      }
    }
  }
  return {
    sprints: [...sprints.values()].sort((a, b) => a.start.localeCompare(b.start)),
    releases: [...releases.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Assembles a cross-project timeline: epics in scope, their children, rollups, dependencies and markers. */
export async function loadTimeline(
  source: JiraDataSource,
  fm: FieldMap,
  scope: { jql: string; label: string },
  opts: TimelineOptions,
): Promise<TimelineResponse> {
  const warnings: string[] = [];
  if (!fm.startDate) warnings.push('No "Start date" field was found on this site; bars use due dates, sprints and releases only.');

  const fields = searchFields(fm);
  const epicJql = buildEpicJql(scope.jql, opts.epicClause, opts.doneWithinDays);
  const epicRes = await source.searchIssues(epicJql, fields, opts.maxEpics);
  if (epicRes.truncated) warnings.push(`Only the first ${opts.maxEpics} epics are shown. Narrow the scope to see the rest.`);

  const epicKeys = epicRes.issues.map((i) => i.key);
  const childRaws: RawIssue[] = [];
  let childBudget = opts.maxChildren;
  let childrenCapped = false;
  for (const keys of chunk(epicKeys, 100)) {
    if (childBudget <= 0) {
      childrenCapped = true;
      break;
    }
    const res = await source.searchIssues(buildChildrenJql(keys), fields, childBudget);
    childRaws.push(...res.issues);
    childBudget -= res.issues.length;
    if (res.truncated) {
      childrenCapped = true;
      break;
    }
  }
  if (childrenCapped) warnings.push(`Child work items were capped at ${opts.maxChildren}; epic rollups may be incomplete.`);

  const epics = epicRes.issues.map((r) => normaliseIssue(r, fm, source.siteUrl));
  const children = childRaws.map((r) => normaliseIssue(r, fm, source.siteUrl));
  const byParent = new Map<string, TimelineItem[]>();
  for (const c of children) {
    if (!c.parentKey) continue;
    const list = byParent.get(c.parentKey) ?? [];
    list.push(c);
    byParent.set(c.parentKey, list);
  }

  for (const c of children) computeEffectiveDates(c, []);
  for (const e of epics) {
    const kids = byParent.get(e.key) ?? [];
    e.childKeys = kids.map((k) => k.key);
    e.progress = computeProgress(kids);
    computeEffectiveDates(e, kids);
  }

  const items = [...epics, ...children];
  const keys = new Set(items.map((i) => i.key));
  const dependencies = extractDependencies([...epicRes.issues, ...childRaws], opts.dependencyLinkTypes, keys);
  const { sprints, releases } = collectMarkers(items);

  return {
    scope: { jql: epicJql, label: scope.label },
    items,
    dependencies,
    sprints,
    releases,
    fields: { startDateFieldId: fm.startDate, sprintFieldId: fm.sprint, teamFieldId: fm.team },
    warnings,
    truncated: epicRes.truncated || childrenCapped,
    generatedAt: new Date().toISOString(),
  };
}
