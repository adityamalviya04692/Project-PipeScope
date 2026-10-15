import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import Landing from './components/Landing';
import Documentation from './components/Documentation';
import { Empty, Progress } from './components/ui';
import { analyzeLineage, loadSampleSql } from './lineage/client';
import type { LineageResult, SqlFile } from './lineage/types';
import { analyzeRun, type Analysis } from './spark/analyze';
import { fetchSample, parseInWorker, SAMPLE_RUNS } from './spark/client';

// Views (and their chart, graph and editor libraries) load on first use, so the landing page stays light.
const SparkView = lazy(() => import('./views/spark/SparkView'));
const LineageView = lazy(() => import('./views/lineage/LineageView'));
const PipelineMap = lazy(() => import('./views/map/PipelineMap'));

type Mode = 'home' | 'spark' | 'lineage' | 'map' | 'docs';

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

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [mode]);

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
    { id: 'docs', label: 'Documentation', ready: true },
  ];

  return (
    <div className={`app mode-${mode}`}>
      <div className="workspace">
        <header className="topbar">
          <button className="mobile-brand" onClick={() => setMode('home')} aria-label="PipeScope home"><img src="./pipescope-icon.svg" width="22" height="22" alt="" aria-hidden="true" />PipeScope</button>
          <nav className="editorial-nav" aria-label="Main navigation">
            {modes.map((m) => <button key={m.id} className={mode === m.id ? 'active' : ''} aria-current={mode === m.id ? 'page' : undefined} onClick={() => setMode(m.id)}>{m.label}</button>)}
          </nav>
          <span className="privacy" title="Event logs and SQL are processed inside this browser tab. Nothing is uploaded.">
            <i />
            <span>runs in your browser</span>
            <b>│</b>
            <span className="runtime">▣ Pyodide &amp; Web Workers</span>
          </span>
          <span className="spacer" />
          <a className="github-button" href="https://github.com/adityamalviya04692/pipescope" target="_blank" rel="noreferrer">GitHub ↗</a>
          <button className="btn header-demo" onClick={onDemo} disabled={!!busy || !!lineageStatus}>Explore demo ↗</button>
        </header>

        <main className="main">
        <div className="view-enter" key={mode}>
          {mode === 'home' && <Landing onFiles={onFiles} onDemo={onDemo} busy={!!busy || !!lineageStatus} status={status} />}
          {mode === 'docs' && <Documentation onDemo={onDemo} busy={!!busy || !!lineageStatus} />}
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
        <footer className="editorial-footer">
          <div><button className="footer-brand" onClick={() => setMode('home')}><img src="./pipescope-icon.svg" width="26" height="26" alt="" />PipeScope <small>v1.4</small></button><p>Understand your pipelines.<br />Spark diagnostics and column-level SQL lineage, entirely in your browser.</p><span className="footer-privacy">● Your files stay in this browser.</span></div>
          <div><span>Analyzers</span><button onClick={() => setMode('spark')}>Spark Doctor</button><button onClick={() => setMode('lineage')}>Lineage Explorer</button><button onClick={() => setMode('map')}>Pipeline Map</button></div>
          <div><span>Architecture</span><button onClick={() => setMode('docs')}>Browser engine</button><button onClick={() => setMode('docs')}>Event log recipes</button><button onClick={() => setMode('docs')}>Security &amp; privacy</button></div>
          <div><span>Project</span><a href="https://github.com/adityamalviya04692/pipescope" target="_blank" rel="noreferrer">GitHub repository ↗</a><a href="https://github.com/adityamalviya04692/pipescope/blob/main/LICENSE" target="_blank" rel="noreferrer">MIT license ↗</a><p>Built by Aditya Malviya</p></div>
        </footer>
      </div>
    </div>
  );
}
