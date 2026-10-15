-- Gold dimension: customers with lifetime order statistics.
CREATE OR REPLACE TABLE gold.dim_customers USING DELTA AS
SELECT
  c.customer_id,
  c.full_name,
  c.city,
  c.state,
  c.signup_date,
  MIN(o.order_date)                                AS first_order_date,
  MAX(o.order_date)                                AS last_order_date,
  COUNT(o.order_id)                                AS order_count,
  COALESCE(SUM(o.gross_amount), 0)                 AS lifetime_value,
  COALESCE(AVG(o.gross_amount), 0)                 AS avg_order_value,
  DATEDIFF(CURRENT_DATE(), MAX(o.order_date))      AS days_since_last_order
FROM silver.customers AS c
LEFT JOIN gold.fct_orders AS o ON c.customer_id = o.customer_id
GROUP BY c.customer_id, c.full_name, c.city, c.state, c.signup_date;
