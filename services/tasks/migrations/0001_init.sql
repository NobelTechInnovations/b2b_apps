CREATE TABLE projects (
  id text PRIMARY KEY, org_id text NOT NULL, name text NOT NULL,
  description text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','archived')),
  due_date date, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(org_id,id)
);
CREATE INDEX projects_org_idx ON projects(org_id,status,created_at);
CREATE TABLE milestones (
  id text PRIMARY KEY, org_id text NOT NULL, project_id text NOT NULL,
  title text NOT NULL, due_date date, completed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(org_id,id),
  FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id)
);
CREATE INDEX milestones_org_idx ON milestones(org_id,project_id);
CREATE TABLE tasks (
  id text PRIMARY KEY, org_id text NOT NULL, project_id text, parent_id text, milestone_id text,
  title text NOT NULL, description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','blocked','done')),
  priority text NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
  assignee_id text, due_date date,
  source_app text, source_type text, source_id text,
  created_by text NOT NULL, completed_at timestamptz, archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id,id),
  FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
  FOREIGN KEY(org_id,parent_id) REFERENCES tasks(org_id,id),
  FOREIGN KEY(org_id,milestone_id) REFERENCES milestones(org_id,id),
  CHECK ((source_app IS NULL AND source_type IS NULL AND source_id IS NULL) OR
         (source_app IS NOT NULL AND source_type IS NOT NULL AND source_id IS NOT NULL))
);
CREATE INDEX tasks_org_board_idx ON tasks(org_id,project_id,status,due_date);
CREATE INDEX tasks_org_assignee_idx ON tasks(org_id,assignee_id,status);
CREATE INDEX tasks_org_parent_idx ON tasks(org_id,parent_id);
CREATE INDEX tasks_org_source_idx ON tasks(org_id,source_app,source_type,source_id);
CREATE TABLE comments (
  id text PRIMARY KEY, org_id text NOT NULL, task_id text NOT NULL, body text NOT NULL,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(org_id,task_id) REFERENCES tasks(org_id,id)
);
CREATE INDEX comments_org_idx ON comments(org_id,task_id,created_at);
CREATE TABLE time_entries (
  id text PRIMARY KEY, org_id text NOT NULL, task_id text NOT NULL, user_id text NOT NULL,
  minutes integer NOT NULL CHECK(minutes BETWEEN 1 AND 1440), worked_on date NOT NULL,
  note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(org_id,task_id) REFERENCES tasks(org_id,id)
);
CREATE INDEX time_org_idx ON time_entries(org_id,worked_on,user_id);
CREATE TABLE attachments (
  id text PRIMARY KEY, org_id text NOT NULL, task_id text NOT NULL, document_id text NOT NULL,
  name text NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id,task_id,document_id), FOREIGN KEY(org_id,task_id) REFERENCES tasks(org_id,id)
);
CREATE INDEX attachments_org_idx ON attachments(org_id,task_id);
CREATE TABLE outbox (
  id text PRIMARY KEY, type text NOT NULL, org_id text, actor_id text,
  data jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1,
  attempts integer NOT NULL DEFAULT 0, claimed_at timestamptz, published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_unpublished_idx ON outbox(created_at) WHERE published_at IS NULL;
