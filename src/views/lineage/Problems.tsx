import { useState } from 'react';
import { Card, Segmented } from '../../components/ui';
import { displayName, type GraphIssue, type LineageIndex } from '../../lineage/graph';
import type { Selection } from './LineageGraph';

const TITLES: Record<string, string> = {
  parse_error: 'Could not parse',
  qualify_failed: 'Unresolved column references',
  unresolved_star: 'SELECT * on an unknown table',
  lineage_failed: 'Column could not be traced',
  cycle: 'Circular dependency',
  merge_subquery: 'MERGE from a subquery',
  select_star: 'SELECT * used',
  jinja: 'dbt Jinja in plain SQL',
};

type Sev = 'all' | 'error' | 'warning' | 'info';

export default function Problems({ ix, issues, onOpen }: { ix: LineageIndex; issues: GraphIssue[]; onOpen: (s: Selection) => void }) {
  const all: GraphIssue[] = [
    ...ix.result.problems.map((p) => ({
      severity: p.severity,
      code: p.code,
      title: `${TITLES[p.code] ?? p.code}${p.table ? `: ${displayName(p.table)}${p.column ? `.${p.column}` : ''}` : ''}`,
      detail: `${p.message}${p.file ? ` (${p.file})` : ''}`,
      table: p.table,
      column: p.column,
    })),
    ...issues,
  ];
  const order = { error: 0, warning: 1, info: 2 };
  all.sort((a, b) => order[a.severity] - order[b.severity]);
  const [sev, setSev] = useState<Sev>('all');
  const count = (s: Sev) => all.filter((x) => s === 'all' || x.severity === s).length;
  const shown = all.filter((x) => sev === 'all' || x.severity === sev);
  return (
    <Card
      title={`Problems and insights (${all.length})`}
      hint="Parser problems from sqlglot, plus graph checks: unused models and columns, PII reaching reports, high-impact columns."
      actions={<Segmented label="Severity" value={sev} onChange={setSev} options={(['all', 'error', 'warning', 'info'] as Sev[]).map((s) => ({ id: s, label: s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1), count: count(s), tone: s === 'error' ? 'critical' : '' }))} />}
    >
      {shown.length === 0 ? (
        <p className="muted">Nothing to report.</p>
      ) : (
        <div className="findings">
          {shown.map((x, i) => (
            <article key={i} className={`finding ${x.severity === 'error' ? 'critical' : x.severity}`}>
              <button onClick={() => x.table && onOpen(x.column ? { kind: 'column', table: x.table, column: x.column } : { kind: 'table', table: x.table })} disabled={!x.table}>
                <span className={`sev ${x.severity === 'error' ? 'critical' : x.severity}`}>{x.severity}</span>
                <span className="finding-title">{x.title}</span>
                {x.table && <span className="chip">open →</span>}
              </button>
              <div className="finding-body">
                <p className="small">{x.detail}</p>
              </div>
            </article>
          ))}
        </div>
      )}
    </Card>
  );
}
