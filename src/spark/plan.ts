// Helpers for Spark's physicalPlanDescription text (EXPLAIN FORMATTED style).

const DEFAULT_CATALOGS = /^(spark_catalog|hive_metastore)\./;

/** Canonical table key shared with the lineage engine: "db.table", lower case, db defaulting to "default". */
export function normalizeTable(raw: string): string {
  const t = raw.replace(/[`"]/g, '').trim().toLowerCase().replace(DEFAULT_CATALOGS, '');
  const parts = t.split('.').filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return `default.${parts[0]}`;
  return parts.slice(-2).join('.');
}

export function displayTable(key: string): string {
  return key.startsWith('default.') ? key.slice('default.'.length) : key;
}

/** The operator tree, without the per-node detail sections that repeat every operator name. */
export function planTree(plan: string): string {
  const body = plan.replace(/^== Physical Plan ==\n?/, '');
  const detail = body.search(/^\(\d+\) /m);
  return (detail >= 0 ? body.slice(0, detail) : body).trimEnd();
}

const IDENT = String.raw`(?:\`[^\`]+\`|\w+)(?:\.(?:\`[^\`]+\`|\w+)){0,2}`;

const READS = [
  new RegExp(String.raw`FileScan\s+\w+\s+(${IDENT})\[`, 'g'),
  new RegExp(String.raw`BatchScan\s+(${IDENT})\[`, 'g'),
  new RegExp(String.raw`HiveTableRelation\s+\[(${IDENT})`, 'g'),
];

const WRITES = [
  new RegExp(String.raw`InsertIntoHadoopFsRelationCommand[^\n]*?,\s*(\`[^\`]+\`(?:\.\`[^\`]+\`){1,2})`, 'g'),
  new RegExp(String.raw`CreateDataSourceTableAsSelectCommand\s+(${IDENT})`, 'g'),
  new RegExp(String.raw`(?:Atomic)?(?:Replace|Create)TableAsSelect(?:Exec)?\s+(${IDENT})`, 'g'),
  new RegExp(String.raw`(?:AppendData|OverwriteByExpression|OverwritePartitionsDynamic)(?:ExecV1|Exec)?\s+(${IDENT})`, 'g'),
  new RegExp(String.raw`InsertIntoHiveTable\s+(${IDENT})`, 'g'),
];

const DESCRIPTION_WRITE = new RegExp(
  String.raw`\b(?:create\s+(?:or\s+replace\s+)?(?:table|view)(?:\s+if\s+not\s+exists)?|insert\s+(?:overwrite|into)(?:\s+table)?|merge\s+into)\s+(${IDENT})`,
  'i',
);

/** Path-based scans (e.g. Delta) have no table name; use the last two path segments. */
const LOCATION = /Location:\s+\w+(?:\(\d+ paths?\))?\[([^\]\s,]+)/g;

function collect(text: string, patterns: RegExp[]): string[] {
  const out = new Set<string>();
  for (const re of patterns) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const key = normalizeTable(m[1]);
      if (key) out.add(key);
    }
  }
  return [...out];
}

export function planTables(plan: string, description = ''): { reads: string[]; writes: string[] } {
  const writes = collect(plan, WRITES);
  if (writes.length === 0) {
    const m = description.match(DESCRIPTION_WRITE);
    if (m) writes.push(normalizeTable(m[1]));
  }
  let reads = collect(plan, READS);
  if (reads.length === 0) {
    const paths = new Set<string>();
    for (const m of plan.matchAll(LOCATION)) {
      const seg = m[1].replace(/\/+$/, '').split('/').filter(Boolean);
      if (seg.length >= 2) paths.add(normalizeTable(seg.slice(-2).join('.')));
    }
    reads = [...paths];
  }
  return { reads: reads.filter((r) => !writes.includes(r)), writes };
}

export const NOTABLE_OPERATORS = [
  'SortMergeJoin',
  'BroadcastHashJoin',
  'ShuffledHashJoin',
  'BroadcastNestedLoopJoin',
  'CartesianProduct',
  'Exchange hashpartitioning',
  'Exchange rangepartitioning',
  'Exchange SinglePartition',
  'Exchange RoundRobinPartitioning',
  'BroadcastExchange',
  'HashAggregate',
  'ObjectHashAggregate',
  'SortAggregate',
  'Window',
  'Generate',
  'Expand',
  'BatchEvalPython',
  'ArrowEvalPython',
  'FlatMapGroupsInPandas',
  'AQEShuffleRead',
  'AdaptiveSparkPlan',
] as const;
export type Operator = (typeof NOTABLE_OPERATORS)[number];

/** How often each notable operator appears in the plan tree. */
export function planOperators(plan: string): Partial<Record<Operator, number>> {
  const tree = planTree(plan);
  const out: Partial<Record<Operator, number>> = {};
  for (const op of NOTABLE_OPERATORS) {
    const re = op.startsWith('Exchange ') ? new RegExp(String.raw`\b${op.replace(' ', String.raw`\s+`)}\b`, 'g') : new RegExp(String.raw`\b${op}\b`, 'g');
    const n = tree.match(re)?.length ?? 0;
    if (n > 0) out[op] = n;
  }
  return out;
}
