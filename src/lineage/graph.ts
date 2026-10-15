import type { ColumnRef, LineageColumn, LineageResult, LineageTable, Transform } from './types';

export type Layer = 'source' | 'bronze' | 'silver' | 'gold' | 'report' | 'other';
export const LAYERS: Layer[] = ['source', 'bronze', 'silver', 'gold', 'report', 'other'];

const DB_LAYER: [RegExp, Layer][] = [
  [/^(bronze|raw|landing|ingest|src)$/, 'bronze'],
  [/^(silver|staging|stg|intermediate|int|clean|cleansed|conformed)$/, 'silver'],
  [/^(gold|marts?|analytics|core|warehouse|dw|curated)$/, 'gold'],
  [/^(reporting|reports?|bi|presentation|dashboards?|semantic)$/, 'report'],
];
const NAME_LAYER: [RegExp, Layer][] = [
  [/^(raw|src|bronze)_/, 'bronze'],
  [/^(stg|int|base|silver)_/, 'silver'],
  [/^(fct|fact|dim|mart|agg|gold)_/, 'gold'],
  [/^(rpt|v|vw|report|dash)_/, 'report'],
];

/** Medallion layer, inferred from the schema name first and the table-name prefix second. */
export function layerOf(t: Pick<LineageTable, 'id' | 'kind'>): Layer {
  const [db, name = ''] = t.id.split('.');
  for (const [re, l] of DB_LAYER) if (re.test(db)) return l;
  for (const [re, l] of NAME_LAYER) if (re.test(name)) return l;
  if (t.kind === 'source' || t.kind === 'external') return 'source';
  return 'other';
}

export const displayName = (id: string) => (id.startsWith('default.') ? id.slice(8) : id);
export const colId = (r: ColumnRef) => `${r.table}::${r.column}`;
export const parseColId = (id: string): ColumnRef => {
  const i = id.indexOf('::');
  return { table: id.slice(0, i), column: id.slice(i + 2) };
};

export interface LineageIndex {
  result: LineageResult;
  tables: Map<string, LineageTable>;
  columns: Map<string, LineageColumn>;
  /** colId -> the columns it is computed from. */
  up: Map<string, ColumnRef[]>;
  /** colId -> the columns computed from it. */
  down: Map<string, ColumnRef[]>;
  tableUp: Map<string, Set<string>>;
  tableDown: Map<string, Set<string>>;
  /** colId -> downstream tables that use it in a filter, join or group-by. */
  indirectUse: Map<string, { table: string; role: string }[]>;
}

export function buildIndex(result: LineageResult): LineageIndex {
  const tables = new Map(result.tables.map((t) => [t.id, t]));
  const columns = new Map<string, LineageColumn>();
  const up = new Map<string, ColumnRef[]>();
  const down = new Map<string, ColumnRef[]>();
  const tableUp = new Map<string, Set<string>>();
  const tableDown = new Map<string, Set<string>>();
  const indirectUse = new Map<string, { table: string; role: string }[]>();
  for (const t of result.tables) {
    tableUp.set(t.id, new Set(t.upstream));
    for (const u of t.upstream) {
      if (!tableDown.has(u)) tableDown.set(u, new Set());
      tableDown.get(u)!.add(t.id);
    }
    for (const c of t.columns) {
      const id = colId({ table: t.id, column: c.name });
      columns.set(id, c);
      up.set(id, c.sources);
      for (const s of c.sources) {
        const sid = colId(s);
        if (!down.has(sid)) down.set(sid, []);
        down.get(sid)!.push({ table: t.id, column: c.name });
      }
    }
    for (const i of t.indirect) {
      const sid = colId(i);
      if (!indirectUse.has(sid)) indirectUse.set(sid, []);
      indirectUse.get(sid)!.push({ table: t.id, role: i.role });
    }
  }
  for (const t of result.tables) if (!tableDown.has(t.id)) tableDown.set(t.id, new Set());
  return { result, tables, columns, up, down, tableUp, tableDown, indirectUse };
}

export interface Reached extends ColumnRef {
  depth: number;
  transform?: Transform;
}

