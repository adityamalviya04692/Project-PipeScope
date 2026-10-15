import { useRef, useState, type DragEvent, type ReactNode } from 'react';

function Drop({ title, icon, accept, items, button, onFiles, directory }: { title: string; icon: ReactNode; accept: string; items: string[]; button: string; onFiles: (f: File[]) => void; directory?: boolean }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
    onFiles([...e.dataTransfer.files]);
  };
  return (
    <div
      className={`drop${over ? ' over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <h3>
        {icon}
        {title}
      </h3>
      <ul>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
      <div className="upload-well" style={{ marginTop: 'auto' }}>
        <span className="upload-icon" aria-hidden="true">↥</span>
        <button className="btn ghost" onClick={() => input.current?.click()}>
          {button}
        </button>
        <span className="muted small">or drop files here</span>
      </div>
      <input
        ref={input}
        type="file"
        hidden
        multiple
        accept={accept}
        {...(directory ? { webkitdirectory: '' } : {})}
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
    </div>
  );
}

const SparkIcon = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: 'var(--accent)' }}>
    <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
  </svg>
);
const LineageIcon = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" style={{ color: 'var(--accent)' }}>
    <circle cx="5" cy="12" r="2.5" />
    <circle cx="19" cy="5" r="2.5" />
    <circle cx="19" cy="19" r="2.5" />
    <path d="M7.5 11 16.5 6M7.5 13l9 5" />
  </svg>
);

export default function Landing({ onFiles, onDemo, busy, status }: { onFiles: (f: File[]) => void; onDemo: () => void; busy: boolean; status: ReactNode }) {
  return (
    <div className="landing">
      <div className="atmosphere">
      <section className="hero">
        <span className="eyebrow">Spark diagnostics · SQL graph lineage</span>
        <h1>See why your pipeline is <em>slow</em>, and <em>what it feeds.</em></h1>
        <p>
          Drop a <b>Spark event log</b> to find skew, spill and wasted cores, with a fix for each. Drop your <b>SQL or dbt project</b> to trace every column from source to dashboard. Put them together to see runtime cost on the lineage graph.
        </p>
      <div className="demo-cta">
        <button className="btn" onClick={onDemo} disabled={busy}>
          <span aria-hidden="true">▶</span> Explore the demo pipeline
        </button>
        <a className="hero-secondary" href="#diagnostic-preview">View the workflow ↓</a>
      </div>
      <span className="hero-caption">A nightly orders ETL: two Spark runs, before and after tuning, plus the SQL that built them.</span>
      </section>
      <div className="technology-strip"><span>Built for your data stack. Executed in your browser.</span><div>{['Apache Spark', 'dbt manifests', 'sqlglot', 'SQL lineage', 'Web Workers', 'Pyodide WASM'].map((item) => <span key={item}>{item}</span>)}</div></div>
      </div>
      <section className="landing-section" id="interactive-suite">
      <div className="section-intro"><div><span className="section-kicker">01 / Dual diagnostic workspace</span><h2>Two targeted lenses.<br className="mobile-break" /> <em>One client-side engine.</em></h2></div><p>Analyze distributed execution traces and parse multi-dialect SQL lineage in your browser. Start with your files or explore the demo.</p></div>
      {status}
      <div className="drops">
        <Drop
          title="Spark Doctor"
          icon={SparkIcon}
          accept=".json,.log,.gz,.txt,application/json,application/gzip,*/*"
          button="Choose event logs"
          onFiles={onFiles}
          items={[
            'Spark event logs (spark.eventLog.dir): plain or .gz',
            'Load two runs of the same job to compare them',
            'Findings for skew, spill, GC, small files, idle cores and config, each with a fix',
          ]}
        />
        <Drop
          title="Lineage Explorer"
          icon={LineageIcon}
          accept=".sql,.json"
          button="Choose SQL files"
          onFiles={onFiles}
          items={[
            '.sql files (CTAS, INSERT, MERGE, views, DDL), in any order',
            'or a dbt target/manifest.json (compiled SQL, docs and tests)',
            'Column-level lineage with impact analysis, powered by sqlglot',
          ]}
        />
      </div>
      </section>
      <section className="landing-section architecture-panel"><div><span className="section-kicker">A browser-native architecture</span><h2>A focused engine.<br />A lighter footprint.</h2><p>Your event logs are parsed in Web Workers. Your SQL is resolved by Python and sqlglot through Pyodide. The analysis stays in this tab.</p></div><div className="terminal-preview"><div className="terminal-bar"><span>● ● ●</span><span>pipescope / browser runtime</span></div><pre>{`> load nightly_orders_etl\n\n  ✓ Parse Spark event logs in a worker\n  ✓ Resolve SQL column dependencies\n  ✓ Correlate runtime with table lineage\n\n  Your files. Your browser. Your analysis.`}</pre></div></section>
      <section className="privacy-feature landing-section"><div><span className="section-kicker">Local by design</span><h2>Your telemetry never leaves<br /><em>your browser sandbox.</em></h2><p>Files are processed in memory. The SQL engine downloads on first use; your event logs and SQL are never uploaded.</p></div><div className="privacy-grid">{[['Zero uploads', 'Local file processing'], ['Worker parsing', 'Responsive analysis'], ['Python via WASM', 'SQL AST resolution'], ['Open source', 'Inspect the engine']].map(([title, text]) => <div key={title}><span aria-hidden="true">◈</span><strong>{title}</strong><small>{text}</small></div>)}</div></section>
      <section className="landing-section" id="diagnostic-preview"><div className="section-intro"><div><span className="section-kicker">02 / From execution to impact</span><h2>Correlate runtime cost directly with <em>data lineage.</em></h2></div></div><div className="workflow-preview"><div className="preview-map"><span className="section-kicker">One connected view</span><div className="preview-nodes"><span>bronze.raw_orders<small>Source data</small></span><i>↓</i><span>silver.orders<small>Clean &amp; transform</small></span><i>↓</i><span className="hot-node">gold.fct_order_items<small>Inspect runtime &amp; findings</small></span><i>↓</i><span>gold.mart_daily_revenue<small>Downstream model</small></span></div></div><div className="preview-copy"><span className="section-kicker">The nightly orders demo</span><h3>Find the bottleneck.<br /><em>Follow its impact.</em></h3><p>Compare two real sample runs, inspect stage skew and spill, and trace the SQL columns behind the tables they build.</p><ul><li>Inspect evidence and suggested fixes</li><li>Compare runtime before and after tuning</li><li>Trace upstream sources and downstream impact</li></ul><button className="btn" onClick={onDemo} disabled={busy}>Open the demo workspace ↗</button></div></div></section>
    </div>
  );
}
