-- Apply after 001_ssai_demo_extension.sql to the existing application database.
-- Sales recorded before this migration remain in the General sales view.
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS sale_type ENUM('general','seasonal') NOT NULL DEFAULT 'general',
  ADD INDEX IF NOT EXISTS idx_sales_store_type_date (store_id, sale_type, sale_date);

-- Older POS clients can omit the ID. New clients reuse it for an interrupted checkout.
ALTER TABLE sale_transaction
  ADD COLUMN IF NOT EXISTS checkout_id CHAR(36) NULL,
  ADD COLUMN IF NOT EXISTS checkout_fingerprint CHAR(64) NULL,
  ADD UNIQUE INDEX IF NOT EXISTS uq_sale_transaction_checkout (store_id, checkout_id);
