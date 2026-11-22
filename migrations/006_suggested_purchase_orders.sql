-- Keep purchase drafts and their decision history separate from stock movements.
ALTER TABLE product ADD COLUMN IF NOT EXISTS reorder_supplier VARCHAR(100) NULL;

CREATE TABLE IF NOT EXISTS reorder_draft (
  id BIGINT NOT NULL AUTO_INCREMENT,
  store_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  created_day DATE NOT NULL,
  snapshot TEXT NOT NULL,
  quantity INT NOT NULL,
  status VARCHAR(16) NOT NULL,
  version INT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reorder_store_product_day (store_id, product_id, created_day),
  CONSTRAINT fk_reorder_draft_store FOREIGN KEY (store_id) REFERENCES store(store_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS reorder_decision (
  id BIGINT NOT NULL AUTO_INCREMENT,
  draft_id BIGINT NOT NULL,
  store_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  action VARCHAR(16) NOT NULL,
  previous_quantity INT NOT NULL,
  quantity INT NOT NULL,
  note VARCHAR(240) NOT NULL,
  recorded_at VARCHAR(28) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_reorder_decision_draft (draft_id),
  KEY idx_reorder_decision_store (store_id, id),
  CONSTRAINT fk_reorder_decision_draft FOREIGN KEY (draft_id) REFERENCES reorder_draft(id),
  CONSTRAINT fk_reorder_decision_store FOREIGN KEY (store_id) REFERENCES store(store_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