function bfs(start: ColumnRef, next: (id: string) => ColumnRef[] | undefined, ix: LineageIndex): Reached[] {
  const out: Reached[] = [];
  const seen = new Set([colId(start)]);
  let frontier = [start];
  for (let depth = 1; frontier.length; depth++) {
    const nextFrontier: ColumnRef[] = [];
    for (const ref of frontier) {
      for (const n of next(colId(ref)) ?? []) {
        const id = colId(n);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ ...n, depth, transform: ix.columns.get(id)?.transform });
        nextFrontier.push(n);
      }
    }
    frontier = nextFrontier;
  }
  return out;
}

export const traceUpstream = (ix: LineageIndex, ref: ColumnRef) => bfs(ref, (id) => ix.up.get(id), ix);
export const traceDownstream = (ix: LineageIndex, ref: ColumnRef) => bfs(ref, (id) => ix.down.get(id), ix);

/** Root sources: upstream columns that are not themselves derived from anything. */
export function rootSources(ix: LineageIndex, ref: ColumnRef): Reached[] {
  return traceUpstream(ix, ref).filter((r) => (ix.up.get(colId(r)) ?? []).length === 0);
}

export interface Impact {
  columns: number;
  tables: number;
  reports: number;
  byTable: { table: string; layer: Layer; columns: Reached[] }[];
  /** Downstream tables that filter / join / group on this column (row-level impact). */
  indirect: { table: string; role: string }[];
}

export function impactOf(ix: LineageIndex, ref: ColumnRef): Impact {
  const reached = traceDownstream(ix, ref);
  const groups = new Map<string, Reached[]>();
  for (const r of reached) groups.set(r.table, [...(groups.get(r.table) ?? []), r]);
  const byTable = [...groups].map(([table, columns]) => ({ table, layer: layerOf(ix.tables.get(table) ?? { id: table, kind: 'table' }), columns: columns.sort((a, b) => a.depth - b.depth) }));
  byTable.sort((a, b) => Math.min(...a.columns.map((c) => c.depth)) - Math.min(...b.columns.map((c) => c.depth)) || a.table.localeCompare(b.table));
  // Row-level impact from the column itself and everything derived from it.
  const indirect = new Map<string, { table: string; role: string }>();
  for (const r of [ref, ...reached]) for (const u of ix.indirectUse.get(colId(r)) ?? []) indirect.set(`${u.table}:${u.role}`, u);
  return {
    columns: reached.length,
    tables: groups.size,
    reports: byTable.filter((g) => g.layer === 'report' || ix.tables.get(g.table)?.kind === 'view').length,
    byTable,
    indirect: [...indirect.values()],
  };
}

/** All tables reachable from a table, in one direction, with their distance. */
export function tableReach(ix: LineageIndex, id: string, dir: 'up' | 'down'): Map<string, number> {
  const adj = dir === 'up' ? ix.tableUp : ix.tableDown;
  const out = new Map<string, number>();
  let frontier = [id];
  for (let d = 1; frontier.length; d++) {
    const next: string[] = [];
    for (const t of frontier) for (const n of adj.get(t) ?? []) if (!out.has(n) && n !== id) (out.set(n, d), next.push(n));
    frontier = next;
  }
  return out;
}

/** Column ids in the full upstream and downstream closure of a column, for highlighting. */
export function closure(ix: LineageIndex, ref: ColumnRef): { up: Set<string>; down: Set<string> } {
  return { up: new Set(traceUpstream(ix, ref).map(colId)), down: new Set(traceDownstream(ix, ref).map(colId)) };
}

// ----------------------------------------------------------------- issues

export interface GraphIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  title: string;
  detail: string;
  table?: string;
  column?: string;
}

const PII = /(^|_)(email|e_mail|phone|mobile|ssn|passport|national_id|address|street|postcode|zip|dob|birth|first_name|last_name|full_name|ip_address)(_|$)/i;

