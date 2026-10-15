-- Gold fact: one row per order line, enriched with order and product attributes.
CREATE OR REPLACE TABLE gold.fct_order_items USING DELTA AS
SELECT
  i.order_id,
  i.line_no,
  o.customer_id,
  o.order_date,
  i.product_id,
  p.category,
  i.quantity,
  i.unit_price,
  i.line_amount
FROM silver.order_items AS i
JOIN silver.orders      AS o ON i.order_id = o.order_id
JOIN silver.products    AS p ON i.product_id = p.product_id
WHERE o.status <> 'cancelled';
