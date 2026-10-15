-- Silver customers: latest record per customer. Phone is deliberately dropped (PII).
CREATE OR REPLACE TABLE silver.customers USING DELTA AS
SELECT
  customer_id,
  INITCAP(TRIM(full_name))  AS full_name,
  LOWER(TRIM(email))        AS email,
  city,
  state,
  signup_date,
  marketing_opt_in
FROM bronze.raw_customers
QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY ingested_at DESC) = 1;
