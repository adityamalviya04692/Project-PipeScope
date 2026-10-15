-- Bronze: raw landing tables written by ingestion jobs (append-only, may contain duplicates).

CREATE TABLE IF NOT EXISTS bronze.raw_orders (
  order_id      STRING,
  customer_id   STRING,
  order_ts      TIMESTAMP,
  status        STRING,
  total_amount  DECIMAL(12, 2),
  channel       STRING,
  ingested_at   TIMESTAMP,
  _source_file  STRING
) USING DELTA;

CREATE TABLE IF NOT EXISTS bronze.raw_order_items (
  order_id      STRING,
  line_no       INT,
  product_id    STRING,
  quantity      INT,
  unit_price    DECIMAL(12, 2),
  discount_pct  DOUBLE,
  ingested_at   TIMESTAMP
) USING DELTA;

CREATE TABLE IF NOT EXISTS bronze.raw_customers (
  customer_id       STRING,
  full_name         STRING,
  email             STRING,
  phone             STRING,
  city              STRING,
  state             STRING,
  signup_date       DATE,
  marketing_opt_in  BOOLEAN,
  ingested_at       TIMESTAMP
) USING DELTA;

CREATE TABLE IF NOT EXISTS bronze.raw_products (
  product_id    STRING,
  product_name  STRING,
  category      STRING,
  subcategory   STRING,
  list_price    DECIMAL(12, 2),
  supplier_id   STRING,
  ingested_at   TIMESTAMP
) USING DELTA;

CREATE TABLE IF NOT EXISTS bronze.raw_payments (
  payment_id   STRING,
  order_id     STRING,
  method       STRING,
  amount       DECIMAL(12, 2),
  status       STRING,
  paid_at      TIMESTAMP,
  gateway_ref  STRING
) USING DELTA;
