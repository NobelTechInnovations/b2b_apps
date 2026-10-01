-- ════════════════════════════════════════════════════════════════════════════
-- A board's own Kanban columns.
--
-- A team adds "Pending", "Review" or "Waiting on client" next to To do and
-- Done. Each column still counts as one of the four task states, so "done",
-- overdue counts and reports keep meaning the same thing everywhere.
-- A task with no column sits in its board's first column for its state.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS board_columns (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  project_id  text NOT NULL,
  name        text NOT NULL,
  status      text NOT NULL CHECK (status IN ('todo', 'in_progress', 'blocked', 'done')),
  position    integer NOT NULL DEFAULT 0,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS board_columns_board_idx ON board_columns (org_id, project_id, position);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS column_id text;
