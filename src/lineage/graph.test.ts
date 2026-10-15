import { describe, expect, it } from 'vitest';
import { fixture } from './fixture';
import { buildIndex, closure, graphIssues, impactOf, layerOf, rootSources, tableReach, toMermaid, traceUpstream } from './graph';

describe('lineage graph', () => {
  const ix = buildIndex(fixture());

  it('infers medallion layers from schema and name', () => {
    expect(layerOf({ id: 'bronze.raw_orders', kind: 'source' })).toBe('bronze');
    expect(layerOf({ id: 'analytics.dim_customer', kind: 'table' })).toBe('gold');
    expect(layerOf({ id: 'default.stg_orders', kind: 'table' })).toBe('silver');
    expect(layerOf({ id: 'reporting.v_dash', kind: 'view' })).toBe('report');
    expect(layerOf({ id: 'ext.something', kind: 'external' })).toBe('source');
  });

  it('traces upstream to root sources', () => {
    expect(traceUpstream(ix, { table: 'reporting.v_dash', column: 'total' }).map((r) => `${r.table}.${r.column}@${r.depth}`)).toEqual(['gold.fct.total@1', 'silver.orders.amount@2', 'bronze.raw_orders.amount@3']);
    expect(rootSources(ix, { table: 'gold.fct', column: 'order_id' }).map((r) => r.column)).toEqual(['id']);
  });

  it('measures the impact of changing a column, including row-level use', () => {
    const imp = impactOf(ix, { table: 'bronze.raw_orders', column: 'amount' });
    expect(imp.columns).toBe(3);
    expect(imp.tables).toBe(3);
    expect(imp.reports).toBe(1);
    expect(imp.byTable.map((g) => g.table)).toEqual(['silver.orders', 'gold.fct', 'reporting.v_dash']);
    expect(impactOf(ix, { table: 'bronze.raw_orders', column: 'notes' }).indirect).toEqual([{ table: 'silver.orders', role: 'filter' }]);
  });

  it('builds highlight closures and table reach', () => {
    const c = closure(ix, { table: 'silver.orders', column: 'amount' });
    expect([...c.up]).toEqual(['bronze.raw_orders::amount']);
    expect([...c.down]).toEqual(['gold.fct::total', 'reporting.v_dash::total']);
    expect([...tableReach(ix, 'bronze.raw_orders', 'down')]).toEqual([['silver.orders', 1], ['silver.orphan', 1], ['gold.fct', 2], ['reporting.v_dash', 3]]);
  });

  it('finds orphan models, unused sources and columns, and PII in gold (once, at its origin)', () => {
    const issues = graphIssues(ix);
    const codes = issues.map((i) => `${i.code}:${i.table}${i.column ? '.' + i.column : ''}`);
    expect(codes).toContain('orphan_model:silver.orphan');
    expect(codes).toContain('unused_source:bronze.raw_unused');
    expect(codes).toContain('unused_columns:silver.orders');
    expect(codes.filter((c) => c.startsWith('pii_propagation'))).toEqual(['pii_propagation:bronze.raw_orders.email']);
    expect(issues.find((i) => i.code === 'unused_columns')!.detail).toContain('legacy_flag');
    // "notes" is only used in a filter, which still counts as used.
    expect(issues.find((i) => i.code === 'unused_columns' && i.table === 'bronze.raw_orders')).toBeUndefined();
  });

  it('exports Mermaid', () => {
    expect(toMermaid(fixture())).toContain('bronze_raw_orders --> silver_orders');
  });
});
