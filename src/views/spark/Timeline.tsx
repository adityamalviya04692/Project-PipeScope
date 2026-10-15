import { useMemo } from 'react';
import EChart, { axisStyle, echarts, tooltipStyle, useOption } from '../../components/EChart';
import { Card } from '../../components/ui';
import { fmtBytes, fmtDuration, fmtNum, fmtRatio } from '../../lib/format';
import type { Analysis } from '../../spark/analyze';
import { severityIndex } from '../../spark/rules';
import { ConcurrencyChart, fmtClock, sevColor } from './Overview';

interface Row {
  label: string;
  kind: 'sql' | 'stage';
  start: number;
  end: number;
  stageKey?: string;
  sqlId?: number;
  detail: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Api = any;

export default function Timeline({ a, onOpenStage }: { a: Analysis; onOpenStage: (key: string) => void }) {
  const sev = useMemo(() => severityIndex(a.findings), [a]);
  const rows = useMemo(() => {
    const out: Row[] = [];
    const ran = a.stages.filter((s) => s.status !== 'skipped' && s.end > s.start);
    for (const q of [...a.sql].sort((x, y) => x.start - y.start)) {
      out.push({ label: q.label, kind: 'sql', start: q.start, end: q.end, sqlId: q.id, detail: `${q.stageKeys.length} stages · task time ${fmtDuration(q.taskTime)}` });
      for (const s of ran.filter((x) => x.sqlId === q.id).sort((x, y) => x.start - y.start)) {
        out.push({ label: `  Stage ${s.id}${s.attempt ? `.${s.attempt}` : ''} · ${s.kind}`, kind: 'stage', start: s.start, end: s.end, stageKey: s.key, detail: `${fmtNum(s.tasks)} tasks · max/median ${fmtRatio(s.skewRatio)} · ${fmtBytes(s.inputBytes + s.shuffleRead)} in` });
      }
    }
    const orphans = ran.filter((s) => s.sqlId == null);
    if (orphans.length) {
      out.push({ label: 'Non-SQL jobs', kind: 'sql', start: Math.min(...orphans.map((s) => s.start)), end: Math.max(...orphans.map((s) => s.end)), detail: `${orphans.length} stages` });
      for (const s of orphans) out.push({ label: `  Stage ${s.id}`, kind: 'stage', start: s.start, end: s.end, stageKey: s.key, detail: `${fmtNum(s.tasks)} tasks` });
    }
    return out;
  }, [a]);

  const option = useOption(
    (t) => {
      const t0 = a.summary.start;
      return {
        textStyle: { fontFamily: 'inherit' },
        grid: { left: 8, right: 20, top: 8, bottom: 44, containLabel: true },
        tooltip: {
          trigger: 'item',
          ...tooltipStyle(t),
          formatter: (p: { dataIndex: number }) => {
            const r = rows[p.dataIndex];
            return `<b>${r.label.trim()}</b><br/>${fmtClock((r.start - t0) / 1000)} → ${fmtClock((r.end - t0) / 1000)} (${fmtDuration(r.end - r.start)})<br/>${r.detail}`;
          },
        },
        dataZoom: [
          { type: 'inside', xAxisIndex: 0, filterMode: 'weakFilter' },
          { type: 'slider', xAxisIndex: 0, height: 16, bottom: 8, filterMode: 'weakFilter', borderColor: t.border, textStyle: { color: t.muted } },
        ],
        xAxis: { type: 'value', min: 0, max: a.summary.duration / 1000, position: 'top', ...axisStyle(t), axisLabel: { color: t.muted, formatter: (v: number) => fmtClock(v) } },
        yAxis: {
          type: 'category',
          inverse: true,
          data: rows.map((r) => r.label),
          ...axisStyle(t),
          splitLine: { show: false },
          axisLabel: {
            color: t.muted,
            fontSize: 11,
            formatter: (v: string, i: number) => (rows[i]?.kind === 'sql' ? `{b|${v}}` : v),
            rich: { b: { fontWeight: 'bold', color: t.text, fontSize: 12 } },
          },
        },
        series: [
          {
            type: 'custom',
            encode: { x: [1, 2], y: 0 },
            data: rows.map((r, i) => ({
              value: [i, (r.start - t0) / 1000, (r.end - t0) / 1000],
              itemStyle: { color: r.kind === 'sql' ? t.surface2 : sevColor(t, r.stageKey ? sev.stage.get(r.stageKey) : undefined) },
            })),
            renderItem: (params: Api, api: Api) => {
              const row = api.value(0);
              const start = api.coord([api.value(1), row]);
              const end = api.coord([api.value(2), row]);
              const isSql = rows[row].kind === 'sql';
              const h = api.size([0, 1])[1] * (isSql ? 0.75 : 0.55);
              const rect = echarts.graphic.clipRectByRect(
                { x: start[0], y: start[1] - h / 2, width: Math.max(2, end[0] - start[0]), height: h },
                { x: params.coordSys.x, y: params.coordSys.y, width: params.coordSys.width, height: params.coordSys.height },
              );
              return rect && { type: 'rect', shape: { ...rect, r: 3 }, style: { fill: api.visual('color'), stroke: isSql ? t.border : undefined } };
            },
          },
        ],
      };
    },
    [a, rows, sev],
  );

  return (
    <div className="stack">
      <Card title="Execution timeline" hint="Each SQL statement and its stages over the life of the app. Stage bars are coloured by their worst finding; scroll or drag the slider to zoom, click a stage to inspect it.">
        <EChart option={option} height={Math.max(260, rows.length * 22 + 70)} onClick={(p) => rows[p.dataIndex]?.stageKey && onOpenStage(rows[p.dataIndex].stageKey!)} />
      </Card>
      <Card title="Cores in use vs available" hint="Long flat stretches near 1 task usually mean a straggler or a single-partition stage.">
        <ConcurrencyChart a={a} height={240} />
      </Card>
    </div>
  );
}
