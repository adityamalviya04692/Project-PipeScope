// Builds small, valid Spark event logs for tests, using Spark's real JSON field names.

export interface TaskSpec {
  duration: number;
  executor?: string;
  input?: number;
  shuffleRead?: number;
  shuffleWrite?: number;
  diskSpill?: number;
  memSpill?: number;
  gc?: number;
  failed?: string;
}

export interface StageSpec {
  id: number;
  name?: string;
  parents?: number[];
  tasks: TaskSpec[];
  /** Concurrent task slots used to lay tasks out in time. */
  slots?: number;
  failure?: string;
}

const T0 = 1_760_400_000_000;

export class LogBuilder {
  events: Record<string, unknown>[] = [];
  now = T0;
  private taskId = 0;

  constructor(opts: { props?: Record<string, string>; executors?: number; cores?: number; version?: string } = {}) {
    const { executors = 2, cores = 4, version = '3.5.1' } = opts;
    this.events.push({ Event: 'SparkListenerLogStart', 'Spark Version': version });
    this.events.push({ Event: 'SparkListenerApplicationStart', 'App Name': 'test_app', 'App ID': 'app-test-0001', Timestamp: this.now, User: 'etl' });
    this.events.push({ Event: 'SparkListenerEnvironmentUpdate', 'JVM Information': {}, 'Spark Properties': { 'spark.app.name': 'test_app', ...opts.props }, 'Hadoop Properties': {}, 'System Properties': {}, 'Classpath Entries': {} });
    for (let i = 1; i <= executors; i++) {
      this.events.push({ Event: 'SparkListenerExecutorAdded', Timestamp: this.now, 'Executor ID': String(i), 'Executor Info': { Host: `10.0.0.${i}`, 'Total Cores': cores, 'Log Urls': {} } });
    }
  }

  sqlStart(id: number, description: string, plan: string) {
    this.events.push({ Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart', executionId: id, description, details: '', physicalPlanDescription: plan, sparkPlanInfo: {}, time: this.now });
  }

  sqlEnd(id: number) {
    this.events.push({ Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionEnd', executionId: id, time: this.now });
  }

  /** Emits a job with its stages run one after another; returns nothing, advances the clock. */
  job(jobId: number, stages: StageSpec[], sqlId?: number) {
    const props: Record<string, string> = sqlId != null ? { 'spark.sql.execution.id': String(sqlId) } : {};
    this.events.push({
      Event: 'SparkListenerJobStart',
      'Job ID': jobId,
      'Submission Time': this.now,
      'Stage Infos': stages.map((s) => ({ 'Stage ID': s.id, 'Stage Attempt ID': 0, 'Stage Name': s.name ?? `stage ${s.id}`, 'Number of Tasks': s.tasks.length, 'Parent IDs': s.parents ?? [], Details: '' })),
      'Stage IDs': stages.map((s) => s.id),
      Properties: props,
    });
    let failed = false;
    for (const s of stages) failed = this.stage(s) || failed;
    this.events.push({ Event: 'SparkListenerJobEnd', 'Job ID': jobId, 'Completion Time': this.now, 'Job Result': { Result: failed ? 'JobFailed' : 'JobSucceeded' } });
  }

  private stage(s: StageSpec): boolean {
    const info = { 'Stage ID': s.id, 'Stage Attempt ID': 0, 'Stage Name': s.name ?? `stage ${s.id}`, 'Number of Tasks': s.tasks.length, 'Parent IDs': s.parents ?? [], Details: '' };
    const submitted = this.now;
    this.events.push({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { ...info, 'Submission Time': submitted }, Properties: {} });
    const slots = new Array(s.slots ?? 8).fill(submitted);
    s.tasks.forEach((t, index) => {
      const slot = slots.indexOf(Math.min(...slots));
      const launch = slots[slot];
      const finish = launch + t.duration;
      slots[slot] = finish;
      this.events.push({
        Event: 'SparkListenerTaskEnd',
        'Stage ID': s.id,
        'Stage Attempt ID': 0,
        'Task Type': 'ShuffleMapTask',
        'Task End Reason': t.failed ? { Reason: t.failed, 'Loss Reason': 'Container killed by YARN for exceeding memory limits' } : { Reason: 'Success' },
        'Task Info': { 'Task ID': this.taskId++, Index: index, Attempt: 0, 'Launch Time': launch, 'Executor ID': t.executor ?? String((slot % 2) + 1), Host: '10.0.0.1', Locality: 'PROCESS_LOCAL', Speculative: false, 'Getting Result Time': 0, 'Finish Time': finish, Failed: !!t.failed, Killed: false },
        'Task Metrics': {
          'Executor Deserialize Time': 2,
          'Executor Run Time': Math.max(0, t.duration - 5),
          'Executor CPU Time': Math.max(0, t.duration - 10) * 1e6,
          'Peak Execution Memory': 0,
          'Result Size': 2000,
          'JVM GC Time': t.gc ?? 0,
          'Result Serialization Time': 1,
          'Memory Bytes Spilled': t.memSpill ?? 0,
          'Disk Bytes Spilled': t.diskSpill ?? 0,
          'Shuffle Read Metrics': { 'Remote Blocks Fetched': 0, 'Local Blocks Fetched': 0, 'Fetch Wait Time': 0, 'Remote Bytes Read': (t.shuffleRead ?? 0) / 2, 'Remote Bytes Read To Disk': 0, 'Local Bytes Read': (t.shuffleRead ?? 0) / 2, 'Total Records Read': 0 },
          'Shuffle Write Metrics': { 'Shuffle Bytes Written': t.shuffleWrite ?? 0, 'Shuffle Write Time': 0, 'Shuffle Records Written': 0 },
          'Input Metrics': { 'Bytes Read': t.input ?? 0, 'Records Read': 0 },
          'Output Metrics': { 'Bytes Written': 0, 'Records Written': 0 },
        },
      });
    });
    this.now = Math.max(...slots);
    this.events.push({ Event: 'SparkListenerStageCompleted', 'Stage Info': { ...info, 'Submission Time': submitted, 'Completion Time': this.now, ...(s.failure ? { 'Failure Reason': s.failure } : {}) } });
    return !!s.failure;
  }

  advance(ms: number) {
    this.now += ms;
  }

  text(): string {
    return [...this.events, { Event: 'SparkListenerApplicationEnd', Timestamp: this.now }].map((e) => JSON.stringify(e)).join('\n') + '\n';
  }
}

export const tasks = (n: number, spec: TaskSpec | ((i: number) => TaskSpec)): TaskSpec[] =>
  Array.from({ length: n }, (_, i) => (typeof spec === 'function' ? spec(i) : { ...spec }));

export const MB = 1024 ** 2;
export const GB = 1024 ** 3;
