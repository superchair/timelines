import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  addDays,
  addMonths,
  fromDayNumber,
  maxDate,
  minDate,
  startOfMonth,
  startOfWeek,
  toDayNumber,
  todayIso,
} from '../../../shared/dates';
import type { Dependency, IsoDate, TimelineItem, TimelineResponse } from '../../../shared/types';
import type { Row } from '../lib/rows';

export type Zoom = 'weeks' | 'months' | 'quarters';

const DAY_WIDTH: Record<Zoom, number> = { weeks: 24, months: 7, quarters: 2.4 };
const LEFT_W = 360;
const ROW_H = 36;
const BAR_H = 20;
const SCALE_TOP = 24;
const SCALE_BOTTOM = 22;
const SPRINT_LANE = 20;
const MAX_SPRINT_LANES = 3;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface Props {
  data: TimelineResponse;
  rows: Row[];
  zoom: Zoom;
  selectedKey?: string;
  selectedDepId?: string;
  todaySignal: number;
  onSelect: (key: string | undefined) => void;
  onSelectDependency: (id: string | undefined) => void;
  onToggle: (key: string) => void;
  onDatesChange: (item: TimelineItem, start: IsoDate, due: IsoDate) => void;
  onCreateDependency: (fromKey: string, toKey: string) => void;
}

type DragMode = 'move' | 'start' | 'end' | 'create' | 'link';
interface DragState {
  mode: DragMode;
  key: string;
  originClientX: number;
  baseStart?: IsoDate;
  baseEnd?: IsoDate;
  anchorDay?: number;
  deltaDays: number;
  pointer: { x: number; y: number };
  moved: boolean;
}

function monthLabel(date: IsoDate, withYear: boolean) {
  const m = MONTHS[Number(date.slice(5, 7)) - 1];
  return withYear ? `${m} ${date.slice(0, 4)}` : m;
}

