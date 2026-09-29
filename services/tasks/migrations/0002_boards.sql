-- ════════════════════════════════════════════════════════════════════════════
-- Boards with their own membership.
--
-- A project is a board. A board is either open to the whole workspace or
-- private to the people added to it — so an owner can give one employee one
-- board and another employee another, and neither sees the other's work.
--
--   owner   manages the board: settings, members, archive
--   editor  creates, edits and assigns tasks on the board
--   viewer  reads the board
--
-- Workspace admins (tasks.boards.manage) see and manage every board.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'workspace'
    CHECK (visibility IN ('workspace', 'private')),
  ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT 'violet'
    CHECK (color IN ('violet', 'indigo', 'blue', 'cyan', 'emerald', 'amber', 'orange', 'rose', 'slate'));

CREATE TABLE IF NOT EXISTS project_members (
  org_id     text NOT NULL,
  project_id text NOT NULL,
  user_id    text NOT NULL,
  role       text NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'editor', 'viewer')),
  added_by   text NOT NULL,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, project_id, user_id),
  FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS project_members_user_idx ON project_members (org_id, user_id);

-- Whoever created an existing project owns its board. Existing projects stay
-- visible to the workspace, exactly as they were.
INSERT INTO project_members (org_id, project_id, user_id, role, added_by)
SELECT org_id, id, created_by, 'owner', created_by FROM projects
ON CONFLICT DO NOTHING;

-- Board lists and "my tasks" filter on these.
CREATE INDEX IF NOT EXISTS tasks_org_creator_idx ON tasks (org_id, created_by) WHERE project_id IS NULL;
