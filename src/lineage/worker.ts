/// <reference lib="webworker" />
// Runs the Python lineage engine (sqlglot) inside Pyodide, off the main thread.
import type { PyodideInterface } from 'pyodide';
import engineSource from '../python/pipescope_lineage.py?raw';

interface Request {
  id: number;
  type: 'init' | 'analyze';
  indexURL: string;
  payload?: unknown;
}

let booting: Promise<PyodideInterface> | null = null;
const status = (id: number, message: string) => self.postMessage({ id, type: 'status', message });

async function boot(id: number, indexURL: string): Promise<PyodideInterface> {
  status(id, 'Starting Python (Pyodide)…');
  const { loadPyodide } = await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`);
  const py: PyodideInterface = await loadPyodide({ indexURL });
  status(id, 'Installing sqlglot…');
  const meta = (await (await fetch(`${indexURL}sqlglot.json`)).json()) as { wheel: string; version: string };
  const wheel = await (await fetch(`${indexURL}${meta.wheel}`)).arrayBuffer();
  py.unpackArchive(wheel, 'wheel', { extractDir: '/home/pyodide/vendor' });
  py.FS.writeFile('/home/pyodide/pipescope_lineage.py', engineSource);
  await py.runPythonAsync('import sys\nsys.path[:0] = ["/home/pyodide", "/home/pyodide/vendor"]\nimport pipescope_lineage');
  return py;
}

self.onmessage = async (e: MessageEvent<Request>) => {
  const { id, type, indexURL, payload } = e.data;
  try {
    booting ??= boot(id, indexURL);
    const py = await booting;
    if (type === 'init') {
      self.postMessage({ id, type: 'done', result: { ready: true } });
      return;
    }
    status(id, 'Tracing column lineage…');
    const analyze = py.runPython('pipescope_lineage.analyze_json') as ((s: string) => string) & { destroy?: () => void };
    const out = analyze(JSON.stringify(payload));
    analyze.destroy?.();
    self.postMessage({ id, type: 'done', result: JSON.parse(out) });
  } catch (err) {
    if (type === 'init') booting = null; // allow a retry if the runtime failed to load
    self.postMessage({ id, type: 'error', message: err instanceof Error ? err.message.split('\n').slice(-3).join('\n') : String(err) });
  }
};