export function Timeline(props: Props) {
  const { data, rows, zoom, selectedKey, selectedDepId, todaySignal } = props;
  const dw = DAY_WIDTH[zoom];
  const today = todayIso();
  const scrollRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  // ----- Time range -----
  const { origin, end } = useMemo(() => {
    const starts = [
      ...data.items.map((i) => i.effectiveStart),
      ...data.sprints.map((s) => s.start),
      ...data.releases.map((r) => r.date),
    ];
    const ends = [...data.items.map((i) => i.effectiveEnd), ...data.sprints.map((s) => s.end), ...data.releases.map((r) => r.date)];
    const lo = minDate([...starts, addDays(today, -30)])!;
    const hi = maxDate([...ends, addDays(today, 120)])!;
    return { origin: addMonths(startOfMonth(lo), -1), end: addMonths(startOfMonth(hi), 2) };
  }, [data, today]);

  const originDay = toDayNumber(origin);
  const totalDays = toDayNumber(end) - originDay;
  const chartW = Math.ceil(totalDays * dw);
  const x = useCallback((d: IsoDate) => (toDayNumber(d) - originDay) * dw, [originDay, dw]);
  const dayAt = useCallback((px: number) => Math.floor(px / dw) + originDay, [originDay, dw]);

  // ----- Sprint lanes (one per board) -----
  const sprintLanes = useMemo(() => {
    const byBoard = new Map<string, typeof data.sprints>();
    for (const s of data.sprints) {
      const k = String(s.boardId ?? 'none');
      byBoard.set(k, [...(byBoard.get(k) ?? []), s]);
    }
    return [...byBoard.values()].slice(0, MAX_SPRINT_LANES);
  }, [data.sprints]);
  const headerH = SCALE_TOP + SCALE_BOTTOM + sprintLanes.length * SPRINT_LANE + (data.releases.length ? 14 : 0);

  // ----- Scale ticks -----
  const { topTicks, bottomTicks } = useMemo(() => {
    const top: Array<{ date: IsoDate; label: string }> = [];
    const bottom: Array<{ date: IsoDate; label: string }> = [];
    if (zoom === 'quarters') {
      for (let m = origin; m < end; m = addMonths(m, 1)) {
        const month = Number(m.slice(5, 7));
        if ((month - 1) % 3 === 0 || m === origin) top.push({ date: m, label: `Q${Math.floor((month - 1) / 3) + 1} ${m.slice(0, 4)}` });
        bottom.push({ date: m, label: monthLabel(m, false) });
      }
    } else {
      for (let m = origin; m < end; m = addMonths(m, 1)) top.push({ date: m, label: monthLabel(m, true) });
      for (let w = startOfWeek(origin); w < end; w = addDays(w, 7)) {
        if (w >= origin) bottom.push({ date: w, label: String(Number(w.slice(8, 10))) });
      }
    }
    return { topTicks: top, bottomTicks: bottom };
  }, [zoom, origin, end]);

  // ----- Scroll to today on load / on request -----
  const scrollToToday = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = Math.max(0, x(today) - (el.clientWidth - LEFT_W) * 0.3);
  }, [x, today]);
  const didInitialScroll = useRef(false);
  useLayoutEffect(() => {
    if (!didInitialScroll.current && rows.length) {
      scrollToToday();
      didInitialScroll.current = true;
    }
  }, [rows.length, scrollToToday]);
  useLayoutEffect(() => {
    if (todaySignal) scrollToToday();
  }, [todaySignal, scrollToToday]);
  // Keep the same date centred when zoom changes.
  const prevDw = useRef(dw);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && prevDw.current !== dw) {
      const centreDay = (el.scrollLeft + (el.clientWidth - LEFT_W) / 2) / prevDw.current;
      el.scrollLeft = centreDay * dw - (el.clientWidth - LEFT_W) / 2;
      prevDw.current = dw;
    }
  }, [dw]);

  // ----- Row geometry -----
  const rowIndex = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => r.kind === 'item' && m.set(r.item.key, i));
    return m;
  }, [rows]);
  const byKey = useMemo(() => new Map(data.items.map((i) => [i.key, i])), [data.items]);

  // ----- Drag preview -----
  const preview = (item: TimelineItem): { start?: IsoDate; end?: IsoDate } => {
    const d = drag;
    if (!d || d.key !== item.key || !d.moved) return { start: item.effectiveStart, end: item.effectiveEnd };
    if (d.mode === 'create' && d.anchorDay !== undefined) {
      const cur = d.anchorDay + d.deltaDays;
      return { start: fromDayNumber(Math.min(d.anchorDay, cur)), end: fromDayNumber(Math.max(d.anchorDay, cur)) };
    }
    if (!d.baseStart || !d.baseEnd) return { start: item.effectiveStart, end: item.effectiveEnd };
    if (d.mode === 'move') return { start: addDays(d.baseStart, d.deltaDays), end: addDays(d.baseEnd, d.deltaDays) };
    if (d.mode === 'start') {
      const s = addDays(d.baseStart, d.deltaDays);
      return { start: s > d.baseEnd ? d.baseEnd : s, end: d.baseEnd };
    }
    if (d.mode === 'end') {
      const e = addDays(d.baseEnd, d.deltaDays);
      return { start: d.baseStart, end: e < d.baseStart ? d.baseStart : e };
    }
    return { start: item.effectiveStart, end: item.effectiveEnd };
  };

  const chartPoint = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const beginDrag = (e: React.PointerEvent, mode: DragMode, item: TimelineItem) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const p = chartPoint(e.clientX, e.clientY);
    setDrag({
      mode,
      key: item.key,
      originClientX: e.clientX,
      baseStart: item.effectiveStart,
      baseEnd: item.effectiveEnd,
      anchorDay: mode === 'create' ? dayAt(p.x) : undefined,
      deltaDays: 0,
      pointer: p,
      moved: false,
    });
  };

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const deltaDays = Math.round((e.clientX - d.originClientX) / dw);
      const moved = d.moved || Math.abs(e.clientX - d.originClientX) > 3;
      setDrag({ ...d, deltaDays, moved, pointer: chartPoint(e.clientX, e.clientY) });
    };
    const onUp = (e: PointerEvent) => {
      const d = dragRef.current;
      setDrag(null);
      if (!d) return;
      const item = byKey.get(d.key);
      if (!item) return;
      if (d.mode === 'link') {
        const target = (document.elementFromPoint(e.clientX, e.clientY) as Element | null)?.closest('[data-bar-key]');
        const toKey = target?.getAttribute('data-bar-key');
        if (toKey && toKey !== d.key) props.onCreateDependency(d.key, toKey);
        return;
      }
      if (d.mode === 'create') {
        if (d.anchorDay === undefined) return;
        if (!d.moved) {
          props.onSelect(d.key);
          return;
        }
        const cur = d.anchorDay + Math.round((e.clientX - d.originClientX) / dw);
        props.onDatesChange(item, fromDayNumber(Math.min(d.anchorDay, cur)), fromDayNumber(Math.max(d.anchorDay, cur)));
        return;
      }
      if (!d.moved || d.deltaDays === 0) {
        props.onSelect(d.key);
        return;
      }
      const delta = Math.round((e.clientX - d.originClientX) / dw);
      const s0 = d.baseStart!;
      const e0 = d.baseEnd!;
      let ns = s0;
      let ne = e0;
      if (d.mode === 'move') {
        ns = addDays(s0, delta);
        ne = addDays(e0, delta);
      } else if (d.mode === 'start') {
        ns = addDays(s0, delta);
        if (ns > e0) ns = e0;
      } else if (d.mode === 'end') {
        ne = addDays(e0, delta);
        if (ne < s0) ne = s0;
      }
      props.onDatesChange(item, ns, ne);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null, dw, byKey]);

  // ----- Dependencies -----
  const depPaths = useMemo(() => {
    const visibleRow = (key: string) => {
      const direct = rowIndex.get(key);
      if (direct !== undefined) return { row: direct, item: byKey.get(key)! };
      const parent = byKey.get(key)?.parentKey;
      const pr = parent ? rowIndex.get(parent) : undefined;
      return pr !== undefined ? { row: pr, item: byKey.get(parent!)! } : undefined;
    };
    const out: Array<{ dep: Dependency; d: string; conflict: boolean }> = [];
    for (const dep of data.dependencies) {
      const a = visibleRow(dep.fromKey);
      const b = visibleRow(dep.toKey);
      if (!a || !b || a.row === b.row) continue;
      const from = byKey.get(dep.fromKey)!;
      const to = byKey.get(dep.toKey)!;
      if (!a.item.effectiveEnd || !b.item.effectiveStart) continue;
      const x1 = x(a.item.effectiveEnd) + dw;
      const y1 = a.row * ROW_H + ROW_H / 2;
      const x2 = x(b.item.effectiveStart);
      const y2 = b.row * ROW_H + ROW_H / 2;
      let d: string;
      if (x2 - x1 >= 24) {
        const bend = Math.max(12, Math.min(80, (x2 - x1) / 2));
        d = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2 - 2} ${y2}`;
      } else {
        // Target starts before (or right at) the blocker's end: route around via the row gap.
        const midY = b.row > a.row ? (a.row + 1) * ROW_H : a.row * ROW_H;
        d = `M ${x1} ${y1} H ${x1 + 8} V ${midY} H ${x2 - 12} V ${y2} H ${x2 - 2}`;
      }
      const conflict = Boolean(from.effectiveEnd && to.effectiveStart && to.effectiveStart <= from.effectiveEnd);
      out.push({ dep, d, conflict });
    }
    return out;
  }, [data.dependencies, rowIndex, byKey, x, dw]);

  const bodyH = Math.max(rows.length * ROW_H, 120);

  return (
    <div className="tl-scroll" ref={scrollRef}>
      <div className="tl-canvas" style={{ width: LEFT_W + chartW }}>
        {/* Header */}
        <div className="tl-header" style={{ height: headerH }}>
          <div className="tl-corner" style={{ width: LEFT_W, height: headerH }}>
            <span>Work</span>
            <span className="muted">{data.items.filter((i) => i.hierarchyLevel >= 1).length} epics</span>
          </div>
          <svg width={chartW} height={headerH} className="tl-scale" role="presentation">
            {topTicks.map((t) => (
              <g key={`t${t.date}`}>
                <line x1={x(t.date)} x2={x(t.date)} y1={0} y2={SCALE_TOP} className="tick" />
                <text x={x(t.date) + 6} y={16} className="scale-top">
                  {t.label}
                </text>
              </g>
            ))}
            {bottomTicks.map((t) => (
              <g key={`b${t.date}`}>
                <line x1={x(t.date)} x2={x(t.date)} y1={SCALE_TOP} y2={SCALE_TOP + SCALE_BOTTOM} className="tick minor" />
                <text x={x(t.date) + 4} y={SCALE_TOP + 15} className="scale-bottom">
                  {t.label}
                </text>
              </g>
            ))}
            {sprintLanes.map((lane, li) =>
              lane.map((s) => {
                const sx = x(s.start);
                const w = Math.max(2, x(addDays(s.end, 1)) - sx - 2);
                const y = SCALE_TOP + SCALE_BOTTOM + li * SPRINT_LANE + 2;
                return (
                  <g key={s.id} className={`sprint ${s.state}`}>
                    <title>{`${s.name} (${s.start} → ${s.end})`}</title>
                    <rect x={sx + 1} y={y} width={w} height={SPRINT_LANE - 4} rx={3} />
                    <clipPath id={`sc${s.id}`}>
                      <rect x={sx + 1} y={y} width={w - 4} height={SPRINT_LANE - 4} />
                    </clipPath>
                    <text x={sx + 6} y={y + 12} clipPath={`url(#sc${s.id})`}>
                      {s.name}
                    </text>
                  </g>
                );
              }),
            )}
            {data.releases.map((r) => (
              <g key={`${r.name}|${r.date}`} className={`release ${r.released ? 'released' : ''}`}>
                <title>{`${r.name} — ${r.date} (${r.projects.join(', ')})`}</title>
                <path d={`M ${x(r.date) + dw / 2} ${headerH - 13} l 5 5 l -5 5 l -5 -5 z`} />
                <text x={x(r.date) + dw / 2 + 8} y={headerH - 4}>
                  {r.name}
                </text>
              </g>
            ))}
            <line x1={x(today) + dw / 2} x2={x(today) + dw / 2} y1={SCALE_TOP} y2={headerH} className="today" />
          </svg>
        </div>

        {/* Body */}
        <div className="tl-body" style={{ height: bodyH }}>
          <div className="tl-left" style={{ width: LEFT_W }}>
            {rows.map((r) =>
              r.kind === 'group' ? (
                <div key={r.id} className="tl-row group" style={{ height: ROW_H }}>
                  <span className="group-label">{r.label}</span>
                  <span className="muted">{r.count}</span>
                </div>
              ) : (
                <div
                  key={r.id}
                  className={`tl-row item depth-${r.depth} ${selectedKey === r.item.key ? 'selected' : ''}`}
                  style={{ height: ROW_H }}
                  onClick={() => props.onSelect(r.item.key)}
                >
                  {r.depth === 0 ? (
                    <button
                      className={`caret ${r.expanded ? 'open' : ''}`}
                      disabled={!r.hasChildren}
                      aria-label={r.expanded ? `Collapse ${r.item.key}` : `Expand ${r.item.key}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onToggle(r.item.key);
                      }}
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                        <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
                      </svg>
                    </button>
                  ) : (
                    <span className="caret-spacer" />
                  )}
                  <span className={`type-dot ${r.item.hierarchyLevel >= 1 ? 'epic' : 'story'}`} title={r.item.issueType} />
                  <span className="row-key">{r.item.key}</span>
                  <span className="row-summary" title={r.item.summary}>
                    {r.item.summary}
                  </span>
                  <span className={`lozenge ${r.item.statusCategory}`}>{r.item.status}</span>
                </div>
              ),
            )}
            {rows.length === 0 && <div className="tl-empty">No epics match this scope.</div>}
          </div>

          <svg
            ref={svgRef}
            width={chartW}
            height={bodyH}
            className={`tl-chart ${drag ? `dragging ${drag.mode}` : ''}`}
            onPointerDown={(e) => {
              if (e.target === e.currentTarget) {
                props.onSelect(undefined);
                props.onSelectDependency(undefined);
              }
            }}
          >
            <defs>
              <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L8 4 L0 8 z" className="arrow-head" />
              </marker>
              <marker id="arrow-conflict" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L8 4 L0 8 z" className="arrow-head conflict" />
              </marker>
              <pattern id="derived" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="3" height="6" className="derived-stripe" />
              </pattern>
            </defs>

            {/* Grid */}
            {zoom === 'weeks' &&
              Array.from({ length: totalDays }, (_, i) => i).map((i) => {
                const wd = (((originDay + i + 3) % 7) + 7) % 7;
                return wd >= 5 ? <rect key={i} x={i * dw} y={0} width={dw} height={bodyH} className="weekend" /> : null;
              })}
            {bottomTicks.map((t) => (
              <line key={t.date} x1={x(t.date)} x2={x(t.date)} y1={0} y2={bodyH} className="grid" />
            ))}
            {rows.map((r, i) =>
              r.kind === 'group' ? (
                <rect key={r.id} x={0} y={i * ROW_H} width={chartW} height={ROW_H} className="group-band" />
              ) : selectedKey === r.item.key ? (
                <rect key={r.id} x={0} y={i * ROW_H} width={chartW} height={ROW_H} className="selected-band" />
              ) : null,
            )}
            {data.sprints
              .filter((s) => s.state === 'active')
              .slice(0, 1)
              .map((s) => (
                <rect key={s.id} x={x(s.start)} y={0} width={x(addDays(s.end, 1)) - x(s.start)} height={bodyH} className="active-sprint" />
              ))}
            {data.releases.map((r) => (
              <line key={`${r.name}|${r.date}`} x1={x(r.date) + dw / 2} x2={x(r.date) + dw / 2} y1={0} y2={bodyH} className="release-line" />
            ))}
            <line x1={x(today) + dw / 2} x2={x(today) + dw / 2} y1={0} y2={bodyH} className="today" />

            {/* Dependencies (under bars so bar handles and connectors stay clickable) */}
            {depPaths.map(({ dep, d, conflict }) => (
              <g
                key={dep.id}
                className={`dep ${conflict ? 'conflict' : ''} ${selectedDepId === dep.id ? 'selected' : ''}`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  props.onSelectDependency(dep.id);
                }}
              >
                <title>{`${dep.fromKey} blocks ${dep.toKey}${conflict ? ' — scheduled to start before its blocker ends' : ''}`}</title>
                <path d={d} className="dep-hit" />
                <path d={d} className="dep-line" markerEnd={`url(#${conflict ? 'arrow-conflict' : 'arrow'})`} />
              </g>
            ))}

            {/* Rows: bars or a drop zone for unscheduled work */}
            {rows.map((r, i) => {
              if (r.kind !== 'item') return null;
              const item = r.item;
              const top = i * ROW_H;
              const { start, end: due } = preview(item);
              if (!start || !due) {
                return (
                  <g key={item.key} className="unscheduled" onPointerDown={(e) => beginDrag(e, 'create', item)}>
                    <rect x={0} y={top + 4} width={chartW} height={ROW_H - 8} className="create-zone" />
                    <title>{`${item.key} has no dates — drag across this row to schedule it`}</title>
                  </g>
                );
              }
              const bx = x(start);
              const bw = Math.max(6, x(addDays(due, 1)) - bx);
              const by = top + (ROW_H - BAR_H) / 2;
              const derived = item.dateSource !== 'explicit' && !(drag?.key === item.key && drag.moved);
              const isEpic = item.hierarchyLevel >= 1;
              const label = `${item.key} ${item.summary}`;
              const fitsInside = bw > label.length * 6.4 + 14;
              const p = item.progress;
              const sourceNote =
                item.dateSource === 'children'
                  ? 'Dates rolled up from child work items'
                  : item.dateSource === 'sprint'
                    ? 'Dates inferred from sprints'
                    : item.dateSource === 'version'
                      ? 'End date inferred from release'
                      : 'Dates set on the work item';
              return (
                <g
                  key={item.key}
                  data-bar-key={item.key}
                  className={`bar ${isEpic ? 'epic' : 'child'} ${item.statusCategory} ${derived ? 'derived' : ''} ${selectedKey === item.key ? 'selected' : ''}`}
                >
                  <title>{`${item.key}: ${item.summary}\n${start} → ${due}\n${sourceNote}`}</title>
                  <rect
                    x={bx}
                    y={by}
                    width={bw}
                    height={BAR_H}
                    rx={4}
                    className="bar-body"
                    onPointerDown={(e) => beginDrag(e, 'move', item)}
                  />
                  {derived && <rect x={bx} y={by} width={bw} height={BAR_H} rx={4} fill="url(#derived)" pointerEvents="none" />}
                  {isEpic && p && p.total > 0 && (
                    <g pointerEvents="none">
                      <rect x={bx + 2} y={by + BAR_H - 5} width={bw - 4} height={3} rx={1.5} className="progress-track" />
                      <rect x={bx + 2} y={by + BAR_H - 5} width={((bw - 4) * p.done) / p.total} height={3} rx={1.5} className="progress-done" />
                      <rect
                        x={bx + 2 + ((bw - 4) * p.done) / p.total}
                        y={by + BAR_H - 5}
                        width={((bw - 4) * p.inProgress) / p.total}
                        height={3}
                        className="progress-doing"
                      />
                    </g>
                  )}
                  <text
                    x={fitsInside ? bx + 8 : bx + bw + 16}
                    y={by + 14 - (isEpic && p?.total ? 1 : 0)}
                    className={`bar-label ${fitsInside ? 'inside' : 'outside'}`}
                    pointerEvents="none"
                  >
                    {label}
                  </text>
                  <rect x={bx - 2} y={by} width={8} height={BAR_H} className="handle" onPointerDown={(e) => beginDrag(e, 'start', item)} />
                  <rect x={bx + bw - 6} y={by} width={8} height={BAR_H} className="handle" onPointerDown={(e) => beginDrag(e, 'end', item)} />
                  <circle cx={bx + bw + 7} cy={by + BAR_H / 2} r={4.5} className="connector" onPointerDown={(e) => beginDrag(e, 'link', item)}>
                    <title>Drag onto another bar to add “blocks” dependency</title>
                  </circle>
                </g>
              );
            })}

            {/* Link drag preview */}
            {drag?.mode === 'link' &&
              (() => {
                const item = byKey.get(drag.key);
                const ri = rowIndex.get(drag.key);
                if (!item?.effectiveEnd || ri === undefined) return null;
                const x1 = x(item.effectiveEnd) + dw + 7;
                const y1 = ri * ROW_H + ROW_H / 2;
                return <line x1={x1} y1={y1} x2={drag.pointer.x} y2={drag.pointer.y} className="link-preview" />;
              })()}

            {/* Date readout while dragging */}
            {drag?.moved &&
              drag.mode !== 'link' &&
              (() => {
                const item = byKey.get(drag.key);
                if (!item) return null;
                const { start, end: due } = preview(item);
                if (!start || !due) return null;
                return (
                  <g className="drag-readout" pointerEvents="none">
                    <rect x={drag.pointer.x + 12} y={drag.pointer.y - 30} width={170} height={22} rx={4} />
                    <text x={drag.pointer.x + 20} y={drag.pointer.y - 15}>{`${start} → ${due}`}</text>
                  </g>
                );
              })()}
          </svg>
        </div>
      </div>
    </div>
  );
}
