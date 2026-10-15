import { useMemo, useState } from 'react';
import { Card } from '../../components/ui';
import { displayName, layerOf, LAYERS, tableReach, type GraphIssue, type LineageIndex } from '../../lineage/graph';
import type { Selection } from './LineageGraph';

export default function Tables({ ix, issues, onOpen }: { ix: LineageIndex; issues: GraphIssue[]; onOpen: (s: Selection) => void }) {
  const [q, setQ] = useState('');
  const rows = useMemo(
    () =>
      ix.result.tables
        .map((t) => ({
          t,
          layer: layerOf(t),
          up: t.upstream.length,
          down: tableReach(ix, t.id, 'down').size,
          derived: t.columns.filter((c) => !['direct', 'source'].includes(c.transform)).length,
          issues: issues.filter((i) => i.table === t.id).length + ix.result.problems.filter((p) => p.table === t.id && p.severity !== 'info').length,
        }))
        .sort((a, b) => LAYERS.indexOf(a.layer) - LAYERS.indexOf(b.layer) || a.t.id.localeCompare(b.t.id)),
    [ix, issues],
  );
  const shown = rows.filter((r) => r.t.id.includes(q.trim().toLowerCase()) || r.t.columns.some((c) => c.name.includes(q.trim().toLowerCase())));
  return (
    <Card title={`Tables (${rows.length})`} hint="Click a row to open it in the graph." actions={<input className="input" type="search" placeholder="Filter tables or columns…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter tables" />}>
      <div className="table-wrap" style={{ maxHeight: 640 }}>
        <table className="dt">
          <thead>
            <tr>
              <th>Table</th>
              <th>Kind</th>
              <th className="num">Columns</th>
              <th className="num">Computed</th>
              <th className="num">Reads from</th>
              <th className="num">Feeds (transitive)</th>
              <th>Defined in</th>
              <th className="num">Issues</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.t.id} className="clickable" onClick={() => onOpen({ kind: 'table', table: r.t.id })} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen({ kind: 'table', table: r.t.id })}>
                <td>
                  <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                    <span className={`layer ${r.layer}`}>{r.layer}</span>
                    <span className="mono">{displayName(r.t.id)}</span>
                  </span>
                </td>
                <td>{r.t.kind}</td>
                <td className="num">{r.t.columns.length}</td>
                <td className="num">{r.derived || '–'}</td>
                <td className="num">{r.up || '–'}</td>
                <td className="num">{r.down || '–'}</td>
                <td className="mono small">{r.t.files.join(', ') || '–'}</td>
                <td className="num">{r.issues ? <span className="count critical">{r.issues}</span> : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
