/** Shape of the JSON returned by src/python/pipescope_lineage.py. */

export type Transform = 'direct' | 'renamed' | 'cast' | 'derived' | 'aggregate' | 'window' | 'constant' | 'source' | 'unknown';

export interface ColumnRef {
  table: string;
  column: string;
}

export interface DbtTest {
  name: string;
  unique_id: string;
}

export interface LineageColumn {
  name: string;
  type: string | null;
  transform: Transform;
  expression: string;
  /** Intermediate expressions from the output back towards the sources (CTEs, subqueries). */
  path: string[];
  sources: ColumnRef[];
  description?: string | null;
  tests?: DbtTest[];
}

export type TableKind = 'source' | 'external' | 'table' | 'view' | 'query';

export interface LineageTable {
  id: string;
  kind: TableKind;
  files: string[];
  statements: { kind: string; file: string; sql: string }[];
  columns: LineageColumn[];
  upstream: string[];
  indirect: (ColumnRef & { role: 'filter' | 'join' | 'group' })[];
  description: string | null;
  tests?: DbtTest[];
  dbt?: { unique_id: string; materialized?: string; tags: string[]; path?: string };
}

export interface LineageProblem {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  file?: string;
  table?: string;
  column?: string;
}

export interface LineageResult {
  version: string;
  sqlglot: string;
  dialect: string;
  tables: LineageTable[];
  edges: { source: string; target: string }[];
  problems: LineageProblem[];
  meta: { source: 'sql' | 'dbt'; adapter?: string; project?: string; dbt_version?: string };
  stats: { files: number; statements: number; skipped: number; tables: number; columns: number; column_edges: number; elapsed_ms: number };
}

export interface SqlFile {
  name: string;
  sql: string;
}

export interface LineageInput {
  files?: SqlFile[];
  manifest?: string;
  dialect?: string;
}
