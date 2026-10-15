import type { ExecutorRec, JobRec, SparkRun, SqlExecRec, StageRec, TaskRec, TaskStatus } from './types';

// The event log is JSON lines written by Spark's JsonProtocol; field names
// below are the exact keys Spark writes (e.g. "Task Metrics", "Launch Time").
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SQL = 'org.apache.spark.sql.execution.ui.';

/** Events we understand but do not need to model. */
const IGNORED = new Set([
  'SparkListenerTaskStart',
  'SparkListenerTaskGettingResult',
  'SparkListenerBlockManagerAdded',
  'SparkListenerBlockManagerRemoved',
  'SparkListenerBlockUpdated',
  'SparkListenerStageExecutorMetrics',
  'SparkListenerExecutorMetricsUpdate',
  'SparkListenerResourceProfileAdded',
  'SparkListenerUnpersistRDD',
  'SparkListenerSpeculativeTaskSubmitted',
  `${SQL}SparkListenerDriverAccumUpdates`,
  `${SQL}SparkListenerSQLAdaptiveSQLMetricUpdates`,
]);

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

function describeFailure(r: J): string {
  const kind = String(r.Reason ?? 'Unknown');
  const detail = r['Loss Reason'] ?? r.Description ?? r['Kill Reason'] ?? r.Message ?? '';
  return detail ? `${kind}: ${String(detail).split('\n')[0].slice(0, 200)}` : kind;
}

function toTask(e: J): TaskRec {
  const ti: J = e['Task Info'] ?? {};
  const tm: J = e['Task Metrics'] ?? {};
  const sr: J = tm['Shuffle Read Metrics'] ?? {};
  const sw: J = tm['Shuffle Write Metrics'] ?? {};
  const im: J = tm['Input Metrics'] ?? {};
  const om: J = tm['Output Metrics'] ?? {};
  const launch = num(ti['Launch Time']);
  const finish = num(ti['Finish Time']) || launch;
  const duration = Math.max(0, finish - launch);
  const runTime = num(tm['Executor Run Time']);
  const deserTime = num(tm['Executor Deserialize Time']);
  const resultSerTime = num(tm['Result Serialization Time']);
  const gettingResultAt = num(ti['Getting Result Time']);
  const gettingResult = gettingResultAt > 0 ? Math.max(0, finish - gettingResultAt) : 0;
  const reason: J = e['Task End Reason'] ?? {};
  const r = String(reason.Reason ?? 'Success');
  const status: TaskStatus = r === 'Success' ? 'success' : r === 'TaskKilled' ? 'killed' : 'failed';
  return {
    taskId: num(ti['Task ID']),
    index: num(ti.Index),
    attempt: num(ti.Attempt),
    executorId: String(ti['Executor ID'] ?? ''),
    host: String(ti.Host ?? ''),
    locality: String(ti.Locality ?? ''),
    speculative: Boolean(ti.Speculative),
    launch,
    finish,
    duration,
    runTime,
    cpuTime: num(tm['Executor CPU Time']) / 1e6, // nanoseconds in the log
    gcTime: num(tm['JVM GC Time']),
    deserTime,
    resultSerTime,
    schedulerDelay: Math.max(0, duration - runTime - deserTime - resultSerTime - gettingResult),
    inputBytes: num(im['Bytes Read']),
    inputRecords: num(im['Records Read']),
    outputBytes: num(om['Bytes Written']),
    outputRecords: num(om['Records Written']),
    shuffleReadBytes: num(sr['Remote Bytes Read']) + num(sr['Local Bytes Read']),
    shuffleReadRecords: num(sr['Total Records Read']),
    fetchWait: num(sr['Fetch Wait Time']),
    shuffleWriteBytes: num(sw['Shuffle Bytes Written']),
    shuffleWriteRecords: num(sw['Shuffle Records Written']),
    memSpill: num(tm['Memory Bytes Spilled']),
    diskSpill: num(tm['Disk Bytes Spilled']),
    peakMemory: num(tm['Peak Execution Memory']),
    status,
    failReason: status === 'success' ? undefined : describeFailure(reason),
  };
}

export interface EventLogParser {
  push(line: string): void;
  finish(): SparkRun;
}

