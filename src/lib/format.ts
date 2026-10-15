const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '–';
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const s = i === 0 || v >= 100 ? Math.round(v).toString() : v.toFixed(1);
  return `${n < 0 ? '-' : ''}${s} ${UNITS[i]}`;
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '–';
  const sign = ms < 0 ? '-' : '';
  const a = Math.abs(ms);
  if (a < 1000) return `${sign}${Math.round(a)} ms`;
  const s = a / 1000;
  if (s < 60) return `${sign}${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${sign}${m}m ${Math.floor(s % 60)}s`;
  return `${sign}${Math.floor(m / 60)}h ${m % 60}m`;
}

export const fmtPct = (x: number, digits = 0) => (Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : '–');
export const fmtNum = (n: number) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '–');
export const fmtRatio = (x: number) => (Number.isFinite(x) ? `${x.toFixed(x < 10 ? 1 : 0)}×` : '–');
export const fmtTime = (epochMs: number) => new Date(epochMs).toISOString().slice(11, 19);
export const fmtDateTime = (epochMs: number) => new Date(epochMs).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
