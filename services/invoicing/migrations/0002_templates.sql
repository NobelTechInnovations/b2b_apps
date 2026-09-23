-- ════════════════════════════════════════════════════════════════════════════
-- Invoice documents.
--
-- The invoice is the record; the template is how it is presented. They are
-- separate on purpose: rebranding must not alter a single figure on an
-- invoice that has already been sent, and an invoice must be reproducible
-- years later as it was actually issued.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE invoice_templates (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  name          text NOT NULL,

  layout        text NOT NULL DEFAULT 'classic'
                  CHECK (layout IN ('classic','modern','minimal')),
  accent        text NOT NULL DEFAULT '#4f46e5',
  -- A data: URI or an https URL. Kept small: a template is read on every
  -- document render and an inlined megabyte would be felt.
  logo_url      text,
  accent_header boolean NOT NULL DEFAULT true,

  -- Seller identity as it should appear. Falls back to the workspace record
  -- when blank, but an explicit override is what lets one workspace bill
  -- under a trading name.
  seller_name    text,
  seller_address text,
  seller_gstin   text,
  seller_pan     text,
  seller_email   text,
  seller_phone   text,
  seller_website text,

  bank_name      text,
  bank_account   text,
  bank_ifsc      text,
  bank_branch    text,
  upi_id         text,

  -- What to show. A services business has no HSN codes to print.
  show_hsn       boolean NOT NULL DEFAULT true,
  show_tax_breakdown boolean NOT NULL DEFAULT true,
  show_bank_details  boolean NOT NULL DEFAULT true,
  show_amount_words  boolean NOT NULL DEFAULT true,
  show_signature     boolean NOT NULL DEFAULT true,
  show_qr            boolean NOT NULL DEFAULT false,

  terms          text,
  footer_note    text,
  signature_name text,
  signature_url  text,

  is_default     boolean NOT NULL DEFAULT false,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz
);

CREATE UNIQUE INDEX invoice_templates_org_name_key ON invoice_templates (org_id, lower(name)) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX invoice_templates_org_default_key ON invoice_templates (org_id) WHERE is_default AND archived_at IS NULL;

-- The template an invoice was issued under. Null means "whatever is default
-- now", which is right for a draft and wrong for anything sent — so issuing
-- an invoice stamps this column.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS template_id text REFERENCES invoice_templates (id) ON DELETE SET NULL;

CREATE TRIGGER invoice_templates_touch BEFORE UPDATE ON invoice_templates
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
