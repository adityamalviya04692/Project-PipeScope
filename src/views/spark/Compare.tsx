import EChart, { axisStyle, tooltipStyle, useOption } from '../../components/EChart';
import { Card } from '../../components/ui';
import { fmtBytes, fmtDuration, fmtNum, fmtPct } from '../../lib/format';
import { runLabel, type Analysis } from '../../spark/analyze';
import { compareRuns, improved, type MetricDelta } from '../../spark/compare';

function fmtMetric(d: MetricDelta, v: number): string {
  switch (d.kind) {
    case 'duration':
      return fmtDuration(v);
    case 'bytes':
      return fmtBytes(v);
    case 'pct':
      return fmtPct(v, 1);
    default:
      return fmtNum(Math.round(v));
  }
}

function change(d: MetricDelta): string {
  if (d.before === d.after) return 'no change';
  if (d.kind === 'pct' || d.kind === 'score') return `${d.after > d.before ? '+' : ''}${d.kind === 'pct' ? ((d.after - d.before) * 100).toFixed(1) + ' pts' : Math.round(d.after - d.before)}`;
  if (d.before === 0) return 'new';
  if (d.after === 0) return 'eliminated';
  const r = d.after / d.before;
  return r < 1 ? `${(1 / r).toFixed(1)}× less` : `${r.toFixed(1)}× more`;
}

export default function Compare({ runs, onSwap }: { runs: [Analysis, Analysis]; onSwap: () => void }) {
  const [a, b] = runs;
  const cmp = compareRuns(a, b);
  const speedup = a.summary.duration / Math.max(1, b.summary.duration);

  const option = useOption(
    (t) => {
      const rows = [...cmp.tables].reverse();
      return {
        textStyle: { fontFamily: 'inherit' },
        grid: { left: 8, right: 16, top: 30, bottom: 8, containLabel: true },
        legend: { top: 0, textStyle: { color: t.muted }, icon: 'roundRect', itemHeight: 8 },
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...tooltipStyle(t), valueFormatter: (v: number) => (v == null ? '–' : fmtDuration(v * 1000)) },
        xAxis: { type: 'value', ...axisStyle(t), axisLabel: { color: t.muted, formatter: (v: number) => fmtDuration(v * 1000) } },
        yAxis: { type: 'category', data: rows.map((r) => r.label), ...axisStyle(t), splitLine: { show: false }, axisLabel: { color: t.text, fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace' } },
        series: [
          { name: `Before (${runLabel(a)})`, type: 'bar', barGap: '10%', barMaxWidth: 14, itemStyle: { color: t.palette[6], borderRadius: [0, 3, 3, 0] }, data: rows.map((r) => (r.before == null ? null : r.before / 1000)) },
          { name: `After (${runLabel(b)})`, type: 'bar', barMaxWidth: 14, itemStyle: { color: t.accent, borderRadius: [0, 3, 3, 0] }, data: rows.map((r) => (r.after == null ? null : r.after / 1000)) },
        ],
      };
    },
    [cmp],
  );

  return (
    <div className="stack">
      <Card
        title="Before vs after"
        hint={`${a.run.fileName} → ${b.run.fileName}`}
        actions={
          <button className="btn ghost small" onClick={onSwap}>
            Swap runs
          </button>
        }
      >
        <p className="headline">
          {speedup >= 1 ? (
            <>
              <span className="accent">{speedup.toFixed(1)}× faster</span>: {fmtDuration(a.summary.duration)} → {fmtDuration(b.summary.duration)}
            </>
          ) : (
            <>
              <span style={{ color: 'var(--critical)' }}>{(1 / speedup).toFixed(1)}× slower</span>: {fmtDuration(a.summary.duration)} → {fmtDuration(b.summary.duration)}
            </>
          )}
        </p>
        <div className="kpis">
          {cmp.metrics.map((d) => (
            <div key={d.label} className={`kpi ${d.before === d.after ? '' : improved(d) ? 'good' : 'critical'}`}>
              <span className="kpi-label">{d.label}</span>
              <span className="kpi-value" style={{ fontSize: 19 }}>
                {fmtMetric(d, d.before)} → {fmtMetric(d, d.after)}
              </span>
              <span className={`delta ${d.before === d.after ? '' : improved(d) ? 'up' : 'down'}`}>{change(d)}</span>
            </div>
          ))}
        </div>
      </Card>
      <div className="grid-2">
        <Card title="Time per table" hint="Wall-clock time of each statement, matched by the table it writes.">
          <EChart option={option} height={Math.max(220, cmp.tables.length * 38 + 50)} />
        </Card>
        <Card title="What changed">
          <h4 className="small muted">RESOLVED ({cmp.resolved.length})</h4>
          {cmp.resolved.length ? (
            <ul className="check-list">
              {cmp.resolved.map((r) => (
                <li key={r.rule}>
                  <span style={{ color: 'var(--good)' }}>✓</span>
                  <span>{r.title}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Nothing resolved.</p>
          )}
          <h4 className="small muted">NEW ({cmp.introduced.length})</h4>
          {cmp.introduced.length ? (
            <ul className="check-list">
              {cmp.introduced.map((r) => (
                <li key={r.rule}>
                  <span style={{ color: 'var(--critical)' }}>!</span>
                  <span>{r.title}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No new problems introduced.</p>
          )}
        </Card>
      </div>
    </div>
  );
}
