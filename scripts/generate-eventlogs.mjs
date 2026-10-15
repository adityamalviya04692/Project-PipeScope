// Generates two synthetic-but-realistic Spark event logs for the same nightly
// pipeline (the SQL in public/sample/sql), before and after tuning:
//
//   public/sample/nightly_orders_etl.before.eventlog.gz
//   public/sample/nightly_orders_etl.after.eventlog.gz
//
// Events use Spark's real JsonProtocol field names. Tasks are placed on
// executor cores by a small list scheduler, so timelines, concurrency and
// utilisation behave like a real cluster. Seeded, so output is reproducible.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sample');
const MB = 1024 ** 2;
const GB = 1024 ** 3;
const LAKE = 'abfss://lake@pipescopedemo.dfs.core.windows.net';

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------- plan strings

const N = (text, ...children) => ({ text, children });
function render(n, prefix = '', root = true, last = true) {
  const out = [root ? n.text : `${prefix}${last ? '+- ' : ':- '}${n.text}`];
  const next = root ? '' : prefix + (last ? '   ' : ':  ');
  n.children.forEach((c, i) => out.push(...render(c, next, false, i === n.children.length - 1)));
  return out;
}
let attr = 10;
const cols = (names) => names.map((c) => `${c}#${attr++}`);
const scan = (t, names) =>
  N(`FileScan parquet spark_catalog.${t}[${cols(names).join(',')}] Batched: true, DataFilters: [], Format: Parquet, Location: PreparedDeltaFileIndex(1 paths)[${LAKE}/${t.replace('.', '/')}], PartitionFilters: [], PushedFilters: [], ReadSchema: struct<${names.map((c) => `${c}:string`).join(',')}>`);

function planText(root, aqe) {
  const tree = render(aqe ? N('AdaptiveSparkPlan isFinalPlan=true', root) : root).join('\n');
  return `== Physical Plan ==\n${tree}\n\n(1) Scan parquet\nOutput: [see tree]\n`;
}

