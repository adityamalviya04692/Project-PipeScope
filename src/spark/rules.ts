import { fmtBytes, fmtDuration, fmtNum, fmtPct, fmtRatio } from '../lib/format';
import type { AnalysisCore, SqlStats, StageStats } from './analyze';
import { displayTable } from './plan';

export type Severity = 'critical' | 'warning' | 'info';

export type RuleId =
  | 'skew'
  | 'spill'
  | 'gc'
  | 'tiny-tasks'
  | 'small-files'
  | 'low-parallelism'
  | 'single-partition'
  | 'low-utilization'
  | 'task-failures'
  | 'stage-failure'
  | 'aqe-disabled'
  | 'broadcast-disabled'
  | 'broadcast-candidate'
  | 'shuffle-partitions'
  | 'python-udf'
  | 'cartesian'
  | 'serializer';

export interface Fix {
  steps: string[];
  code?: string;
  lang?: 'python' | 'sql' | 'properties';
}

export interface Finding {
  id: string;
  rule: RuleId;
  severity: Severity;
  title: string;
  summary: string;
  stageKeys: string[];
  sqlIds: number[];
  evidence: { label: string; value: string }[];
  fix: Fix;
  /** Rough wall-clock time this problem cost, when it can be estimated. */
  impactMs?: number;
}

/** Thresholds are exported so the UI and README can show exactly what each rule checks. */
export const T = {
  skewMinTasks: 10,
  skewRatio: 5,
  skewMinExcessMs: 30_000,
  spillWarnBytes: 100 * 1024 ** 2,
  spillCriticalBytes: 5 * 1024 ** 3,
  gcWarn: 0.1,
  gcCritical: 0.25,
  gcMinRunMs: 60_000,
  tinyTaskMinTasks: 100,
  tinyTaskMedianMs: 300,
  smallFileMinTasks: 200,
  smallFileAvgBytes: 16 * 1024 ** 2,
  lowParallelMinMs: 60_000,
  singlePartitionMinMs: 30_000,
  utilizationWarn: 0.4,
  utilizationCritical: 0.25,
  utilizationMinAppMs: 5 * 60_000,
  broadcastSmallBytes: 10 * 1024 ** 2,
  broadcastBigBytes: 1024 ** 3,
  partitionTargetBytes: 128 * 1024 ** 2,
} as const;

const PENALTY: Record<Severity, number> = { critical: 15, warning: 6, info: 2 };

/** 100 minus penalties, with each rule's total penalty capped at twice its base. */
export function scoreFindings(findings: Finding[]): number {
  const byRule = new Map<RuleId, number>();
  for (const f of findings) {
    const cap = PENALTY[f.severity] * 2;
    byRule.set(f.rule, Math.min(cap, Math.max(byRule.get(f.rule) ?? 0, 0) + PENALTY[f.severity]));
  }
  let penalty = 0;
  for (const v of byRule.values()) penalty += v;
  return Math.max(0, 100 - penalty);
}

export function stageLabel(s: StageStats): string {
  return `Stage ${s.id}${s.attempt ? ` (attempt ${s.attempt})` : ''}${s.table ? ` · ${displayTable(s.table)}` : ''}`;
}

const prop = (c: AnalysisCore, key: string) => c.run.properties[key];
const isTrue = (v: string | undefined) => (v ?? '').toLowerCase() === 'true';
const sparkMajor = (c: AnalysisCore) => Number((c.run.sparkVersion ?? '3').split('.')[0]) || 3;

// ---------------------------------------------------------------- stage rules

