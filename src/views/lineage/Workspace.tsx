import { useState } from 'react';
import SqlEditor from '../../components/SqlEditor';
import { Card } from '../../components/ui';
import { DIALECTS } from '../../lineage/client';
import type { SqlFile } from '../../lineage/types';

export default function Workspace({ files, dialect, busy, onChange, onAnalyze }: { files: SqlFile[]; dialect: string; busy: boolean; onChange: (files: SqlFile[], dialect: string) => void; onAnalyze: () => void }) {
  const [active, setActive] = useState(files[0]?.name ?? '');
  const [version, setVersion] = useState(0);
  const current = files.find((f) => f.name === active) ?? files[0];

  const update = (sql: string) => onChange(files.map((f) => (f.name === current.name ? { ...f, sql } : f)), dialect);
  const add = () => {
    let n = files.length + 1;
    while (files.some((f) => f.name === `new_model_${n}.sql`)) n++;
    const name = `new_model_${n}.sql`;
    onChange([...files, { name, sql: `-- Write a model, then click "Re-analyse"\nCREATE OR REPLACE TABLE gold.new_model_${n} AS\nSELECT\n  order_date,\n  SUM(revenue) AS revenue\nFROM gold.mart_daily_revenue\nGROUP BY order_date;\n` }], dialect);
    setActive(name);
    setVersion((v) => v + 1);
  };
  const remove = (name: string) => {
    const next = files.filter((f) => f.name !== name);
    onChange(next, dialect);
    if (active === name) setActive(next[0]?.name ?? '');
    setVersion((v) => v + 1);
  };

  return (
    <div className="split">
      <Card title={`Files (${files.length})`} actions={<button className="btn ghost small" onClick={add}>+ New</button>}>
        <label className="small muted">
          Dialect{' '}
          <select className="input" value={dialect} onChange={(e) => onChange(files, e.target.value)}>
            {DIALECTS.map((d) => (
              <option key={d.id} value={d.id}>{d.label}</option>
            ))}
          </select>
        </label>
        <div className="files">
          {files.map((f) => (
            <button key={f.name} className={f.name === current?.name ? 'active' : ''} onClick={() => setActive(f.name)}>
              <span>{f.name}</span>
              <span
                className="muted"
                role="button"
                aria-label={`Remove ${f.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  remove(f.name);
                }}
              >
                ×
              </span>
            </button>
          ))}
        </div>
        <button className="btn" onClick={onAnalyze} disabled={busy || files.length === 0}>
          {busy ? 'Analysing…' : 'Re-analyse lineage'}
        </button>
        <p className="small muted">Edit any model, add a new one, or switch dialect, then re-analyse. Everything stays in this tab.</p>
      </Card>
      {current ? (
        <Card title={<span className="mono">{current.name}</span>} hint="Edits are kept until you reload the page.">
          <SqlEditor key={`${current.name}:${version}`} docKey={`${current.name}:${version}:${dialect}`} value={current.sql} onChange={update} dialect={dialect} />
        </Card>
      ) : (
        <Card title="No files">
          <p className="muted">Add a file to start.</p>
        </Card>
      )}
    </div>
  );
}
