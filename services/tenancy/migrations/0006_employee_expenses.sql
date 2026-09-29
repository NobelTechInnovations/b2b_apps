-- Employees can file their own expense claims.
--
-- Safe for the same reason as task boards: the Expenses app shows everyone
-- their own claims only, unless they hold approve or reimburse.
UPDATE roles
   SET permission_patterns = ARRAY(
         SELECT DISTINCT unnest(permission_patterns || ARRAY[
           'expenses.claims.view', 'expenses.claims.create', 'expenses.claims.edit'])),
       description = 'Their own payslips, attendance, leave, documents and expense claims, plus the task boards they are added to.'
 WHERE is_system = true AND slug = 'employee';

UPDATE organizations SET epoch = epoch + 1;

-- Administrators run the new apps day to day: assign tickets, publish
-- articles, move candidates along, reimburse claims. Billing stays denied.
UPDATE roles
   SET permission_patterns = ARRAY(
         SELECT DISTINCT unnest(permission_patterns || ARRAY['*.*.assign', '*.*.publish', '*.*.advance', '*.*.reimburse']))
 WHERE is_system = true AND slug = 'admin';