function skew(c: AnalysisCore): Finding[] {
  return c.stages
    .filter((s) => s.tasks >= T.skewMinTasks && s.skewRatio >= T.skewRatio && s.taskDuration.max - s.taskDuration.p75 >= T.skewMinExcessMs)
    .map((s) => {
      const impact = s.taskDuration.max - s.taskDuration.p90;
      const share = c.summary.duration ? impact / c.summary.duration : 0;
      const top = s.slowest!;
      const shuffleSkew = s.taskShuffleRead.p50 > 0 ? top.shuffleReadBytes / s.taskShuffleRead.p50 : 0;
      const evidence = [
        { label: 'Slowest task', value: `${fmtDuration(s.taskDuration.max)} (task ${top.index}, executor ${top.executorId})` },
        { label: 'Median task', value: fmtDuration(s.taskDuration.p50) },
        { label: 'Max / median', value: fmtRatio(s.skewRatio) },
      ];
      if (shuffleSkew > 1) evidence.push({ label: 'Its shuffle read', value: `${fmtBytes(top.shuffleReadBytes)} vs median ${fmtBytes(s.taskShuffleRead.p50)} (${fmtRatio(shuffleSkew)})` });
      evidence.push({ label: 'Time lost waiting', value: `~${fmtDuration(impact)} (${fmtPct(share)} of the app)` });
      return {
        id: `skew:${s.key}`,
        rule: 'skew' as const,
        severity: share >= 0.1 || impact >= 5 * 60_000 ? ('critical' as const) : ('warning' as const),
        title: `Data skew in ${stageLabel(s)}`,
        summary: `One task ran ${fmtRatio(s.skewRatio)} longer than the median${shuffleSkew > 2 ? ` because it read ${fmtRatio(shuffleSkew)} more shuffle data` : ''}. The whole stage waited for it while the other cores sat idle.`,
        stageKeys: [s.key],
        sqlIds: s.sqlId != null ? [s.sqlId] : [],
        evidence,
        impactMs: impact,
        fix: {
          steps: [
            'Turn on adaptive execution so Spark splits skewed partitions automatically (Spark 3.0+).',
            'If one join key is "hot", salt it so its rows spread over several partitions.',
            'If the other side of the join is small, broadcast it so no shuffle is needed.',
          ],
          lang: 'python',
          code: `spark.conf.set("spark.sql.adaptive.enabled", "true")
spark.conf.set("spark.sql.adaptive.skewJoin.enabled", "true")

# Salting a hot key across N buckets
from pyspark.sql import functions as F
N = 16
big   = big.withColumn("salt", (F.rand(seed=42) * N).cast("int"))
small = small.withColumn("salt", F.explode(F.sequence(F.lit(0), F.lit(N - 1))))
joined = big.join(small, ["join_key", "salt"]).drop("salt")`,
        },
      };
    });
}

function spill(c: AnalysisCore): Finding[] {
  return c.stages
    .filter((s) => s.diskSpill >= T.spillWarnBytes)
    .map((s) => {
      const top = s.taskDiskSpill.max;
      const concentrated = s.diskSpill > 0 && top / s.diskSpill >= 0.6;
      return {
        id: `spill:${s.key}`,
        rule: 'spill' as const,
        severity: s.diskSpill >= T.spillCriticalBytes ? ('critical' as const) : ('warning' as const),
        title: `${fmtBytes(s.diskSpill)} spilled to disk in ${stageLabel(s)}`,
        summary: concentrated
          ? 'Most of the spill comes from a single task, so this is a side effect of skew: fix the skew first.'
          : 'Tasks ran out of execution memory and wrote intermediate data to disk, which is slow.',
        stageKeys: [s.key],
        sqlIds: s.sqlId != null ? [s.sqlId] : [],
        evidence: [
          { label: 'Disk spill', value: fmtBytes(s.diskSpill) },
          { label: 'Memory spill', value: fmtBytes(s.memSpill) },
          { label: 'Largest single task', value: `${fmtBytes(top)}${concentrated ? ' (most of the total)' : ''}` },
          { label: 'Median task spill', value: fmtBytes(s.taskDiskSpill.p50) },
        ],
        fix: {
          steps: [
            'Give each task less data: more shuffle partitions, or let AQE size them.',
            'Or give each task more memory: fewer cores per executor, or more executor memory.',
            concentrated ? 'Remove the skew that concentrates data in one task.' : 'Check for exploding joins that multiply rows.',
          ],
          lang: 'python',
          code: `spark.conf.set("spark.sql.adaptive.enabled", "true")
spark.conf.set("spark.sql.adaptive.advisoryPartitionSizeInBytes", "128m")
# Without AQE, raise parallelism for this shuffle instead:
spark.conf.set("spark.sql.shuffle.partitions", "800")`,
        },
      };
    });
}

