import { useMemo, useState } from 'react';
import EChart, { axisStyle, echarts, tooltipStyle, useOption } from '../../components/EChart';
import { BarCell, Card, Kpi } from '../../components/ui';
import { fmtBytes, fmtDuration, fmtNum, fmtPct, fmtRatio } from '../../lib/format';
import { dist, type Analysis, type StageStats } from '../../spark/analyze';
import { displayTable } from '../../spark/plan';
import { severityIndex, type Severity } from '../../spark/rules';
import type { TaskRec } from '../../spark/types';
import { FindingCard, fmtClock } from './Overview';

type SortKey = 'id' | 'duration' | 'tasks' | 'input' | 'shuffle' | 'spill' | 'gc' | 'skew';

const SORTS: Record<SortKey, (s: StageStats) => number> = {
  id: (s) => s.id * 100 + s.attempt,
  duration: (s) => s.duration,
  tasks: (s) => s.tasks,
  input: (s) => s.inputBytes,
  shuffle: (s) => s.shuffleRead + s.shuffleWrite,
  spill: (s) => s.diskSpill,
  gc: (s) => s.gcRatio,
  skew: (s) => s.skewRatio,
};

function StageTable({ a, selected, onSelect, sev }: { a: Analysis; selected: string | null; onSelect: (k: string) => void; sev: Map<string, Severity> }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'id', desc: false });
  const ran = a.stages.filter((s) => s.status !== 'skipped');
  const rows = [...ran].sort((x, y) => (SORTS[sort.key](x) - SORTS[sort.key](y)) * (sort.desc ? -1 : 1));
  const max = (f: (s: StageStats) => number) => Math.max(1, ...ran.map(f));
  const mDur = max((s) => s.duration);
  const mIn = max((s) => s.inputBytes);
  const mSh = max((s) => s.shuffleRead + s.shuffleWrite);
  const th = (key: SortKey, label: string, num = true) => (
    <th className={`sortable${num ? ' num' : ''}`} onClick={() => setSort({ key, desc: sort.key === key ? !sort.desc : key !== 'id' })} aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      {label}
      {sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
    </th>
  );
  return (
    <div className="table-wrap" style={{ maxHeight: 420 }}>
      <table className="dt">
        <thead>
          <tr>
            {th('id', 'Stage', false)}
            <th>Builds</th>
            <th>Kind</th>
            {th('tasks', 'Tasks')}
            {th('duration', 'Duration')}
            {th('input', 'Input')}
            {th('shuffle', 'Shuffle R/W')}
            {th('spill', 'Disk spill')}
            {th('gc', 'GC')}
            {th('skew', 'Max/median')}
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.key} className={`clickable${selected === s.key ? ' selected' : ''}`} onClick={() => onSelect(s.key)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onSelect(s.key)}>
              <td>
                <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  <span className={`dot-sev ${sev.get(s.key) ?? ''}`} />
                  <b>
                    {s.id}
                    {s.attempt ? `.${s.attempt}` : ''}
                  </b>
                  {s.status === 'failed' && <span className="sev critical">failed</span>}
                </span>
              </td>
              <td className="mono small">{s.table ? displayTable(s.table) : '–'}</td>
              <td>{s.kind}</td>
              <td className="num">{fmtNum(s.tasks)}</td>
              <td className="num"><BarCell value={s.duration} max={mDur} label={fmtDuration(s.duration)} hot={sev.get(s.key) === 'critical'} /></td>
              <td className="num"><BarCell value={s.inputBytes} max={mIn} label={s.inputBytes ? fmtBytes(s.inputBytes) : '–'} /></td>
              <td className="num"><BarCell value={s.shuffleRead + s.shuffleWrite} max={mSh} label={s.shuffleRead + s.shuffleWrite ? `${fmtBytes(s.shuffleRead)} / ${fmtBytes(s.shuffleWrite)}` : '–'} /></td>
              <td className="num">{s.diskSpill ? fmtBytes(s.diskSpill) : '–'}</td>
              <td className="num">{s.runTime ? fmtPct(s.gcRatio) : '–'}</td>
              <td className="num" style={{ color: s.skewRatio >= 5 ? 'var(--critical)' : undefined, fontWeight: s.skewRatio >= 5 ? 700 : undefined }}>{s.tasks > 1 ? fmtRatio(s.skewRatio) : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const METRICS: { label: string; get: (t: TaskRec) => number; fmt: (v: number) => string }[] = [
  { label: 'Duration', get: (t) => t.duration, fmt: fmtDuration },
  { label: 'Scheduler delay', get: (t) => t.schedulerDelay, fmt: fmtDuration },
  { label: 'GC time', get: (t) => t.gcTime, fmt: fmtDuration },
  { label: 'Input', get: (t) => t.inputBytes, fmt: fmtBytes },
  { label: 'Shuffle read', get: (t) => t.shuffleReadBytes, fmt: fmtBytes },
  { label: 'Shuffle write', get: (t) => t.shuffleWriteBytes, fmt: fmtBytes },
  { label: 'Disk spill', get: (t) => t.diskSpill, fmt: fmtBytes },
  { label: 'Peak exec memory', get: (t) => t.peakMemory, fmt: fmtBytes },
];

function Percentiles({ tasks }: { tasks: TaskRec[] }) {
  const rows = METRICS.map((m) => ({ m, d: dist(tasks.map(m.get)) })).filter(({ d }) => d.max > 0);
  return (
    <div className="table-wrap">
      <table className="dt">
        <thead>
          <tr>
            <th>Metric</th>
            <th className="num">Min</th>
            <th className="num">25th</th>
            <th className="num">Median</th>
            <th className="num">75th</th>
            <th className="num">Max</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ m, d }) => (
            <tr key={m.label}>
              <td>{m.label}</td>
              <td className="num">{m.fmt(d.min)}</td>
              <td className="num">{m.fmt(d.p25)}</td>
              <td className="num">{m.fmt(d.p50)}</td>
              <td className="num">{m.fmt(d.p75)}</td>
              <td className="num" style={{ fontWeight: d.p50 > 0 && d.max / d.p50 >= 5 ? 700 : undefined, color: d.p50 > 0 && d.max / d.p50 >= 5 ? 'var(--critical)' : undefined }}>
                {m.fmt(d.max)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Histogram({ tasks, median }: { tasks: TaskRec[]; median: number }) {
  const option = useOption(
    (t) => {
      const ds = tasks.map((x) => x.duration);
      const lo = Math.min(...ds);
      const hi = Math.max(...ds);
      const bins = Math.min(40, Math.max(8, Math.ceil(Math.sqrt(ds.length))));
      const w = hi > lo ? (hi - lo) / bins : 1;
      const counts = new Array<number>(bins).fill(0);
      for (const d of ds) counts[Math.min(bins - 1, Math.floor((d - lo) / w))]++;
      const labels = counts.map((_, i) => `${fmtDuration(lo + i * w)} – ${fmtDuration(lo + (i + 1) * w)}`);
      return {
        textStyle: { fontFamily: 'inherit' },
        grid: { left: 8, right: 12, top: 10, bottom: 8, containLabel: true },
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...tooltipStyle(t) },
        xAxis: { type: 'category', data: labels, ...axisStyle(t), splitLine: { show: false }, axisLabel: { color: t.muted, fontSize: 10, interval: Math.ceil(bins / 6) - 1, formatter: (v: string) => v.split(' – ')[0] } },
        // min below 1 so a bin holding a single straggler still gets a visible bar
        yAxis: { type: 'log', logBase: 10, min: 0.5, ...axisStyle(t), axisLabel: { color: t.muted, fontSize: 11, formatter: (v: number) => (v < 1 ? '' : fmtNum(v)) } },
        series: [{ type: 'bar', name: 'tasks', barCategoryGap: '6%', data: counts.map((c, i) => ({ value: c || null, itemStyle: { color: lo + i * w > median * 4 ? t.critical : t.accent, borderRadius: [2, 2, 0, 0] } })) }],
      };
    },
    [tasks, median],
  );
  return <EChart option={option} height={230} />;
}

function Scatter({ tasks, s }: { tasks: TaskRec[]; s: StageStats }) {
  const useShuffle = s.shuffleRead > 0;
  const execs = useMemo(() => [...new Set(tasks.map((x) => x.executorId))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [tasks]);
  const option = useOption(
    (t) => ({
      textStyle: { fontFamily: 'inherit' },
      grid: { left: 8, right: 16, top: 48, bottom: 26, containLabel: true },
      legend: { top: 0, left: 'center', type: 'scroll', textStyle: { color: t.muted }, itemHeight: 8, icon: 'circle' },
      tooltip: {
        trigger: 'item',
        ...tooltipStyle(t),
        formatter: (p: { data: [number, number, number, string] }) => `Task ${p.data[2]} · executor ${p.data[3]}<br/>${useShuffle ? 'Shuffle read' : 'Input'} ${fmtBytes(p.data[0] * 1024 ** 2)}<br/>Duration ${fmtDuration(p.data[1] * 1000)}`,
      },
      xAxis: { type: 'value', scale: true, name: useShuffle ? 'shuffle read (MB)' : 'input (MB)', nameLocation: 'middle', nameGap: 24, nameTextStyle: { color: t.muted }, ...axisStyle(t) },
      yAxis: { type: 'value', scale: true, name: 'seconds', nameTextStyle: { color: t.muted }, ...axisStyle(t) },
      series: execs.map((ex, i) => ({
        name: `exec ${ex}`,
        type: 'scatter',
        symbolSize: 6,
        itemStyle: { color: t.palette[i % 6], opacity: 0.7 },
        data: tasks.filter((x) => x.executorId === ex).map((x) => [(useShuffle ? x.shuffleReadBytes : x.inputBytes) / 1024 ** 2, x.duration / 1000, x.index, ex]),
      })),
    }),
    [tasks, execs, useShuffle],
  );
  return <EChart option={option} height={260} />;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Api = any;

function TaskTimeline({ tasks, median, start }: { tasks: TaskRec[]; median: number; start: number }) {
  const lanes = useMemo(() => {
    // Pack each executor's tasks into lanes (one per concurrently running task).
    const byExec = new Map<string, TaskRec[]>();
    for (const x of tasks) byExec.set(x.executorId, [...(byExec.get(x.executorId) ?? []), x]);
    const rows: { label: string; tasks: TaskRec[] }[] = [];
    for (const ex of [...byExec.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
      const free: number[] = [];
      const laneTasks: TaskRec[][] = [];
      for (const x of byExec.get(ex)!.sort((p, q) => p.launch - q.launch)) {
        let i = free.findIndex((f) => f <= x.launch);
        if (i < 0) {
          i = free.length;
          free.push(0);
          laneTasks.push([]);
        }
        free[i] = x.finish;
        laneTasks[i].push(x);
      }
      laneTasks.forEach((l, i) => rows.push({ label: i === 0 ? `exec ${ex}` : '', tasks: l }));
    }
    return rows;
  }, [tasks]);

  const option = useOption(
    (t) => ({
      textStyle: { fontFamily: 'inherit' },
      grid: { left: 8, right: 16, top: 8, bottom: 24, containLabel: true },
      tooltip: { trigger: 'item', ...tooltipStyle(t), formatter: (p: { data: { task: TaskRec } }) => `Task ${p.data.task.index}${p.data.task.attempt ? ` (attempt ${p.data.task.attempt})` : ''} · ${p.data.task.status}<br/>${fmtDuration(p.data.task.duration)}${p.data.task.failReason ? `<br/>${p.data.task.failReason}` : ''}` },
      xAxis: { type: 'value', min: 0, ...axisStyle(t), axisLabel: { color: t.muted, formatter: (v: number) => fmtClock(v) } },
      yAxis: { type: 'category', inverse: true, data: lanes.map((l) => l.label), ...axisStyle(t), splitLine: { show: false }, axisLabel: { color: t.muted, fontSize: 10, interval: 0 } },
      series: [
        {
          type: 'custom',
          encode: { x: [1, 2], y: 0 },
          data: lanes.flatMap((l, row) =>
            l.tasks.map((x) => ({
              value: [row, (x.launch - start) / 1000, (x.finish - start) / 1000],
              task: x,
              itemStyle: { color: x.status === 'failed' ? t.warning : x.duration > median * 4 ? t.critical : t.accent },
            })),
          ),
          renderItem: (params: Api, api: Api) => {
            const a0 = api.coord([api.value(1), api.value(0)]);
            const a1 = api.coord([api.value(2), api.value(0)]);
            const h = Math.max(2, api.size([0, 1])[1] * 0.7);
            const rect = echarts.graphic.clipRectByRect({ x: a0[0], y: a0[1] - h / 2, width: Math.max(1, a1[0] - a0[0] - 0.5), height: h }, { x: params.coordSys.x, y: params.coordSys.y, width: params.coordSys.width, height: params.coordSys.height });
            return rect && { type: 'rect', shape: rect, style: { fill: api.visual('color') } };
          },
        },
      ],
    }),
    [lanes, median, start],
  );
  return <EChart option={option} height={Math.min(560, Math.max(180, lanes.length * 9 + 50))} />;
}

function StageDetail({ a, s, sev }: { a: Analysis; s: StageStats; sev?: Severity }) {
  const rec = a.run.stages.find((x) => x.key === s.key)!;
  const ok = rec.tasks.filter((x) => x.status === 'success');
  const findings = a.findings.filter((f) => f.stageKeys.includes(s.key));
  const slowest = [...ok].sort((x, y) => y.duration - x.duration).slice(0, 10);
  const sqlx = a.sql.find((x) => x.id === s.sqlId);
  return (
    <div className="stack">
      <div className="view-head">
        <h2>
          <span className={`dot-sev ${sev ?? ''}`} />
          Stage {s.id}
          {s.attempt ? ` (attempt ${s.attempt})` : ''}
          {s.table && <span className="chip mono">{displayTable(s.table)}</span>}
          <span className="chip">{s.kind}</span>
          {s.status === 'failed' && <span className="sev critical">failed</span>}
        </h2>
        <span className="meta">
          {s.name}
          {sqlx ? ` · SQL ${sqlx.id}` : ''} · jobs {s.jobIds.join(', ')}
        </span>
      </div>
      <div className="kpis">
        <Kpi label="Duration" value={fmtDuration(s.duration)} sub={`${fmtNum(s.tasks)} tasks on ${s.executors} executors`} tone={sev === 'critical' ? 'critical' : ''} />
        <Kpi label="Median / max task" value={`${fmtDuration(s.taskDuration.p50)} / ${fmtDuration(s.taskDuration.max)}`} sub={`ratio ${fmtRatio(s.skewRatio)}`} tone={s.skewRatio >= 5 ? 'critical' : ''} />
        <Kpi label="Data in" value={fmtBytes(s.inputBytes + s.shuffleRead)} sub={s.inputBytes ? 'from storage' : 'from shuffle'} />
        <Kpi label="Shuffle write" value={fmtBytes(s.shuffleWrite)} sub={s.outputBytes ? `output ${fmtBytes(s.outputBytes)}` : undefined} />
        <Kpi label="Disk spill" value={fmtBytes(s.diskSpill)} sub={`memory ${fmtBytes(s.memSpill)}`} tone={s.diskSpill ? 'warning' : 'good'} />
        <Kpi label="GC" value={fmtPct(s.gcRatio)} sub={fmtDuration(s.gcTime)} tone={s.gcRatio >= 0.1 ? 'warning' : ''} />
      </div>
      {s.failureReason && <div className="error-box">{s.failureReason}</div>}
      {findings.length > 0 && (
        <div className="findings">
          {findings.map((f) => (
            <FindingCard key={f.id} f={f} a={a} />
          ))}
        </div>
      )}
      {ok.length > 0 && (
        <>
          <div className="grid-2">
            <Card title="Task duration distribution" hint="Log scale. Red bins are more than 4× the median: the stragglers.">
              <Histogram tasks={ok} median={s.taskDuration.p50} />
            </Card>
            <Card title={`Duration vs ${s.shuffleRead ? 'shuffle read' : 'input'} per task`} hint="Points far to the right and top read much more data than the rest: classic skew.">
              <Scatter tasks={ok} s={s} />
            </Card>
          </div>
          <Card title="Tasks on executors" hint="One lane per concurrently running task. Long red bars are stragglers that keep the stage open.">
            <TaskTimeline tasks={rec.tasks} median={s.taskDuration.p50} start={s.start} />
          </Card>
          <div className="grid-2">
            <Card title="Task metrics" hint="Same summary as the Spark UI. The max column turns red when it is 5× the median or more.">
              <Percentiles tasks={ok} />
            </Card>
            <Card title="Slowest tasks">
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Executor</th>
                      <th className="num">Duration</th>
                      <th className="num">GC</th>
                      <th className="num">Data in</th>
                      <th className="num">Spill</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slowest.map((x) => (
                      <tr key={x.taskId}>
                        <td>{x.index}</td>
                        <td>{x.executorId}</td>
                        <td className="num">{fmtDuration(x.duration)}</td>
                        <td className="num">{fmtDuration(x.gcTime)}</td>
                        <td className="num">{fmtBytes(x.inputBytes + x.shuffleReadBytes)}</td>
                        <td className="num">{x.diskSpill ? fmtBytes(x.diskSpill) : '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

export default function Stages({ a, selected, onSelect }: { a: Analysis; selected: string | null; onSelect: (k: string) => void }) {
  const sev = useMemo(() => severityIndex(a.findings).stage, [a]);
  const current = a.stages.find((s) => s.key === selected) ?? [...a.stages].filter((s) => s.status !== 'skipped').sort((x, y) => y.duration - x.duration)[0];
  return (
    <div className="stack">
      <Card title={`Stages (${a.stages.filter((s) => s.status !== 'skipped').length})`} hint={`Click a stage to inspect its tasks. ${a.summary.skippedStages ? `${a.summary.skippedStages} skipped stages hidden.` : ''}`}>
        <StageTable a={a} selected={current?.key ?? null} onSelect={onSelect} sev={sev} />
      </Card>
      {current && <StageDetail key={current.key} a={a} s={current} sev={sev.get(current.key)} />}
    </div>
  );
}
