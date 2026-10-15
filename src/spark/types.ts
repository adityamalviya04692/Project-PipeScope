/** Normalised view of one Spark application, built from its event log. */

export type TaskStatus = 'success' | 'failed' | 'killed';

export interface TaskRec {
  taskId: number;
  index: number;
  attempt: number;
  executorId: string;
  host: string;
  locality: string;
  speculative: boolean;
  /** Epoch ms. */
  launch: number;
  finish: number;
  duration: number;
  runTime: number;
  cpuTime: number;
  gcTime: number;
  deserTime: number;
  resultSerTime: number;
  schedulerDelay: number;
  inputBytes: number;
  inputRecords: number;
  outputBytes: number;
  outputRecords: number;
  shuffleReadBytes: number;
  shuffleReadRecords: number;
  fetchWait: number;
  shuffleWriteBytes: number;
  shuffleWriteRecords: number;
  memSpill: number;
  diskSpill: number;
  peakMemory: number;
  status: TaskStatus;
  failReason?: string;
}

export type StageStatus = 'complete' | 'failed' | 'skipped' | 'running';

export interface StageRec {
  /** `${id}.${attempt}` */
  key: string;
  id: number;
  attempt: number;
  name: string;
  details: string;
  numTasks: number;
  parentIds: number[];
  jobIds: number[];
  submitted?: number;
  completed?: number;
  status: StageStatus;
  failureReason?: string;
  tasks: TaskRec[];
}

export interface JobRec {
  id: number;
  submitted: number;
  completed?: number;
  result: 'succeeded' | 'failed' | 'unknown';
  stageIds: number[];
  sqlExecutionId?: number;
  description?: string;
  group?: string;
}

export interface ExecutorRec {
  id: string;
  host: string;
  cores: number;
  added: number;
  removed?: number;
  removedReason?: string;
}

export interface SqlExecRec {
  id: number;
  description: string;
  details: string;
  /** Final physical plan (the AQE-updated plan when adaptive execution re-planned it). */
  plan: string;
  start: number;
  end?: number;
  jobIds: number[];
}

export interface SparkRun {
  fileName: string;
  sparkVersion?: string;
  appId?: string;
  appName?: string;
  user?: string;
  start?: number;
  end?: number;
  properties: Record<string, string>;
  jobs: JobRec[];
  stages: StageRec[];
  executors: ExecutorRec[];
  sql: SqlExecRec[];
  eventCount: number;
  /** Event types we saw but do not model, with counts. */
  unknownEvents: Record<string, number>;
  /** Lines that were not valid JSON (e.g. a truncated last line of a running app). */
  parseErrors: number;
}
