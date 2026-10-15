import { useCallback, useMemo, useState } from 'react';
import { Segmented } from '../../components/ui';
import { buildIndex, graphIssues, toMermaid } from '../../lineage/graph';
import type { LineageResult, SqlFile } from '../../lineage/types';
import LineageGraph, { type Selection } from './LineageGraph';
import Problems from './Problems';
import SidePanel from './SidePanel';
import Tables from './Tables';
import Workspace from './Workspace';

type Tab = 'graph' | 'tables' | 'problems' | 'workspace';

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function LineageView({ result, files, dialect, busy, onFilesChange, onAnalyze }: { result: LineageResult; files: SqlFile[]; dialect: string; busy: boolean; onFilesChange: (f: SqlFile[], d: string) => void; onAnalyze: () => void }) {
  const ix = useMemo(() => buildIndex(result), [result]);
  const issues = useMemo(() => graphIssues(ix), [ix]);
  const [tab, setTab] = useState<Tab>('graph');
  const [selection, setSelection] = useState<Selection>({ kind: 'none' });
  const [copied, setCopied] = useState(false);
  const open = useCallback((s: Selection) => {
    setSelection(s);
    setTab('graph');
  }, []);
  const errors = result.problems.filter((p) => p.severity === 'error').length;
  const warnings = result.problems.filter((p) => p.severity === 'warning').length + issues.filter((i) => i.severity === 'warning').length;

  const copyMermaid = async () => {
    try {
      await navigator.clipboard.writeText(toMermaid(result));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      download('lineage.mmd', toMermaid(result), 'text/plain');
    }
  };

  return (
    <div className="stack">
      <div className="view-head">
        <div>
          <h2>Lineage{result.meta.project ? ` · ${result.meta.project}` : ''}</h2>
          <p className="meta">
            {result.stats.tables} tables · {result.stats.columns} columns · {result.stats.column_edges} column edges · {result.dialect} · parsed in {Math.round(result.stats.elapsed_ms)} ms by sqlglot {result.sqlglot}
          </p>
        </div>
        <div className="row">
          <button className="btn ghost small" onClick={copyMermaid}>{copied ? 'Copied Mermaid' : 'Copy as Mermaid'}</button>
          <button className="btn ghost small" onClick={() => download('lineage.json', JSON.stringify(result, null, 2), 'application/json')}>Download JSON</button>
        </div>
      </div>
      <div className="subtabs">
        <Segmented
          label="Lineage sections"
          value={tab}
          onChange={setTab}
          options={[
            { id: 'graph', label: 'Graph' },
            { id: 'tables', label: 'Tables', count: result.tables.length },
            { id: 'problems', label: 'Problems', count: errors + warnings, tone: errors ? 'critical' : '' },
            { id: 'workspace', label: 'SQL workspace' },
          ]}
        />
      </div>
      <div className="view-panel" key={tab}>
        {tab === 'graph' && (
          <div className="lineage-layout">
            <LineageGraph ix={ix} selection={selection} onSelect={setSelection} />
            <SidePanel ix={ix} selection={selection} onSelect={setSelection} />
          </div>
        )}
        {tab === 'tables' && <Tables ix={ix} issues={issues} onOpen={open} />}
        {tab === 'problems' && <Problems ix={ix} issues={issues} onOpen={open} />}
        {tab === 'workspace' && <Workspace files={files} dialect={dialect} busy={busy} onChange={onFilesChange} onAnalyze={onAnalyze} />}
      </div>
    </div>
  );
}
