import { describe, expect, it } from 'vitest';
import { analyzeRun, concurrency, dist, grade } from './analyze';
import { compareRuns, improved } from './compare';
import { parseEventLogText } from './parser';
import { displayTable, normalizeTable, planOperators, planTables, planTree } from './plan';
import { readEventLog } from './readLog';
import { scoreFindings, type Finding } from './rules';
import { GB, LogBuilder, MB, tasks } from './testkit';

const SMJ_PLAN = `== Physical Plan ==
AdaptiveSparkPlan isFinalPlan=false
+- Execute InsertIntoHadoopFsRelationCommand abfss://lake@acct.dfs.core.windows.net/gold/fct_order_items, false, Parquet, [path=abfss://lake@acct.dfs.core.windows.net/gold/fct_order_items], Overwrite, \`spark_catalog\`.\`gold\`.\`fct_order_items\`, org.apache.spark.sql.execution.datasources.InMemoryFileIndex, [order_id, product_id]
   +- SortMergeJoin [product_id#12], [product_id#40], Inner
      :- Sort [product_id#12 ASC NULLS FIRST], false, 0
      :  +- Exchange hashpartitioning(product_id#12, 200), ENSURE_REQUIREMENTS, [plan_id=41]
      :     +- FileScan parquet spark_catalog.silver.order_items[order_id#10,product_id#12] Batched: true, Location: InMemoryFileIndex(1 paths)[abfss://lake@acct.dfs.core.windows.net/silver/order_items]
      +- Sort [product_id#40 ASC NULLS FIRST], false, 0
         +- Exchange hashpartitioning(product_id#40, 200), ENSURE_REQUIREMENTS, [plan_id=44]
            +- FileScan parquet spark_catalog.silver.products[product_id#40,category#41] Batched: true

(1) Scan parquet spark_catalog.silver.order_items
Output [2]: [order_id#10, product_id#12]

(5) SortMergeJoin
Left keys [1]: [product_id#12]
`;

