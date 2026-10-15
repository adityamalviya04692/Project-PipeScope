import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, CustomChart, LineChart, ScatterChart } from 'echarts/charts';
import { DataZoomComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

echarts.use([BarChart, CustomChart, LineChart, ScatterChart, DataZoomComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent, CanvasRenderer]);

export { echarts };
export type Option = EChartsCoreOption;

export interface Theme {
  accent: string;
  accentSoft: string;
  text: string;
  muted: string;
  border: string;
  surface: string;
  surface2: string;
  critical: string;
  warning: string;
  info: string;
  good: string;
  palette: string[];
}

export function readTheme(): Theme {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => s.getPropertyValue(n).trim();
  return {
    accent: v('--accent'),
    accentSoft: v('--accent-soft'),
    text: v('--text'),
    muted: v('--text-muted'),
    border: v('--border'),
    surface: v('--surface'),
    surface2: v('--surface-2'),
    critical: v('--critical'),
    warning: v('--warning'),
    info: v('--info'),
    good: v('--good'),
    palette: [1, 2, 3, 4, 5, 6, 7].map((i) => v(`--c${i}`)),
  };
}

export function useColorScheme(): string {
  const [scheme, setScheme] = useState(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setScheme(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return scheme;
}

/** Build an option from the current theme; rebuilt when deps or the colour scheme change. */
export function useOption(build: (t: Theme) => Option, deps: unknown[]): Option {
  const scheme = useColorScheme();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => build(readTheme()), [...deps, scheme]);
}

export const tooltipStyle = (t: Theme) => ({ backgroundColor: t.surface, borderColor: t.border, textStyle: { color: t.text, fontSize: 12 }, extraCssText: 'box-shadow: 0 6px 18px rgba(0,0,0,.12); border-radius: 8px;' });

export const axisStyle = (t: Theme) => ({
  axisLine: { lineStyle: { color: t.border } },
  axisTick: { show: false },
  axisLabel: { color: t.muted, hideOverlap: true, fontSize: 11 },
  splitLine: { lineStyle: { color: t.border, type: 'dashed' as const } },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (params: any) => void;

export default function EChart({ option, height = 280, onClick }: { option: Option; height?: number; onClick?: Handler }) {
  const el = useRef<HTMLDivElement>(null);
  const click = useRef<Handler | undefined>(onClick);
  click.current = onClick;
  useEffect(() => {
    if (!el.current) return;
    const chart = echarts.init(el.current, undefined, { renderer: 'canvas' });
    chart.setOption(option);
    chart.on('click', (p) => click.current?.(p));
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [option]);
  return <div className="chart-shell" ref={el} style={{ width: '100%', height, cursor: onClick ? 'pointer' : undefined }} />;
}
