import { displayTable, planOperators, planTables, type Operator } from './plan';
import { runRules, scoreFindings, type Finding } from './rules';
import type { SparkRun, StageRec, StageStatus, TaskRec } from './types';

export interface Dist {
  count: number;
  sum: number;
  mean: number;
  min: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  max: number;
}

const EMPTY_DIST: Dist = { count: 0, sum: 0, mean: 0, min: 0, p25: 0, p50: 0, p75: 0, p90: 0, max: 0 };

export function dist(values: number[]): Dist {
  const n = values.length;
  if (n === 0) return { ...EMPTY_DIST };
  const s = Float64Array.from(values).sort();
  const q = (p: number) => {
    const pos = (n - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  };
  let sum = 0;
  for (const v of s) sum += v;
  return { count: n, sum, mean: sum / n, min: s[0], p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), max: s[n - 1] };
}

export type StageKind = 'scan' | 'shuffle' | 'other';

export interface StageStats {
  key: string;
  id: number;
  attempt: number;
  name: string;
  status: StageStatus;
  failureReason?: string;
  jobIds: number[];
  parentIds: number[];
  sqlId?: number;
  /** Table this stage helps build (from its SQL execution), if known. */
  table?: string;
  kind: StageKind;
  start: number;
  end: number;
  duration: number;
  numTasks: number;
  tasks: number;
  failedTasks: number;
  killedTasks: number;
  speculativeTasks: number;
  inputBytes: number;
  inputRecords: number;
  outputBytes: number;
  shuffleRead: number;
  shuffleWrite: number;
  memSpill: number;
  diskSpill: number;
  runTime: number;
  gcTime: number;
  cpuTime: number;
  gcRatio: number;
  taskDuration: Dist;
  taskInput: Dist;
  taskShuffleRead: Dist;
  taskDiskSpill: Dist;
  taskGc: Dist;
  /** max / median task duration. */
  skewRatio: number;
  executors: number;
  meanSchedulerDelay: number;
  slowest: TaskRec | null;
}

export interface SqlStats {
  id: number;
  description: string;
  label: string;
  reads: string[];
  writes: string[];
  target?: string;
  start: number;
  end: number;
  duration: number;
  jobIds: number[];
  stageKeys: string[];
  operators: Partial<Record<Operator, number>>;
  plan: string;
  /** Sum of task time across this execution's stages. */
  taskTime: number;
}

export interface RunSummary {
  appName: string;
  appId: string;
  sparkVersion: string;
  start: number;
  end: number;
  duration: number;
  jobs: number;
  failedJobs: number;
  stages: number;
  failedStages: number;
  skippedStages: number;
  tasks: number;
  failedTasks: number;
  executors: number;
  peakCores: number;
  maxConcurrentTasks: number;
  /** Core-milliseconds the cluster offered while the app ran. */
  coreMsAvailable: number;
  /** Task-milliseconds actually used. */
  taskMs: number;
  /** taskMs / coreMsAvailable. */
  utilization: number;
  inputBytes: number;
  outputBytes: number;
  shuffleRead: number;
  shuffleWrite: number;
  memSpill: number;
  diskSpill: number;
  runTime: number;
  gcTime: number;
  cpuTime: number;
  gcRatio: number;
}

export interface Concurrency {
  t: number[];
  running: number[];
  cores: number[];
}

export interface Analysis {
  run: SparkRun;
  summary: RunSummary;
  stages: StageStats[];
  sql: SqlStats[];
  concurrency: Concurrency;
  findings: Finding[];
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
}

export interface AnalysisCore {
  run: SparkRun;
  summary: RunSummary;
  stages: StageStats[];
  sql: SqlStats[];
}

