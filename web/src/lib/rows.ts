import type { TimelineItem, TimelineResponse } from '../../../shared/types';

export type GroupBy = 'project' | 'team' | 'none';

export type Row =
  | { kind: 'group'; id: string; label: string; count: number }
  | { kind: 'item'; id: string; item: TimelineItem; depth: number; hasChildren: boolean; expanded: boolean };

export interface RowOptions {
  groupBy: GroupBy;
  expanded: Set<string>;
  search: string;
  hideDoneChildren: boolean;
}

function groupKey(item: TimelineItem, groupBy: GroupBy): { id: string; label: string } {
  if (groupBy === 'project') return { id: `p:${item.projectKey}`, label: `${item.projectName} (${item.projectKey})` };
  if (groupBy === 'team') return item.team ? { id: `t:${item.team.id}`, label: item.team.name } : { id: 't:none', label: 'No team' };
  return { id: 'all', label: 'All work' };
}

function matches(item: TimelineItem, q: string): boolean {
  return item.key.toLowerCase().includes(q) || item.summary.toLowerCase().includes(q);
}

/** Flattens epics and children into display rows, grouped into swimlanes. */
export function buildRows(data: TimelineResponse, opts: RowOptions): Row[] {
  const byKey = new Map(data.items.map((i) => [i.key, i]));
  const epics = data.items.filter((i) => i.hierarchyLevel >= 1);
  const q = opts.search.trim().toLowerCase();

  const groups = new Map<string, { label: string; epics: TimelineItem[] }>();
  for (const epic of epics) {
    const children = epic.childKeys.map((k) => byKey.get(k)).filter((c): c is TimelineItem => Boolean(c));
    if (q && !matches(epic, q) && !children.some((c) => matches(c, q))) continue;
    const g = groupKey(epic, opts.groupBy);
    const entry = groups.get(g.id) ?? { label: g.label, epics: [] };
    entry.epics.push(epic);
    groups.set(g.id, entry);
  }

  const sorted = [...groups.entries()].sort((a, b) => {
    if (a[0].endsWith(':none')) return 1;
    if (b[0].endsWith(':none')) return -1;
    return a[1].label.localeCompare(b[1].label);
  });

  const rows: Row[] = [];
  for (const [id, g] of sorted) {
    if (opts.groupBy !== 'none') rows.push({ kind: 'group', id, label: g.label, count: g.epics.length });
    for (const epic of g.epics) {
      let children = epic.childKeys.map((k) => byKey.get(k)).filter((c): c is TimelineItem => Boolean(c));
      if (opts.hideDoneChildren) children = children.filter((c) => c.statusCategory !== 'done');
      // While searching, reveal children so matches are visible.
      const expanded = opts.expanded.has(epic.key) || (q !== '' && children.some((c) => matches(c, q)));
      rows.push({ kind: 'item', id: epic.key, item: epic, depth: 0, hasChildren: children.length > 0, expanded });
      if (expanded) {
        for (const child of children) {
          if (q && !matches(child, q) && !matches(epic, q)) continue;
          rows.push({ kind: 'item', id: child.key, item: child, depth: 1, hasChildren: false, expanded: false });
        }
      }
    }
  }
  return rows;
}
