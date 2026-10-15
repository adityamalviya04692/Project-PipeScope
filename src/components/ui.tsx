import { useState, type ReactNode } from 'react';

export function Card({ title, hint, actions, children, className = '' }: { title?: ReactNode; hint?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && <h3>{title}</h3>}
            {hint && <p className="muted small hint">{hint}</p>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export type Tone = '' | 'good' | 'warning' | 'critical';

export function Kpi({ label, value, sub, tone = '' }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className={`kpi ${tone}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {sub && <span className="kpi-sub">{sub}</span>}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange, label }: { options: { id: T; label: ReactNode; count?: number; tone?: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} role="tab" aria-selected={value === o.id} className={value === o.id ? 'active' : ''} onClick={() => onChange(o.id)}>
          {o.label}
          {o.count != null && o.count > 0 && <span className={`count ${o.tone ?? ''}`}>{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="code">
      {lang && <span className="lang">{lang}</span>}
      <button className="btn ghost small copy" onClick={copy} aria-label="Copy code">
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function scoreTone(score: number): 'good' | 'ok' | 'bad' {
  return score >= 85 ? 'good' : score >= 60 ? 'ok' : 'bad';
}

export function ScoreRing({ score, grade, size = 120, label = 'Health score' }: { score: number; grade: string; size?: number; label?: string }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  return (
    <svg className={`ring ${scoreTone(score)}`} viewBox="0 0 100 100" width={size} height={size} role="img" aria-label={`${label} ${score} of 100, grade ${grade}`}>
      <circle cx="50" cy="50" r={r} className="ring-track" />
      <circle cx="50" cy="50" r={r} className="ring-value" strokeDasharray={`${(Math.max(score, 0.5) / 100) * c} ${c}`} transform="rotate(-90 50 50)" />
      <text x="50" y="52" textAnchor="middle" className="ring-score">{Math.round(score)}</text>
      <text x="50" y="66" textAnchor="middle" className="ring-grade">Grade {grade}</text>
    </svg>
  );
}

export function Progress({ value, label }: { value: number; label: ReactNode }) {
  return (
    <div className="loading" role="status">
      <span className="small">{label}</span>
      <div className="progress"><div style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} /></div>
    </div>
  );
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`chev${open ? ' open' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

/** Small bar plus value, for numeric table cells. */
export function BarCell({ value, max, label, hot }: { value: number; max: number; label: ReactNode; hot?: boolean }) {
  return (
    <div className="bar-cell">
      <span>{label}</span>
      <div className={`bar${hot ? ' hot' : ''}`}><div style={{ width: `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%` }} /></div>
    </div>
  );
}
