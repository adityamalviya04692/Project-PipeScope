// Integration test: the bundled demo logs must produce the story the app tells.
// Lives outside src/ so the browser tsconfig never sees Node APIs.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeRun } from '../src/spark/analyze';
import { compareRuns } from '../src/spark/compare';
import { readEventLog } from '../src/spark/readLog';
import { fmtDuration, fmtPct } from '../src/lib/format';

async function load(name: string) {
  const buf = readFileSync(new URL(`../public/sample/nightly_orders_etl.${name}.eventlog.gz`, import.meta.url));
  return analyzeRun(await readEventLog(new Blob([buf]), `${name}.eventlog.gz`));
}

describe('demo event logs', async () => {
  const before = await load('before');
  const after = await load('after');

  it('prints a summary (for humans reading the test output)', () => {
    for (const [name, a] of [['before', before], ['after', after]] as const) {
      console.log(
        `${name}: ${fmtDuration(a.summary.duration)}, ${a.summary.tasks} tasks, utilisation ${fmtPct(a.summary.utilization)}, score ${a.score} (${a.grade})\n` +
          a.findings.map((f) => `  [${f.severity}] ${f.title}`).join('\n') +
          '\n  ' +
          a.sql.map((s) => `${s.label} ${fmtDuration(s.duration)}`).join(' | '),
      );
    }
  });

  it('finds every planted problem in the untuned run', () => {
    const rules = new Set(before.findings.map((f) => f.rule));
    for (const r of ['skew', 'spill', 'gc', 'small-files', 'tiny-tasks', 'single-partition', 'low-utilization', 'task-failures', 'aqe-disabled', 'broadcast-disabled', 'broadcast-candidate', 'python-udf'] as const) {
      expect(rules, r).toContain(r);
    }
    const skew = before.findings.find((f) => f.rule === 'skew')!;
    expect(skew.severity).toBe('critical');
    expect(skew.title).toContain('gold.fct_order_items');
    expect(before.grade).toBe('F');
  });

  it('maps every SQL execution to the table it builds', () => {
    expect(before.sql.map((s) => s.label)).toEqual([
      'silver.orders',
      'silver.order_items',
      'silver.customers',
      'silver.products',
      'silver.payments',
      'gold.fct_order_items',
      'gold.fct_orders',
      'gold.dim_customers',
      'gold.mart_daily_revenue',
      'gold.mart_customer_ltv',
    ]);
    expect(before.sql.find((s) => s.label === 'gold.fct_order_items')?.reads).toEqual(['silver.order_items', 'silver.orders', 'silver.products']);
  });

  it('shows the tuned run is faster and healthier', () => {
    const cmp = compareRuns(before, after);
    expect(after.summary.duration).toBeLessThan(before.summary.duration / 2.5);
    expect(after.score).toBeGreaterThanOrEqual(85);
    expect(after.findings.filter((f) => f.severity === 'critical')).toEqual([]);
    expect(cmp.resolved.map((r) => r.rule)).toEqual(expect.arrayContaining(['skew', 'spill', 'small-files', 'single-partition', 'python-udf', 'aqe-disabled']));
  });
});