function makePlans(aqe) {
  let id = 0;
  const ex = (key, child) =>
    aqe
      ? N('AQEShuffleRead coalesced', N(`ShuffleQueryStage ${id}`, N(`Exchange hashpartitioning(${key}, 200), ENSURE_REQUIREMENTS, [plan_id=${++id}]`, child)))
      : N(`Exchange hashpartitioning(${key}, 200), ENSURE_REQUIREMENTS, [plan_id=${++id}]`, child);
  const write = (t, child) => N(`Execute AtomicReplaceTableAsSelect spark_catalog.${t}, [provider=delta], true`, child);
  const sort = (key, child) => N(`Sort [${key} ASC NULLS FIRST], false, 0`, child);
  const agg = (key, child) => N(`HashAggregate(keys=[${key}], functions=[sum(amount), count(1)])`, child);

  return {
    'silver.orders': write('silver.orders', N('Project [order_id, customer_id, order_ts, status, total_amount]', N('Filter (rn = 1)', N('Window [row_number() windowspecdefinition(order_id, ingested_at DESC NULLS LAST) AS rn], [order_id], [ingested_at DESC NULLS LAST]', sort('order_id', ex('order_id', N('Project [order_id, customer_id, order_ts, status, total_amount, ingested_at]', scan('bronze.raw_orders', ['order_id', 'customer_id', 'order_ts', 'status', 'total_amount', 'ingested_at'])))))))),
    'silver.order_items': write('silver.order_items', agg('order_id, line_no', ex('order_id, line_no', agg('order_id, line_no', scan('bronze.raw_order_items', ['order_id', 'line_no', 'product_id', 'quantity', 'unit_price']))))),
    'silver.customers': write('silver.customers', agg('customer_id', ex('customer_id', agg('customer_id', scan('bronze.raw_customers', ['customer_id', 'full_name', 'email', 'city', 'signup_date']))))),
    'silver.products': write('silver.products', agg('product_id', ex('product_id', agg('product_id', scan('bronze.raw_products', ['product_id', 'product_name', 'category', 'list_price']))))),
    'silver.payments': write('silver.payments', N('Project [payment_id, order_id, method, amount, paid_at]', N('Filter (status = captured)', scan('bronze.raw_payments', ['payment_id', 'order_id', 'method', 'amount', 'status', 'paid_at'])))),
    'gold.fct_order_items': aqe
      ? write('gold.fct_order_items', N('Project [order_id, line_no, customer_id, order_date, product_id, category, quantity, unit_price, line_amount]', N('BroadcastHashJoin [product_id], [product_id], Inner, BuildRight, false', N('SortMergeJoin(skew=true) [order_id], [order_id], Inner', sort('order_id', ex('order_id', scan('silver.order_items', ['order_id', 'line_no', 'product_id', 'quantity', 'unit_price']))), sort('order_id', ex('order_id', scan('silver.orders', ['order_id', 'customer_id', 'order_ts', 'status'])))), N('BroadcastQueryStage 2', N('BroadcastExchange HashedRelationBroadcastMode(List(input[0, string, true]),false), [plan_id=9]', scan('silver.products', ['product_id', 'category']))))))
      : write('gold.fct_order_items', N('Project [order_id, line_no, customer_id, order_date, product_id, category, quantity, unit_price, line_amount]', N('SortMergeJoin [product_id], [product_id], Inner', sort('product_id', ex('product_id', N('SortMergeJoin [order_id], [order_id], Inner', sort('order_id', ex('order_id', scan('silver.order_items', ['order_id', 'line_no', 'product_id', 'quantity', 'unit_price']))), sort('order_id', ex('order_id', scan('silver.orders', ['order_id', 'customer_id', 'order_ts', 'status'])))))), sort('product_id', ex('product_id', scan('silver.products', ['product_id', 'category'])))))),
    'gold.fct_orders': write('gold.fct_orders', N('Project [order_id, customer_id, order_date, items, gross_amount, paid_amount, payment_method]', N('SortMergeJoin [order_id], [order_id], LeftOuter', sort('order_id', agg('order_id', ex('order_id', agg('order_id', scan('gold.fct_order_items', ['order_id', 'customer_id', 'order_date', 'quantity', 'line_amount']))))), sort('order_id', ex('order_id', scan('silver.payments', ['order_id', 'method', 'amount'])))))),
    'gold.dim_customers': write('gold.dim_customers', N('Project [customer_id, full_name, city, signup_date, first_order_date, last_order_date, order_count, lifetime_value, avg_order_value, days_since_last_order]', N('Window [min(order_date), max(order_date), count(order_id), sum(gross_amount)] windowspecdefinition(customer_id)', sort('customer_id', N('SortMergeJoin [customer_id], [customer_id], LeftOuter', sort('customer_id', ex('customer_id', scan('silver.customers', ['customer_id', 'full_name', 'city', 'signup_date']))), sort('customer_id', ex('customer_id', scan('gold.fct_orders', ['order_id', 'customer_id', 'order_date', 'gross_amount'])))))))),
    'gold.mart_daily_revenue': write('gold.mart_daily_revenue', N('HashAggregate(keys=[order_date, category], functions=[sum(line_amount), count(DISTINCT order_id)])', ex('order_date, category', N('HashAggregate(keys=[order_date, category], functions=[partial_sum(line_amount)])', scan('gold.fct_order_items', ['order_id', 'order_date', 'category', 'line_amount']))))),
    'gold.mart_customer_ltv': aqe
      ? write('gold.mart_customer_ltv', N('Project [customer_id, segment, lifetime_value, order_count, rank_in_segment, ltv_band]', N('Window [rank() windowspecdefinition(segment, lifetime_value DESC NULLS LAST) AS rank_in_segment], [segment], [lifetime_value DESC NULLS LAST]', sort('segment', ex('segment', N('Project [customer_id, CASE WHEN (lifetime_value >= 50000) THEN vip WHEN (lifetime_value >= 10000) THEN loyal ELSE standard END AS segment]', scan('gold.dim_customers', ['customer_id', 'lifetime_value', 'order_count'])))))))
      : write('gold.mart_customer_ltv', N('Project [customer_id, segment, lifetime_value, order_count, overall_rank, ltv_band]', N('BatchEvalPython [segment_udf(lifetime_value)#91], [pythonUDF0#92]', N('Window [rank() windowspecdefinition(lifetime_value DESC NULLS LAST) AS overall_rank], [lifetime_value DESC NULLS LAST]', N('Sort [lifetime_value DESC NULLS LAST], false, 0', N('Exchange SinglePartition, ENSURE_REQUIREMENTS, [plan_id=88]', N('SortMergeJoin [customer_id], [customer_id], Inner', sort('customer_id', ex('customer_id', scan('gold.dim_customers', ['customer_id', 'lifetime_value', 'order_count']))), sort('customer_id', ex('customer_id', scan('gold.fct_orders', ['customer_id', 'order_id'])))))))))),
  };
}