describe('event log parser', () => {
  const b = new LogBuilder({ props: { 'spark.sql.adaptive.enabled': 'false' } });
  b.sqlStart(0, 'CREATE OR REPLACE TABLE gold.fct_order_items AS SELECT ...', SMJ_PLAN);
  b.job(0, [
    { id: 0, tasks: tasks(4, { duration: 1000, input: 64 * MB, shuffleWrite: 10 * MB }) },
    { id: 1, parents: [0], tasks: [...tasks(3, { duration: 500, shuffleRead: 4 * MB }), { duration: 900, failed: 'ExecutorLostFailure' }] },
  ], 0);
  b.sqlEnd(0);
  const text = b.text().replace('\n', '\n{not json\n') + JSON.stringify({ Event: 'SomeVendorEvent' }) + '\n';
  const run = parseEventLogText(text, 'test.log');

  it('reads app metadata, properties and executors', () => {
    expect(run.sparkVersion).toBe('3.5.1');
    expect(run.appName).toBe('test_app');
    expect(run.properties['spark.sql.adaptive.enabled']).toBe('false');
    expect(run.executors.map((e) => [e.id, e.cores])).toEqual([['1', 4], ['2', 4]]);
  });

  it('links stages to jobs and jobs to SQL executions', () => {
    expect(run.stages.map((s) => [s.key, s.status, s.jobIds])).toEqual([['0.0', 'complete', [0]], ['1.0', 'complete', [0]]]);
    expect(run.stages[1].parentIds).toEqual([0]);
    expect(run.sql[0].jobIds).toEqual([0]);
    expect(run.jobs[0]).toMatchObject({ sqlExecutionId: 0, result: 'succeeded' });
  });

  it('converts task metrics and failure reasons', () => {
    const t = run.stages[1].tasks[0];
    expect(t.shuffleReadBytes).toBe(4 * MB); // remote + local
    expect(t.cpuTime).toBe(490); // ns -> ms
    expect(t.schedulerDelay).toBe(2); // 500 - 495 run - 2 deser - 1 ser
    const failed = run.stages[1].tasks.find((x) => x.status === 'failed')!;
    expect(failed.failReason).toBe('ExecutorLostFailure: Container killed by YARN for exceeding memory limits');
  });

  it('counts bad lines and unknown events without failing', () => {
    expect(run.parseErrors).toBe(1);
    expect(run.unknownEvents).toEqual({ SomeVendorEvent: 1 });
  });

  it('marks stages that were announced but never ran as skipped', () => {
    const r = parseEventLogText(
      [
        { Event: 'SparkListenerJobStart', 'Job ID': 3, 'Submission Time': 1, 'Stage Infos': [{ 'Stage ID': 7, 'Stage Attempt ID': 0, 'Stage Name': 'x', 'Number of Tasks': 200, 'Parent IDs': [] }], 'Stage IDs': [7], Properties: {} },
      ].map((e) => JSON.stringify(e)).join('\n'),
    );
    expect(r.stages[0]).toMatchObject({ key: '7.0', status: 'skipped', jobIds: [3] });
  });

  it('keeps the final plan from AQE updates', () => {
    const r = parseEventLogText(
      [
        { Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart', executionId: 1, description: 'q', physicalPlanDescription: 'initial', time: 5 },
        { Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLAdaptiveExecutionUpdate', executionId: 1, physicalPlanDescription: 'final' },
      ].map((e) => JSON.stringify(e)).join('\n'),
    );
    expect(r.sql[0].plan).toBe('final');
  });
});

describe('streaming reader', () => {
  const text = new LogBuilder().text();

  it('reads plain and gzip logs and reports progress', async () => {
    const seen: number[] = [];
    const plain = await readEventLog(new Blob([text]), 'app.log', (f) => seen.push(f));
    const gzipped = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
    const gz = await readEventLog(gzipped, 'app.log.gz');
    expect(plain.appName).toBe('test_app');
    expect(gz.eventCount).toBe(plain.eventCount);
    expect(seen.at(-1)).toBe(1);
  });

  it('explains unsupported codecs and non-log files', async () => {
    await expect(readEventLog(new Blob([text]), 'app.lz4')).rejects.toThrow(/lz4/);
    await expect(readEventLog(new Blob(['hello\nworld']), 'notes.txt')).rejects.toThrow(/does not look like a Spark event log/);
  });
});

describe('physical plan helpers', () => {
  it('normalises table names to db.table', () => {
    expect(normalizeTable('`spark_catalog`.`Gold`.`Fct`')).toBe('gold.fct');
    expect(normalizeTable('hive_metastore.silver.orders')).toBe('silver.orders');
    expect(normalizeTable('orders')).toBe('default.orders');
    expect(displayTable('default.orders')).toBe('orders');
  });

  it('finds the tables a query reads and writes', () => {
    expect(planTables(SMJ_PLAN)).toEqual({ reads: ['silver.order_items', 'silver.products'], writes: ['gold.fct_order_items'] });
    expect(planTables('AtomicReplaceTableAsSelect spark_catalog.gold.t, ...\n+- BatchScan spark_catalog.silver.s[a#1]')).toEqual({ reads: ['silver.s'], writes: ['gold.t'] });
    expect(planTables('+- FileScan parquet [a#1] Location: TahoeLogFileIndex(1 paths)[abfss://x@y/bronze/raw_orders]', 'INSERT OVERWRITE TABLE silver.orders SELECT')).toEqual({
      reads: ['bronze.raw_orders'],
      writes: ['silver.orders'],
    });
  });

  it('counts operators in the tree only, not the detail sections', () => {
    expect(planTree(SMJ_PLAN)).not.toContain('(1) Scan');
    expect(planOperators(SMJ_PLAN)).toEqual({ SortMergeJoin: 1, 'Exchange hashpartitioning': 2, AdaptiveSparkPlan: 1 });
  });
});

describe('statistics', () => {
  it('computes percentiles', () => {
    const d = dist([5, 1, 3, 2, 4]);
    expect([d.min, d.p25, d.p50, d.p75, d.max, d.mean]).toEqual([1, 2, 3, 4, 5, 3]);
    expect(dist([]).count).toBe(0);
  });

  it('integrates running tasks and cores over time', () => {
    const b = new LogBuilder({ executors: 1, cores: 2 });
    b.job(0, [{ id: 0, slots: 2, tasks: tasks(2, { duration: 10_000 }) }]);
    const run = parseEventLogText(b.text());
    const c = concurrency(run, run.start!, run.end!, 10);
    expect(c.running.every((v) => v === 2)).toBe(true);
    expect(c.cores.every((v) => v === 2)).toBe(true);
  });
});

/** A one-stage app whose findings we can assert on. */
function analyzeStage(spec: Parameters<LogBuilder['job']>[1][number], opts: ConstructorParameters<typeof LogBuilder>[0] = {}, plan = '') {
  const b = new LogBuilder(opts);
  if (plan) b.sqlStart(0, 'q', plan);
  b.job(0, [spec], plan ? 0 : undefined);
  if (plan) b.sqlEnd(0);
  return analyzeRun(parseEventLogText(b.text()));
}
const rulesOf = (fs: Finding[]) => fs.map((f) => f.rule);

describe('diagnosis rules', () => {
  it('detects skew and estimates the time lost', () => {
    const a = analyzeStage({ id: 0, tasks: tasks(20, (i) => (i === 7 ? { duration: 200_000, shuffleRead: 4 * GB } : { duration: 5_000, shuffleRead: 40 * MB })) });
    const f = a.findings.find((x) => x.rule === 'skew')!;
    expect(f.severity).toBe('critical');
    expect(f.impactMs).toBe(195_000);
    expect(f.summary).toContain('more shuffle data');
    expect(a.stages[0].skewRatio).toBe(40);
  });

  it('flags small files on scans and tiny tasks on shuffles', () => {
    expect(rulesOf(analyzeStage({ id: 0, tasks: tasks(300, { duration: 200, input: 2 * MB }) }).findings)).toContain('small-files');
    const tiny = analyzeStage({ id: 0, tasks: tasks(200, { duration: 60, shuffleRead: 100_000 }) }).findings;
    expect(rulesOf(tiny)).toContain('tiny-tasks');
    expect(rulesOf(tiny)).not.toContain('small-files');
  });

  it('flags spill and GC pressure by severity', () => {
    const a = analyzeStage({ id: 0, tasks: tasks(16, { duration: 20_000, shuffleRead: GB, diskSpill: 400 * MB, gc: 6_000 }) });
    expect(a.findings.find((f) => f.rule === 'spill')?.severity).toBe('critical');
    expect(a.findings.find((f) => f.rule === 'gc')?.severity).toBe('critical');
  });

  it('flags a single-partition bottleneck', () => {
    const a = analyzeStage({ id: 0, tasks: [{ duration: 90_000, shuffleRead: GB }] });
    expect(a.findings.find((f) => f.rule === 'single-partition')?.impactMs).toBe(90_000);
  });

  it('flags low cluster utilisation on long runs', () => {
    const a = analyzeStage({ id: 0, slots: 2, tasks: tasks(4, { duration: 200_000 }) }, { executors: 4, cores: 8 });
    const f = a.findings.find((x) => x.rule === 'low-utilization')!;
    expect(a.summary.utilization).toBeCloseTo(2 / 32, 2);
    expect(f.severity).toBe('critical');
  });

  it('reports failed task attempts with their reasons', () => {
    const a = analyzeStage({ id: 0, tasks: [...tasks(3, { duration: 1000 }), { duration: 500, failed: 'ExecutorLostFailure' }] });
    const f = a.findings.find((x) => x.rule === 'task-failures')!;
    expect(f.evidence).toContainEqual({ label: 'ExecutorLostFailure', value: '1' });
    expect(f.fix.steps[0]).toMatch(/memoryOverhead/);
  });

  it('audits configuration against the plan', () => {
    const a = analyzeStage(
      { id: 0, tasks: tasks(4, { duration: 1000 }) },
      { props: { 'spark.sql.adaptive.enabled': 'false', 'spark.sql.autoBroadcastJoinThreshold': '-1' } },
      SMJ_PLAN,
    );
    expect(rulesOf(a.findings)).toEqual(expect.arrayContaining(['aqe-disabled', 'broadcast-disabled', 'serializer']));
    const ok = analyzeStage({ id: 0, tasks: tasks(4, { duration: 1000 }) }, { props: { 'spark.serializer': 'org.apache.spark.serializer.KryoSerializer' } });
    expect(ok.findings).toEqual([]);
    expect(ok.score).toBe(100);
  });

  it('suggests broadcasting a tiny join side', () => {
    const b = new LogBuilder({ props: { 'spark.serializer': 'Kryo' } });
    b.sqlStart(0, 'q', SMJ_PLAN);
    b.job(0, [
      { id: 0, tasks: tasks(8, { duration: 2000, input: GB, shuffleWrite: 2 * GB / 8 }) },
      { id: 1, tasks: tasks(2, { duration: 300, input: 4 * MB, shuffleWrite: 2 * MB }) },
      { id: 2, parents: [0, 1], tasks: tasks(8, { duration: 3000, shuffleRead: 2 * GB / 8 }) },
    ], 0);
    b.sqlEnd(0);
    const a = analyzeRun(parseEventLogText(b.text()));
    const f = a.findings.find((x) => x.rule === 'broadcast-candidate')!;
    expect(f.stageKeys).toEqual(['1.0']);
    expect(a.sql[0]).toMatchObject({ label: 'gold.fct_order_items', reads: ['silver.order_items', 'silver.products'] });
    expect(a.stages.every((s) => s.table === 'gold.fct_order_items')).toBe(true);
  });
});

describe('scoring and comparison', () => {
  const f = (rule: Finding['rule'], severity: Finding['severity']): Finding => ({ id: rule + severity, rule, severity, title: rule, summary: '', stageKeys: [], sqlIds: [], evidence: [], fix: { steps: [] } });

  it('caps the penalty per rule', () => {
    expect(scoreFindings([f('skew', 'critical'), f('skew', 'critical'), f('skew', 'critical')])).toBe(70);
    expect(scoreFindings([f('skew', 'critical'), f('gc', 'warning'), f('serializer', 'info')])).toBe(77);
    expect([95, 80, 65, 45, 10].map(grade)).toEqual(['A', 'B', 'C', 'D', 'F']);
  });

  it('compares a slow run with a tuned one', () => {
    const before = analyzeStage({ id: 0, tasks: tasks(20, (i) => ({ duration: i === 0 ? 200_000 : 5_000, shuffleRead: 40 * MB })) });
    const after = analyzeStage({ id: 0, tasks: tasks(20, { duration: 6_000, shuffleRead: 40 * MB }) });
    const cmp = compareRuns(before, after);
    const wall = cmp.metrics.find((m) => m.label === 'Wall-clock time')!;
    expect(improved(wall)).toBe(true);
    expect(cmp.resolved.map((r) => r.rule)).toContain('skew');
    expect(cmp.introduced).toEqual([]);
  });
});
