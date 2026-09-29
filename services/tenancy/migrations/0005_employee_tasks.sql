-- Employees can work on the task boards they are added to.
--
-- Safe because boards carry their own membership: with these patterns an
-- employee sees only boards they were added to and their own to-dos — never
-- another employee's board, and nothing in CRM, HR or billing.
UPDATE roles
   SET permission_patterns = ARRAY(
         SELECT DISTINCT unnest(permission_patterns || ARRAY[
           'tasks.tasks.view', 'tasks.tasks.create', 'tasks.tasks.edit',
           'tasks.projects.view', 'tasks.time.view', 'tasks.time.log']))
 WHERE is_system = true AND slug = 'employee';

UPDATE roles SET description = 'Their own payslips, attendance, leave and documents, plus the task boards they are added to.'
 WHERE is_system = true AND slug = 'employee';

UPDATE organizations SET epoch = epoch + 1;
