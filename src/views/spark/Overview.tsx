import { useMemo, useState } from 'react';
import EChart, { axisStyle, tooltipStyle, useOption, type Theme } from '../../components/EChart';
import { Card, Chevron, CodeBlock, Kpi, ScoreRing } from '../../components/ui';
import { fmtBytes, fmtDuration, fmtNum, fmtPct } from '../../lib/format';
import type { Analysis } from '../../spark/analyze';
import { severityIndex, type Finding, type Severity } from '../../spark/rules';

export function sevColor(t: Theme, s?: Severity): string {
  return s === 'critical' ? t.critical : s === 'warning' ? t.warning : s === 'info' ? t.info : t.accent;
}

export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

export function FindingCard({ f, a, defaultOpen = false, onOpenStage }: { f: Finding; a: Analysis; defaultOpen?: boolean; onOpenStage?: (key: string) => void }) {
  const [open, setOpen] = useState(defaultOpen);
  const stageName = (key: string) => {
    const s = a.stages.find((x) => x.key === key);
    return s ? `Stage ${s.id}${s.attempt ? `.${s.attempt}` : ''}` : key;
  };
  return (
    <article className={`finding ${f.severity}`}>
      <button onClick={() => setOpen(!open)} aria-expanded={open}>
        <Chevron open={open} />
        <span className={`sev ${f.severity}`}>{f.severity}</span>
        <span className="finding-title">{f.title}</span>
        {f.impactMs ? <span className="chip">~{fmtDuration(f.impactMs)} lost</span> : null}
      </button>
      {open && (
        <div className="finding-body">
          <p>{f.summary}</p>
          {f.evidence.length > 0 && (
            <dl className="evidence">
              {f.evidence.map((e) => (
                <div key={e.label}>
                  <dt>{e.label}</dt>
                  <dd>{e.value}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="fix">
            <h4>How to fix</h4>
            <ol>
              {f.fix.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            {f.fix.code && <CodeBlock code={f.fix.code} lang={f.fix.lang} />}
          </div>
          {onOpenStage && f.stageKeys.length > 0 && (
            <div className="row">
              <span className="muted small">Inspect:</span>
              {f.stageKeys.slice(0, 8).map((k) => (
                <button key={k} className="chip" onClick={() => onOpenStage(k)}>
                  {stageName(k)} →
                </button>
              ))}
              {f.stageKeys.length > 8 && <span className="muted small">+{f.stageKeys.length - 8} more</span>}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export function ConcurrencyChart({ a, height = 220 }: { a: Analysis; height?: number }) {
  const option = useOption(
    (t) => {
      const t0 = a.summary.start;
      const xs = a.concurrency.t.map((x) => (x - t0) / 1000);
      return {
        textStyle: { fontFamily: 'inherit' },
        grid: { left: 8, right: 16, top: 30, bottom: 8, containLabel: true },
        legend: { top: 0, right: 0, textStyle: { color: t.muted }, icon: 'roundRect', itemHeight: 8 },
        tooltip: { trigger: 'axis', ...tooltipStyle(t), valueFormatter: (v: number) => fmtNum(Math.round(v)) },
        xAxis: { type: 'value', min: 0, max: a.summary.duration / 1000, ...axisStyle(t), splitLine: { show: false }, axisLabel: { color: t.muted, formatter: (v: number) => fmtClock(v) } },
        yAxis: { type: 'value', name: 'cores', nameTextStyle: { color: t.muted }, ...axisStyle(t) },
        series: [
          { name: 'Tasks running', type: 'line', showSymbol: false, data: xs.map((x, i) => [x, a.concurrency.running[i]]), lineStyle: { width: 1.5, color: t.accent }, itemStyle: { color: t.accent }, areaStyle: { color: t.accentSoft } },
          { name: 'Cores available', type: 'line', step: 'middle', showSymbol: false, data: xs.map((x, i) => [x, a.concurrency.cores[i]]), lineStyle: { width: 1.5, type: 'dashed', color: t.muted }, itemStyle: { color: t.muted } },
        ],
      };
    },
    [a],
  );
  return <EChart option={option} height={height} />;
}

function TimeByTable({ a, onOpenSql }: { a: Analysis; onOpenSql: (id: number) => void }) {
  const sev = useMemo(() => severityIndex(a.findings).sql, [a]);
  const items = a.sql;
  const option = useOption(
    (t) => {
      const data = [...items].reverse();
      return {
        textStyle: { fontFamily: 'inherit' },
        grid: { left: 8, right: 70, top: 4, bottom: 4, containLabel: true },
        tooltip: {
          trigger: 'item',
          ...tooltipStyle(t),
          formatter: (p: { dataIndex: number }) => {
            const q = data[p.dataIndex];
            return `<b>${q.label}</b><br/>Wall time ${fmtDuration(q.duration)}<br/>Task time ${fmtDuration(q.taskTime)}<br/>${q.stageKeys.length} stages`;
          },
        },
        xAxis: { type: 'value', ...axisStyle(t), axisLabel: { color: t.muted, formatter: (v: number) => fmtClock(v) } },
        yAxis: { type: 'category', data: data.map((q) => q.label), ...axisStyle(t), splitLine: { show: false }, axisLabel: { color: t.text, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 } },
        series: [
          {
            type: 'bar',
            barMaxWidth: 18,
            data: data.map((q) => ({ value: q.duration / 1000, itemStyle: { color: sevColor(t, sev.get(q.id)), borderRadius: [0, 4, 4, 0] } })),
            label: { show: true, position: 'right', color: t.muted, fontSize: 11, formatter: (p: { value: number }) => fmtDuration(p.value * 1000) },
          },
        ],
      };
    },
    [a, sev],
  );
  return <EChart option={option} height={Math.max(180, items.length * 30 + 20)} onClick={(p) => onOpenSql([...items].reverse()[p.dataIndex].id)} />;
}

export default function Overview({ a, onOpenStage, onOpenSql }: { a: Analysis; onOpenStage: (key: string) => void; onOpenSql: (id: number) => void }) {
  const s = a.summary;
  const counts = { critical: 0, warning: 0, info: 0 };
  a.findings.forEach((f) => counts[f.severity]++);
  const straggler = a.findings.filter((f) => f.rule === 'skew' || f.rule === 'single-partition').reduce((x, f) => x + (f.impactMs ?? 0), 0);
  const idleCoreHours = Math.max(0, (s.coreMsAvailable - s.taskMs) / 3_600_000);

  return (
    <div className="stack">
      <div className="kpis audit-kpis">
        <Kpi label="Wall-clock" value={fmtDuration(s.duration)} sub={`${fmtNum(s.jobs)} jobs · ${fmtNum(s.stages)} stages`} />
        <Kpi label="Tasks" value={fmtNum(s.tasks)} sub={s.failedTasks ? `${s.failedTasks} failed attempts` : 'no failures'} tone={s.failedTasks ? 'warning' : ''} />
        <Kpi label="Executors" value={fmtNum(s.executors)} sub={`peak ${s.peakCores} cores`} />
        <Kpi label="Utilisation" value={fmtPct(s.utilization)} sub={`${idleCoreHours.toFixed(1)} idle core-hours`} tone={s.utilization < 0.25 ? 'critical' : s.utilization < 0.4 ? 'warning' : 'good'} />
        <Kpi label="Input" value={fmtBytes(s.inputBytes)} sub={`output ${fmtBytes(s.outputBytes)}`} />
        <Kpi label="Shuffle" value={fmtBytes(s.shuffleRead)} sub={`written ${fmtBytes(s.shuffleWrite)}`} />
        <Kpi label="Disk spill" value={fmtBytes(s.diskSpill)} sub={`memory ${fmtBytes(s.memSpill)}`} tone={s.diskSpill > 5 * 1024 ** 3 ? 'critical' : s.diskSpill > 0 ? 'warning' : 'good'} />
        <Kpi label="GC" value={fmtPct(s.gcRatio, 1)} sub="of executor run time" tone={s.gcRatio > 0.1 ? 'warning' : 'good'} />
      </div>

      <div className="overview-workspace">
        <div className="stack">
          <Card title="Run health" hint="100 minus a penalty per finding (critical 15, warning 6, note 2; capped per rule).">
            <div className="score-card">
              <ScoreRing score={a.score} grade={a.grade} />
              <div className="stack" style={{ gap: 10, flex: 1, minWidth: 220 }}>
                <p><b>{a.findings.length} findings</b> in {fmtDuration(s.duration)} of runtime.</p>
                <div className="sev-counts">
                  <span className="sev critical">{counts.critical} critical</span>
                  <span className="sev warning">{counts.warning} warning</span>
                  <span className="sev info">{counts.info} notes</span>
                </div>
                {straggler > 0 && <p className="small">About <b>{fmtDuration(straggler)}</b> ({fmtPct(straggler / s.duration)}) was spent waiting on straggler tasks while other cores sat idle.</p>}
                <p className="muted small">Spark {s.sparkVersion || '?'} · {a.run.fileName}</p>
              </div>
            </div>
          </Card>
          <Card title="Where the time went" hint="Wall-clock time per SQL statement, coloured by its worst finding. Click a bar to see its stage DAG.">
            {a.sql.length ? <TimeByTable a={a} onOpenSql={onOpenSql} /> : <p className="muted">No SQL executions in this log.</p>}
          </Card>
          <Card title="Cores in use vs available" hint="Time-weighted running tasks against executor cores. The gap is capacity you paid for but did not use.">
            <ConcurrencyChart a={a} />
          </Card>
        </div>

        <Card className="findings-panel" title={`Critical hotspots & findings (${a.findings.length})`} hint="Sorted by severity, then by estimated time lost. Expand one for evidence and a copyable fix.">
          {a.findings.length === 0 ? <p className="muted">No problems detected. This run looks healthy.</p> : (
            <div className="findings">
              {a.findings.map((f, i) => <FindingCard key={f.id} f={f} a={a} defaultOpen={i < 2} onOpenStage={onOpenStage} />)}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
