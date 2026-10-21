import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dependency, IsoDate, MeResponse, ScopeRequest, ScopeSource, TimelineItem, TimelineResponse } from '../../shared/types';
import { DetailPanel } from './components/DetailPanel';
import { Timeline, type Zoom } from './components/Timeline';
import { Toolbar } from './components/Toolbar';
import { api, ApiRequestError } from './lib/api';
import { buildRows, type GroupBy } from './lib/rows';
import { loadJson, saveJson } from './lib/storage';

interface Toast {
  id: number;
  kind: 'error' | 'info';
  text: string;
  detail?: string;
}

interface ViewPrefs {
  groupBy: GroupBy;
  zoom: Zoom;
  hideDoneChildren: boolean;
}

const PREFS_KEY = 'timelines.prefs.v1';
const LAST_SCOPE_KEY = 'timelines.lastScope.v1';

function readUrl(): { scope: ScopeRequest | null; groupBy?: GroupBy; zoom?: Zoom } {
  const q = new URLSearchParams(window.location.search);
  const source = q.get('source') as ScopeSource | null;
  const value = q.get('value');
  const scope =
    source && value && ['board', 'filter', 'jql'].includes(source)
      ? { source, value, doneWithinDays: Number(q.get('done') ?? 30) }
      : null;
  const g = q.get('group') as GroupBy | null;
  const z = q.get('zoom') as Zoom | null;
  return {
    scope,
    groupBy: g && ['project', 'team', 'none'].includes(g) ? g : undefined,
    zoom: z && ['weeks', 'months', 'quarters'].includes(z) ? z : undefined,
  };
}

function writeUrl(scope: ScopeRequest | null, prefs: ViewPrefs) {
  const q = new URLSearchParams();
  if (scope) {
    q.set('source', scope.source);
    q.set('value', scope.value);
    q.set('done', String(scope.doneWithinDays ?? 30));
  }
  q.set('group', prefs.groupBy);
  q.set('zoom', prefs.zoom);
  window.history.replaceState(null, '', `${window.location.pathname}?${q}`);
}

function errorToast(e: unknown, fallback: string): Omit<Toast, 'id'> {
  if (e instanceof ApiRequestError) return { kind: 'error', text: e.message, detail: e.detail };
  return { kind: 'error', text: fallback, detail: e instanceof Error ? e.message : undefined };
}

export function App() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [meError, setMeError] = useState<string | null>(null);

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch((e) => setMeError(e instanceof ApiRequestError ? `${e.message}${e.detail ? ` — ${e.detail}` : ''}` : String(e)));
  }, []);

  if (meError) return <CenteredMessage title="Can't reach Jira" body={meError} />;
  if (!me) return <CenteredMessage title="Loading…" />;
  if (!me.authenticated && me.sites?.length) return <SitePicker me={me} />;
  if (!me.authenticated) return <SignIn />;
  return <Workspace me={me} />;
}

function CenteredMessage({ title, body }: { title: string; body?: string }) {
  return (
    <main className="centered">
      <div className="card">
        <h1>{title}</h1>
        {body && <p className="muted">{body}</p>}
      </div>
    </main>
  );
}

function SignIn() {
  return (
    <main className="centered">
      <div className="card">
        <h1>Timelines</h1>
        <p className="muted">Plan across every Jira space your teams use. Sign in with your Atlassian account; changes are made as you, with your Jira permissions.</p>
        <a className="button primary" href="/auth/login">
          Sign in with Atlassian
        </a>
      </div>
    </main>
  );
}

