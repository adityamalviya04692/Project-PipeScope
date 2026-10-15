import type { Analysis } from './analyze';
import type { RuleId } from './rules';

export interface MetricDelta {
  label: string;
  before: number;
  after: number;
  kind: 'duration' | 'bytes' | 'pct' | 'count' | 'score';
  /** Which direction is an improvement. */
  better: 'lower' | 'higher';
}

export interface TableDelta {
  label: string;
  before: number | null;
  after: number | null;
}

export interface RunComparison {
  metrics: MetricDelta[];
  tables: TableDelta[];
  resolved: { rule: RuleId; title: string }[];
  introduced: { rule: RuleId; title: string }[];
}

export function improved(d: MetricDelta): boolean {
  return d.better === 'lower' ? d.after < d.before : d.after > d.before;
}

export function compareRuns(a: Analysis, b: Analysis): RunComparison {
  const s1 = a.summary;
  const s2 = b.summary;
  const metrics: MetricDelta[] = [
    { label: 'Wall-clock time', before: s1.duration, after: s2.duration, kind: 'duration', better: 'lower' },
    { label: 'Task time', before: s1.taskMs, after: s2.taskMs, kind: 'duration', better: 'lower' },
    { label: 'Health score', before: a.score, after: b.score, kind: 'score', better: 'higher' },
    { label: 'Cluster utilisation', before: s1.utilization, after: s2.utilization, kind: 'pct', better: 'higher' },
    { label: 'Tasks', before: s1.tasks, after: s2.tasks, kind: 'count', better: 'lower' },
    { label: 'Shuffle read + write', before: s1.shuffleRead + s1.shuffleWrite, after: s2.shuffleRead + s2.shuffleWrite, kind: 'bytes', better: 'lower' },
    { label: 'Disk spill', before: s1.diskSpill, after: s2.diskSpill, kind: 'bytes', better: 'lower' },
    { label: 'GC share of task time', before: s1.gcRatio, after: s2.gcRatio, kind: 'pct', better: 'lower' },
    { label: 'Findings', before: a.findings.length, after: b.findings.length, kind: 'count', better: 'lower' },
  ];

  const byLabel = (x: Analysis) => {
    const m = new Map<string, number>();
    for (const q of x.sql) m.set(q.label, (m.get(q.label) ?? 0) + q.duration);
    return m;
  };
  const m1 = byLabel(a);
  const m2 = byLabel(b);
  const labels = [...new Set([...m1.keys(), ...m2.keys()])];
  const tables = labels
    .map((label) => ({ label, before: m1.get(label) ?? null, after: m2.get(label) ?? null }))
    .sort((x, y) => (y.before ?? 0) - (x.before ?? 0));

  const rules = (x: Analysis) => new Map(x.findings.map((f) => [f.rule, f.title]));
  const r1 = rules(a);
  const r2 = rules(b);
  return {
    metrics,
    tables,
    resolved: [...r1].filter(([r]) => !r2.has(r)).map(([rule, title]) => ({ rule, title })),
    introduced: [...r2].filter(([r]) => !r1.has(r)).map(([rule, title]) => ({ rule, title })),
  };
}
