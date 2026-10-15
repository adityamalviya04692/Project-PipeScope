-- Silver payments: captured payments only.
CREATE OR REPLACE TABLE silver.payments USING DELTA AS
SELECT
  payment_id,
  order_id,
  LOWER(method)  AS method,
  amount,
  paid_at
FROM bronze.raw_payments
WHERE status = 'captured';