// --------------------------------------------------------------- simulator

class Sim {
  constructor({ seed, start, appName, appId, props, executors, cores }) {
    this.rand = mulberry32(seed);
    this.t = start;
    this.events = [];
    this.taskId = 0;
    this.stageId = 0;
    this.jobId = 0;
    this.sqlId = 0;
    this.cores = cores;
    this.execs = new Map();
    this.nextExec = 1;
    this.emit({ Event: 'SparkListenerLogStart', 'Spark Version': '3.5.1' });
    this.emit({ Event: 'SparkListenerResourceProfileAdded', 'Resource Profile Id': 0, 'Executor Resource Requests': {}, 'Task Resource Requests': {} });
    this.emit({ Event: 'SparkListenerEnvironmentUpdate', 'JVM Information': { 'Java Version': '17.0.10 (Azul Systems, Inc.)' }, 'Spark Properties': props, 'Hadoop Properties': {}, 'System Properties': {}, 'Metrics Properties': {}, 'Classpath Entries': {} });
    this.emit({ Event: 'SparkListenerApplicationStart', 'App Name': appName, 'App ID': appId, Timestamp: this.t, User: 'svc_etl' });
    this.setExecutors(executors, 0);
    this.t += 4000;
  }

  emit(e) {
    this.events.push(e);
  }

  between(a, b) {
    return a + (b - a) * this.rand();
  }

  jitter(x, pct = 0.15) {
    return x * (1 + (this.rand() * 2 - 1) * pct);
  }

  addExecutor(at) {
    const id = String(this.nextExec++);
    this.execs.set(id, { id, host: `10.12.0.${10 + Number(id)}` });
    this.emit({ Event: 'SparkListenerExecutorAdded', Timestamp: at, 'Executor ID': id, 'Executor Info': { Host: `10.12.0.${10 + Number(id)}`, 'Total Cores': this.cores, 'Log Urls': {}, Attributes: {}, Resources: {}, 'Resource Profile Id': 0 } });
    return id;
  }

  removeExecutor(id, at, reason) {
    this.execs.delete(id);
    this.emit({ Event: 'SparkListenerExecutorRemoved', Timestamp: at, 'Executor ID': id, 'Removed Reason': reason });
  }

  /** Dynamic allocation: scale to n executors (new ones take ~2 s to start). */
  setExecutors(n, startup = 2000) {
    while (this.execs.size < n) this.addExecutor(this.t + startup);
    const ids = [...this.execs.keys()];
    while (this.execs.size > n) this.removeExecutor(ids.pop(), this.t, 'Executor killed by driver.');
    this.t += startup;
  }

