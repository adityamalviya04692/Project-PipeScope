-- Mart: customer value segments and rankings for the CRM team.
CREATE OR REPLACE TABLE gold.mart_customer_ltv USING DELTA AS
SELECT
  d.customer_id,
  CASE
    WHEN d.lifetime_value >= 50000 THEN 'vip'
    WHEN d.lifetime_value >= 10000 THEN 'loyal'
    ELSE 'standard'
  END                                                        AS segment,
  d.lifetime_value,
  d.order_count,
  RANK() OVER (
    PARTITION BY CASE WHEN d.lifetime_value >= 50000 THEN 'vip' WHEN d.lifetime_value >= 10000 THEN 'loyal' ELSE 'standard' END
    ORDER BY d.lifetime_value DESC
  )                                                          AS rank_in_segment,
  NTILE(10) OVER (ORDER BY d.lifetime_value DESC)            AS ltv_decile
FROM gold.dim_customers AS d;