function gc(c: AnalysisCore): Finding[] {
  return c.stages
    .filter((s) => s.gcRatio >= T.gcWarn && s.runTime >= T.gcMinRunMs)
    .map((s) => ({
      id: `gc:${s.key}`,
      rule: 'gc' as const,
      severity: s.gcRatio >= T.gcCritical ? ('critical' as const) : ('warning' as const),
      title: `${fmtPct(s.gcRatio)} of task time spent in garbage collection in ${stageLabel(s)}`,
      summary: 'Executors are under memory pressure, so the JVM keeps pausing to free memory instead of doing work.',
      stageKeys: [s.key],
      sqlIds: s.sqlId != null ? [s.sqlId] : [],
      evidence: [
        { label: 'GC time', value: fmtDuration(s.gcTime) },
        { label: 'Task run time', value: fmtDuration(s.runTime) },
        { label: 'Worst task GC', value: fmtDuration(s.taskGc.max) },
      ],
      fix: {
        steps: [
          'Give each core more memory (fewer cores per executor, or more executor memory).',
          'Use Kryo serialization and avoid caching very wide rows.',
          'Prefer built-in functions to UDFs, which create many short-lived objects.',
        ],
        lang: 'properties',
        code: `spark.executor.memory=16g
spark.executor.cores=4
spark.serializer=org.apache.spark.serializer.KryoSerializer
spark.executor.extraJavaOptions=-XX:+UseG1GC`,
      },
    }));
}

function smallFilesAndTinyTasks(c: AnalysisCore): Finding[] {
  const out: Finding[] = [];
  for (const s of c.stages) {
    if (s.kind === 'scan' && s.tasks >= T.smallFileMinTasks && s.inputBytes / s.tasks < T.smallFileAvgBytes) {
      out.push({
        id: `small-files:${s.key}`,
        rule: 'small-files',
        severity: s.tasks >= 1000 ? 'critical' : 'warning',
        title: `Small files: ${fmtNum(s.tasks)} read tasks of ~${fmtBytes(s.inputBytes / s.tasks)} each in ${stageLabel(s)}`,
        summary: 'The input is split across many tiny files. Each one costs a task, a file open and scheduling overhead, so the read is far slower than the data size suggests.',
        stageKeys: [s.key],
        sqlIds: s.sqlId != null ? [s.sqlId] : [],
        evidence: [
          { label: 'Read tasks', value: fmtNum(s.tasks) },
          { label: 'Total input', value: fmtBytes(s.inputBytes) },
          { label: 'Avg per task', value: fmtBytes(s.inputBytes / s.tasks) },
          { label: 'Median task time', value: fmtDuration(s.taskDuration.p50) },
        ],
        fix: {
          steps: [
            'Compact the source table into fewer, larger files (Delta: OPTIMIZE).',
            'Write fewer files upstream, for example by repartitioning before the write.',
            'Let Spark pack more small files into each read task.',
          ],
          lang: 'python',
          code: `# Delta Lake: compact small files (optionally co-locate by a filter column)
spark.sql("OPTIMIZE bronze.raw_orders ZORDER BY (order_date)")

# Pack more bytes into each read task
spark.conf.set("spark.sql.files.maxPartitionBytes", "256m")`,
        },
      });
    } else if (s.kind !== 'scan' && s.tasks >= T.tinyTaskMinTasks && s.taskDuration.p50 < T.tinyTaskMedianMs) {
      out.push({
        id: `tiny-tasks:${s.key}`,
        rule: 'tiny-tasks',
        severity: 'warning',
        title: `Too many tiny tasks: ${fmtNum(s.tasks)} tasks with a median of ${fmtDuration(s.taskDuration.p50)} in ${stageLabel(s)}`,
        summary: `Only ${fmtBytes(s.shuffleRead || s.inputBytes)} is spread over ${fmtNum(s.tasks)} partitions, so scheduling overhead outweighs the actual work.`,
        stageKeys: [s.key],
        sqlIds: s.sqlId != null ? [s.sqlId] : [],
        evidence: [
          { label: 'Tasks', value: fmtNum(s.tasks) },
          { label: 'Data per task', value: fmtBytes((s.shuffleRead || s.inputBytes) / s.tasks) },
          { label: 'Avg scheduler delay', value: fmtDuration(s.meanSchedulerDelay) },
        ],
        fix: {
          steps: ['Let AQE coalesce small shuffle partitions after each stage.', 'Or lower spark.sql.shuffle.partitions for small jobs.'],
          lang: 'python',
          code: `spark.conf.set("spark.sql.adaptive.enabled", "true")
spark.conf.set("spark.sql.adaptive.coalescePartitions.enabled", "true")`,
        },
      });
    }
  }
  return out;
}

