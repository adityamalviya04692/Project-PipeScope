import type { SparkRun } from './types';

let worker: Worker | null = null;
let seq = 0;

/** Parse an event log in a Web Worker so the UI stays responsive on large logs. */
export function parseInWorker(file: Blob, name: string, onProgress?: (p: number) => void): Promise<SparkRun> {
  worker ??= new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const w = worker;
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { id: number; type: string; value?: number; run?: SparkRun; message?: string };
      if (m.id !== id) return;
      if (m.type === 'progress') {
        onProgress?.(m.value ?? 0);
        return;
      }
      w.removeEventListener('message', onMessage);
      if (m.type === 'done' && m.run) resolve(m.run);
      else reject(new Error(m.message ?? 'Failed to read the event log'));
    };
    w.addEventListener('message', onMessage);
    w.postMessage({ id, file, name });
  });
}

export const SAMPLE_RUNS = ['before', 'after'] as const;

export async function fetchSample(path: string): Promise<Blob> {
  const res = await fetch(`${import.meta.env.BASE_URL}sample/${path}`);
  if (!res.ok) throw new Error(`Could not load sample ${path} (${res.status})`);
  return res.blob();
}