/** Graph-level checks on top of the parser's own problems. */
export function graphIssues(ix: LineageIndex): GraphIssue[] {
  const out: GraphIssue[] = [];
  const used = new Set<string>();
  for (const [id, consumers] of ix.down) if (consumers.length) used.add(id);
  for (const id of ix.indirectUse.keys()) used.add(id);

  for (const t of ix.result.tables) {
    const layer = layerOf(t);
    const consumers = ix.tableDown.get(t.id) ?? new Set();
    const terminal = layer === 'gold' || layer === 'report' || t.kind === 'view' || t.kind === 'query';
    if (consumers.size === 0) {
      if (t.kind === 'source') out.push({ severity: 'info', code: 'unused_source', title: `${displayName(t.id)} is never read`, detail: 'Declared as a source, but no model in this project reads it.', table: t.id });
      else if (!terminal && t.kind !== 'external') out.push({ severity: 'warning', code: 'orphan_model', title: `${displayName(t.id)} is built but nothing reads it`, detail: `A ${layer} model with no downstream consumers costs compute every run. Remove it, or check for a missing reference.`, table: t.id });
      continue;
    }
    const dead = t.columns.filter((c) => !used.has(colId({ table: t.id, column: c.name })));
    if (dead.length && !terminal) {
      out.push({
        severity: 'info',
        code: 'unused_columns',
        title: `${dead.length} unused column${dead.length > 1 ? 's' : ''} in ${displayName(t.id)}`,
        detail: `${dead.map((c) => c.name).join(', ')} ${dead.length > 1 ? 'are' : 'is'} carried here but never used downstream. Dropping ${dead.length > 1 ? 'them' : 'it'} reduces storage and scan cost.`,
        table: t.id,
      });
    }
  }

  // PII reaching gold or reporting layers.
  for (const t of ix.result.tables) {
    if (!['bronze', 'source', 'silver'].includes(layerOf(t))) continue;
    for (const c of t.columns) {
      // Report PII once, at its origin, not again for every copy of it along the way.
      if (!PII.test(c.name) || c.sources.some((s) => PII.test(s.column))) continue;
      const reach = traceDownstream(ix, { table: t.id, column: c.name }).filter((r) => ['gold', 'report'].includes(layerOf(ix.tables.get(r.table) ?? { id: r.table, kind: 'table' })));
      if (reach.length) {
        const where = [...new Set(reach.map((r) => displayName(r.table)))];
        out.push({ severity: 'warning', code: 'pii_propagation', title: `Possible PII ${displayName(t.id)}.${c.name} reaches ${where.length} gold/reporting table${where.length > 1 ? 's' : ''}`, detail: `Flows into ${where.join(', ')}. Check masking and access rules.`, table: t.id, column: c.name });
      }
    }
  }

  // High-impact columns: the ones whose change would ripple furthest.
  const fanout = [...ix.columns.keys()]
    .filter((id) => ['source', 'bronze', 'silver'].includes(layerOf(ix.tables.get(parseColId(id).table)!)))
    .map((id) => ({ id, n: traceDownstream(ix, parseColId(id)).length }))
    .filter((x) => x.n >= 5)
    .sort((a, b) => b.n - a.n)
    .slice(0, 3);
  for (const { id, n } of fanout) {
    const ref = parseColId(id);
    const imp = impactOf(ix, ref);
    out.push({ severity: 'info', code: 'high_impact', title: `High-impact column: ${displayName(ref.table)}.${ref.column}`, detail: `Changing it affects ${n} columns across ${imp.tables} tables. Add tests or a data contract here.`, table: ref.table, column: ref.column });
  }
  return out;
}

export const TRANSFORM_LABEL: Record<Transform, string> = {
  direct: 'direct',
  renamed: 'renamed',
  cast: 'cast',
  derived: 'derived',
  aggregate: 'aggregate',
  window: 'window',
  constant: 'constant',
  source: 'source',
  unknown: 'unknown',
};

/** Mermaid flowchart of table-level lineage, for pasting into docs or a README. */
export function toMermaid(r: LineageResult): string {
  const safe = (id: string) => id.replace(/[^A-Za-z0-9_]/g, '_');
  const lines = ['flowchart LR'];
  for (const t of r.tables) lines.push(`  ${safe(t.id)}["${displayName(t.id)}"]`);
  for (const e of r.edges) lines.push(`  ${safe(e.source)} --> ${safe(e.target)}`);
  return lines.join('\n');
}
