import { useState } from 'react';
import { Card } from '../../components/ui';
import type { Analysis } from '../../spark/analyze';

type Verdict = 'good' | 'warning' | 'info' | 'neutral';

interface Check {
  key: string;
  default: string;
  why: string;
  judge: (v: string | undefined, a: Analysis) => { verdict: Verdict; note: string };
}

const on = (v?: string) => (v ?? '').toLowerCase() === 'true';

const CHECKS: Check[] = [
  {
    key: 'spark.sql.adaptive.enabled',
    default: 'true (Spark 3.2+)',
    why: 'Re-plans at runtime: coalesces partitions, splits skew, picks broadcast joins.',
    judge: (v) => (v == null || on(v) ? { verdict: 'good', note: 'enabled' } : { verdict: 'warning', note: 'Turn on: most tuning below depends on it.' }),
  },
  {
    key: 'spark.sql.adaptive.skewJoin.enabled',
    default: 'true',
    why: 'Splits oversized shuffle partitions in sort-merge joins.',
    judge: (v, a) => (v == null || on(v) ? { verdict: on(a.run.properties['spark.sql.adaptive.enabled'] ?? 'true') ? 'good' : 'info', note: 'only applies when AQE is on' } : { verdict: 'warning', note: 'Enable to handle hot keys automatically.' }),
  },
  {
    key: 'spark.sql.adaptive.coalescePartitions.enabled',
    default: 'true',
    why: 'Merges tiny shuffle partitions after each stage.',
    judge: (v) => (v == null || on(v) ? { verdict: 'good', note: 'enabled' } : { verdict: 'warning', note: 'Enable to avoid thousands of tiny tasks.' }),
  },
  {
    key: 'spark.sql.shuffle.partitions',
    default: '200',
    why: 'Partitions per shuffle. With AQE this is an upper bound; without it, one size for every query.',
    judge: (_v, a) => {
      const aqe = on(a.run.properties['spark.sql.adaptive.enabled'] ?? 'true');
      return aqe ? { verdict: 'good', note: 'AQE right-sizes it per shuffle' } : { verdict: 'info', note: 'Fixed for every shuffle. Tune per job or enable AQE.' };
    },
  },
  {
    key: 'spark.sql.autoBroadcastJoinThreshold',
    default: '10485760 (10 MB)',
    why: 'Tables smaller than this are broadcast instead of shuffled.',
    judge: (v) => (v === '-1' ? { verdict: 'warning', note: 'Disabled: every join shuffles both sides.' } : { verdict: 'good', note: v ? `${Math.round(Number(v) / 1024 ** 2)} MB` : 'default' }),
  },
  {
    key: 'spark.dynamicAllocation.enabled',
    default: 'false',
    why: 'Releases idle executors and requests more when work queues up.',
    judge: (v, a) => (on(v) ? { verdict: 'good', note: 'enabled' } : a.summary.utilization < 0.4 ? { verdict: 'warning', note: `Utilisation was ${Math.round(a.summary.utilization * 100)}%: idle executors cost money.` } : { verdict: 'neutral', note: 'off; fine for steady workloads' }),
  },
  {
    key: 'spark.executor.memory',
    default: '1g',
    why: 'Heap per executor. Too small per core leads to spill and GC.',
    judge: (v, a) => (a.summary.diskSpill > 1024 ** 3 || a.summary.gcRatio > 0.1 ? { verdict: 'warning', note: 'Spill or GC pressure seen: consider more memory per core.' } : { verdict: 'neutral', note: v ?? 'default' }),
  },
  {
    key: 'spark.executor.memoryOverhead',
    default: 'max(384 MB, 10% of executor memory)',
    why: 'Off-heap room for Python workers, netty buffers and native libraries.',
    judge: (v, a) => (a.run.stages.some((s) => s.tasks.some((t) => t.failReason?.startsWith('ExecutorLostFailure'))) && !v ? { verdict: 'warning', note: 'Executors were killed for memory: raise this.' } : { verdict: 'neutral', note: v ?? 'default' }),
  },
  {
    key: 'spark.serializer',
    default: 'JavaSerializer',
    why: 'Kryo is faster and smaller for RDD and cached data.',
    judge: (v) => (v && /Kryo/i.test(v) ? { verdict: 'good', note: 'Kryo' } : { verdict: 'info', note: 'Consider Kryo.' }),
  },
];

export default function Config({ a }: { a: Analysis }) {
  const [q, setQ] = useState('');
  const props = Object.entries(a.run.properties).sort(([x], [y]) => x.localeCompare(y));
  const shown = props.filter(([k, v]) => `${k} ${v}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="stack">
      <Card title="Configuration audit" hint="Settings that most affect performance, judged against what actually happened in this run.">
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th>Setting</th>
                <th>Value</th>
                <th>Verdict</th>
                <th>Why it matters</th>
              </tr>
            </thead>
            <tbody>
              {CHECKS.map((c) => {
                const v = a.run.properties[c.key];
                const r = c.judge(v, a);
                return (
                  <tr key={c.key}>
                    <td className="mono small">{c.key}</td>
                    <td className="mono small">{v ?? <span className="muted">default: {c.default}</span>}</td>
                    <td className="wrap">{r.verdict === 'neutral' ? <span className="muted small">{r.note}</span> : <><span className={`sev ${r.verdict}`}>{r.verdict === 'good' ? 'ok' : r.verdict}</span> <span className="small">{r.note}</span></>}</td>
                    <td className="wrap small muted">{c.why}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title={`All Spark properties (${props.length})`} actions={<input className="input" type="search" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter properties" />}>
        <div className="table-wrap">
          <table className="dt">
            <tbody>
              {shown.map(([k, v]) => (
                <tr key={k}>
                  <td className="mono small">{k}</td>
                  <td className="mono small wrap">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
