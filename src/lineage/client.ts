import type { LineageInput, LineageResult, SqlFile } from './types';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; onStatus?: (m: string) => void }>();

function ensure(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data as { id: number; type: string; message?: string; result?: unknown };
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === 'status') return p.onStatus?.(m.message ?? '');
    pending.delete(m.id);
    if (m.type === 'done') p.resolve(m.result);
    else p.reject(new Error(m.message ?? 'Lineage engine failed'));
  };
  return worker;
}

const indexURL = () => new URL(`${import.meta.env.BASE_URL}pyodide/`, document.baseURI).href;

function call<T>(type: 'init' | 'analyze', payload?: unknown, onStatus?: (m: string) => void): Promise<T> {
  const w = ensure();
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onStatus });
    w.postMessage({ id, type, indexURL: indexURL(), payload });
  });
}

/** Start Python early so the first analysis is fast. Safe to call more than once. */
export function warmUpLineage(onStatus?: (m: string) => void): Promise<unknown> {
  return call('init', undefined, onStatus);
}

export function analyzeLineage(input: LineageInput, onStatus?: (m: string) => void): Promise<LineageResult> {
  return call<LineageResult>('analyze', input, onStatus);
}

export async function loadSampleSql(): Promise<SqlFile[]> {
  const base = `${import.meta.env.BASE_URL}sample/sql/`;
  const names = (await (await fetch(`${base}index.json`)).json()) as string[];
  return Promise.all(names.map(async (name) => ({ name, sql: await (await fetch(`${base}${name}`)).text() })));
}

export const DIALECTS = [
  { id: 'databricks', label: 'Databricks' },
  { id: 'spark', label: 'Spark SQL' },
  { id: 'snowflake', label: 'Snowflake' },
  { id: 'bigquery', label: 'BigQuery' },
  { id: 'postgres', label: 'PostgreSQL' },
  { id: 'redshift', label: 'Redshift' },
  { id: 'tsql', label: 'SQL Server / Fabric' },
  { id: 'duckdb', label: 'DuckDB' },
  { id: 'trino', label: 'Trino / Athena' },
  { id: 'mysql', label: 'MySQL' },
] as const;
