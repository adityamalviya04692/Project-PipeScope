import { describe, expect, it } from 'vitest';
import { buildIndex } from '../lineage/graph';
import { fixture } from '../lineage/fixture';
import { analyzeRun } from '../spark/analyze';
import { parseEventLogText } from '../spark/parser';
import { LogBuilder, tasks } from '../spark/testkit';
import { blockedDownstream, coverage, criticalPath, runsByTable } from './overlay';

const write = (t: string) => `== Physical Plan ==\nExecute AtomicReplaceTableAsSelect spark_catalog.${t}, [provider=delta], true\n+- FileScan parquet spark_catalog.x.y[a#1] Batched: true`;

function run() {
  const b = new LogBuilder({ props: { 'spark.serializer': 'Kryo' } });
  const steps: [string, number][] = [
    ['silver.orders', 20_000],
    ['silver.orphan', 5_000],
    ['gold.fct', 60_000],
    ['gold.unknown_table', 1_000],
  ];
  steps.forEach(([t, ms], i) => {
    b.sqlStart(i, `CREATE OR REPLACE TABLE ${t} AS SELECT 1`, write(t));
    b.job(i, [{ id: i, slots: 4, tasks: tasks(4, { duration: ms }) }], i);
    b.sqlEnd(i);
  });
  return analyzeRun(parseEventLogText(b.text()));
}

describe('pipeline overlay', () => {
  const a = run();
  const ix = buildIndex(fixture());
  const runs = runsByTable(a);

  it('maps each Spark statement to the table it builds', () => {
    expect([...runs.keys()]).toEqual(['silver.orders', 'silver.orphan', 'gold.fct', 'gold.unknown_table']);
    expect(runs.get('gold.fct')!.durationMs).toBeGreaterThanOrEqual(60_000);
    expect(runs.get('gold.fct')!.share).toBeGreaterThan(0.6);
  });

  it('reports which models matched the run', () => {
    expect(coverage(ix, runs)).toEqual({ matched: ['silver.orders', 'silver.orphan', 'gold.fct'], runOnly: ['gold.unknown_table'], modelOnly: [] });
  });

  it('finds the critical path through dependent builds', () => {
    const cp = criticalPath(ix, runs);
    expect(cp.path).toEqual(['silver.orders', 'gold.fct']);
    expect(cp.totalMs).toBe(runs.get('silver.orders')!.durationMs + runs.get('gold.fct')!.durationMs);
    expect(blockedDownstream(ix, 'silver.orders')).toBe(2);
  });
});