  /** Runs one SQL execution made of jobs, each a list of stage specs run in order. */
  sql(table, description, plan, jobs) {
    const id = this.sqlId++;
    this.emit({ Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart', executionId: id, rootExecutionId: id, description, details: 'org.apache.spark.sql.SparkSession.sql(SparkSession.scala:638)', physicalPlanDescription: plan, sparkPlanInfo: {}, time: this.t, modifiedConfigs: {} });
    this.t += Math.round(this.between(300, 900)); // planning
    for (const stages of jobs) this.job(stages, id);
    this.t += Math.round(this.between(200, 600)); // commit
    this.emit({ Event: 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionEnd', executionId: id, time: this.t });
    this.t += Math.round(this.between(800, 2500));
    return table;
  }

  job(stages, sqlId) {
    const jobId = this.jobId++;
    const ids = new Map(stages.map((s) => [s.key, this.stageId++]));
    const info = (s) => ({ 'Stage ID': ids.get(s.key), 'Stage Attempt ID': 0, 'Stage Name': 'sql at NativeMethodAccessorImpl.java:0', 'Number of Tasks': s.n, 'RDD Info': [], 'Parent IDs': (s.parents ?? []).map((p) => ids.get(p)), Details: 'org.apache.spark.sql.Dataset.<init>(Dataset.scala:220)', Accumulables: [], 'Resource Profile Id': 0 });
    this.emit({ Event: 'SparkListenerJobStart', 'Job ID': jobId, 'Submission Time': this.t, 'Stage Infos': stages.map(info), 'Stage IDs': [...ids.values()], Properties: { 'spark.sql.execution.id': String(sqlId), 'spark.job.description': `nightly_orders_etl` } });
    for (const s of stages) this.stage(s, info(s));
    this.emit({ Event: 'SparkListenerJobEnd', 'Job ID': jobId, 'Completion Time': this.t, 'Job Result': { Result: 'JobSucceeded' } });
  }

  stage(s, info) {
    const stageId = info['Stage ID'];
    const submitted = this.t;
    this.emit({ Event: 'SparkListenerStageSubmitted', 'Stage Info': { ...info, 'Submission Time': submitted }, Properties: {} });
    const slots = [];
    for (const ex of this.execs.values()) for (let c = 0; c < this.cores; c++) slots.push({ exec: ex.id, host: ex.host, free: submitted });
    const timed = [];
    const queue = Array.from({ length: s.n }, (_, i) => ({ index: i, attempt: 0 }));
    while (queue.length) {
      const { index, attempt } = queue.shift();
      const slot = slots.reduce((m, x) => (x.free < m.free ? x : m));
      const launch = Math.round(slot.free + this.between(4, 30));
      const m = s.task(index, this);
      const fail = s.fail && s.fail.index === index && attempt === 0;
      const dur = Math.round(fail ? m.dur * 0.55 : m.dur);
      const finish = launch + dur;
      slot.free = finish;
      timed.push([finish, this.taskEnd(stageId, index, attempt, slot, launch, finish, m, fail ? s.fail.reason : null)]);
      if (fail) {
        // The executor died: its cores are gone until a replacement starts ~30 s later.
        const dead = slot.exec;
        timed.push([finish + 1, { Event: 'SparkListenerExecutorRemoved', Timestamp: finish + 1, 'Executor ID': dead, 'Removed Reason': 'Container killed by YARN for exceeding physical memory limits. 9.2 GB of 9 GB physical memory used.' }]);
        this.execs.delete(dead);
        const replacement = String(this.nextExec++);
        const host = `10.12.0.${10 + Number(replacement)}`;
        this.execs.set(replacement, { id: replacement, host });
        timed.push([finish + 30_000, { Event: 'SparkListenerExecutorAdded', Timestamp: finish + 30_000, 'Executor ID': replacement, 'Executor Info': { Host: host, 'Total Cores': this.cores, 'Log Urls': {}, Attributes: {}, Resources: {}, 'Resource Profile Id': 0 } }]);
        for (const x of slots) if (x.exec === dead) Object.assign(x, { exec: replacement, host, free: Math.max(x.free, finish + 30_000) });
        queue.push({ index, attempt: 1 });
      }
    }
    timed.sort((a, b) => a[0] - b[0]);
    for (const [, e] of timed) this.emit(e);
    this.t = Math.max(...timed.map(([t]) => t));
    this.emit({ Event: 'SparkListenerStageCompleted', 'Stage Info': { ...info, 'Submission Time': submitted, 'Completion Time': this.t } });
    this.t += Math.round(this.between(60, 250));
  }

  taskEnd(stageId, index, attempt, slot, launch, finish, m, failure) {
    const dur = finish - launch;
    const deser = Math.round(this.between(2, 25));
    const ser = Math.round(this.between(0, 3));
    const run = Math.max(0, dur - deser - ser - Math.round(this.between(1, 12)));
    const sr = failure ? 0 : m.shuffleRead ?? 0;
    return {
      Event: 'SparkListenerTaskEnd',
      'Stage ID': stageId,
      'Stage Attempt ID': 0,
      'Task Type': m.result ? 'ResultTask' : 'ShuffleMapTask',
      'Task End Reason': failure ? { Reason: failure, 'Executor ID': slot.exec, 'Exit Caused By App': true, 'Loss Reason': 'Container killed by YARN for exceeding physical memory limits. 9.2 GB of 9 GB physical memory used.' } : { Reason: 'Success' },
      'Task Info': { 'Task ID': this.taskId++, Index: index, Attempt: attempt, 'Partition ID': index, 'Launch Time': launch, 'Executor ID': slot.exec, Host: slot.host, Locality: m.input ? 'NODE_LOCAL' : 'PROCESS_LOCAL', Speculative: false, 'Getting Result Time': 0, 'Finish Time': finish, Failed: !!failure, Killed: false, Accumulables: [] },
      'Task Metrics': failure
        ? { 'Executor Run Time': run, 'JVM GC Time': Math.round(run * 0.4) }
        : {
            'Executor Deserialize Time': deser,
            'Executor Deserialize CPU Time': deser * 800_000,
            'Executor Run Time': run,
            'Executor CPU Time': Math.round(run * this.between(0.7, 0.9) * 1e6),
            'Peak Execution Memory': Math.round(Math.min(sr, 2 * GB) * 0.6),
            'Result Size': 4120,
            'JVM GC Time': Math.round(m.gc ?? run * this.between(0.01, 0.04)),
            'Result Serialization Time': ser,
            'Memory Bytes Spilled': Math.round(m.memSpill ?? 0),
            'Disk Bytes Spilled': Math.round(m.diskSpill ?? 0),
            'Shuffle Read Metrics': { 'Remote Blocks Fetched': sr ? 24 : 0, 'Local Blocks Fetched': sr ? 8 : 0, 'Fetch Wait Time': sr ? Math.round(this.between(1, 40)) : 0, 'Remote Bytes Read': Math.round(sr * 0.75), 'Remote Bytes Read To Disk': 0, 'Local Bytes Read': Math.round(sr * 0.25), 'Total Records Read': Math.round(sr / 96) },
            'Shuffle Write Metrics': { 'Shuffle Bytes Written': Math.round(m.shuffleWrite ?? 0), 'Shuffle Write Time': Math.round((m.shuffleWrite ?? 0) / 400), 'Shuffle Records Written': Math.round((m.shuffleWrite ?? 0) / 96) },
            'Input Metrics': { 'Bytes Read': Math.round(m.input ?? 0), 'Records Read': Math.round((m.input ?? 0) / 110) },
            'Output Metrics': { 'Bytes Written': Math.round(m.output ?? 0), 'Records Written': Math.round((m.output ?? 0) / 120) },
            'Updated Blocks': [],
          },
    };
  }

  finish() {
    this.emit({ Event: 'SparkListenerApplicationEnd', Timestamp: this.t });
    return this.events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  }
}

// ---------------------------------------------------------------- pipeline

const SQL_FILE = {
  'silver.orders': '10_silver_orders.sql',
  'silver.order_items': '11_silver_order_items.sql',
  'silver.customers': '12_silver_customers.sql',
  'silver.products': '13_silver_products.sql',
  'silver.payments': '14_silver_payments.sql',
  'gold.fct_order_items': '20_gold_fct_order_items.sql',
  'gold.fct_orders': '21_gold_fct_orders.sql',
  'gold.dim_customers': '22_gold_dim_customers.sql',
  'gold.mart_daily_revenue': '30_gold_mart_daily_revenue.sql',
  'gold.mart_customer_ltv': '31_gold_mart_customer_ltv.sql',
};

function pipeline(sim, tuned) {
  const plans = makePlans(tuned);
  const S = (n, task, extra = {}) => ({ n, task, ...extra });
  const scanTask = (sizeMb, msPerMb, writeRatio, base = 300) => (_i, x) => {
    const input = x.jitter(sizeMb * MB, 0.25);
    return { input, dur: base + (input / MB) * msPerMb * x.jitter(1, 0.2), shuffleWrite: input * writeRatio };
  };
  const shuffleTask = (readMb, msPerMb, extra = () => ({}), base = 200) => (i, x) => {
    const shuffleRead = x.jitter(readMb * MB, 0.3);
    return { shuffleRead, dur: base + (shuffleRead / MB) * msPerMb * x.jitter(1, 0.2), output: shuffleRead * 0.7, result: true, ...extra(i, x, shuffleRead) };
  };
  const run = (table, jobs, executors) => {
    if (tuned && executors) sim.setExecutors(executors);
    sim.sql(table, `CREATE OR REPLACE TABLE ${table} AS SELECT …  -- models/${SQL_FILE[table]}`, planText(plans[table], tuned), jobs);
  };

  // silver.orders: bronze landing zone has 1,200 tiny files until it is compacted
  run('silver.orders', [[
    tuned ? { key: 'a', ...S(40, scanTask(62, 38, 0.55, 600)) } : { key: 'a', ...S(1200, scanTask(2, 110, 0.55, 140)) },
    { key: 'b', parents: ['a'], ...(tuned ? S(12, shuffleTask(110, 40)) : S(200, shuffleTask(6.6, 160))) },
  ]], 4);

  // silver.order_items: one executor is OOM-killed in the untuned run
  run('silver.order_items', [[
    { key: 'a', ...S(64, scanTask(128, 55, 0.6, 400)), ...(tuned ? {} : { fail: { index: 37, reason: 'ExecutorLostFailure' } }) },
    { key: 'b', parents: ['a'], ...(tuned ? S(40, shuffleTask(122, 42)) : S(200, shuffleTask(25, 120))) },
  ]], 6);

  run('silver.customers', [[
    { key: 'a', ...S(8, scanTask(30, 50, 0.8)) },
    { key: 'b', parents: ['a'], ...(tuned ? S(2, shuffleTask(95, 12)) : S(200, shuffleTask(0.1, 200, undefined, 25))) },
  ]], 2);

  run('silver.products', [[
    { key: 'a', ...S(2, scanTask(3, 60, 0.9)) },
    { key: 'b', parents: ['a'], ...(tuned ? S(1, shuffleTask(5, 40)) : S(200, shuffleTask(0.03, 200, undefined, 20))) },
  ]], 2);

  run('silver.payments', [[{ key: 'a', ...S(24, (i, x) => ({ ...scanTask(90, 42, 0, 400)(i, x), shuffleWrite: 0, output: 70 * MB, result: true })) }]], 4);

  // gold.fct_order_items: the hot product_id meets a shuffled sort-merge join
  const HOT = 117;
  if (tuned) {
    run('gold.fct_order_items', [
      [{ key: 'p', ...S(1, scanTask(4, 80, 0)) }], // broadcast build side
      [
        { key: 'a', ...S(48, scanTask(120, 40, 0.92, 400)) },
        { key: 'b', ...S(16, scanTask(60, 42, 0.85, 400)) },
        // AQE: 60 coalesced partitions plus the hot one split into 12 pieces
        { key: 'd', parents: ['a', 'b'], ...S(72, (i, x) => (i >= 60 ? { shuffleRead: x.jitter(330 * MB, 0.1), dur: x.between(20_000, 26_000), output: 260 * MB, result: true } : shuffleTask(98, 70)(i, x))) },
      ],
    ], 8);
  } else {
    run('gold.fct_order_items', [[
      { key: 'a', ...S(48, scanTask(120, 40, 0.92, 400)) },
      { key: 'b', ...S(16, scanTask(60, 42, 0.85, 400)) },
      { key: 'c', ...S(1, scanTask(4, 80, 0.75)) },
      { key: 'd', parents: ['a', 'b'], ...S(200, shuffleTask(30, 105, () => ({ shuffleWrite: 28 * MB, output: 0, result: false }))) },
      {
        key: 'e',
        parents: ['d', 'c'],
        ...S(200, (i, x) =>
          i === HOT
            ? { shuffleRead: 3.9 * GB, dur: 810_000, gc: 285_000, diskSpill: 6.8 * GB, memSpill: 14.2 * GB, output: 3.1 * GB, result: true }
            : shuffleTask(26, 125)(i, x)),
      },
    ]], 8);
  }

  run('gold.fct_orders', [[
    { key: 'a', ...S(40, scanTask(130, 30, 0.45, 400)) },
    { key: 'b', ...S(24, scanTask(90, 32, 0.45, 400)) },
    { key: 'c', parents: ['a', 'b'], ...(tuned ? S(28, shuffleTask(120, 55)) : S(200, shuffleTask(17, 140))) },
  ]], 6);

  // gold.dim_customers: window functions on 8 GB executors spill and thrash GC
  run('gold.dim_customers', [[
    { key: 'a', ...S(8, scanTask(30, 50, 0.8)) },
    { key: 'b', ...S(32, scanTask(100, 32, 0.9, 400)) },
    {
      key: 'c',
      parents: ['a', 'b'],
      ...(tuned
        ? S(24, shuffleTask(125, 80, (_i, x, sr) => ({ gc: 0.05 * (sr / MB) * 80, diskSpill: 0 })))
        : S(200, (i, x) => {
            const shuffleRead = x.jitter(15 * MB, 0.25);
            const dur = x.between(9_000, 14_000);
            return { shuffleRead, dur, gc: dur * x.between(0.24, 0.33), diskSpill: x.between(70, 110) * MB, memSpill: x.between(180, 260) * MB, output: shuffleRead * 0.5, result: true };
          })),
    },
  ]], 6);

  run('gold.mart_daily_revenue', [[
    { key: 'a', ...S(40, scanTask(130, 26, 0.003, 400)) },
    { key: 'b', parents: ['a'], ...(tuned ? S(1, shuffleTask(16, 25)) : S(200, shuffleTask(0.08, 300, undefined, 35))) },
  ]], 3);

  // gold.mart_customer_ltv: a Python UDF and a global rank over one partition
  run('gold.mart_customer_ltv', [[
    { key: 'a', ...S(8, scanTask(40, 45, 0.85)) },
    { key: 'b', ...S(32, scanTask(100, 30, 0.2, 400)) },
    { key: 'c', parents: ['a', 'b'], ...(tuned ? S(6, shuffleTask(160, 18, () => ({ shuffleWrite: 50 * MB, output: 0, result: false }))) : S(200, shuffleTask(1.6, 350, () => ({ shuffleWrite: 1.5 * MB, output: 0, result: false }), 120))) },
    { key: 'd', parents: ['c'], ...(tuned ? S(3, shuffleTask(100, 80)) : S(1, () => ({ shuffleRead: 300 * MB, dur: 95_000, output: 210 * MB, gc: 9_000, result: true }))) },
  ]], 3);
}

function build(tuned) {
  const before = {
    'spark.app.name': 'nightly_orders_etl',
    'spark.master': 'yarn',
    'spark.submit.deployMode': 'cluster',
    'spark.executor.instances': '8',
    'spark.executor.cores': '4',
    'spark.executor.memory': '8g',
    'spark.driver.memory': '4g',
    'spark.sql.extensions': 'io.delta.sql.DeltaSparkSessionExtension',
    'spark.sql.catalog.spark_catalog': 'org.apache.spark.sql.delta.catalog.DeltaCatalog',
    'spark.sql.adaptive.enabled': 'false',
    'spark.sql.shuffle.partitions': '200',
    'spark.sql.autoBroadcastJoinThreshold': '-1',
    'spark.dynamicAllocation.enabled': 'false',
    'spark.eventLog.enabled': 'true',
  };
  const after = {
    ...before,
    'spark.executor.memory': '12g',
    'spark.executor.memoryOverhead': '2g',
    'spark.sql.adaptive.enabled': 'true',
    'spark.sql.adaptive.coalescePartitions.enabled': 'true',
    'spark.sql.adaptive.skewJoin.enabled': 'true',
    'spark.sql.adaptive.advisoryPartitionSizeInBytes': '128m',
    'spark.sql.autoBroadcastJoinThreshold': '10485760',
    'spark.dynamicAllocation.enabled': 'true',
    'spark.dynamicAllocation.shuffleTracking.enabled': 'true',
    'spark.dynamicAllocation.minExecutors': '2',
    'spark.dynamicAllocation.maxExecutors': '8',
    'spark.serializer': 'org.apache.spark.serializer.KryoSerializer',
  };
  delete after['spark.executor.instances'];
  const sim = new Sim({
    seed: tuned ? 2026_10_21 : 2026_10_14,
    start: tuned ? Date.UTC(2025, 9, 21, 2, 0, 0) : Date.UTC(2025, 9, 14, 2, 0, 0),
    appName: 'nightly_orders_etl',
    appId: tuned ? 'application_1760900000000_0412' : 'application_1760300000000_0388',
    props: tuned ? after : before,
    executors: tuned ? 4 : 8,
    cores: 4,
  });
  pipeline(sim, tuned);
  if (tuned) sim.setExecutors(2, 0);
  return sim.finish();
}

mkdirSync(OUT, { recursive: true });
for (const [name, tuned] of [['before', false], ['after', true]]) {
  const text = build(tuned);
  const gz = gzipSync(text, { level: 9 });
  writeFileSync(join(OUT, `nightly_orders_etl.${name}.eventlog.gz`), gz);
  const lines = text.split('\n').length - 1;
  console.log(`${name}: ${lines} events, ${(text.length / MB).toFixed(1)} MB raw, ${(gz.length / 1024).toFixed(0)} KB gzip`);
}
