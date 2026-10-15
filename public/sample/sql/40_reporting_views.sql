-- Reporting views consumed by the BI tool.

CREATE OR REPLACE VIEW reporting.v_exec_dashboard AS
SELECT
  r.order_date,
  SUM(r.revenue)                              AS revenue,
  SUM(r.orders)                               AS orders,
  SUM(r.revenue) / NULLIF(SUM(r.orders), 0)   AS avg_order_value
FROM gold.mart_daily_revenue AS r
GROUP BY r.order_date;

CREATE OR REPLACE VIEW reporting.v_vip_customers AS
SELECT *
FROM gold.mart_customer_ltv
WHERE segment = 'vip';
