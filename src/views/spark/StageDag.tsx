import { useMemo } from 'react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { Card } from '../../components/ui';
import { layoutDag } from '../../lib/dag';
import { fmtBytes, fmtDuration, fmtNum, fmtRatio } from '../../lib/format';
import type { Analysis, StageStats } from '../../spark/analyze';
import { displayTable } from '../../spark/plan';
import { severityIndex, type Severity } from '../../spark/rules';

type StageData = { s: StageStats; sev?: Severity; onOpen: (k: string) => void };
type TargetData = { label: string };

function StageNode({ data }: NodeProps<Node<StageData>>) {
  const { s, sev } = data;
  return (
    <div className={`stage-node ${sev ?? ''}`} onClick={() => data.onOpen(s.key)} title="Open stage details">
      <Handle type="target" position={Position.Left} />
      <div className="t">
        <span>Stage {s.id}{s.attempt ? `.${s.attempt}` : ''}</span>
        <span className="chip">{s.kind}</span>
      </div>
      <div className="m"><span>time</span><b>{fmtDuration(s.duration)}</b></div>
      <div className="m"><span>tasks</span><b>{fmtNum(s.tasks)}</b></div>
      <div className="m"><span>{s.inputBytes ? 'input' : 'shuffle in'}</span><b>{fmtBytes(s.inputBytes || s.shuffleRead)}</b></div>
      {s.tasks > 1 && <div className="m"><span>max/median</span><b style={{ color: s.skewRatio >= 5 ? 'var(--critical)' : undefined }}>{fmtRatio(s.skewRatio)}</b></div>}
      {s.diskSpill > 0 && <div className="m"><span>spill</span><b style={{ color: 'var(--warning)' }}>{fmtBytes(s.diskSpill)}</b></div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function TargetNode({ data }: NodeProps<Node<TargetData>>) {
  return (
    <div className="table-target">
      <Handle type="target" position={Position.Left} />
      <div className="muted small">writes</div>
      <div className="mono">{data.label}</div>
    </div>
  );
}

const nodeTypes = { stage: StageNode, target: TargetNode };

export default function StageDag({ a, sqlId, onSelectSql, onOpenStage }: { a: Analysis; sqlId: number | null; onSelectSql: (id: number) => void; onOpenStage: (k: string) => void }) {
  const sev = useMemo(() => severityIndex(a.findings), [a]);
  const current = a.sql.find((x) => x.id === sqlId) ?? [...a.sql].sort((x, y) => y.duration - x.duration)[0];

  const { nodes, edges } = useMemo(() => {
    if (!current) return { nodes: [], edges: [] };
    const stages = a.stages.filter((s) => s.sqlId === current.id && s.status !== 'skipped');
    const latest = new Map<number, StageStats>();
    for (const s of stages) if (!latest.has(s.id) || latest.get(s.id)!.attempt < s.attempt) latest.set(s.id, s);
    const list = [...latest.values()];
    const ids = new Set(list.map((s) => s.id));
    const parentOf = new Set(list.flatMap((s) => s.parentIds));
    const e: Edge[] = [];
    for (const s of list) {
      for (const p of s.parentIds) {
        if (!ids.has(p)) continue;
        const src = latest.get(p)!;
        e.push({
          id: `${p}->${s.id}`,
          source: `s${p}`,
          target: `s${s.id}`,
          label: src.shuffleWrite ? fmtBytes(src.shuffleWrite) : undefined,
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { strokeWidth: Math.min(6, 1 + Math.log10(1 + src.shuffleWrite / 1024 ** 2)) },
          labelStyle: { fontSize: 11 },
        });
      }
    }
    const sinks = list.filter((s) => !parentOf.has(s.id));
    const target = current.target ? displayTable(current.target) : null;
    if (target) for (const s of sinks) e.push({ id: `${s.id}->t`, source: `s${s.id}`, target: 'target', markerEnd: { type: MarkerType.ArrowClosed } });
    const layoutNodes = [...list.map((s) => ({ id: `s${s.id}`, width: 220, height: s.diskSpill > 0 ? 128 : 110 })), ...(target ? [{ id: 'target', width: 220, height: 60 }] : [])];
    const pos = layoutDag(layoutNodes, e);
    const n: Node[] = list.map((s) => ({ id: `s${s.id}`, type: 'stage', position: pos.get(`s${s.id}`)!, data: { s, sev: sev.stage.get(s.key), onOpen: onOpenStage } }));
    if (target) n.push({ id: 'target', type: 'target', position: pos.get('target')!, data: { label: target } });
    return { nodes: n, edges: e };
  }, [a, current, sev, onOpenStage]);

  if (!current) return <Card title="Stage DAG"><p className="muted">No SQL executions in this log.</p></Card>;

  return (
    <Card
      title="Stage DAG"
      hint="How each statement's stages depend on each other. Edge thickness and labels show shuffle data passed between stages; click a stage to open it."
      actions={
        <select className="input" value={current.id} onChange={(e) => onSelectSql(Number(e.target.value))} aria-label="SQL statement">
          {a.sql.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label} · {fmtDuration(x.duration)}
              {sev.sql.get(x.id) ? ` · ${sev.sql.get(x.id)}` : ''}
            </option>
          ))}
        </select>
      }
    >
      {current.reads.length > 0 && (
        <p className="small muted">
          Reads <span className="mono">{current.reads.map(displayTable).join(', ')}</span>
          {current.target && (
            <>
              {' '}→ writes <span className="mono">{displayTable(current.target)}</span>
            </>
          )}
        </p>
      )}
      <div className="graph" style={{ height: 520 }}>
        <ReactFlow key={current.id} nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.15 }} nodesDraggable={false} nodesConnectable={false} proOptions={{ hideAttribution: true }} minZoom={0.2}>
          <Background gap={20} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </Card>
  );
}