function parallelism(c: AnalysisCore): Finding[] {
  const cores = c.summary.peakCores;
  const out: Finding[] = [];
  for (const s of c.stages) {
    const single = s.tasks === 1 && s.duration >= T.singlePartitionMinMs;
    const sqlx = c.sql.find((x) => x.id === s.sqlId);
    if (single) {
      out.push({
        id: `single-partition:${s.key}`,
        rule: 'single-partition',
        severity: s.duration >= 5 * 60_000 ? 'critical' : 'warning',
        title: `Single-partition bottleneck in ${stageLabel(s)}`,
        summary: `All the data went through one task for ${fmtDuration(s.duration)}${sqlx?.operators['Exchange SinglePartition'] ? ' (the plan has an Exchange SinglePartition, usually a global sort or a window with no PARTITION BY)' : ''}.`,
        stageKeys: [s.key],
        sqlIds: s.sqlId != null ? [s.sqlId] : [],
        evidence: [
          { label: 'Tasks', value: '1' },
          { label: 'Stage time', value: fmtDuration(s.duration) },
          { label: 'Idle cores meanwhile', value: fmtNum(Math.max(0, cores - 1)) },
        ],
        impactMs: s.duration,
        fix: {
          steps: [
            'Add PARTITION BY to window functions, or rank within groups instead of globally.',
            'Avoid a global orderBy on large data unless you really need one sorted file.',
          ],
          lang: 'python',
          code: `from pyspark.sql import Window, functions as F
# Before: Window.orderBy(F.desc("lifetime_value"))  -> one partition
w = Window.partitionBy("segment").orderBy(F.desc("lifetime_value"))
df = df.withColumn("rank_in_segment", F.row_number().over(w))`,
        },
      });
    } else if (cores > 0 && s.tasks > 1 && s.tasks < cores * 0.5 && s.duration >= T.lowParallelMinMs && s.skewRatio < T.skewRatio) {
      out.push({
        id: `low-parallelism:${s.key}`,
        rule: 'low-parallelism',
        severity: 'warning',
        title: `Only ${s.tasks} tasks for ${cores} cores in ${stageLabel(s)}`,
        summary: `Fewer than half the cores had work for ${fmtDuration(s.duration)}.`,
        stageKeys: [s.key],
        sqlIds: s.sqlId != null ? [s.sqlId] : [],
        evidence: [
          { label: 'Tasks', value: fmtNum(s.tasks) },
          { label: 'Cores', value: fmtNum(cores) },
          { label: 'Stage time', value: fmtDuration(s.duration) },
        ],
        fix: { steps: ['Repartition before the expensive step, to at least 2–3 tasks per core.'], lang: 'python', code: `df = df.repartition(${cores * 2})` },
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ app rules

function utilization(c: AnalysisCore): Finding[] {
  const s = c.summary;
  if (s.duration < T.utilizationMinAppMs || s.utilization >= T.utilizationWarn || s.coreMsAvailable === 0) return [];
  const idleCoreHours = (s.coreMsAvailable - s.taskMs) / 3_600_000;
  const dyn = isTrue(prop(c, 'spark.dynamicAllocation.enabled'));
  return [
    {
      id: 'low-utilization',
      rule: 'low-utilization',
      severity: s.utilization < T.utilizationCritical ? 'critical' : 'warning',
      title: `Cluster only ${fmtPct(s.utilization)} busy`,
      summary: `The executors offered ${(s.coreMsAvailable / 3_600_000).toFixed(1)} core-hours, but tasks used ${(s.taskMs / 3_600_000).toFixed(1)}. You paid for about ${idleCoreHours.toFixed(1)} idle core-hours.`,
      stageKeys: [],
      sqlIds: [],
      evidence: [
        { label: 'Utilisation', value: fmtPct(s.utilization) },
        { label: 'Executors / peak cores', value: `${s.executors} / ${s.peakCores}` },
        { label: 'Idle core-hours', value: idleCoreHours.toFixed(1) },
        { label: 'Dynamic allocation', value: dyn ? 'on' : 'off' },
      ],
      fix: {
        steps: [
          'Fix stragglers first: skew and single-partition stages leave most cores idle.',
          dyn ? 'Lower maxExecutors to what the job actually uses.' : 'Turn on dynamic allocation so idle executors are released.',
          'Right-size the cluster to the measured peak.',
        ],
        lang: 'properties',
        code: `spark.dynamicAllocation.enabled=true
spark.dynamicAllocation.shuffleTracking.enabled=true
spark.dynamicAllocation.minExecutors=2
spark.dynamicAllocation.maxExecutors=${Math.max(2, Math.ceil(s.executors * Math.max(s.utilization * 2, 0.5)))}`,
      },
    },
  ];
}

function failures(c: AnalysisCore): Finding[] {
  const out: Finding[] = [];
  const failedStages = c.stages.filter((s) => s.status === 'failed');
  for (const s of failedStages) {
    out.push({
      id: `stage-failure:${s.key}`,
      rule: 'stage-failure',
      severity: 'critical',
      title: `${stageLabel(s)} failed`,
      summary: s.failureReason ?? 'The stage failed and was retried or aborted the job.',
      stageKeys: [s.key],
      sqlIds: s.sqlId != null ? [s.sqlId] : [],
      evidence: [{ label: 'Reason', value: s.failureReason ?? 'unknown' }],
      fix: { steps: ['Open the stage and check the failed tasks for the root cause (OOM, fetch failure, bad data).'] },
    });
  }
  const failedTasks = c.run.stages.flatMap((s) => s.tasks.filter((t) => t.status === 'failed').map((t) => ({ s, t })));
  if (failedTasks.length > 0) {
    const reasons = new Map<string, number>();
    for (const { t } of failedTasks) {
      const kind = (t.failReason ?? 'Unknown').split(':')[0];
      reasons.set(kind, (reasons.get(kind) ?? 0) + 1);
    }
    const lostExecutors = c.run.executors.filter((e) => e.removed && e.removedReason && !/killed by driver|dynamic/i.test(e.removedReason));
    const steps: string[] = [];
    if (reasons.has('ExecutorLostFailure')) steps.push('Executors died, usually from container OOM: raise spark.executor.memoryOverhead or reduce memory per task.');
    if (reasons.has('FetchFailed')) steps.push('Shuffle fetch failures: enable the external shuffle service and check for skewed or lost shuffle blocks.');
    if (reasons.has('ExceptionFailure')) steps.push('Task exceptions: inspect the error message, often bad input data or a UDF bug.');
    if (steps.length === 0) steps.push('Inspect the failed tasks for their error messages.');
    out.push({
      id: 'task-failures',
      rule: 'task-failures',
      severity: c.summary.failedJobs > 0 ? 'critical' : 'warning',
      title: `${fmtNum(failedTasks.length)} task attempt${failedTasks.length === 1 ? '' : 's'} failed and had to be retried`,
      summary: `Retries cost time and usually point at memory or infrastructure problems. ${[...reasons].map(([k, n]) => `${k} × ${n}`).join(', ')}.`,
      stageKeys: [...new Set(failedTasks.map(({ s }) => s.key))],
      sqlIds: [],
      evidence: [
        ...[...reasons].map(([k, n]) => ({ label: k, value: fmtNum(n) })),
        ...(lostExecutors.length ? [{ label: 'Executors lost', value: lostExecutors.map((e) => `#${e.id} (${e.removedReason})`).join('; ') }] : []),
      ],
      fix: { steps, lang: 'properties', code: 'spark.executor.memoryOverhead=2g\nspark.shuffle.service.enabled=true' },
    });
  }
  return out;
}

// ------------------------------------------------------------ config and plan

function config(c: AnalysisCore): Finding[] {
  const out: Finding[] = [];
  const aqe = prop(c, 'spark.sql.adaptive.enabled');
  // AQE is on by default from Spark 3.2; flag it only when explicitly or implicitly off.
  const aqeOff = aqe ? !isTrue(aqe) : sparkMajor(c) < 3;
  if (aqeOff) {
    out.push({
      id: 'aqe-disabled',
      rule: 'aqe-disabled',
      severity: 'warning',
      title: 'Adaptive Query Execution is turned off',
      summary: 'AQE re-plans queries at runtime: it coalesces tiny partitions, splits skewed ones and switches to broadcast joins when a side turns out small. Several findings here are things it fixes automatically.',
      stageKeys: [],
      sqlIds: [],
      evidence: [{ label: 'spark.sql.adaptive.enabled', value: aqe ?? '(unset)' }],
      fix: {
        steps: ['Enable AQE and its skew-join and coalescing features.'],
        lang: 'properties',
        code: 'spark.sql.adaptive.enabled=true\nspark.sql.adaptive.coalescePartitions.enabled=true\nspark.sql.adaptive.skewJoin.enabled=true',
      },
    });
  }
  const threshold = prop(c, 'spark.sql.autoBroadcastJoinThreshold');
  const smj = c.sql.some((x) => (x.operators.SortMergeJoin ?? 0) > 0);
  if (threshold === '-1' && smj) {
    out.push({
      id: 'broadcast-disabled',
      rule: 'broadcast-disabled',
      severity: 'warning',
      title: 'Broadcast joins are disabled',
      summary: 'spark.sql.autoBroadcastJoinThreshold=-1 forces every join to shuffle both sides, even when one side is tiny.',
      stageKeys: [],
      sqlIds: c.sql.filter((x) => x.operators.SortMergeJoin).map((x) => x.id),
      evidence: [{ label: 'spark.sql.autoBroadcastJoinThreshold', value: '-1' }],
      fix: { steps: ['Restore the default (10 MB) or raise it for dimension tables.'], lang: 'properties', code: 'spark.sql.autoBroadcastJoinThreshold=10485760' },
    });
  }
  const partitions = Number(prop(c, 'spark.sql.shuffle.partitions') ?? 200);
  const shuffleStages = c.stages.filter((s) => s.kind === 'shuffle' && s.tasks === partitions);
  const biggest = Math.max(0, ...shuffleStages.map((s) => s.shuffleRead));
  if (aqeOff && shuffleStages.length >= 2) {
    const recommended = Math.max(8, Math.ceil(biggest / T.partitionTargetBytes / 8) * 8);
    const tooFew = biggest / partitions > 4 * T.partitionTargetBytes;
    const tooMany = biggest / partitions < 8 * 1024 ** 2;
    if (tooFew || tooMany) {
      out.push({
        id: 'shuffle-partitions',
        rule: 'shuffle-partitions',
        severity: 'info',
        title: `spark.sql.shuffle.partitions=${partitions} does not fit this workload`,
        summary: `Every shuffle uses ${partitions} partitions, from tiny dimension tables to the largest join (${fmtBytes(biggest)}). One fixed number cannot suit both.`,
        stageKeys: shuffleStages.map((s) => s.key),
        sqlIds: [],
        evidence: [
          { label: 'Configured', value: String(partitions) },
          { label: 'Largest shuffle', value: fmtBytes(biggest) },
          { label: '~128 MB per partition', value: `${recommended} partitions for the largest shuffle` },
        ],
        fix: { steps: ['Let AQE choose partition counts per shuffle (preferred), or tune per job.'], lang: 'properties', code: 'spark.sql.adaptive.enabled=true\nspark.sql.adaptive.advisoryPartitionSizeInBytes=128m' },
      });
    }
  }
  const serializer = prop(c, 'spark.serializer');
  if (!serializer || !/Kryo/i.test(serializer)) {
    out.push({
      id: 'serializer',
      rule: 'serializer',
      severity: 'info',
      title: 'Java serialization in use',
      summary: 'Kryo is faster and more compact for RDD and cached data. DataFrame shuffles use Tungsten either way, so the gain is mainly for RDD-heavy code.',
      stageKeys: [],
      sqlIds: [],
      evidence: [{ label: 'spark.serializer', value: serializer ?? '(default JavaSerializer)' }],
      fix: { steps: ['Switch to Kryo.'], lang: 'properties', code: 'spark.serializer=org.apache.spark.serializer.KryoSerializer' },
    });
  }
  return out;
}

function planRules(c: AnalysisCore): Finding[] {
  const out: Finding[] = [];
  const stagesOf = (x: SqlStats) => c.stages.filter((s) => s.sqlId === x.id);
  for (const x of c.sql) {
    if (x.operators.CartesianProduct || x.operators.BroadcastNestedLoopJoin) {
      out.push({
        id: `cartesian:${x.id}`,
        rule: 'cartesian',
        severity: 'critical',
        title: `Nested-loop or cartesian join while building ${x.label}`,
        summary: 'The plan compares every row with every other row. That usually means a missing or non-equi join condition.',
        stageKeys: x.stageKeys,
        sqlIds: [x.id],
        evidence: [{ label: 'Operators', value: Object.keys(x.operators).filter((o) => /Cartesian|NestedLoop/.test(o)).join(', ') }],
        fix: { steps: ['Add an equality join condition, or pre-filter both sides.'] },
      });
    }
    if (x.operators.BatchEvalPython || x.operators.ArrowEvalPython) {
      out.push({
        id: `python-udf:${x.id}`,
        rule: 'python-udf',
        severity: x.duration >= 5 * 60_000 ? 'warning' : 'info',
        title: `Python UDF in ${x.label}`,
        summary: 'Rows are serialized to a Python worker and back. Built-in functions run inside the JVM and are usually many times faster.',
        stageKeys: x.stageKeys,
        sqlIds: [x.id],
        evidence: [{ label: 'Operator', value: x.operators.BatchEvalPython ? 'BatchEvalPython (row-at-a-time UDF)' : 'ArrowEvalPython (pandas UDF)' }],
        fix: {
          steps: ['Replace the UDF with built-in functions, or at least use a vectorised pandas_udf.'],
          lang: 'python',
          code: `# Before: @udf(returnType=StringType()) def segment(v): ...
from pyspark.sql import functions as F
df = df.withColumn("segment",
    F.when(F.col("lifetime_value") >= 50000, "vip")
     .when(F.col("lifetime_value") >= 10000, "loyal")
     .otherwise("standard"))`,
        },
      });
    }
    if (x.operators.SortMergeJoin) {
      const own = stagesOf(x);
      const small = own.filter((s) => s.shuffleWrite > 0 && s.shuffleWrite <= T.broadcastSmallBytes);
      const big = own.some((s) => s.shuffleWrite >= T.broadcastBigBytes || s.shuffleRead >= T.broadcastBigBytes);
      if (small.length && big) {
        out.push({
          id: `broadcast-candidate:${x.id}`,
          rule: 'broadcast-candidate',
          severity: 'warning',
          title: `Broadcast the small side of the join in ${x.label}`,
          summary: `A side of only ${fmtBytes(small[0].shuffleWrite)} was shuffled for a sort-merge join with a much larger table. Broadcasting it avoids the shuffle, and with it the skew.`,
          stageKeys: small.map((s) => s.key),
          sqlIds: [x.id],
          evidence: [
            { label: 'Small side shuffle write', value: fmtBytes(small[0].shuffleWrite) },
            { label: 'Join type', value: 'SortMergeJoin' },
          ],
          fix: { steps: ['Hint the broadcast explicitly, or restore autoBroadcastJoinThreshold.'], lang: 'python', code: 'from pyspark.sql import functions as F\njoined = order_items.join(F.broadcast(products), "product_id")' },
        });
      }
    }
  }
  return out;
}

const ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export function worse(a: Severity | undefined, b: Severity): Severity {
  return !a || ORDER[b] < ORDER[a] ? b : a;
}

/** Worst finding severity per stage key and per SQL execution id. */
export function severityIndex(findings: Finding[]): { stage: Map<string, Severity>; sql: Map<number, Severity> } {
  const stage = new Map<string, Severity>();
  const sql = new Map<number, Severity>();
  for (const f of findings) {
    for (const k of f.stageKeys) stage.set(k, worse(stage.get(k), f.severity));
    for (const id of f.sqlIds) sql.set(id, worse(sql.get(id), f.severity));
  }
  return { stage, sql };
}

export function runRules(c: AnalysisCore): Finding[] {
  const all = [
    ...skew(c),
    ...spill(c),
    ...gc(c),
    ...smallFilesAndTinyTasks(c),
    ...parallelism(c),
    ...utilization(c),
    ...failures(c),
    ...config(c),
    ...planRules(c),
  ];
  return all.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || (b.impactMs ?? 0) - (a.impactMs ?? 0));
}
