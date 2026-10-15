-- Silver orders: one row per order (latest ingested version wins), cleaned status.
CREATE OR REPLACE TABLE silver.orders USING DELTA AS
WITH ranked AS (
  SELECT
    *,
    ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY ingested_at DESC) AS rn
  FROM bronze.raw_orders
)
SELECT
  order_id,
  customer_id,
  order_ts,
  CAST(order_ts AS DATE)        AS order_date,
  LOWER(TRIM(status))           AS status,
  total_amount,
  COALESCE(channel, 'web')      AS channel
FROM ranked
WHERE rn = 1
  AND order_id IS NOT NULL;
