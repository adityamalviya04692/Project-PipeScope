import { useMemo } from 'react';
import { Card, CodeBlock } from '../../components/ui';
import { fmtDuration, fmtPct } from '../../lib/format';
import { colId, displayName, impactOf, layerOf, rootSources, tableReach, traceDownstream, type LineageIndex } from '../../lineage/graph';
import type { LineageColumn } from '../../lineage/types';
import type { TableRun } from '../../pipeline/overlay';
import type { Analysis } from '../../spark/analyze';
import { FindingCard } from '../spark/Overview';
import type { Selection } from './LineageGraph';

function Ref({ table, column, onSelect }: { table: string; column?: string; onSelect: (s: Selection) => void }) {
  return (
    <button className="col-ref" onClick={() => onSelect(column ? { kind: 'column', table, column } : { kind: 'table', table })}>
      {displayName(table)}
      {column ? `.${column}` : ''}
    </button>
  );
}

function Layer({ id, ix }: { id: string; ix: LineageIndex }) {
  const t = ix.tables.get(id);
  const l = t ? layerOf(t) : 'other';
  return <span className={`layer ${l}`}>{l}</span>;
}

function ColumnPanel({ ix, table, column, onSelect }: { ix: LineageIndex; table: string; column: string; onSelect: (s: Selection) => void }) {
  const c = ix.columns.get(colId({ table, column })) as LineageColumn | undefined;
  const impact = useMemo(() => impactOf(ix, { table, column }), [ix, table, column]);
  const roots = useMemo(() => rootSources(ix, { table, column }), [ix, table, column]);
  if (!c) return <Card title="Column not found">{null}</Card>;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <Card
        title={
          <span className="row" style={{ gap: 8 }}>
            <Layer id={table} ix={ix} />
            <span className="mono">
              {displayName(table)}.<b>{column}</b>
            </span>
          </span>
        }
        hint={c.description ?? undefined}
      >
        <div className="row">
          <span className={`xf-pill ${c.transform}`}>{c.transform}</span>
          {c.type && <span className="chip mono">{c.type}</span>}
          {c.tests?.map((t) => (
            <span key={t.unique_id} className="sev good">✓ {t.name}</span>
          ))}
        </div>
        {c.expression && c.transform !== 'source' && (
          <>
            <h4 className="small muted">HOW IT IS COMPUTED</h4>
            <CodeBlock code={c.expression} lang="sql" />
            {c.path.length > 1 && (
              <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {c.path.slice(1).map((p) => (
                  <li key={p} className="mono" style={{ wordBreak: 'break-word' }}>
                    via {p}
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </Card>

      <Card title="Comes from" hint={c.sources.length ? `${c.sources.length} direct source column${c.sources.length > 1 ? 's' : ''}` : 'No upstream columns: this is a source or a constant.'}>
        {c.sources.length > 0 && (
          <ul className="impact-tree">
            {c.sources.map((s) => (
              <li key={colId(s)}>
                <span className="muted">←</span>
                <Ref {...s} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        )}
        {roots.length > 0 && roots.some((r) => r.depth > 1) && (
          <>
            <h4 className="small muted">ORIGINAL SOURCES</h4>
            <ul className="impact-tree">
              {roots.map((r) => (
                <li key={colId(r)}>
                  <Layer id={r.table} ix={ix} />
                  <Ref {...r} onSelect={onSelect} />
                  <span className="muted small">{r.depth} hops</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <Card title="Impact of changing it" hint={impact.columns ? `Affects ${impact.columns} column${impact.columns > 1 ? 's' : ''} in ${impact.tables} table${impact.tables > 1 ? 's' : ''}${impact.reports ? `, including ${impact.reports} report${impact.reports > 1 ? 's' : ''}/view${impact.reports > 1 ? 's' : ''}` : ''}.` : 'Nothing downstream uses its value.'}>
        {impact.byTable.map((g) => (
          <div key={g.table} className="stack" style={{ gap: 4 }}>
            <div className="row">
              <span className={`layer ${g.layer}`}>{g.layer}</span>
              <Ref table={g.table} onSelect={onSelect} />
            </div>
            <ul className="impact-tree" style={{ paddingLeft: 12 }}>
              {g.columns.map((r) => (
                <li key={colId(r)}>
                  <span className="muted">→</span>
                  <Ref {...r} onSelect={onSelect} />
                  {r.transform && <span className={`xf-pill ${r.transform}`}>{r.transform}</span>}
                  <span className="muted small">{r.depth} hop{r.depth > 1 ? 's' : ''}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {impact.indirect.length > 0 && (
          <>
            <h4 className="small muted">ALSO CHANGES WHICH ROWS APPEAR IN</h4>
            <ul className="impact-tree">
              {impact.indirect.map((u) => (
                <li key={`${u.table}:${u.role}`}>
                  <Ref table={u.table} onSelect={onSelect} />
                  <span className="chip">{u.role === 'filter' ? 'WHERE / HAVING' : u.role === 'join' ? 'JOIN key' : 'GROUP BY'}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}

function TablePanel({ ix, table, onSelect, run, analysis }: { ix: LineageIndex; table: string; onSelect: (s: Selection) => void; run?: TableRun; analysis?: Analysis }) {
  const t = ix.tables.get(table);
  const up = useMemo(() => [...tableReach(ix, table, 'up')].sort((a, b) => a[1] - b[1]), [ix, table]);
  const down = useMemo(() => [...tableReach(ix, table, 'down')].sort((a, b) => a[1] - b[1]), [ix, table]);
  if (!t) return null;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <Card
        title={
          <span className="row" style={{ gap: 8 }}>
            <Layer id={table} ix={ix} />
            <span className="mono">{displayName(table)}</span>
          </span>
        }
        hint={t.description ?? `${t.kind}${t.files.length ? ` · ${t.files.join(', ')}` : ''}`}
      >
        <div className="row">
          <span className="chip">{t.kind}</span>
          <span className="chip">{t.columns.length} columns</span>
          {t.dbt?.materialized && <span className="chip">dbt: {t.dbt.materialized}</span>}
          {t.dbt?.tags.map((g) => (
            <span key={g} className="chip">#{g}</span>
          ))}
          {t.tests?.map((x) => (
            <span key={x.unique_id} className="sev good">✓ {x.name}</span>
          ))}
        </div>
      </Card>

      {run && (
        <Card title="Last Spark run" hint={`${fmtDuration(run.durationMs)} wall-clock · ${fmtPct(run.share)} of the whole run · ${run.stages} stages`}>
          {run.findings.length === 0 ? (
            <p className="small" style={{ color: 'var(--good)' }}>✓ No problems found in this build.</p>
          ) : (
            <div className="findings">
              {run.findings.map((f) => (analysis ? <FindingCard key={f.id} f={f} a={analysis} /> : <p key={f.id}>{f.title}</p>))}
            </div>
          )}
        </Card>
      )}

      <Card title="Columns">
        <ul className="impact-tree">
          {t.columns.map((c) => {
            const n = traceDownstream(ix, { table, column: c.name }).length;
            return (
              <li key={c.name}>
                <button className="col-ref" onClick={() => onSelect({ kind: 'column', table, column: c.name })}>{c.name}</button>
                {c.transform !== 'source' && <span className={`xf-pill ${c.transform}`}>{c.transform}</span>}
                {n > 0 && <span className="muted small">feeds {n}</span>}
              </li>
            );
          })}
        </ul>
      </Card>

      <Card title="Dependencies" hint={`${up.length} upstream · ${down.length} downstream (transitive)`}>
        {up.length > 0 && (
          <>
            <h4 className="small muted">UPSTREAM</h4>
            <ul className="impact-tree">
              {up.map(([id, d]) => (
                <li key={id}>
                  <Layer id={id} ix={ix} />
                  <Ref table={id} onSelect={onSelect} />
                  <span className="muted small">{d} hop{d > 1 ? 's' : ''}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {down.length > 0 && (
          <>
            <h4 className="small muted">DOWNSTREAM</h4>
            <ul className="impact-tree">
              {down.map(([id, d]) => (
                <li key={id}>
                  <Layer id={id} ix={ix} />
                  <Ref table={id} onSelect={onSelect} />
                  <span className="muted small">{d} hop{d > 1 ? 's' : ''}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      {t.statements.length > 0 && (
        <Card title="SQL" hint="Normalised by sqlglot.">
          {t.statements.map((s, i) => (
            <CodeBlock key={i} code={s.sql} lang={`${s.kind} · ${s.file}`} />
          ))}
        </Card>
      )}
    </div>
  );
}

function Summary({ ix, onSelect }: { ix: LineageIndex; onSelect: (s: Selection) => void }) {
  const s = ix.result.stats;
  const top = useMemo(
    () =>
      [...ix.columns.keys()]
        .map((id) => {
          const [table, column] = [id.slice(0, id.indexOf('::')), id.slice(id.indexOf('::') + 2)];
          return { table, column, n: traceDownstream(ix, { table, column }).length };
        })
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n)
        .slice(0, 8),
    [ix],
  );
  return (
    <div className="stack" style={{ gap: 12 }}>
      <Card title="Project" hint={`${ix.result.meta.source === 'dbt' ? `dbt project ${ix.result.meta.project ?? ''}` : 'SQL files'} · ${ix.result.dialect} dialect · sqlglot ${ix.result.sqlglot}`}>
        <div className="kpis" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <div className="kpi"><span className="kpi-label">Tables</span><span className="kpi-value">{s.tables}</span><span className="kpi-sub">{s.statements} statements in {s.files} files</span></div>
          <div className="kpi"><span className="kpi-label">Column edges</span><span className="kpi-value">{s.column_edges}</span><span className="kpi-sub">{s.columns} columns traced in {Math.round(s.elapsed_ms)} ms</span></div>
        </div>
        <p className="small muted">Click a column in the graph to trace it end to end, or a table header to see its dependencies.</p>
      </Card>
      <Card title="Highest-impact columns" hint="Columns whose change would ripple furthest downstream.">
        <ul className="impact-tree">
          {top.map((x) => (
            <li key={`${x.table}.${x.column}`}>
              <Ref table={x.table} column={x.column} onSelect={onSelect} />
              <span className="muted small">feeds {x.n} columns</span>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Transform types">
        <div className="row">
          {['direct', 'renamed', 'cast', 'derived', 'aggregate', 'window', 'constant'].map((x) => (
            <span key={x} className={`xf-pill ${x}`}>{x}</span>
          ))}
        </div>
      </Card>
    </div>
  );
}

export default function SidePanel({ ix, selection, onSelect, runs, analysis }: { ix: LineageIndex; selection: Selection; onSelect: (s: Selection) => void; runs?: Map<string, TableRun>; analysis?: Analysis }) {
  return (
    <aside className="side" aria-label="Details">
      {selection.kind === 'column' && <ColumnPanel key={`${selection.table}.${selection.column}`} ix={ix} table={selection.table} column={selection.column} onSelect={onSelect} />}
      {selection.kind === 'table' && <TablePanel key={selection.table} ix={ix} table={selection.table} onSelect={onSelect} run={runs?.get(selection.table)} analysis={analysis} />}
      {selection.kind === 'none' && <Summary ix={ix} onSelect={onSelect} />}
    </aside>
  );
}
