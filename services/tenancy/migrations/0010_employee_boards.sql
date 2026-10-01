-- Employees create their own boards. A new board is private to whoever made
-- it and the people they add; owners and admins still see every board.
UPDATE roles
   SET permission_patterns = ARRAY(SELECT DISTINCT unnest(permission_patterns || ARRAY['tasks.projects.create', 'tasks.projects.edit']))
 WHERE is_system = true AND slug = 'employee';

UPDATE organizations SET epoch = epoch + 1;
