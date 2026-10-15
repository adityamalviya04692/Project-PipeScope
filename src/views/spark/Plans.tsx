import { useMemo, type ReactNode } from 'react';
import { Card } from '../../components/ui';
import { fmtDuration } from '../../lib/format';
import type { Analysis } from '../../spark/analyze';
import { displayTable, planTree } from '../../spark/plan';
import { severityIndex } from '../../spark/rules';
import { FindingCard } from './Overview';

// Order matters: "Exchange SinglePartition" must match the "bad" group before the generic exchange one.
const TOKEN = /(Exchange SinglePartition|BatchEvalPython|ArrowEvalPython|CartesianProduct|BroadcastNestedLoopJoin)|(Execute \w+|AtomicReplaceTableAsSelect|InsertIntoHadoopFsRelationCommand)|(Exchange (?:hashpartitioning|rangepartitioning|RoundRobinPartitioning)|BroadcastExchange|AQEShuffleRead \w+)|(SortMergeJoin(?:\(skew=true\))?|BroadcastHashJoin|ShuffledHashJoin)|(FileScan \w+|BatchScan)|(HashAggregate|ObjectHashAggregate|SortAggregate|Window)/g;
const CLASSES = ['op-bad', 'op-write', 'op-exchange', 'op-join', 'op-scan', 'op-agg'];

function highlight(line: string, key: number): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    const group = m.slice(1).findIndex(Boolean);
    if (m.index! > last) out.push(line.slice(last, m.index));
    out.push(
      <span key={m.index} className={CLASSES[group]}>
        {m[0]}
      </span>,
    );
    last = m.index! + m[0].length;
  }
  out.push(line.slice(last));
  return <div key={key}>{out}</div>;
}

const OP_SHORT: Record<string, string> = {
  SortMergeJoin: 'SMJ',
  BroadcastHashJoin: 'Broadcast join',
  ShuffledHashJoin: 'Shuffled hash join',
  'Exchange hashpartitioning': 'Shuffle',
  'Exchange SinglePartition': 'Single partition',
  BatchEvalPython: 'Python UDF',
  ArrowEvalPython: 'Pandas UDF',
  Window: 'Window',
  CartesianProduct: 'Cartesian',
  BroadcastNestedLoopJoin: 'Nested loop',
};

export default function Plans({ a, sqlId, onSelect, onOpenStage }: { a: Analysis; sqlId: number | null; onSelect: (id: number) => void; onOpenStage: (k: string) => void }) {
  const sev = useMemo(() => severityIndex(a.findings).sql, [a]);
  const current = a.sql.find((x) => x.id === sqlId) ?? a.sql[0];
  if (!current) return <Card title="SQL & plans"><p className="muted">This log has no Spark SQL executions (RDD-only jobs).</p></Card>;
  const findings = a.findings.filter((f) => f.sqlIds.includes(current.id) || f.stageKeys.some((k) => current.stageKeys.includes(k)));
  return (
    <div className="split">
      <div className="list" role="listbox" aria-label="SQL statements">
        {a.sql.map((x) => (
          <button key={x.id} className={`list-item${x.id === current.id ? ' active' : ''}`} onClick={() => onSelect(x.id)} role="option" aria-selected={x.id === current.id}>
            <span className="title">
              <span className={`dot-sev ${sev.get(x.id) ?? ''}`} />
              <span className="mono">{x.label}</span>
            </span>
            <span className="muted small">
              SQL {x.id} · {fmtDuration(x.duration)} · {x.stageKeys.length} stages
            </span>
            <span className="row" style={{ gap: 4 }}>
              {Object.entries(x.operators)
                .filter(([op]) => OP_SHORT[op])
                .map(([op, n]) => (
                  <span key={op} className="chip" style={/Single|UDF|Cartesian|Nested/.test(OP_SHORT[op]) ? { color: 'var(--critical)' } : undefined}>
                    {OP_SHORT[op]}
                    {n! > 1 ? ` ×${n}` : ''}
                  </span>
                ))}
            </span>
          </button>
        ))}
      </div>
      <div className="stack">
        <Card title={<span className="mono">{current.label}</span>} hint={current.description}>
          <p className="small">
            {current.reads.length ? (
              <>
                Reads <span className="mono">{current.reads.map(displayTable).join(', ')}</span>
              </>
            ) : (
              'No table reads detected'
            )}
            {current.target && (
              <>
                {' '}→ writes <span className="mono">{displayTable(current.target)}</span>
              </>
            )}
            {' · '}
            {fmtDuration(current.duration)} wall, {fmtDuration(current.taskTime)} of task time
          </p>
          <div className="legend">
            <span><i style={{ background: 'var(--critical)' }} />bottleneck operator</span>
            <span><i style={{ background: 'var(--warning)' }} />shuffle</span>
            <span><i style={{ background: 'var(--accent)' }} />join</span>
            <span><i style={{ background: 'var(--good)' }} />scan</span>
            <span><i style={{ background: 'var(--info)' }} />aggregate / window</span>
          </div>
          <div className="code plan">
            <pre>{planTree(current.plan).split('\n').map(highlight)}</pre>
          </div>
        </Card>
        {findings.length > 0 && (
          <Card title={`Findings for this statement (${findings.length})`}>
            <div className="findings">
              {findings.map((f) => (
                <FindingCard key={f.id} f={f} a={a} onOpenStage={onOpenStage} />
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
