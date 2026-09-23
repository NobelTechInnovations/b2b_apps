-- ════════════════════════════════════════════════════════════════════════════
-- DOCUMENTS — the file vault, plus the spreadsheet engine that turns an
-- uploaded workbook into records in other apps.
--
-- Blobs are content-addressed: the same bytes uploaded twice are stored once
-- and referenced twice. Quota counts unique bytes, so re-sharing a 40 MB deck
-- does not cost a customer 40 MB again.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE blobs (
  checksum     text PRIMARY KEY,           -- sha256 of the content
  org_id       text NOT NULL,              -- blobs are never shared across tenants
  byte_size    bigint NOT NULL,
  mime_type    text NOT NULL,
  storage_key  text NOT NULL,
  ref_count    integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX blobs_org_idx ON blobs (org_id);

-- ── folders ─────────────────────────────────────────────────────────────────
CREATE TABLE folders (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  name        text NOT NULL,
  parent_id   text REFERENCES folders (id) ON DELETE CASCADE,
  -- Materialised path ('/', '/inv/', '/inv/2026/') so a subtree is one
  -- indexed prefix scan rather than a recursive walk per request.
  path        text NOT NULL,
  colour      text NOT NULL DEFAULT 'slate',
  is_system   boolean NOT NULL DEFAULT false,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE UNIQUE INDEX folders_org_parent_name_key
  ON folders (org_id, COALESCE(parent_id, ''), lower(name)) WHERE archived_at IS NULL;
CREATE INDEX folders_org_path_idx ON folders (org_id, path) WHERE archived_at IS NULL;

-- ── documents ───────────────────────────────────────────────────────────────
CREATE TABLE documents (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  folder_id     text REFERENCES folders (id) ON DELETE SET NULL,
  name          text NOT NULL,
  description   text,
  kind          text NOT NULL DEFAULT 'file'
                  CHECK (kind IN ('file', 'spreadsheet', 'document', 'image', 'pdf', 'archive')),
  current_version integer NOT NULL DEFAULT 1,
  checksum      text REFERENCES blobs (checksum),
  byte_size     bigint NOT NULL DEFAULT 0,
  mime_type     text,
  extension     text,
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'pending_approval', 'approved', 'rejected', 'archived')),
  -- Spreadsheet structure, profiled on upload. Null for everything else.
  sheet_profile jsonb,
  tags          text[] NOT NULL DEFAULT '{}',
  owner_user_id text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);

CREATE INDEX documents_org_idx        ON documents (org_id, created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX documents_org_folder_idx ON documents (org_id, folder_id)       WHERE archived_at IS NULL;
CREATE INDEX documents_org_kind_idx   ON documents (org_id, kind)            WHERE archived_at IS NULL;
CREATE INDEX documents_org_name_idx   ON documents (org_id, lower(name))     WHERE archived_at IS NULL;
CREATE INDEX documents_org_tags_idx   ON documents USING gin (tags);

-- Every upload to a document keeps the one before it.
CREATE TABLE document_versions (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  document_id  text NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  version      integer NOT NULL,
  checksum     text NOT NULL REFERENCES blobs (checksum),
  byte_size    bigint NOT NULL,
  mime_type    text,
  note         text,
  uploaded_by  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX document_versions_key ON document_versions (document_id, version);
CREATE INDEX document_versions_org_idx ON document_versions (org_id, created_at DESC);

-- ── sharing ─────────────────────────────────────────────────────────────────
-- A grant on a folder cascades to everything beneath it via the path prefix.
CREATE TABLE shares (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('document', 'folder')),
  subject_id  text NOT NULL,
  grantee_type text NOT NULL CHECK (grantee_type IN ('member', 'role', 'workspace')),
  grantee_id  text,
  access      text NOT NULL DEFAULT 'view' CHECK (access IN ('view', 'comment', 'edit', 'manage')),
  granted_by  text,
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX shares_key ON shares (subject_type, subject_id, grantee_type, COALESCE(grantee_id, ''));
CREATE INDEX shares_org_idx ON shares (org_id, subject_id);

-- ── approvals ───────────────────────────────────────────────────────────────
CREATE TABLE approvals (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  document_id  text NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  version      integer NOT NULL,
  requested_by text NOT NULL,
  approver_id  text,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  note         text,
  decision_note text,
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX approvals_org_status_idx ON approvals (org_id, status);
CREATE INDEX approvals_doc_idx        ON approvals (org_id, document_id, created_at DESC);

-- ── import jobs ─────────────────────────────────────────────────────────────
-- The bridge from a spreadsheet to records in another app.
CREATE TABLE import_jobs (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  document_id   text NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  sheet_name    text NOT NULL,
  target_key    text NOT NULL,
  mapping       jsonb NOT NULL DEFAULT '{}',
  options       jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'validated', 'running', 'completed', 'failed', 'cancelled')),
  total_rows    integer NOT NULL DEFAULT 0,
  valid_rows    integer NOT NULL DEFAULT 0,
  warning_rows  integer NOT NULL DEFAULT 0,
  error_rows    integer NOT NULL DEFAULT 0,
  created_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  failed_count  integer NOT NULL DEFAULT 0,
  started_at    timestamptz,
  finished_at   timestamptz,
  error_message text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX import_jobs_org_idx ON import_jobs (org_id, created_at DESC);
CREATE INDEX import_jobs_doc_idx ON import_jobs (org_id, document_id);

-- Per-row outcome. Kept so a partly-failed import can be explained line by
-- line and the failures exported for correction.
CREATE TABLE import_rows (
  id          bigserial PRIMARY KEY,
  org_id      text NOT NULL,
  job_id      text NOT NULL REFERENCES import_jobs (id) ON DELETE CASCADE,
  row_number  integer NOT NULL,
  severity    text NOT NULL DEFAULT 'ok' CHECK (severity IN ('ok', 'warning', 'error')),
  outcome     text CHECK (outcome IN ('created', 'updated', 'skipped', 'failed')),
  issues      jsonb NOT NULL DEFAULT '[]',
  payload     jsonb NOT NULL DEFAULT '{}',
  target_id   text
);

CREATE UNIQUE INDEX import_rows_key ON import_rows (job_id, row_number);
CREATE INDEX import_rows_severity_idx ON import_rows (job_id, severity);

-- ── outbox ──────────────────────────────────────────────────────────────────
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

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER documents_touch   BEFORE UPDATE ON documents   FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER folders_touch     BEFORE UPDATE ON folders     FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER import_jobs_touch BEFORE UPDATE ON import_jobs FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
