import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import Landing from './components/Landing';
import { Empty, Progress } from './components/ui';
import { analyzeLineage, loadSampleSql } from './lineage/client';
import type { LineageResult, SqlFile } from './lineage/types';
import { analyzeRun, type Analysis } from './spark/analyze';
import { fetchSample, parseInWorker, SAMPLE_RUNS } from './spark/client';

// Views (and their chart, graph and editor libraries) load on first use, so the landing page stays light.
const SparkView = lazy(() => import('./views/spark/SparkView'));
const LineageView = lazy(() => import('./views/lineage/LineageView'));
const PipelineMap = lazy(() => import('./views/map/PipelineMap'));

type Mode = 'home' | 'spark' | 'lineage' | 'map';

function ModeIcon({ mode }: { mode: Mode }) {
  if (mode === 'home') return <path d="M4 13h6V4H4v9Zm0 7h6v-4H4v4Zm10 0h6v-9h-6v9Zm0-16v4h6V4h-6Z" />;
  if (mode === 'spark') return <path d="m13 2-9 12h7l-1 8 9-12h-7l1-8Z" />;
  if (mode === 'lineage') return <><circle cx="5" cy="12" r="2" /><circle cx="19" cy="5" r="2" /><circle cx="19" cy="19" r="2" /><path d="m7 11 10-5M7 13l10 5" /></>;
  return <><circle cx="5" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="12" r="2" /><path d="M7 5h4a3 3 0 0 1 3 3v1a3 3 0 0 0 3 3M7 19h4a3 3 0 0 0 3-3v-1" /></>;
}

interface Busy {
  label: string;
  progress: number;
}

const isSql = (f: File) => /\.sql$/i.test(f.name);
const isManifest = (f: File) => /manifest\.json$/i.test(f.name);

