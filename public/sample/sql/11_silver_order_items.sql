-- Silver order items: deduplicated lines with the net line amount.
CREATE OR REPLACE TABLE silver.order_items USING DELTA AS
SELECT DISTINCT
  order_id,
  line_no,
  product_id,
  quantity,
  unit_price,
  COALESCE(discount_pct, 0)                                 AS discount_pct,
  quantity * unit_price * (1 - COALESCE(discount_pct, 0))   AS line_amount
FROM bronze.raw_order_items
WHERE quantity > 0;
