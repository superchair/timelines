import { useEffect, useState } from 'react';
import type { BoardRef, ScopeRequest, ScopeSource } from '../../../shared/types';
import { api } from '../lib/api';
import type { GroupBy } from '../lib/rows';
import type { Zoom } from './Timeline';

interface Props {
  scope: ScopeRequest | null;
  groupBy: GroupBy;
  zoom: Zoom;
  search: string;
  hideDoneChildren: boolean;
  loading: boolean;
  onScope: (scope: ScopeRequest) => void;
  onGroupBy: (g: GroupBy) => void;
  onZoom: (z: Zoom) => void;
  onSearch: (s: string) => void;
  onHideDoneChildren: (v: boolean) => void;
  onRefresh: () => void;
  onToday: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}

const PLACEHOLDER: Record<ScopeSource, string> = {
  board: 'Board ID, e.g. 656',
  filter: 'Saved filter ID',
  jql: 'project in (ABC, DEF) OR category = "Platform"',
};

export function Toolbar(p: Props) {
  const [source, setSource] = useState<ScopeSource>(p.scope?.source ?? 'board');
  const [value, setValue] = useState(p.scope?.value ?? '');
  const [doneDays, setDoneDays] = useState(p.scope?.doneWithinDays ?? 30);
  const [boards, setBoards] = useState<BoardRef[]>([]);

  useEffect(() => {
    if (p.scope) {
      setSource(p.scope.source);
      setValue(p.scope.value);
      setDoneDays(p.scope.doneWithinDays ?? 30);
    }
  }, [p.scope]);

  useEffect(() => {
    if (source !== 'board') return;
    let cancelled = false;
    api
      .boards()
      .then((b) => !cancelled && setBoards(b))
      .catch(() => !cancelled && setBoards([]));
    return () => {
      cancelled = true;
    };
  }, [source]);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (value.trim()) p.onScope({ source, value: value.trim(), doneWithinDays: doneDays });
  };

  return (
    <div className="toolbar">
      <form className="scope" onSubmit={submit}>
        <select value={source} onChange={(e) => setSource(e.target.value as ScopeSource)} aria-label="Scope type">
          <option value="board">Board</option>
          <option value="filter">Saved filter</option>
          <option value="jql">JQL</option>
        </select>
        {source === 'board' && boards.length > 0 ? (
          <select
            className="scope-value"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (e.target.value) p.onScope({ source: 'board', value: e.target.value, doneWithinDays: doneDays });
            }}
            aria-label="Board"
          >
            <option value="">Choose a board…</option>
            {value && !boards.some((b) => String(b.id) === value) && <option value={value}>Board {value}</option>}
            {boards.map((b) => (
              <option key={b.id} value={String(b.id)}>
                {b.name} ({b.id})
              </option>
            ))}
          </select>
        ) : (
          <input className="scope-value" value={value} onChange={(e) => setValue(e.target.value)} placeholder={PLACEHOLDER[source]} aria-label="Scope value" />
        )}
        <select value={doneDays} onChange={(e) => setDoneDays(Number(e.target.value))} aria-label="Completed epics" title="Which completed epics to include">
          <option value={0}>Hide done epics</option>
          <option value={30}>Done in last 30 days</option>
          <option value={90}>Done in last 90 days</option>
          <option value={-1}>All done epics</option>
        </select>
        <button type="submit" className="primary" disabled={!value.trim() || p.loading}>
          Load
        </button>
      </form>

      <div className="view-controls">
        <input type="search" value={p.search} onChange={(e) => p.onSearch(e.target.value)} placeholder="Filter by key or summary" aria-label="Filter work" />
        <label className="inline">
          Group
          <select value={p.groupBy} onChange={(e) => p.onGroupBy(e.target.value as GroupBy)}>
            <option value="project">Space</option>
            <option value="team">Team</option>
            <option value="none">None</option>
          </select>
        </label>
        <div className="segmented" role="group" aria-label="Zoom">
          {(['weeks', 'months', 'quarters'] as Zoom[]).map((z) => (
            <button key={z} className={p.zoom === z ? 'active' : ''} onClick={() => p.onZoom(z)} type="button">
              {z[0].toUpperCase() + z.slice(1)}
            </button>
          ))}
        </div>
        <label className="inline checkbox">
          <input type="checkbox" checked={p.hideDoneChildren} onChange={(e) => p.onHideDoneChildren(e.target.checked)} />
          Hide done children
        </label>
        <button type="button" onClick={p.onExpandAll}>
          Expand all
        </button>
        <button type="button" onClick={p.onCollapseAll}>
          Collapse
        </button>
        <button type="button" onClick={p.onToday}>
          Today
        </button>
        <button type="button" onClick={p.onRefresh} disabled={p.loading || !p.scope} title="Reload from Jira">
          {p.loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
    </div>
  );
}
