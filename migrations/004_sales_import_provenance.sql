-- Apply after the existing backend migrations. Existing sales remain intact.
CREATE TABLE IF NOT EXISTS sales_import_batch (
  batch_id BIGINT NOT NULL AUTO_INCREMENT,
  store_id BIGINT NOT NULL,
  imported_by BIGINT NOT NULL,
  source_type ENUM('partner_pos','unspecified') NOT NULL,
  source_label VARCHAR(120) NULL,
  file_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  imported_rows INT UNSIGNED NOT NULL,
  duplicate_rows INT UNSIGNED NOT NULL,
  skipped_rows INT UNSIGNED NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  unique_products INT UNSIGNED NOT NULL,
  units BIGINT UNSIGNED NOT NULL,
  imported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (batch_id),
  UNIQUE KEY uq_sales_import_batch_file (store_id, file_sha256),
  UNIQUE KEY uq_sales_import_batch_store (store_id, batch_id),
  CONSTRAINT fk_sales_import_batch_store FOREIGN KEY (store_id) REFERENCES store (store_id),
  CONSTRAINT fk_sales_import_batch_user FOREIGN KEY (imported_by) REFERENCES users (users_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS import_batch_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS import_line_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD UNIQUE INDEX IF NOT EXISTS uq_sales_import_line (store_id, import_line_key),
  ADD INDEX IF NOT EXISTS idx_sales_import_batch (store_id, import_batch_id),
  ADD CONSTRAINT fk_sales_import_batch FOREIGN KEY IF NOT EXISTS (store_id, import_batch_id)
    REFERENCES sales_import_batch (store_id, batch_id);