export default function App() {
  const [mode, setMode] = useState<Mode>('home');
  const [runs, setRuns] = useState<Analysis[]>([]);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [lineage, setLineage] = useState<LineageResult | null>(null);
  const [files, setFiles] = useState<SqlFile[]>([]);
  const [dialect, setDialect] = useState('databricks');
  const [lineageStatus, setLineageStatus] = useState<string | null>(null);

  // ------------------------------------------------------------ Spark
  const ingestSpark = useCallback(async (items: { blob: Blob; name: string }[], replace = false) => {
    const out: Analysis[] = [];
    for (const [i, it] of items.entries()) {
      const label = `Reading ${it.name}${items.length > 1 ? ` (${i + 1}/${items.length})` : ''}`;
      setBusy({ label, progress: 0 });
      const run = await parseInWorker(it.blob, it.name, (p) => setBusy({ label, progress: p }));
      setBusy({ label: `Analysing ${it.name}…`, progress: 1 });
      out.push(analyzeRun(run));
    }
    // Keep at most two runs (for before/after), oldest first.
    setRuns((prev) => [...(replace ? [] : prev), ...out].sort((a, b) => a.summary.start - b.summary.start).slice(-2));
    setBusy(null);
  }, []);

  // ---------------------------------------------------------- Lineage
  const runLineage = useCallback(async (input: { files?: SqlFile[]; manifest?: string; dialect?: string }) => {
    setLineageStatus('Starting the lineage engine…');
    try {
      const res = await analyzeLineage(input, setLineageStatus);
      setLineage(res);
      if (res.dialect) setDialect(res.dialect);
      return res;
    } finally {
      setLineageStatus(null);
    }
  }, []);

  const onFiles = useCallback(
    async (dropped: File[]) => {
      if (dropped.length === 0) return;
      setError(null);
      const sql = dropped.filter(isSql);
      const manifest = dropped.find(isManifest);
      const spark = dropped.filter((f) => !isSql(f) && !isManifest(f));
      const jobs: Promise<unknown>[] = [];
      if (sql.length || manifest) {
        jobs.push(
          (async () => {
            if (manifest) {
              await runLineage({ manifest: await manifest.text() });
              setFiles([]);
            } else {
              const loaded = await Promise.all(sql.map(async (f) => ({ name: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, sql: await f.text() })));
              loaded.sort((a, b) => a.name.localeCompare(b.name));
              setFiles(loaded);
              await runLineage({ files: loaded, dialect });
            }
            if (!spark.length) setMode('lineage');
          })(),
        );
      }
      if (spark.length) {
        jobs.push(ingestSpark(spark.map((f) => ({ blob: f, name: f.name }))).then(() => setMode('spark')));
      }
      const results = await Promise.allSettled(jobs);
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) setError(failed.reason instanceof Error ? failed.reason.message : String(failed.reason));
      setBusy(null);
    },
    [dialect, ingestSpark, runLineage],
  );

  const onDemo = useCallback(async () => {
    setError(null);
    const spark = (async () => {
      const items = await Promise.all(SAMPLE_RUNS.map(async (r) => ({ name: `nightly_orders_etl.${r}.eventlog.gz`, blob: await fetchSample(`nightly_orders_etl.${r}.eventlog.gz`) })));
      await ingestSpark(items, true);
      setMode('spark');
    })();
    const sql = (async () => {
      const sample = await loadSampleSql();
      setFiles(sample);
      setDialect('databricks');
      await runLineage({ files: sample, dialect: 'databricks' });
    })();
    const results = await Promise.allSettled([spark, sql]);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) setError(failed.reason instanceof Error ? failed.reason.message : String(failed.reason));
    setBusy(null);
  }, [ingestSpark, runLineage]);

  const reanalyse = useCallback(async () => {
    setError(null);
    try {
      await runLineage({ files, dialect });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [files, dialect, runLineage]);

  // Accept drops anywhere on the page, not just on the landing drop zones.
  useEffect(() => {
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer?.files.length) onFiles([...e.dataTransfer.files]);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [onFiles]);

  const status = (
    <>
      {busy && <Progress value={busy.progress} label={busy.label} />}
      {lineageStatus && <Progress value={0.5} label={`Lineage: ${lineageStatus} (the first run downloads Python + sqlglot, about 13 MB, then it is cached)`} />}
      {error && <div className="error-box" role="alert">{error}</div>}
    </>
  );

  const modes: { id: Mode; label: string; ready: boolean }[] = [
    { id: 'home', label: 'Data Hub', ready: true },
    { id: 'spark', label: 'Spark Doctor', ready: runs.length > 0 },
    { id: 'lineage', label: 'Lineage Explorer', ready: !!lineage },
    { id: 'map', label: 'Pipeline map', ready: !!lineage && runs.length > 0 },
  ];

  const loadedTarget = runs.length ? runs[runs.length - 1].run.fileName : lineage ? `${lineage.stats.tables} table lineage` : 'No dataset loaded';

  return (
    <div className="app">
      <aside className="sidebar">
        <button className="brand" onClick={() => setMode('home')} aria-label="PipeScope home">
          <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="9" fill="var(--surface-3)" />
            <circle cx="8" cy="16" r="3" fill="var(--c2)" />
            <circle cx="16" cy="8" r="3" fill="var(--accent)" />
            <circle cx="24" cy="16" r="3" fill="var(--good)" />
            <circle cx="16" cy="24" r="3" fill="var(--c4)" />
            <path d="m10.5 14.5 3-4m5 0 3 4m0 3-3 4m-5 0-3-4" stroke="var(--text-muted)" strokeWidth="1.5" />
          </svg>
          <span>PipeScope</span>
          <span className="version">v1.4</span>
        </button>

        <div className="target-card">
          <span className="target-label">Active workspace</span>
          <strong title={loadedTarget}>{loadedTarget}</strong>
          <span className={runs.length || lineage ? 'target-ready' : 'target-idle'}>
            <i />{runs.length || lineage ? 'Loaded in browser memory' : 'Load files or explore the demo'}
          </span>
        </div>

        <div className="nav-group">
          <span className="nav-label">Modules &amp; views</span>
          <nav className="modes" aria-label="Views">
          {modes.map((m) => (
            <button key={m.id} className={mode === m.id ? 'active' : ''} onClick={() => setMode(m.id)} aria-current={mode === m.id ? 'page' : undefined}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><ModeIcon mode={m.id} /></svg>
              {m.label}
              {m.ready && m.id !== 'home' && <span className="dot" aria-hidden="true" />}
            </button>
          ))}
          </nav>
        </div>

        <div className="sidebar-foot">
          <div className="privacy-panel">
            <span>▣ 100% client-side engine</span>
            <p>Data never leaves your browser sandbox.</p>
          </div>
          <span>PipeScope · built by Aditya Malviya</span>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <button className="mobile-brand" onClick={() => setMode('home')} aria-label="PipeScope home">PipeScope</button>
          <span className="privacy" title="Event logs and SQL are processed inside this browser tab. Nothing is uploaded.">
            <i />
            <span>runs in your browser</span>
            <b>│</b>
            <span className="runtime">▣ Pyodide &amp; Web Workers</span>
          </span>
          <span className="spacer" />
          <a className="github-button" href="https://github.com/adityamalviya04692/pipescope" target="_blank" rel="noreferrer">GitHub ↗</a>
        </header>

        <main className="main">
        <div className="view-enter" key={mode}>
          {mode === 'home' && <Landing onFiles={onFiles} onDemo={onDemo} busy={!!busy || !!lineageStatus} status={status} />}
          {mode !== 'home' && status}
          <Suspense fallback={<Progress value={0.3} label="Loading view…" />}>
            {mode === 'spark' && (runs.length ? <SparkView runs={runs} onSwap={() => setRuns(([a, b]) => [b, a])} /> : <Empty>Drop a Spark event log anywhere on the page, or load the demo from the home screen.</Empty>)}
            {mode === 'lineage' &&
              (lineage ? (
                <LineageView result={lineage} files={files} dialect={dialect} busy={!!lineageStatus} onFilesChange={(f, d) => (setFiles(f), setDialect(d))} onAnalyze={reanalyse} />
              ) : (
                <Empty>{lineageStatus ? 'Analysing your SQL…' : 'Drop .sql files or a dbt manifest.json anywhere on the page, or load the demo from the home screen.'}</Empty>
              ))}
            {mode === 'map' &&
              (lineage && runs.length ? (
                <PipelineMap lineage={lineage} runs={runs} />
              ) : (
                <Empty>
                  The pipeline map needs both a Spark event log and the SQL that the run executed. {!runs.length && 'No Spark log loaded yet. '}
                  {!lineage && 'No SQL loaded yet. '}
                  <button className="btn small" onClick={onDemo} disabled={!!busy || !!lineageStatus}>Load the demo pipeline</button>
                </Empty>
              ))}
          </Suspense>
        </div>
        </main>
        <footer className="footer"><span>PipeScope · Spark event-log analysis and SQL lineage, in the browser</span><b>WASM Active</b></footer>
      </div>
    </div>
  );
}
