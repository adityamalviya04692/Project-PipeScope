/// <reference lib="webworker" />
import { readEventLog } from './readLog';

interface Request {
  id: number;
  file: Blob;
  name: string;
}

self.onmessage = async (e: MessageEvent<Request>) => {
  const { id, file, name } = e.data;
  let last = -1;
  try {
    const run = await readEventLog(file, name, (p) => {
      const pct = Math.floor(p * 100);
      if (pct !== last) {
        last = pct;
        self.postMessage({ id, type: 'progress', value: p });
      }
    });
    self.postMessage({ id, type: 'done', run });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