/** Incremental parser: feed it one line at a time, then call finish(). */
export function createEventLogParser(fileName: string): EventLogParser {
  const run: SparkRun = {
    fileName,
    properties: {},
    jobs: [],
    stages: [],
    executors: [],
    sql: [],
    eventCount: 0,
    unknownEvents: {},
    parseErrors: 0,
  };
  const stages = new Map<string, StageRec>();
  const jobs = new Map<number, JobRec>();
  const execs = new Map<string, ExecutorRec>();
  const sqlExecs = new Map<number, SqlExecRec>();

  const stage = (id: number, attempt: number): StageRec => {
    const key = `${id}.${attempt}`;
    let s = stages.get(key);
    if (!s) {
      s = { key, id, attempt, name: '', details: '', numTasks: 0, parentIds: [], jobIds: [], status: 'skipped', tasks: [] };
      stages.set(key, s);
    }
    return s;
  };

  const applyStageInfo = (info: J): StageRec => {
    const s = stage(num(info['Stage ID']), num(info['Stage Attempt ID']));
    if (info['Stage Name']) s.name = String(info['Stage Name']);
    if (info.Details) s.details = String(info.Details);
    if (info['Number of Tasks'] != null) s.numTasks = num(info['Number of Tasks']);
    if (Array.isArray(info['Parent IDs'])) s.parentIds = info['Parent IDs'].map(num);
    if (info['Submission Time'] != null) s.submitted = num(info['Submission Time']);
    if (info['Completion Time'] != null) s.completed = num(info['Completion Time']);
    return s;
  };

  function handle(e: J): void {
    const type = String(e.Event ?? '');
    switch (type) {
      case 'SparkListenerLogStart':
        run.sparkVersion = e['Spark Version'];
        return;
      case 'SparkListenerApplicationStart':
        run.appName = e['App Name'];
        run.appId = e['App ID'];
        run.start = num(e.Timestamp);
        run.user = e.User;
        return;
      case 'SparkListenerApplicationEnd':
        run.end = num(e.Timestamp);
        return;
      case 'SparkListenerEnvironmentUpdate': {
        const p = e['Spark Properties'];
        const entries: [string, unknown][] = Array.isArray(p) ? p : p && typeof p === 'object' ? Object.entries(p) : [];
        for (const [k, v] of entries) run.properties[k] = String(v);
        return;
      }
      case 'SparkListenerExecutorAdded': {
        const id = String(e['Executor ID']);
        const info: J = e['Executor Info'] ?? {};
        execs.set(id, { id, host: String(info.Host ?? ''), cores: num(info['Total Cores']), added: num(e.Timestamp) });
        return;
      }
      case 'SparkListenerExecutorRemoved': {
        const ex = execs.get(String(e['Executor ID']));
        if (ex) {
          ex.removed = num(e.Timestamp);
          ex.removedReason = e['Removed Reason'];
        }
        return;
      }
      case 'SparkListenerJobStart': {
        const props: J = e.Properties ?? {};
        const sqlId = props['spark.sql.execution.id'];
        const job: JobRec = {
          id: num(e['Job ID']),
          submitted: num(e['Submission Time']),
          result: 'unknown',
          stageIds: (e['Stage IDs'] ?? []).map(num),
          sqlExecutionId: sqlId != null && sqlId !== '' ? Number(sqlId) : undefined,
          description: props['spark.job.description'],
          group: props['spark.jobGroup.id'],
        };
        jobs.set(job.id, job);
        // Stage infos are announced here; stages that never get submitted stay "skipped".
        for (const info of e['Stage Infos'] ?? []) applyStageInfo(info);
        return;
      }
      case 'SparkListenerJobEnd': {
        const j = jobs.get(num(e['Job ID']));
        if (j) {
          j.completed = num(e['Completion Time']);
          j.result = e['Job Result']?.Result === 'JobSucceeded' ? 'succeeded' : 'failed';
        }
        return;
      }
      case 'SparkListenerStageSubmitted':
        applyStageInfo(e['Stage Info'] ?? {}).status = 'running';
        return;
      case 'SparkListenerStageCompleted': {
        const info: J = e['Stage Info'] ?? {};
        const s = applyStageInfo(info);
        s.failureReason = info['Failure Reason'] ? String(info['Failure Reason']).split('\n')[0] : undefined;
        s.status = s.failureReason ? 'failed' : 'complete';
        return;
      }
      case 'SparkListenerTaskEnd':
        stage(num(e['Stage ID']), num(e['Stage Attempt ID'])).tasks.push(toTask(e));
        return;
      case `${SQL}SparkListenerSQLExecutionStart`: {
        const id = num(e.executionId);
        sqlExecs.set(id, {
          id,
          description: String(e.description ?? ''),
          details: String(e.details ?? ''),
          plan: String(e.physicalPlanDescription ?? ''),
          start: num(e.time),
          jobIds: [],
        });
        return;
      }
      case `${SQL}SparkListenerSQLAdaptiveExecutionUpdate`: {
        // AQE re-planned the query: keep the latest (final) physical plan.
        const x = sqlExecs.get(num(e.executionId));
        if (x && e.physicalPlanDescription) x.plan = String(e.physicalPlanDescription);
        return;
      }
      case `${SQL}SparkListenerSQLExecutionEnd`: {
        const x = sqlExecs.get(num(e.executionId));
        if (x) x.end = num(e.time);
        return;
      }
      default:
        if (!IGNORED.has(type)) run.unknownEvents[type] = (run.unknownEvents[type] ?? 0) + 1;
    }
  }

  return {
    push(line: string) {
      const t = line.trim();
      if (!t) return;
      let e: J;
      try {
        e = JSON.parse(t);
      } catch {
        run.parseErrors++;
        return;
      }
      run.eventCount++;
      handle(e);
    },
    finish(): SparkRun {
      const byStageId = new Map<number, StageRec[]>();
      for (const s of stages.values()) {
        const list = byStageId.get(s.id) ?? [];
        list.push(s);
        byStageId.set(s.id, list);
        s.tasks.sort((a, b) => a.launch - b.launch);
      }
      for (const j of jobs.values()) {
        for (const sid of j.stageIds) for (const s of byStageId.get(sid) ?? []) if (!s.jobIds.includes(j.id)) s.jobIds.push(j.id);
        if (j.sqlExecutionId != null) sqlExecs.get(j.sqlExecutionId)?.jobIds.push(j.id);
      }
      run.stages = [...stages.values()].sort((a, b) => a.id - b.id || a.attempt - b.attempt);
      run.jobs = [...jobs.values()].sort((a, b) => a.id - b.id);
      run.executors = [...execs.values()].sort((a, b) => a.added - b.added || a.id.localeCompare(b.id, undefined, { numeric: true }));
      run.sql = [...sqlExecs.values()].sort((a, b) => a.id - b.id);
      return run;
    },
  };
}

/** Parse a whole log held in memory (tests, small files). */
export function parseEventLogText(text: string, fileName = 'eventlog'): SparkRun {
  const p = createEventLogParser(fileName);
  for (const line of text.split('\n')) p.push(line);
  return p.finish();
}
