import { useMemo, useState } from 'react';
import { BarCell, Card, Kpi, Segmented } from '../../components/ui';
import { fmtDuration, fmtPct } from '../../lib/format';
import { buildIndex, displayName, layerOf } from '../../lineage/graph';
import type { LineageResult } from '../../lineage/types';
import { blockedDownstream, coverage, criticalPath, runsByTable } from '../../pipeline/overlay';
import { runLabel, type Analysis } from '../../spark/analyze';
import LineageGraph, { type Selection } from '../lineage/LineageGraph';
import SidePanel from '../lineage/SidePanel';

export default function PipelineMap({ lineage, runs }: { lineage: LineageResult; runs: Analysis[] }) {
  const [runIdx, setRunIdx] = useState(0);
  const a = runs[Math.min(runIdx, runs.length - 1)];
  const ix = useMemo(() => buildIndex(lineage), [lineage]);
  const tr = useMemo(() => runsByTable(a), [a]);
  const cov = useMemo(() => coverage(ix, tr), [ix, tr]);
  const cp = useMemo(() => criticalPath(ix, tr), [ix, tr]);
  const [selection, setSelection] = useState<Selection>({ kind: 'none' });

  const ranking = useMemo(() => [...tr.values()].filter((r) => ix.tables.has(r.table)).sort((x, y) => y.durationMs - x.durationMs), [tr, ix]);
  const maxMs = ranking[0]?.durationMs ?? 1;
  const criticalTables = ranking.filter((r) => r.severity === 'critical').length;
  const models = cov.matched.length + cov.modelOnly.length;

  return (
    <div className="stack">
      <div className="view-head">
        <div>
          <h2>Pipeline map</h2>
          <p className="meta">Spark runtime from {a.run.fileName} laid over the lineage of {lineage.stats.tables} tables. Click a table to see its build time and findings.</p>
        </div>
        {runs.length > 1 && (
          <Segmented
            label="Run"
            value={String(runIdx)}
            onChange={(v) => {
              setRunIdx(Number(v));
              setSelection({ kind: 'none' });
            }}
            options={runs.map((r, i) => ({ id: String(i), label: `${i === 0 ? 'Before' : 'After'} · ${fmtDuration(r.summary.duration)}` }))}
          />
        )}
      </div>

      <div className="kpis">
        <Kpi label="Models matched" value={`${cov.matched.length} / ${models}`} sub={cov.runOnly.length ? `${cov.runOnly.length} written tables not in the SQL` : 'every built table found in lineage'} tone={cov.matched.length === models ? 'good' : 'warning'} />
        <Kpi label="Run wall-clock" value={fmtDuration(a.summary.duration)} sub={runLabel(a)} />
        <Kpi label="Critical path" value={fmtDuration(cp.totalMs)} sub={`${cp.path.length} dependent builds`} tone={cp.totalMs > a.summary.duration * 0.5 ? 'warning' : ''} />
        <Kpi label="Slowest build" value={ranking[0] ? fmtDuration(ranking[0].durationMs) : '–'} sub={ranking[0] ? displayName(ranking[0].table) : undefined} tone={ranking[0]?.severity === 'critical' ? 'critical' : ''} />
        <Kpi label="Builds with critical findings" value={criticalTables} sub={`of ${ranking.length} tables built`} tone={criticalTables ? 'critical' : 'good'} />
      </div>

      {cp.path.length > 0 && (
        <Card title="Critical path" hint="The slowest chain of builds where each one waits for the previous. Shortening anything on it shortens the whole pipeline; speeding up anything else does not.">
          <div className="row" style={{ gap: 6 }}>
            {cp.path.map((t, i) => {
              const r = tr.get(t)!;
              return (
                <span key={t} className="row" style={{ gap: 6 }}>
                  {i > 0 && <span className="muted">→</span>}
                  <button className="chip" onClick={() => setSelection({ kind: 'table', table: t })} style={r.severity === 'critical' ? { borderColor: 'var(--critical)', color: 'var(--critical)' } : undefined}>
                    <span className={`dot-sev ${r.severity ?? ''}`} />
                    <span className="mono">{displayName(t)}</span>
                    <b>{fmtDuration(r.durationMs)}</b>
                  </button>
                </span>
              );
            })}
          </div>
        </Card>
      )}

      <div className="lineage-layout">
        <LineageGraph ix={ix} selection={selection} onSelect={setSelection} runs={tr} defaultShowColumns={false} height={720} />
        {selection.kind === 'none' ? (
          <aside className="side">
            <Card title="Build time by table" hint="Sorted by wall-clock time. 'Blocks' counts the tables downstream that wait for it.">
              <div className="table-wrap" style={{ maxHeight: 600 }}>
                <table className="dt">
                  <thead>
                    <tr>
                      <th>Table</th>
                      <th className="num">Time</th>
                      <th className="num">Blocks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranking.map((r) => (
                      <tr key={r.table} className="clickable" onClick={() => setSelection({ kind: 'table', table: r.table })} title={`${layerOf(ix.tables.get(r.table)!)} · ${fmtPct(r.share)} of the run`}>
                        <td>
                          <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                            <span className={`dot-sev ${r.severity ?? ''}`} />
                            <span className="mono small">{displayName(r.table)}</span>
                          </span>
                        </td>
                        <td className="num"><BarCell value={r.durationMs} max={maxMs} label={fmtDuration(r.durationMs)} hot={r.severity === 'critical'} /></td>
                        <td className="num">{blockedDownstream(ix, r.table) || '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {cov.runOnly.length > 0 && <p className="small muted">Built by Spark but not in the SQL: {cov.runOnly.map(displayName).join(', ')}</p>}
              {cov.modelOnly.length > 0 && <p className="small muted">In the SQL but not built in this run: {cov.modelOnly.map(displayName).join(', ')}</p>}
            </Card>
          </aside>
        ) : (
          <SidePanel ix={ix} selection={selection} onSelect={setSelection} runs={tr} analysis={a} />
        )}
      </div>
    </div>
  );
}
