-- ════════════════════════════════════════════════════════════════════════════
-- ERP — what a business makes, buys, holds and sells.
--
-- One service, six apps (Inventory & Purchasing, Manufacturing, Quality,
-- Maintenance, Point of Sale, Online Store), because every one of them moves
-- stock, and stock has to move in one transaction or it drifts.
--
-- Stock is a ledger: `stock_moves` is the history (append-only), and
-- `stock_quants` is the running balance per product per warehouse, updated in
-- the same transaction as the move that changed it.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE counters (
  org_id     text NOT NULL,
  kind       text NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, kind)
);

-- ── catalogue ───────────────────────────────────────────────────────────────
CREATE TABLE product_categories (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_categories_name_key ON product_categories (org_id, lower(name));

CREATE TABLE products (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  sku           text,
  name          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  category_id   text REFERENCES product_categories (id) ON DELETE SET NULL,
  -- stockable: counted in warehouses. consumable: bought and used, not counted.
  -- service: never has stock (installation, a repair visit).
  type          text NOT NULL DEFAULT 'stockable' CHECK (type IN ('stockable', 'consumable', 'service')),
  uom           text NOT NULL DEFAULT 'nos',
  barcode       text,
  hsn_sac       text,
  sale_price    numeric(14,2) NOT NULL DEFAULT 0 CHECK (sale_price >= 0),
  cost_price    numeric(14,2) NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
  tax_rate      numeric(5,2)  NOT NULL DEFAULT 18 CHECK (tax_rate >= 0 AND tax_rate <= 100),
  reorder_level numeric(14,3) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  active        boolean NOT NULL DEFAULT true,
  -- Online Store: the same product, published or not.
  online        boolean NOT NULL DEFAULT false,
  image_url     text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX products_sku_key ON products (org_id, lower(sku)) WHERE sku IS NOT NULL;
CREATE UNIQUE INDEX products_barcode_key ON products (org_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX products_org_name_idx ON products (org_id, lower(name));

CREATE TABLE warehouses (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  code        text NOT NULL,
  name        text NOT NULL,
  address     text NOT NULL DEFAULT '',
  is_default  boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX warehouses_code_key ON warehouses (org_id, lower(code));
CREATE UNIQUE INDEX warehouses_default_key ON warehouses (org_id) WHERE is_default;

CREATE TABLE stock_quants (
  org_id       text NOT NULL,
  product_id   text NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  warehouse_id text NOT NULL REFERENCES warehouses (id) ON DELETE CASCADE,
  quantity     numeric(14,3) NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, product_id, warehouse_id)
);

CREATE TABLE stock_moves (
  id                text PRIMARY KEY,
  org_id            text NOT NULL,
  product_id        text NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  from_warehouse_id text REFERENCES warehouses (id) ON DELETE SET NULL,
  to_warehouse_id   text REFERENCES warehouses (id) ON DELETE SET NULL,
  quantity          numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_cost         numeric(14,2),
  kind              text NOT NULL CHECK (kind IN ('receipt', 'delivery', 'transfer', 'adjustment_in', 'adjustment_out',
                      'production_in', 'production_out', 'scrap', 'pos_sale', 'pos_return', 'online_sale', 'online_return', 'maintenance')),
  reference         text,
  source_type       text,
  source_id         text,
  note              text,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (from_warehouse_id IS NOT NULL OR to_warehouse_id IS NOT NULL)
);
CREATE INDEX stock_moves_product_idx ON stock_moves (org_id, product_id, created_at DESC);
CREATE INDEX stock_moves_org_idx ON stock_moves (org_id, created_at DESC);

-- ── purchasing ──────────────────────────────────────────────────────────────
CREATE TABLE vendors (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL,
  name               text NOT NULL,
  contact_name       text,
  email              text,
  phone              text,
  gstin              text,
  address            text NOT NULL DEFAULT '',
  payment_terms_days integer NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 365),
  notes              text NOT NULL DEFAULT '',
  active             boolean NOT NULL DEFAULT true,
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vendors_name_key ON vendors (org_id, lower(name));

CREATE TABLE purchase_orders (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  number        text NOT NULL,
  vendor_id     text NOT NULL REFERENCES vendors (id) ON DELETE RESTRICT,
  warehouse_id  text REFERENCES warehouses (id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'approved', 'partially_received', 'received', 'cancelled')),
  order_date    date NOT NULL DEFAULT current_date,
  expected_date date,
  notes         text NOT NULL DEFAULT '',
  subtotal      numeric(14,2) NOT NULL DEFAULT 0,
  tax_total     numeric(14,2) NOT NULL DEFAULT 0,
  total         numeric(14,2) NOT NULL DEFAULT 0,
  approved_by   text,
  approved_at   timestamptz,
  received_at   timestamptz,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX purchase_orders_number_key ON purchase_orders (org_id, number);
CREATE INDEX purchase_orders_status_idx ON purchase_orders (org_id, status);

CREATE TABLE purchase_order_lines (
  id                text PRIMARY KEY,
  org_id            text NOT NULL,
  po_id             text NOT NULL REFERENCES purchase_orders (id) ON DELETE CASCADE,
  position          integer NOT NULL DEFAULT 0,
  product_id        text NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  description       text NOT NULL DEFAULT '',
  quantity          numeric(14,3) NOT NULL CHECK (quantity > 0),
  received_quantity numeric(14,3) NOT NULL DEFAULT 0,
  unit_price        numeric(14,2) NOT NULL DEFAULT 0,
  tax_rate          numeric(5,2) NOT NULL DEFAULT 0,
  line_total        numeric(14,2) NOT NULL DEFAULT 0
);
CREATE INDEX purchase_order_lines_po_idx ON purchase_order_lines (org_id, po_id, position);

-- ── manufacturing ───────────────────────────────────────────────────────────
CREATE TABLE work_centers (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL,
  name               text NOT NULL,
  code               text,
  hours_per_day      numeric(5,2) NOT NULL DEFAULT 8 CHECK (hours_per_day > 0 AND hours_per_day <= 24),
  cost_per_hour      numeric(14,2) NOT NULL DEFAULT 0,
  active             boolean NOT NULL DEFAULT true,
  notes              text NOT NULL DEFAULT '',
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX work_centers_name_key ON work_centers (org_id, lower(name));

CREATE TABLE boms (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  product_id  text NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  name        text NOT NULL DEFAULT '',
  -- The recipe makes this many units of the product.
  quantity    numeric(14,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  work_center_id text REFERENCES work_centers (id) ON DELETE SET NULL,
  hours       numeric(8,2) NOT NULL DEFAULT 0,
  notes       text NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX boms_product_idx ON boms (org_id, product_id);

CREATE TABLE bom_lines (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  bom_id      text NOT NULL REFERENCES boms (id) ON DELETE CASCADE,
  position    integer NOT NULL DEFAULT 0,
  product_id  text NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  quantity    numeric(14,3) NOT NULL CHECK (quantity > 0)
);
CREATE INDEX bom_lines_bom_idx ON bom_lines (org_id, bom_id, position);

CREATE TABLE manufacturing_orders (
  id                text PRIMARY KEY,
  org_id            text NOT NULL,
  number            text NOT NULL,
  product_id        text NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  bom_id            text NOT NULL REFERENCES boms (id) ON DELETE RESTRICT,
  quantity          numeric(14,3) NOT NULL CHECK (quantity > 0),
  produced_quantity numeric(14,3) NOT NULL DEFAULT 0,
  scrap_quantity    numeric(14,3) NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'in_progress', 'done', 'cancelled')),
  work_center_id    text REFERENCES work_centers (id) ON DELETE SET NULL,
  warehouse_id      text REFERENCES warehouses (id) ON DELETE SET NULL,
  planned_start     date,
  planned_end       date,
  started_at        timestamptz,
  finished_at       timestamptz,
  unit_cost         numeric(14,2),
  notes             text NOT NULL DEFAULT '',
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX manufacturing_orders_number_key ON manufacturing_orders (org_id, number);
CREATE INDEX manufacturing_orders_status_idx ON manufacturing_orders (org_id, status, planned_start);

-- ── quality ─────────────────────────────────────────────────────────────────
CREATE TABLE quality_plans (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  name        text NOT NULL,
  trigger     text NOT NULL DEFAULT 'receipt' CHECK (trigger IN ('receipt', 'production', 'manual')),
  -- Narrow the plan to one product or one category; neither = every product.
  product_id  text REFERENCES products (id) ON DELETE CASCADE,
  category_id text REFERENCES product_categories (id) ON DELETE CASCADE,
  checklist   jsonb NOT NULL DEFAULT '[]',
  active      boolean NOT NULL DEFAULT true,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quality_checks (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  number       text NOT NULL,
  plan_id      text REFERENCES quality_plans (id) ON DELETE SET NULL,
  product_id   text REFERENCES products (id) ON DELETE SET NULL,
  trigger      text NOT NULL DEFAULT 'manual' CHECK (trigger IN ('receipt', 'production', 'manual')),
  source_type  text,
  source_id    text,
  source_ref   text,
  quantity     numeric(14,3),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'passed', 'failed')),
  results      jsonb NOT NULL DEFAULT '[]',
  note         text NOT NULL DEFAULT '',
  performed_by text,
  performed_at timestamptz,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX quality_checks_number_key ON quality_checks (org_id, number);
CREATE INDEX quality_checks_status_idx ON quality_checks (org_id, status, created_at DESC);

CREATE TABLE quality_ncrs (
  id                text PRIMARY KEY,
  org_id            text NOT NULL,
  number            text NOT NULL,
  title             text NOT NULL,
  check_id          text REFERENCES quality_checks (id) ON DELETE SET NULL,
  product_id        text REFERENCES products (id) ON DELETE SET NULL,
  severity          text NOT NULL DEFAULT 'minor' CHECK (severity IN ('minor', 'major', 'critical')),
  description       text NOT NULL DEFAULT '',
  root_cause        text NOT NULL DEFAULT '',
  corrective_action text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved', 'closed')),
  owner_id          text,
  due_date          date,
  closed_by         text,
  closed_at         timestamptz,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX quality_ncrs_number_key ON quality_ncrs (org_id, number);

-- ── maintenance ─────────────────────────────────────────────────────────────
CREATE TABLE equipment (
  id                    text PRIMARY KEY,
  org_id                text NOT NULL,
  name                  text NOT NULL,
  code                  text,
  category              text,
  location              text,
  serial_number         text,
  work_center_id        text REFERENCES work_centers (id) ON DELETE SET NULL,
  purchase_date         date,
  warranty_until        date,
  preventive_every_days integer CHECK (preventive_every_days IS NULL OR preventive_every_days BETWEEN 1 AND 3650),
  last_maintained_on    date,
  status                text NOT NULL DEFAULT 'operational' CHECK (status IN ('operational', 'down', 'retired')),
  technician_id         text,
  notes                 text NOT NULL DEFAULT '',
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX equipment_code_key ON equipment (org_id, lower(code)) WHERE code IS NOT NULL;

CREATE TABLE maintenance_requests (
  id             text PRIMARY KEY,
  org_id         text NOT NULL,
  number         text NOT NULL,
  equipment_id   text NOT NULL REFERENCES equipment (id) ON DELETE CASCADE,
  title          text NOT NULL,
  kind           text NOT NULL DEFAULT 'corrective' CHECK (kind IN ('corrective', 'preventive')),
  priority       text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status         text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'repaired', 'scrapped', 'cancelled')),
  assignee_id    text,
  scheduled_for  date,
  started_at     timestamptz,
  completed_at   timestamptz,
  downtime_hours numeric(8,2) NOT NULL DEFAULT 0,
  description    text NOT NULL DEFAULT '',
  resolution     text NOT NULL DEFAULT '',
  parts          jsonb NOT NULL DEFAULT '[]',
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX maintenance_requests_number_key ON maintenance_requests (org_id, number);
CREATE INDEX maintenance_requests_status_idx ON maintenance_requests (org_id, status);
-- One open preventive request per machine: generating twice must not duplicate.
CREATE UNIQUE INDEX maintenance_requests_open_preventive_key ON maintenance_requests (org_id, equipment_id)
  WHERE kind = 'preventive' AND status IN ('new', 'in_progress');

-- ── point of sale ───────────────────────────────────────────────────────────
CREATE TABLE pos_registers (
  id             text PRIMARY KEY,
  org_id         text NOT NULL,
  name           text NOT NULL,
  warehouse_id   text REFERENCES warehouses (id) ON DELETE SET NULL,
  receipt_footer text NOT NULL DEFAULT 'Thank you for shopping with us!',
  active         boolean NOT NULL DEFAULT true,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pos_sessions (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  register_id   text NOT NULL REFERENCES pos_registers (id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_by     text NOT NULL,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  opening_cash  numeric(14,2) NOT NULL DEFAULT 0,
  closed_by     text,
  closed_at     timestamptz,
  expected_cash numeric(14,2),
  counted_cash  numeric(14,2),
  note          text NOT NULL DEFAULT ''
);
-- A till has one open session at a time.
CREATE UNIQUE INDEX pos_sessions_open_key ON pos_sessions (org_id, register_id) WHERE status = 'open';

CREATE TABLE pos_sales (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  number          text NOT NULL,
  session_id      text NOT NULL REFERENCES pos_sessions (id) ON DELETE RESTRICT,
  register_id     text NOT NULL REFERENCES pos_registers (id) ON DELETE RESTRICT,
  -- Generated by the till, so a sale rung up offline and synced twice is one sale.
  client_ref      text NOT NULL,
  customer_name   text,
  customer_phone  text,
  subtotal        numeric(14,2) NOT NULL DEFAULT 0,
  discount_total  numeric(14,2) NOT NULL DEFAULT 0,
  tax_total       numeric(14,2) NOT NULL DEFAULT 0,
  total           numeric(14,2) NOT NULL DEFAULT 0,
  payment_method  text NOT NULL CHECK (payment_method IN ('cash', 'card', 'upi', 'other')),
  amount_tendered numeric(14,2),
  change_due      numeric(14,2) NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'refunded')),
  refund_reason   text,
  refunded_by     text,
  refunded_at     timestamptz,
  sold_at         timestamptz NOT NULL DEFAULT now(),
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pos_sales_client_ref_key ON pos_sales (org_id, client_ref);
CREATE UNIQUE INDEX pos_sales_number_key ON pos_sales (org_id, number);
CREATE INDEX pos_sales_session_idx ON pos_sales (org_id, session_id);
CREATE INDEX pos_sales_day_idx ON pos_sales (org_id, sold_at DESC);

CREATE TABLE pos_sale_lines (
  id               text PRIMARY KEY,
  org_id           text NOT NULL,
  sale_id          text NOT NULL REFERENCES pos_sales (id) ON DELETE CASCADE,
  product_id       text REFERENCES products (id) ON DELETE SET NULL,
  name             text NOT NULL,
  quantity         numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price       numeric(14,2) NOT NULL,
  discount_percent numeric(5,2) NOT NULL DEFAULT 0,
  tax_rate         numeric(5,2) NOT NULL DEFAULT 0,
  line_total       numeric(14,2) NOT NULL
);
CREATE INDEX pos_sale_lines_sale_idx ON pos_sale_lines (org_id, sale_id);

-- ── online store ────────────────────────────────────────────────────────────
CREATE TABLE store_settings (
  org_id             text PRIMARY KEY,
  name               text NOT NULL DEFAULT '',
  tagline            text NOT NULL DEFAULT '',
  published          boolean NOT NULL DEFAULT false,
  shipping_fee       numeric(14,2) NOT NULL DEFAULT 0,
  free_shipping_over numeric(14,2),
  cod_enabled        boolean NOT NULL DEFAULT true,
  contact_email      text,
  contact_phone      text,
  warehouse_id       text REFERENCES warehouses (id) ON DELETE SET NULL,
  updated_by         text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE store_promotions (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  code        text NOT NULL,
  kind        text NOT NULL DEFAULT 'percent' CHECK (kind IN ('percent', 'amount')),
  value       numeric(14,2) NOT NULL CHECK (value > 0),
  min_order   numeric(14,2) NOT NULL DEFAULT 0,
  starts_on   date,
  ends_on     date,
  usage_limit integer CHECK (usage_limit IS NULL OR usage_limit > 0),
  used_count  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'percent' OR value <= 100)
);
CREATE UNIQUE INDEX store_promotions_code_key ON store_promotions (org_id, upper(code));

CREATE TABLE store_orders (
  id               text PRIMARY KEY,
  org_id           text NOT NULL,
  number           text NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled')),
  customer_name    text NOT NULL,
  customer_email   text,
  customer_phone   text NOT NULL,
  shipping_address jsonb NOT NULL DEFAULT '{}',
  subtotal         numeric(14,2) NOT NULL DEFAULT 0,
  discount_total   numeric(14,2) NOT NULL DEFAULT 0,
  shipping_fee     numeric(14,2) NOT NULL DEFAULT 0,
  tax_total        numeric(14,2) NOT NULL DEFAULT 0,
  total            numeric(14,2) NOT NULL DEFAULT 0,
  promo_code       text,
  payment_method   text NOT NULL DEFAULT 'cod' CHECK (payment_method IN ('cod', 'prepaid')),
  payment_status   text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid', 'refunded')),
  notes            text NOT NULL DEFAULT '',
  tracking_number  text,
  stock_reserved   boolean NOT NULL DEFAULT false,
  ip_hash          text,
  placed_at        timestamptz NOT NULL DEFAULT now(),
  confirmed_at     timestamptz,
  shipped_at       timestamptz,
  delivered_at     timestamptz,
  cancelled_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX store_orders_number_key ON store_orders (org_id, number);
CREATE INDEX store_orders_status_idx ON store_orders (org_id, status, placed_at DESC);

CREATE TABLE store_order_lines (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  order_id    text NOT NULL REFERENCES store_orders (id) ON DELETE CASCADE,
  product_id  text REFERENCES products (id) ON DELETE SET NULL,
  name        text NOT NULL,
  quantity    numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price  numeric(14,2) NOT NULL,
  tax_rate    numeric(5,2) NOT NULL DEFAULT 0,
  line_total  numeric(14,2) NOT NULL
);
CREATE INDEX store_order_lines_order_idx ON store_order_lines (org_id, order_id);

-- ── events ──────────────────────────────────────────────────────────────────
CREATE TABLE outbox (
  id           text PRIMARY KEY,
  type         text NOT NULL,
  org_id       text,
  actor_id     text,
  data         jsonb NOT NULL DEFAULT '{}',
  version      integer NOT NULL DEFAULT 1,
  attempts     integer NOT NULL DEFAULT 0,
  claimed_at   timestamptz,
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_unpublished_idx ON outbox (created_at) WHERE published_at IS NULL;
