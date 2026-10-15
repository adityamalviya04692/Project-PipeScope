import { memo, useEffect, useMemo, useState } from 'react';
import { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { layoutDag } from '../../lib/dag';
import { fmtDuration, fmtPct } from '../../lib/format';
import { closure, colId, displayName, layerOf, LAYERS, tableReach, type Layer, type LineageIndex } from '../../lineage/graph';
import type { LineageColumn, LineageTable } from '../../lineage/types';
import type { TableRun } from '../../pipeline/overlay';

export type Selection = { kind: 'none' } | { kind: 'table'; table: string } | { kind: 'column'; table: string; column: string };

const MAX_COLS = 10;
const HEAD_H = 38;
const ROW_H = 24;
const MORE_H = 22;
const RUN_H = 30;

type ColState = 'self' | 'up' | 'down' | 'faded' | '';

interface TableData extends Record<string, unknown> {
  t: LineageTable;
  layer: Layer;
  cols: { c: LineageColumn; state: ColState }[];
  hidden: number;
  selected: boolean;
  dim: boolean;
  run?: TableRun;
  expanded: boolean;
  onTable: (id: string) => void;
  onColumn: (table: string, column: string) => void;
  onToggle: (id: string) => void;
}

const XF_SHORT: Record<string, string> = { direct: '', renamed: 'ren', cast: 'cast', derived: 'fx', aggregate: 'agg', window: 'win', constant: 'const', source: '', unknown: '?' };

const TableNode = memo(function TableNode({ data }: NodeProps<Node<TableData>>) {
  const { t, layer, cols, hidden, run } = data;
  return (
    <div className={`tbl-node${data.selected ? ' selected' : ''}${data.dim ? ' dim' : ''}`}>
      <Handle type="target" position={Position.Left} id="tbl-in" style={{ top: HEAD_H / 2 }} />
      <div className="tbl-head" onClick={() => data.onTable(t.id)} title={`${t.id} · ${t.kind}`}>
        <span className={`layer ${layer}`}>{layer === 'report' ? 'rpt' : layer === 'source' ? 'src' : layer.slice(0, 3)}</span>
        <span className="name">{displayName(t.id)}</span>
        {t.kind === 'view' && <span className="chip">view</span>}
        {t.kind === 'external' && <span className="chip">ext</span>}
      </div>
      {cols.length > 0 && (
        <div className="tbl-cols">
          {cols.map(({ c, state }) => (
            <div
              key={c.name}
              className={`tbl-col ${state}`}
              onClick={(e) => {
                e.stopPropagation();
                data.onColumn(t.id, c.name);
              }}
              title={c.expression ? `${c.name} = ${c.expression}` : c.name}
            >
              <Handle type="target" position={Position.Left} id={`in:${c.name}`} className="col-handle" />
              <span className="cname">{c.name}</span>
              {XF_SHORT[c.transform] && <span className="xf">{XF_SHORT[c.transform]}</span>}
              {c.tests?.length ? <span className="xf" title={c.tests.map((x) => x.name).join(', ')}>✓</span> : null}
              <Handle type="source" position={Position.Right} id={`out:${c.name}`} className="col-handle" />
            </div>
          ))}
        </div>
      )}
      {(hidden > 0 || data.expanded) && (
        <button
          className="tbl-more"
          onClick={(e) => {
            e.stopPropagation();
            data.onToggle(t.id);
          }}
        >
          {data.expanded ? 'Show fewer columns' : `+${hidden} more column${hidden > 1 ? 's' : ''}`}
        </button>
      )}
      {run && (
        <div className={`tbl-run ${run.severity === 'critical' ? 'critical' : run.severity === 'warning' ? 'warning' : 'ok'}`} title={run.findings.map((f) => f.title).join('\n')}>
          <span>⏱ {fmtDuration(run.durationMs)}</span>
          <span>{fmtPct(run.share)} of run{run.findings.length ? ` · ${run.findings.length} finding${run.findings.length > 1 ? 's' : ''}` : ''}</span>
        </div>
      )}
      <Handle type="source" position={Position.Right} id="tbl-out" style={{ top: HEAD_H / 2 }} />
    </div>
  );
});

const nodeTypes = { table: TableNode };

interface Props {
  ix: LineageIndex;
  selection: Selection;
  onSelect: (s: Selection) => void;
  runs?: Map<string, TableRun>;
  defaultShowColumns?: boolean;
  height?: number;
}

function GraphInner({ ix, selection, onSelect, runs, defaultShowColumns = true, height = 680 }: Props) {
  const flow = useReactFlow();
  const [showCols, setShowCols] = useState(defaultShowColumns);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const present = useMemo(() => LAYERS.filter((l) => ix.result.tables.some((t) => layerOf(t) === l)), [ix]);
  const [hiddenLayers, setHiddenLayers] = useState<Set<Layer>>(new Set());
  const [query, setQuery] = useState('');

  // What is highlighted for the current selection.
  const hl = useMemo(() => {
    if (selection.kind === 'column') {
      const self = colId(selection);
      const c = closure(ix, selection);
      const tables = new Set([selection.table, ...[...c.up, ...c.down].map((id) => id.split('::')[0])]);
      return { self, up: c.up, down: c.down, tables };
    }
    if (selection.kind === 'table') {
      const tables = new Set([selection.table, ...tableReach(ix, selection.table, 'up').keys(), ...tableReach(ix, selection.table, 'down').keys()]);
      return { self: '', up: new Set<string>(), down: new Set<string>(), tables };
    }
    return null;
  }, [ix, selection]);

  const visible = useMemo(() => ix.result.tables.filter((t) => !hiddenLayers.has(layerOf(t))), [ix, hiddenLayers]);

  // Columns that drive layout (stable while the selection changes).
  const baseCols = (t: LineageTable) => (!showCols ? [] : expanded.has(t.id) ? t.columns : t.columns.slice(0, MAX_COLS));

  const positions = useMemo(() => {
    const ids = new Set(visible.map((t) => t.id));
    const nodes = visible.map((t) => {
      const shown = baseCols(t).length;
      const hidden = showCols && !expanded.has(t.id) && t.columns.length > MAX_COLS;
      return { id: t.id, width: 250, height: HEAD_H + shown * ROW_H + (hidden || expanded.has(t.id) ? MORE_H : 0) + (runs?.has(t.id) ? RUN_H : 0) };
    });
    const edges = ix.result.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    return layoutDag(nodes, edges, { rankdir: 'LR', nodesep: showCols ? 36 : 22, ranksep: 110 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, showCols, expanded, runs, ix]);

  const nodes: Node<TableData>[] = useMemo(
    () =>
      visible.map((t) => {
        const base = baseCols(t);
        const extra = hl && hl.tables.has(t.id) ? t.columns.filter((c) => !base.includes(c) && [hl.self, ...hl.up, ...hl.down].includes(colId({ table: t.id, column: c.name }))) : [];
        const cols = [...base, ...extra].map((c) => {
          const id = colId({ table: t.id, column: c.name });
          const state: ColState = !hl || selection.kind !== 'column' ? '' : id === hl.self ? 'self' : hl.up.has(id) ? 'up' : hl.down.has(id) ? 'down' : 'faded';
          return { c, state };
        });
        const hiddenCount = showCols && !expanded.has(t.id) ? Math.max(0, t.columns.length - MAX_COLS) : 0;
        return {
          id: t.id,
          type: 'table',
          position: positions.get(t.id) ?? { x: 0, y: 0 },
          // Known size up front, so the minimap can draw nodes before React Flow measures them.
          initialWidth: 250,
          initialHeight: HEAD_H + cols.length * ROW_H + (hiddenCount || expanded.has(t.id) ? MORE_H : 0) + (runs?.has(t.id) ? RUN_H : 0),
          data: {
            t,
            layer: layerOf(t),
            cols,
            hidden: hiddenCount,
            selected: selection.kind !== 'none' && selection.table === t.id,
            dim: !!hl && !hl.tables.has(t.id),
            run: runs?.get(t.id),
            expanded: expanded.has(t.id),
            onTable: (id: string) => onSelect({ kind: 'table', table: id }),
            onColumn: (table: string, column: string) => onSelect({ kind: 'column', table, column }),
            onToggle: (id: string) => setExpanded((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id]))),
          },
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, positions, hl, selection, showCols, expanded, runs, onSelect],
  );

  const edges: Edge[] = useMemo(() => {
    const ids = new Set(visible.map((t) => t.id));
    const css = getComputedStyle(document.documentElement);
    const upColor = css.getPropertyValue('--c2').trim();
    const downColor = css.getPropertyValue('--c3').trim();
    const muted = css.getPropertyValue('--text-muted').trim();
    const accent = css.getPropertyValue('--accent').trim();
    if (selection.kind === 'column' && hl) {
      const inClosure = new Set([hl.self, ...hl.up, ...hl.down]);
      const out: Edge[] = [];
      for (const id of inClosure) {
        const [table, column] = [id.slice(0, id.indexOf('::')), id.slice(id.indexOf('::') + 2)];
        if (!ids.has(table)) continue;
        for (const s of ix.up.get(id) ?? []) {
          const sid = colId(s);
          if (!inClosure.has(sid) || !ids.has(s.table)) continue;
          const color = hl.down.has(id) ? downColor : upColor;
          out.push({ id: `${sid}->${id}`, source: s.table, target: table, sourceHandle: `out:${s.column}`, targetHandle: `in:${column}`, animated: true, style: { stroke: color, strokeWidth: 2 }, markerEnd: { type: MarkerType.ArrowClosed, color } });
        }
      }
      return out;
    }
    return ix.result.edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => {
        const on = !hl || (hl.tables.has(e.source) && hl.tables.has(e.target));
        return { id: `${e.source}->${e.target}`, source: e.source, target: e.target, sourceHandle: 'tbl-out', targetHandle: 'tbl-in', style: { stroke: on && hl ? accent : muted, strokeWidth: on && hl ? 2 : 1.2, opacity: on ? 0.9 : 0.15 }, markerEnd: { type: MarkerType.ArrowClosed, color: on && hl ? accent : muted } };
      });
  }, [ix, selection, hl, visible]);

  useEffect(() => {
    const id = requestAnimationFrame(() => flow.fitView({ padding: 0.08, duration: 300 }));
    return () => cancelAnimationFrame(id);
  }, [flow, visible, showCols]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const out: Selection[] = [];
    for (const t of ix.result.tables) {
      if (t.id.includes(q)) out.push({ kind: 'table', table: t.id });
      for (const c of t.columns) if (`${t.id}.${c.name}`.includes(q) || c.name.includes(q)) out.push({ kind: 'column', table: t.id, column: c.name });
    }
    return out.slice(0, 8);
  }, [ix, query]);

  const pick = (s: Selection) => {
    onSelect(s);
    setQuery('');
    if (s.kind !== 'none') {
      if (hiddenLayers.has(layerOf(ix.tables.get(s.table)!))) setHiddenLayers(new Set());
      setTimeout(() => flow.fitView({ nodes: [{ id: s.table }], padding: 1.2, duration: 400, maxZoom: 1.1 }), 60);
    }
  };

  return (
    <div className="graph" style={{ height }}>
      <div className="graph-toolbar">
        <div style={{ position: 'relative' }}>
          <input className="input" type="search" placeholder="Find a table or column…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && matches[0] && pick(matches[0])} aria-label="Find a table or column" style={{ width: 240 }} />
          {matches.length > 0 && (
            <div className="card" style={{ position: 'absolute', top: 38, left: 0, width: 320, padding: 6, gap: 2, zIndex: 10 }}>
              {matches.map((m) => (
                <button key={m.kind === 'column' ? `${m.table}.${m.column}` : m.kind === 'table' ? m.table : ''} className="list-item" style={{ padding: '6px 8px' }} onClick={() => pick(m)}>
                  <span className="mono small">{m.kind === 'column' ? `${displayName(m.table)}.${m.column}` : m.kind === 'table' ? displayName(m.table) : ''}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="segmented" role="group" aria-label="Layers">
          {present.map((l) => (
            <button key={l} className={hiddenLayers.has(l) ? '' : 'active'} onClick={() => setHiddenLayers((s) => (s.has(l) ? new Set([...s].filter((x) => x !== l)) : new Set([...s, l])))} aria-pressed={!hiddenLayers.has(l)}>
              <span className={`layer ${l}`} style={{ fontSize: 9 }}>{l === 'report' ? 'rpt' : l === 'source' ? 'src' : l.slice(0, 3)}</span>
            </button>
          ))}
        </div>
        <button className="btn ghost small" style={{ background: 'var(--surface)' }} onClick={() => setShowCols((v) => !v)}>
          {showCols ? 'Hide columns' : 'Show columns'}
        </button>
        {selection.kind !== 'none' && (
          <button className="btn ghost small" style={{ background: 'var(--surface)' }} onClick={() => onSelect({ kind: 'none' })}>
            Clear selection
          </button>
        )}
        <span className="spacer" style={{ flex: 1 }} />
        {selection.kind === 'column' && (
          <div className="legend card" style={{ padding: '6px 10px', flexDirection: 'row', gap: 10 }}>
            <span><i style={{ background: 'var(--c2)' }} />upstream</span>
            <span><i style={{ background: 'var(--c3)' }} />downstream</span>
          </div>
        )}
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onPaneClick={() => onSelect({ kind: 'none' })}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        minZoom={0.1}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={22} size={1} />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          style={{ width: 170, height: 110 }}
          nodeBorderRadius={6}
          nodeColor={(n) => {
            const l = (n.data as TableData).layer;
            return getComputedStyle(document.documentElement).getPropertyValue(`--layer-${l === 'report' || l === 'other' ? 'source' : l}`).trim() || '#999';
          }}
        />
      </ReactFlow>
    </div>
  );
}

export default function LineageGraph(props: Props) {
  return (
    <ReactFlowProvider>
      <GraphInner {...props} />
    </ReactFlowProvider>
  );
}
