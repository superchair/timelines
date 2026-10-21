import { useEffect, useState } from 'react';
import type { Dependency, IsoDate, TimelineItem, TimelineResponse } from '../../../shared/types';

interface Props {
  item: TimelineItem;
  data: TimelineResponse;
  busy: boolean;
  onClose: () => void;
  onSaveDates: (item: TimelineItem, start: IsoDate | null, due: IsoDate | null) => void;
  onAddDependency: (fromKey: string, toKey: string) => void;
  onRemoveDependency: (dep: Dependency) => void;
  onSelect: (key: string) => void;
}

const SOURCE_TEXT: Record<TimelineItem['dateSource'], string> = {
  explicit: 'Set on the work item',
  children: 'Rolled up from child work items',
  sprint: 'Inferred from sprints',
  version: 'End inferred from release date',
  none: 'Not scheduled',
};

export function DetailPanel({ item, data, busy, onClose, onSaveDates, onAddDependency, onRemoveDependency, onSelect }: Props) {
  const [start, setStart] = useState(item.start ?? '');
  const [due, setDue] = useState(item.due ?? '');
  const [newDep, setNewDep] = useState('');
  const [depDirection, setDepDirection] = useState<'blocks' | 'blockedBy'>('blocks');

  useEffect(() => {
    setStart(item.start ?? '');
    setDue(item.due ?? '');
  }, [item.key, item.start, item.due]);

  const byKey = new Map(data.items.map((i) => [i.key, i]));
  const blocks = data.dependencies.filter((d) => d.fromKey === item.key);
  const blockedBy = data.dependencies.filter((d) => d.toKey === item.key);
  const canSaveStart = Boolean(data.fields.startDateFieldId);
  const invalid = Boolean(start && due && start > due);
  const dirty = (start || null) !== (item.start ?? null) || (due || null) !== (item.due ?? null);
  const parent = item.parentKey ? byKey.get(item.parentKey) : undefined;

  const depRow = (d: Dependency, otherKey: string) => {
    const other = byKey.get(otherKey);
    return (
      <li key={d.id}>
        <button className="link" onClick={() => onSelect(otherKey)}>
          {otherKey}
        </button>
        <span className="dep-summary">{other?.summary ?? ''}</span>
        <button className="icon-btn" title="Remove dependency" aria-label={`Remove dependency with ${otherKey}`} disabled={busy} onClick={() => onRemoveDependency(d)}>
          ×
        </button>
      </li>
    );
  };

  return (
    <aside className="detail" aria-label={`Details for ${item.key}`}>
      <header>
        <div>
          <a href={item.url} target="_blank" rel="noreferrer" className="detail-key">
            {item.key} ↗
          </a>
          <span className={`lozenge ${item.statusCategory}`}>{item.status}</span>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </header>
      <h2>{item.summary}</h2>
      <dl className="facts">
        <dt>Type</dt>
        <dd>{item.issueType}</dd>
        <dt>Space</dt>
        <dd>
          {item.projectName} ({item.projectKey})
        </dd>
        {parent && (
          <>
            <dt>Parent</dt>
            <dd>
              <button className="link" onClick={() => onSelect(parent.key)}>
                {parent.key}
              </button>{' '}
              {parent.summary}
            </dd>
          </>
        )}
        {item.team && (
          <>
            <dt>Team</dt>
            <dd>{item.team.name}</dd>
          </>
        )}
        <dt>Assignee</dt>
        <dd>{item.assignee?.displayName ?? 'Unassigned'}</dd>
        {item.progress && item.progress.total > 0 && (
          <>
            <dt>Progress</dt>
            <dd>
              {item.progress.done}/{item.progress.total} done · {item.progress.inProgress} in progress
            </dd>
          </>
        )}
        {item.sprints.length > 0 && (
          <>
            <dt>Sprints</dt>
            <dd>{item.sprints.map((s) => s.name).join(', ')}</dd>
          </>
        )}
        {item.fixVersions.length > 0 && (
          <>
            <dt>Releases</dt>
            <dd>{item.fixVersions.map((v) => `${v.name}${v.releaseDate ? ` (${v.releaseDate})` : ''}`).join(', ')}</dd>
          </>
        )}
      </dl>

      <section>
        <h3>Dates</h3>
        <p className="muted small">
          Showing {item.effectiveStart ?? '—'} → {item.effectiveEnd ?? '—'} · {SOURCE_TEXT[item.dateSource]}
        </p>
        <form
          className="dates"
          onSubmit={(e) => {
            e.preventDefault();
            if (!invalid) onSaveDates(item, start || null, due || null);
          }}
        >
          <label>
            Start date
            <input type="date" value={start} disabled={!canSaveStart || busy} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label>
            Due date
            <input type="date" value={due} disabled={busy} onChange={(e) => setDue(e.target.value)} />
          </label>
          {invalid && <p className="error small">Start must be on or before due.</p>}
          {!canSaveStart && <p className="muted small">This site has no Start date field, so only due dates can be saved.</p>}
          <div className="actions">
            <button type="submit" className="primary" disabled={!dirty || invalid || busy}>
              Save to Jira
            </button>
            <button
              type="button"
              disabled={busy || (!item.start && !item.due)}
              onClick={() => onSaveDates(item, null, null)}
              title="Remove Start date and Due date from the work item"
            >
              Clear dates
            </button>
          </div>
        </form>
      </section>

      <section>
        <h3>Dependencies</h3>
        {blocks.length > 0 && (
          <>
            <p className="dep-heading">Blocks</p>
            <ul className="dep-list">{blocks.map((d) => depRow(d, d.toKey))}</ul>
          </>
        )}
        {blockedBy.length > 0 && (
          <>
            <p className="dep-heading">Is blocked by</p>
            <ul className="dep-list">{blockedBy.map((d) => depRow(d, d.fromKey))}</ul>
          </>
        )}
        {blocks.length + blockedBy.length === 0 && <p className="muted small">No dependencies in this view.</p>}
        <form
          className="add-dep"
          onSubmit={(e) => {
            e.preventDefault();
            const key = newDep.trim().toUpperCase();
            if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key) || key === item.key) return;
            if (depDirection === 'blocks') onAddDependency(item.key, key);
            else onAddDependency(key, item.key);
            setNewDep('');
          }}
        >
          <select value={depDirection} onChange={(e) => setDepDirection(e.target.value as 'blocks' | 'blockedBy')} aria-label="Dependency direction">
            <option value="blocks">Blocks</option>
            <option value="blockedBy">Is blocked by</option>
          </select>
          <input value={newDep} onChange={(e) => setNewDep(e.target.value)} placeholder="KEY-123" aria-label="Work item key" list="item-keys" />
          <datalist id="item-keys">
            {data.items.slice(0, 500).map((i) => (
              <option key={i.key} value={i.key}>
                {i.summary}
              </option>
            ))}
          </datalist>
          <button type="submit" disabled={busy || !newDep.trim()}>
            Add
          </button>
        </form>
        <p className="muted small">Tip: drag from the dot at the end of a bar onto another bar.</p>
      </section>
    </aside>
  );
}
