import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '../shared/types';
import { MockSource } from '../server/jira/mock';
import {
  buildEpicJql,
  computeEffectiveDates,
  extractDependencies,
  loadTimeline,
  resolveFields,
  stripOrderBy,
} from '../server/timeline';

const base = (over: Partial<TimelineItem>): TimelineItem => ({
  key: 'A-1', id: '1', summary: '', url: '', projectKey: 'A', projectName: 'A', issueType: 'Story',
  hierarchyLevel: 0, status: '', statusCategory: 'new', dateSource: 'none', sprints: [], fixVersions: [],
  childKeys: [], ...over,
});

describe('JQL handling', () => {
  it('strips a trailing ORDER BY but not one inside quotes', () => {
    expect(stripOrderBy('project = A ORDER BY Rank ASC')).toBe('project = A');
    expect(stripOrderBy('summary ~ "order by" order by created')).toBe('summary ~ "order by"');
    expect(stripOrderBy('ORDER BY Rank')).toBe('');
  });
  it('wraps the scope and adds epic + done filters', () => {
    expect(buildEpicJql('project in (A, B) OR category = X ORDER BY Rank', 'issuetype = Epic', 30)).toBe(
      '(project in (A, B) OR category = X) AND (issuetype = Epic) AND (statusCategory != Done OR resolved >= -30d) ORDER BY Rank ASC',
    );
    expect(buildEpicJql('', 'issuetype = Epic', -1)).toBe('(issuetype = Epic) ORDER BY Rank ASC');
  });
});

describe('field resolution', () => {
  it('finds start date, sprint and team fields by schema', async () => {
    const fm = resolveFields(await new MockSource().listFields());
    expect(fm).toEqual({ startDate: 'customfield_10015', sprint: 'customfield_10020', team: 'customfield_10001' });
  });
  it('honours overrides', () => {
    expect(resolveFields([], { startDate: 'customfield_1' }).startDate).toBe('customfield_1');
  });
});

describe('effective dates', () => {
  it('prefers explicit dates', () => {
    const i = base({ start: '2026-01-05', due: '2026-01-20' });
    computeEffectiveDates(i, [base({ effectiveStart: '2025-12-01', effectiveEnd: '2026-03-01' })]);
    expect([i.effectiveStart, i.effectiveEnd, i.dateSource]).toEqual(['2026-01-05', '2026-01-20', 'explicit']);
  });
  it('rolls up from children', () => {
    const i = base({});
    computeEffectiveDates(i, [
      base({ effectiveStart: '2026-02-01', effectiveEnd: '2026-02-10' }),
      base({ effectiveStart: '2026-01-15', effectiveEnd: '2026-03-01' }),
    ]);
    expect([i.effectiveStart, i.effectiveEnd, i.dateSource]).toEqual(['2026-01-15', '2026-03-01', 'children']);
  });
  it('fills a missing start from sprints and keeps the explicit due', () => {
    const i = base({ due: '2026-04-30', sprints: [{ id: 1, name: 'S', state: 'future', start: '2026-04-06', end: '2026-04-19' }] });
    computeEffectiveDates(i, []);
    expect([i.effectiveStart, i.effectiveEnd, i.dateSource]).toEqual(['2026-04-06', '2026-04-30', 'sprint']);
  });
  it('uses a release date as an end and makes a one-day bar', () => {
    const i = base({ fixVersions: [{ id: '1', name: 'v1', projectKey: 'A', released: false, releaseDate: '2026-05-01' }] });
    computeEffectiveDates(i, []);
    expect([i.effectiveStart, i.effectiveEnd, i.dateSource]).toEqual(['2026-05-01', '2026-05-01', 'version']);
  });
  it('leaves unscheduled work unscheduled', () => {
    const i = base({});
    computeEffectiveDates(i, []);
    expect(i.effectiveStart).toBeUndefined();
    expect(i.dateSource).toBe('none');
  });
  it('never produces an end before the start', () => {
    const i = base({ start: '2026-06-10', due: '2026-06-01' });
    computeEffectiveDates(i, []);
    expect(i.effectiveEnd).toBe('2026-06-10');
  });
});

describe('dependencies', () => {
  it('reads both link directions, dedupes, and drops out-of-scope ends', () => {
    const type = { name: 'Blocks' };
    const deps = extractDependencies(
      [
        { id: '1', key: 'A-1', fields: { issuelinks: [{ id: '9', type, outwardIssue: { key: 'B-1' } }, { id: '8', type, outwardIssue: { key: 'Z-9' } }] } },
        { id: '2', key: 'B-1', fields: { issuelinks: [{ id: '9', type, inwardIssue: { key: 'A-1' } }, { id: '7', type: { name: 'Relates' }, outwardIssue: { key: 'A-1' } }] } },
      ],
      ['Blocks'],
      new Set(['A-1', 'B-1']),
    );
    expect(deps).toEqual([{ id: '9', fromKey: 'A-1', toKey: 'B-1', type: 'Blocks' }]);
  });
});

describe('loadTimeline (mock source)', () => {
  it('builds a cross-project timeline from a board scope', async () => {
    const src = new MockSource('2026-10-20');
    const fm = resolveFields(await src.listFields());
    const scope = await src.getBoardScope(656);
    const t = await loadTimeline(src, fm, { jql: scope.jql, label: scope.name }, {
      epicClause: 'issuetype = Epic', dependencyLinkTypes: ['Blocks'], maxEpics: 500, maxChildren: 3000, doneWithinDays: 30,
    });
    const projects = new Set(t.items.map((i) => i.projectKey));
    expect([...projects].sort()).toEqual(['IDP', 'LNK', 'NTF', 'PIPE']);
    const ntf55 = t.items.find((i) => i.key === 'NTF-55')!;
    expect(ntf55.dateSource).toBe('children');
    expect(ntf55.progress?.total).toBe(2);
    expect(t.dependencies.some((d) => d.fromKey === 'IDP-120' && d.toKey === 'NTF-55')).toBe(true);
    expect(t.dependencies.some((d) => d.toKey === 'DLR-302')).toBe(false); // other board
    expect(t.releases.find((r) => r.name === '2026.Q4.1')?.projects.sort()).toEqual(['IDP', 'LNK', 'NTF']);
  });
});