function stageStats(s: StageRec, sqlId: number | undefined, table: string | undefined): StageStats {
  const ok = s.tasks.filter((t) => t.status === 'success');
  const sum = (f: (t: TaskRec) => number) => ok.reduce((a, t) => a + f(t), 0);
  const launches = s.tasks.map((t) => t.launch).filter((x) => x > 0);
  const finishes = s.tasks.map((t) => t.finish).filter((x) => x > 0);
  const start = s.submitted ?? (launches.length ? Math.min(...launches) : 0);
  const end = s.completed ?? (finishes.length ? Math.max(...finishes) : start);
  const inputBytes = sum((t) => t.inputBytes);
  const shuffleRead = sum((t) => t.shuffleReadBytes);
  const runTime = sum((t) => t.runTime);
  const gcTime = sum((t) => t.gcTime);
  const taskDuration = dist(ok.map((t) => t.duration));
  const slowest = ok.reduce<TaskRec | null>((m, t) => (!m || t.duration > m.duration ? t : m), null);
  return {
    key: s.key,
    id: s.id,
    attempt: s.attempt,
    name: s.name,
    status: s.status,
    failureReason: s.failureReason,
    jobIds: s.jobIds,
    parentIds: s.parentIds,
    sqlId,
    table,
    kind: shuffleRead > 0 ? 'shuffle' : inputBytes > 0 ? 'scan' : 'other',
    start,
    end,
    duration: Math.max(0, end - start),
    numTasks: s.numTasks,
    tasks: ok.length,
    failedTasks: s.tasks.filter((t) => t.status === 'failed').length,
    killedTasks: s.tasks.filter((t) => t.status === 'killed').length,
    speculativeTasks: s.tasks.filter((t) => t.speculative).length,
    inputBytes,
    inputRecords: sum((t) => t.inputRecords),
    outputBytes: sum((t) => t.outputBytes),
    shuffleRead,
    shuffleWrite: sum((t) => t.shuffleWriteBytes),
    memSpill: sum((t) => t.memSpill),
    diskSpill: sum((t) => t.diskSpill),
    runTime,
    gcTime,
    cpuTime: sum((t) => t.cpuTime),
    gcRatio: runTime > 0 ? gcTime / runTime : 0,
    taskDuration,
    taskInput: dist(ok.map((t) => t.inputBytes)),
    taskShuffleRead: dist(ok.map((t) => t.shuffleReadBytes)),
    taskDiskSpill: dist(ok.map((t) => t.diskSpill)),
    taskGc: dist(ok.map((t) => t.gcTime)),
    skewRatio: taskDuration.p50 > 0 ? taskDuration.max / taskDuration.p50 : 1,
    executors: new Set(ok.map((t) => t.executorId)).size,
    meanSchedulerDelay: ok.length ? sum((t) => t.schedulerDelay) / ok.length : 0,
    slowest,
  };
}

/** Time-weighted running-task count and available cores, bucketed for charting. */
export function concurrency(run: SparkRun, start: number, end: number, buckets = 480): Concurrency {
  const span = Math.max(1, end - start);
  const width = span / buckets;
  const running = new Float64Array(buckets);
  const cores = new Float64Array(buckets);

  const integrate = (events: [number, number][], into: Float64Array) => {
    events.sort((a, b) => a[0] - b[0]);
    let level = 0;
    let prev = start;
    const add = (from: number, to: number, v: number) => {
      if (v === 0 || to <= from) return;
      const a = Math.max(from, start);
      const b = Math.min(to, end);
      if (b <= a) return;
      for (let i = Math.floor((a - start) / width); i < buckets; i++) {
        const bs = start + i * width;
        const be = bs + width;
        const overlap = Math.min(b, be) - Math.max(a, bs);
        if (overlap > 0) into[i] += (v * overlap) / width;
        if (be >= b) break;
      }
    };
    for (const [t, d] of events) {
      add(prev, t, level);
      level += d;
      prev = t;
    }
    add(prev, end, level);
  };

  const taskEvents: [number, number][] = [];
  for (const s of run.stages) for (const t of s.tasks) if (t.finish > t.launch) taskEvents.push([t.launch, 1], [t.finish, -1]);
  integrate(taskEvents, running);

  const coreEvents: [number, number][] = [];
  for (const ex of run.executors) {
    if (ex.id === 'driver' || ex.cores <= 0) continue;
    coreEvents.push([ex.added, ex.cores], [ex.removed ?? end, -ex.cores]);
  }
  integrate(coreEvents, cores);

  return {
    t: Array.from({ length: buckets }, (_, i) => start + (i + 0.5) * width),
    running: Array.from(running, (v) => Math.round(v * 10) / 10),
    cores: Array.from(cores, (v) => Math.round(v * 10) / 10),
  };
}

function maxConcurrent(run: SparkRun): number {
  const ev: [number, number][] = [];
  for (const s of run.stages) for (const t of s.tasks) if (t.finish > t.launch) ev.push([t.launch, 1], [t.finish, -1]);
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let level = 0;
  let peak = 0;
  for (const [, d] of ev) {
    level += d;
    peak = Math.max(peak, level);
  }
  return peak;
}