function SitePicker({ me }: { me: MeResponse }) {
  const [busy, setBusy] = useState(false);
  return (
    <main className="centered">
      <div className="card">
        <h1>Choose a Jira site</h1>
        <ul className="site-list">
          {me.sites!.map((s) => (
            <li key={s.cloudId}>
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await api.selectSite(s.cloudId).catch(() => undefined);
                  window.location.reload();
                }}
              >
                <strong>{s.name}</strong>
                <span className="muted">{s.url}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}

function Workspace({ me }: { me: MeResponse }) {
  const initial = useMemo(readUrl, []);
  const savedPrefs = loadJson<ViewPrefs>(PREFS_KEY, { groupBy: 'project', zoom: 'months', hideDoneChildren: false });
  const [prefs, setPrefs] = useState<ViewPrefs>({
    ...savedPrefs,
    groupBy: initial.groupBy ?? savedPrefs.groupBy,
    zoom: initial.zoom ?? savedPrefs.zoom,
  });
  const [scope, setScope] = useState<ScopeRequest | null>(initial.scope ?? loadJson<ScopeRequest | null>(LAST_SCOPE_KEY, null));
  const [data, setData] = useState<TimelineResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<Omit<Toast, 'id'> | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [selectedKey, setSelectedKey] = useState<string>();
  const [selectedDepId, setSelectedDepId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [todaySignal, setTodaySignal] = useState(0);
  const loadSeq = useRef(0);

  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { ...t, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.kind === 'error' ? 9000 : 3500);
  }, []);

  const load = useCallback(
    async (s: ScopeRequest, opts: { fresh?: boolean; silent?: boolean } = {}) => {
      const seq = ++loadSeq.current;
      if (!opts.silent) setLoading(true);
      try {
        const res = await api.timeline(s, opts.fresh);
        if (seq !== loadSeq.current) return;
        setData(res);
        setLoadError(null);
      } catch (e) {
        if (seq !== loadSeq.current) return;
        if (e instanceof ApiRequestError && e.status === 401) {
          window.location.reload();
          return;
        }
        if (!opts.silent) setData(null);
        setLoadError(errorToast(e, 'Could not load the timeline'));
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    writeUrl(scope, prefs);
    saveJson(PREFS_KEY, prefs);
  }, [scope, prefs]);

  useEffect(() => {
    if (!scope) return;
    saveJson(LAST_SCOPE_KEY, scope);
    setSelectedKey(undefined);
    setSelectedDepId(undefined);
    void load(scope);
  }, [scope, load]);

  const rows = useMemo(
    () => (data ? buildRows(data, { groupBy: prefs.groupBy, expanded, search, hideDoneChildren: prefs.hideDoneChildren }) : []),
    [data, prefs.groupBy, prefs.hideDoneChildren, expanded, search],
  );

  const selectedItem = data?.items.find((i) => i.key === selectedKey);
  const selectedDep = data?.dependencies.find((d) => d.id === selectedDepId);

  // ----- Mutations (optimistic, then re-sync from Jira) -----
  const saveDates = useCallback(
    async (item: TimelineItem, start: IsoDate | null, due: IsoDate | null) => {
      if (!scope) return;
      setData((d) =>
        d && {
          ...d,
          items: d.items.map((i) =>
            i.key === item.key
              ? {
                  ...i,
                  start: start ?? undefined,
                  due: due ?? undefined,
                  effectiveStart: start ?? due ?? undefined,
                  effectiveEnd: due ?? start ?? undefined,
                  dateSource: start || due ? 'explicit' : 'none',
                }
              : i,
          ),
        },
      );
      setBusy(true);
      try {
        await api.updateDates(item.key, { start, due });
        toast({ kind: 'info', text: `${item.key} updated in Jira` });
      } catch (e) {
        toast(errorToast(e, `Could not update ${item.key}`));
      } finally {
        setBusy(false);
        void load(scope, { fresh: true, silent: true });
      }
    },
    [scope, load, toast],
  );

  const addDependency = useCallback(
    async (fromKey: string, toKey: string) => {
      if (!scope) return;
      if (data?.dependencies.some((d) => d.fromKey === fromKey && d.toKey === toKey)) {
        toast({ kind: 'info', text: `${fromKey} already blocks ${toKey}` });
        return;
      }
      setBusy(true);
      try {
        await api.createDependency({ fromKey, toKey });
        toast({ kind: 'info', text: `${fromKey} now blocks ${toKey}` });
      } catch (e) {
        toast(errorToast(e, 'Could not add the dependency'));
      } finally {
        setBusy(false);
        void load(scope, { fresh: true, silent: true });
      }
    },
    [scope, data, load, toast],
  );

  const removeDependency = useCallback(
    async (dep: Dependency) => {
      if (!scope) return;
      setData((d) => d && { ...d, dependencies: d.dependencies.filter((x) => x.id !== dep.id) });
      setSelectedDepId(undefined);
      setBusy(true);
      try {
        await api.deleteDependency(dep.id);
        toast({ kind: 'info', text: `Removed: ${dep.fromKey} blocks ${dep.toKey}` });
      } catch (e) {
        toast(errorToast(e, 'Could not remove the dependency'));
      } finally {
        setBusy(false);
        void load(scope, { fresh: true, silent: true });
      }
    },
    [scope, load, toast],
  );

  const epicKeys = useMemo(() => data?.items.filter((i) => i.hierarchyLevel >= 1 && i.childKeys.length).map((i) => i.key) ?? [], [data]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden>
            <rect x="1" y="3" width="9" height="3" rx="1.5" className="brand-a" />
            <rect x="5" y="10" width="10" height="3" rx="1.5" className="brand-b" />
          </svg>
          <span>Timelines</span>
          {data && <span className="scope-label">{data.scope.label}</span>}
        </div>
        <div className="who">
          {me.mode === 'mock' && <span className="badge">Demo data</span>}
          {me.site && <span className="muted">{me.site.name}</span>}
          {me.user && <span>{me.user.displayName}</span>}
          {me.mode === 'oauth' && (
            <button
              onClick={async () => {
                await api.logout().catch(() => undefined);
                window.location.href = '/';
              }}
            >
              Sign out
            </button>
          )}
        </div>
      </header>

      <Toolbar
        scope={scope}
        groupBy={prefs.groupBy}
        zoom={prefs.zoom}
        search={search}
        hideDoneChildren={prefs.hideDoneChildren}
        loading={loading}
        onScope={(s) => setScope({ ...s })}
        onGroupBy={(groupBy) => setPrefs((p) => ({ ...p, groupBy }))}
        onZoom={(zoom) => setPrefs((p) => ({ ...p, zoom }))}
        onSearch={setSearch}
        onHideDoneChildren={(hideDoneChildren) => setPrefs((p) => ({ ...p, hideDoneChildren }))}
        onRefresh={() => scope && load(scope, { fresh: true })}
        onToday={() => setTodaySignal((n) => n + 1)}
        onExpandAll={() => setExpanded(new Set(epicKeys))}
        onCollapseAll={() => setExpanded(new Set())}
      />

      {data?.warnings.map((w) => (
        <div key={w} className="banner warn">
          {w}
        </div>
      ))}
      {loadError && (
        <div className="banner error">
          <strong>{loadError.text}</strong>
          {loadError.detail && <span> — {loadError.detail}</span>}
        </div>
      )}

      <div className="main">
        {!scope && (
          <div className="empty-state">
            <h2>Pick what to plan</h2>
            <p className="muted">
              Choose a board to use its filter as the scope — a board that spans several spaces gives you a cross-space timeline. You can also use a saved filter ID or any JQL.
            </p>
          </div>
        )}
        {scope && !data && loading && <div className="empty-state muted">Loading from Jira…</div>}
        {data && (
          <Timeline
            data={data}
            rows={rows}
            zoom={prefs.zoom}
            selectedKey={selectedKey}
            selectedDepId={selectedDepId}
            todaySignal={todaySignal}
            onSelect={(k) => {
              setSelectedKey(k);
              setSelectedDepId(undefined);
            }}
            onSelectDependency={(id) => {
              setSelectedDepId(id);
              if (id) setSelectedKey(undefined);
            }}
            onToggle={(k) =>
              setExpanded((s) => {
                const n = new Set(s);
                if (n.has(k)) n.delete(k);
                else n.add(k);
                return n;
              })
            }
            onDatesChange={(item, start, due) => void saveDates(item, start, due)}
            onCreateDependency={(a, b) => void addDependency(a, b)}
          />
        )}
        {data && selectedItem && (
          <DetailPanel
            item={selectedItem}
            data={data}
            busy={busy}
            onClose={() => setSelectedKey(undefined)}
            onSaveDates={(item, s, d) => void saveDates(item, s, d)}
            onAddDependency={(a, b) => void addDependency(a, b)}
            onRemoveDependency={(d) => void removeDependency(d)}
            onSelect={(k) => setSelectedKey(k)}
          />
        )}
      </div>

      {selectedDep && (
        <div className="dep-popover" role="dialog" aria-label="Dependency">
          <span>
            <strong>{selectedDep.fromKey}</strong> blocks <strong>{selectedDep.toKey}</strong>
          </span>
          <button className="danger" disabled={busy} onClick={() => void removeDependency(selectedDep)}>
            Remove
          </button>
          <button onClick={() => setSelectedDepId(undefined)}>Close</button>
        </div>
      )}

      <footer className="legend" aria-label="Legend">
        <span>
          <i className="sw epic" /> Epic
        </span>
        <span>
          <i className="sw new" /> To do
        </span>
        <span>
          <i className="sw indeterminate" /> In progress
        </span>
        <span>
          <i className="sw done" /> Done
        </span>
        <span>
          <i className="sw derived" /> Inferred dates
        </span>
        <span>
          <i className="sw dep" /> Blocks
        </span>
        <span>
          <i className="sw dep conflict" /> Scheduling conflict
        </span>
        <span>
          <i className="sw release" /> Release
        </span>
        <span>
          <i className="sw today" /> Today
        </span>
      </footer>

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <strong>{t.text}</strong>
            {t.detail && <div className="small">{t.detail}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
