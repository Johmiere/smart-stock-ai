-- Apply after migrations/001_ssai_demo_extension.sql to the existing database.
-- Unknown planned prices and season months remain NULL for existing products.
ALTER TABLE product
  ADD COLUMN IF NOT EXISTS product_projected_price DECIMAL(10,2) NULL,
  ADD COLUMN IF NOT EXISTS season_start_month TINYINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS season_end_month TINYINT UNSIGNED NULL;
