-- Silver products: current product catalogue.
CREATE OR REPLACE TABLE silver.products USING DELTA AS
SELECT
  product_id,
  product_name,
  category,
  subcategory,
  list_price,
  supplier_id
FROM bronze.raw_products
QUALIFY ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY ingested_at DESC) = 1;