function summarize(run: SparkRun, stages: StageStats[]): RunSummary {
  const allTasks = run.stages.flatMap((s) => s.tasks);
  const launches = allTasks.map((t) => t.launch).filter((x) => x > 0);
  const finishes = allTasks.map((t) => t.finish).filter((x) => x > 0);
  const start = run.start ?? (launches.length ? Math.min(...launches) : 0);
  const end = run.end ?? (finishes.length ? Math.max(...finishes) : start);
  const duration = Math.max(0, end - start);
  const total = (f: (s: StageStats) => number) => stages.reduce((a, s) => a + f(s), 0);

  const workers = run.executors.filter((e) => e.id !== 'driver' && e.cores > 0);
  let coreMsAvailable = workers.reduce((a, e) => a + e.cores * Math.max(0, Math.min(e.removed ?? end, end) - Math.max(e.added, start)), 0);
  const peakTasks = maxConcurrent(run);
  // Local mode logs have no executor-added events: fall back to the observed peak.
  if (coreMsAvailable === 0) coreMsAvailable = peakTasks * duration;
  let peakCores = 0;
  {
    const ev: [number, number][] = workers.flatMap((e) => [[e.added, e.cores], [e.removed ?? end, -e.cores]] as [number, number][]);
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let lvl = 0;
    for (const [, d] of ev) peakCores = Math.max(peakCores, (lvl += d));
    if (peakCores === 0) peakCores = peakTasks;
  }
  const taskMs = allTasks.reduce((a, t) => a + t.duration, 0);
  const runTime = total((s) => s.runTime);
  const gcTime = total((s) => s.gcTime);
  return {
    appName: run.appName ?? run.fileName,
    appId: run.appId ?? '',
    sparkVersion: run.sparkVersion ?? '',
    start,
    end,
    duration,
    jobs: run.jobs.length,
    failedJobs: run.jobs.filter((j) => j.result === 'failed').length,
    stages: stages.filter((s) => s.status !== 'skipped').length,
    failedStages: stages.filter((s) => s.status === 'failed').length,
    skippedStages: stages.filter((s) => s.status === 'skipped').length,
    tasks: allTasks.length,
    failedTasks: allTasks.filter((t) => t.status === 'failed').length,
    executors: workers.length,
    peakCores,
    maxConcurrentTasks: peakTasks,
    coreMsAvailable,
    taskMs,
    utilization: coreMsAvailable > 0 ? Math.min(1, taskMs / coreMsAvailable) : 0,
    inputBytes: total((s) => s.inputBytes),
    outputBytes: total((s) => s.outputBytes),
    shuffleRead: total((s) => s.shuffleRead),
    shuffleWrite: total((s) => s.shuffleWrite),
    memSpill: total((s) => s.memSpill),
    diskSpill: total((s) => s.diskSpill),
    runTime,
    gcTime,
    cpuTime: total((s) => s.cpuTime),
    gcRatio: runTime > 0 ? gcTime / runTime : 0,
  };
}

function shortDescription(d: string): string {
  const one = d.replace(/\s+/g, ' ').trim();
  return one.length > 80 ? `${one.slice(0, 77)}…` : one;
}

export function runLabel(a: Analysis): string {
  const d = new Date(a.summary.start);
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const time = d.toISOString().slice(11, 16);
  return `${date} ${time} UTC`;
}

export function grade(score: number): Analysis['grade'] {
  return score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
}

export function analyzeRun(run: SparkRun): Analysis {
  const jobSql = new Map(run.jobs.map((j) => [j.id, j.sqlExecutionId]));
  const sqlTables = new Map(run.sql.map((x) => [x.id, planTables(x.plan, x.description)]));

  const stages = run.stages.map((s) => {
    const sqlId = s.jobIds.map((j) => jobSql.get(j)).find((x) => x != null);
    const io = sqlId != null ? sqlTables.get(sqlId) : undefined;
    return stageStats(s, sqlId, io?.writes[0]);
  });

  const sql: SqlStats[] = run.sql.map((x) => {
    const io = sqlTables.get(x.id)!;
    const own = stages.filter((s) => s.sqlId === x.id);
    const end = x.end ?? Math.max(x.start, ...own.map((s) => s.end));
    const target = io.writes[0];
    return {
      id: x.id,
      description: x.description,
      label: target ? displayTable(target) : shortDescription(x.description) || `SQL ${x.id}`,
      reads: io.reads,
      writes: io.writes,
      target,
      start: x.start,
      end,
      duration: Math.max(0, end - x.start),
      jobIds: x.jobIds,
      stageKeys: own.map((s) => s.key),
      operators: planOperators(x.plan),
      plan: x.plan,
      taskTime: own.reduce((a, s) => a + s.runTime, 0),
    };
  });

  const summary = summarize(run, stages);
  const core: AnalysisCore = { run, summary, stages, sql };
  const findings = runRules(core);
  const score = scoreFindings(findings);
  return {
    ...core,
    concurrency: concurrency(run, summary.start, summary.end),
    findings,
    score,
    grade: grade(score),
  };
}
