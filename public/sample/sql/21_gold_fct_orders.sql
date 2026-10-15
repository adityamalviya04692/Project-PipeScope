-- Gold fact: one row per order with item totals and what was actually paid.
CREATE OR REPLACE TABLE gold.fct_orders USING DELTA AS
WITH items AS (
  SELECT
    order_id,
    customer_id,
    order_date,
    COUNT(*)          AS items,
    SUM(line_amount)  AS gross_amount
  FROM gold.fct_order_items
  GROUP BY order_id, customer_id, order_date
),
pay AS (
  SELECT
    order_id,
    SUM(amount)  AS paid_amount,
    MAX(method)  AS payment_method
  FROM silver.payments
  GROUP BY order_id
)
SELECT
  i.order_id,
  i.customer_id,
  i.order_date,
  i.items,
  i.gross_amount,
  COALESCE(p.paid_amount, 0)                   AS paid_amount,
  p.payment_method,
  i.gross_amount - COALESCE(p.paid_amount, 0)  AS balance_due
FROM items AS i
LEFT JOIN pay AS p ON i.order_id = p.order_id;
