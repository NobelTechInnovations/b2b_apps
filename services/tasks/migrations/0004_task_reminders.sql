-- ════════════════════════════════════════════════════════════════════════════
-- Due-date reminders.
--
-- On its due date (from 9 am India time), or as soon as it is found overdue, an
-- open task reminds its assignee once. Moving the due date or reassigning the
-- task arms the reminder again.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminded_at timestamptz;

-- Open, dated tasks that have not reminded anyone yet.
CREATE INDEX IF NOT EXISTS tasks_reminder_idx ON tasks (due_date)
  WHERE reminded_at IS NULL AND archived_at IS NULL AND status <> 'done' AND due_date IS NOT NULL;
