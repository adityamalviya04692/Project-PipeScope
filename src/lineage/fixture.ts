// Small hand-built lineage result shared by the graph and overlay tests.
import type { LineageColumn, LineageResult, LineageTable } from './types';

const col = (name: string, sources: [string, string][] = [], transform: LineageColumn['transform'] = sources.length ? 'direct' : 'source'): LineageColumn => ({
  name,
  type: null,
  transform,
  expression: '',
  path: [],
  sources: sources.map(([table, column]) => ({ table, column })),
});

const tbl = (id: string, kind: LineageTable['kind'], columns: LineageColumn[], upstream: string[] = [], indirect: LineageTable['indirect'] = []): LineageTable => ({
  id,
  kind,
  files: [],
  statements: [],
  columns,
  upstream,
  indirect,
  description: null,
});

export function fixture(): LineageResult {
  const tables = [
    tbl('bronze.raw_orders', 'source', [col('id'), col('amount'), col('email'), col('notes')]),
    tbl('bronze.raw_unused', 'source', [col('x')]),
    tbl('silver.orders', 'table', [col('order_id', [['bronze.raw_orders', 'id']], 'renamed'), col('amount', [['bronze.raw_orders', 'amount']]), col('email', [['bronze.raw_orders', 'email']]), col('legacy_flag')], ['bronze.raw_orders'], [{ table: 'bronze.raw_orders', column: 'notes', role: 'filter' }]),
    tbl('silver.orphan', 'table', [col('a', [['bronze.raw_orders', 'id']])], ['bronze.raw_orders']),
    tbl('gold.fct', 'table', [col('order_id', [['silver.orders', 'order_id']]), col('total', [['silver.orders', 'amount']], 'aggregate'), col('contact', [['silver.orders', 'email']], 'renamed')], ['silver.orders']),
    tbl('reporting.v_dash', 'view', [col('total', [['gold.fct', 'total']], 'aggregate')], ['gold.fct']),
  ];
  return {
    version: '1',
    sqlglot: 'x',
    dialect: 'databricks',
    tables,
    edges: tables.flatMap((t) => t.upstream.map((u) => ({ source: u, target: t.id }))),
    problems: [],
    meta: { source: 'sql' },
    stats: { files: 0, statements: 0, skipped: 0, tables: tables.length, columns: 0, column_edges: 0, elapsed_ms: 0 },
  };
}
