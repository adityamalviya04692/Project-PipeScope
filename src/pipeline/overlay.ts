import { tableReach, type LineageIndex } from '../lineage/graph';
import type { Analysis } from '../spark/analyze';
import { worse, type Finding, type Severity } from '../spark/rules';

/** Runtime facts for one lineage table, taken from the Spark run that built it. */
export interface TableRun {
  table: string;
  sqlIds: number[];
  durationMs: number;
  taskMs: number;
  /** Share of the whole application's wall-clock time. */
  share: number;
  severity?: Severity;
  findings: Finding[];
  stages: number;
}

export function runsByTable(a: Analysis): Map<string, TableRun> {
  const out = new Map<string, TableRun>();
  for (const q of a.sql) {
    if (!q.target) continue;
    const findings = a.findings.filter((f) => f.sqlIds.includes(q.id) || f.stageKeys.some((k) => q.stageKeys.includes(k)));
    const prev = out.get(q.target);
    const all = [...(prev?.findings ?? []), ...findings.filter((f) => !prev?.findings.some((p) => p.id === f.id))];
    out.set(q.target, {
      table: q.target,
      sqlIds: [...(prev?.sqlIds ?? []), q.id],
      durationMs: (prev?.durationMs ?? 0) + q.duration,
      taskMs: (prev?.taskMs ?? 0) + q.taskTime,
      share: 0,
      severity: all.reduce<Severity | undefined>((s, f) => worse(s, f.severity), undefined),
      findings: all,
      stages: (prev?.stages ?? 0) + q.stageKeys.length,
    });
  }
  for (const r of out.values()) r.share = a.summary.duration ? r.durationMs / a.summary.duration : 0;
  return out;
}

export interface Coverage {
  matched: string[];
  /** Tables the Spark run wrote that the SQL project does not define. */
  runOnly: string[];
  /** Models in the SQL project that the Spark run did not build. */
  modelOnly: string[];
}

export function coverage(ix: LineageIndex, runs: Map<string, TableRun>): Coverage {
  const models = ix.result.tables.filter((t) => t.kind === 'table' || t.kind === 'view').map((t) => t.id);
  const matched = models.filter((m) => runs.has(m));
  return {
    matched,
    runOnly: [...runs.keys()].filter((k) => !ix.tables.has(k)),
    modelOnly: models.filter((m) => !runs.has(m) && ix.tables.get(m)?.kind !== 'view'),
  };
}

/**
 * The slowest chain of dependent builds: each table can only start once its
 * upstream tables exist, so this chain bounds the pipeline's end-to-end time.
 */
export function criticalPath(ix: LineageIndex, runs: Map<string, TableRun>): { path: string[]; totalMs: number } {
  const memo = new Map<string, { ms: number; prev?: string }>();
  const visiting = new Set<string>();
  const best = (t: string): number => {
    const hit = memo.get(t);
    if (hit) return hit.ms;
    if (visiting.has(t)) return 0; // cycle guard
    visiting.add(t);
    let ms = 0;
    let prev: string | undefined;
    for (const u of ix.tableUp.get(t) ?? []) {
      const v = best(u);
      if (v > ms) {
        ms = v;
        prev = u;
      }
    }
    visiting.delete(t);
    const total = ms + (runs.get(t)?.durationMs ?? 0);
    memo.set(t, { ms: total, prev });
    return total;
  };
  let end = '';
  let totalMs = 0;
  for (const t of ix.tables.keys()) {
    const v = best(t);
    if (v > totalMs) {
      totalMs = v;
      end = t;
    }
  }
  const path: string[] = [];
  for (let t: string | undefined = end; t; t = memo.get(t)?.prev) path.unshift(t);
  return { path: path.filter((t) => runs.has(t)), totalMs };
}

/** How many tables downstream have to wait for this one. */
export const blockedDownstream = (ix: LineageIndex, table: string) => tableReach(ix, table, 'down').size;
