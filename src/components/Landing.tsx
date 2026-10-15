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
      <div className="row" style={{ marginTop: 'auto' }}>
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
      <section className="hero">
        <h1>See why your pipeline is slow, and what it feeds.</h1>
        <p>
          Drop a <b>Spark event log</b> to find skew, spill and wasted cores, with a fix for each. Drop your <b>SQL or dbt project</b> to trace every column from source to dashboard. Put them together to see runtime cost on the lineage graph.
        </p>
      </section>
      <div className="demo-cta">
        <button className="btn" onClick={onDemo} disabled={busy}>
          Explore the demo pipeline
        </button>
        <span className="muted small">A nightly orders ETL: two Spark runs (before and after tuning) plus the SQL that built them.</span>
      </div>
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
      <p className="muted small" style={{ textAlign: 'center' }}>
        Everything runs in this tab (Web Workers, plus Python via Pyodide for SQL parsing). No file is uploaded anywhere.
      </p>
    </div>
  );
}
