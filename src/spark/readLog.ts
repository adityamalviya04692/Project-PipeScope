import { createEventLogParser } from './parser';
import type { SparkRun } from './types';

const UNSUPPORTED = /\.(lz4|lzf|snappy|zstd|zst)$/i;

/**
 * Stream an event log (plain JSON lines, or gzip) through the parser without
 * ever holding the decompressed text in memory, so large logs stay usable.
 */
export async function readEventLog(source: Blob, fileName: string, onProgress?: (fraction: number) => void): Promise<SparkRun> {
  if (UNSUPPORTED.test(fileName)) {
    throw new Error(
      `${fileName} uses lz4/snappy/zstd compression, which browsers can't decompress yet. Decompress it first, or produce a plain or gzip log (spark.eventLog.compress=false).`,
    );
  }
  const head = new Uint8Array(await source.slice(0, 2).arrayBuffer());
  const gzip = head[0] === 0x1f && head[1] === 0x8b;

  const total = source.size;
  let read = 0;
  const counting = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      read += chunk.byteLength;
      onProgress?.(total ? read / total : 0);
      ctl.enqueue(chunk);
    },
  });

  let bytes: ReadableStream<Uint8Array> = source.stream().pipeThrough(counting);
  if (gzip) bytes = bytes.pipeThrough(new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>);
  const reader = bytes.pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>).getReader();

  const parser = createEventLogParser(fileName);
  let carry = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const lines = (carry + value).split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) parser.push(line);
  }
  if (carry) parser.push(carry);
  const run = parser.finish();
  if (run.eventCount === 0) throw new Error(`${fileName} does not look like a Spark event log (no JSON events found).`);
  return run;
}
