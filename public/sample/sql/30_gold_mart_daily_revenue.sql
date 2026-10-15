-- Mart: daily revenue by product category, feeds the executive dashboard.
CREATE OR REPLACE TABLE gold.mart_daily_revenue USING DELTA AS
SELECT
  order_date,
  category,
  SUM(line_amount)          AS revenue,
  COUNT(DISTINCT order_id)  AS orders,
  SUM(quantity)             AS units
FROM gold.fct_order_items
GROUP BY order_date, category;
