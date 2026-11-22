-- Keep legacy and imported lines nullable because their historical costs are unknown.
ALTER TABLE product ADD COLUMN IF NOT EXISTS product_unit_cost DECIMAL(10,2) NULL;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS sale_unit_cost DECIMAL(10,2) NULL;
