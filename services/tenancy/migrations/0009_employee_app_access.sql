-- Employee-portal people keep filing their own expense claims. 0008 limited
-- everyone who is not an owner or admin to Boards; for people whose only role
-- is Employee that also hid the claims screen their role exists to give them.
UPDATE members m
   SET app_access = ARRAY['expenses', 'tasks']
 WHERE m.app_access = ARRAY['tasks']
   AND EXISTS (SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.member_id = m.id)
   AND NOT EXISTS (
     SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id
      WHERE mr.member_id = m.id AND r.slug <> 'employee'
   );

UPDATE organizations SET epoch = epoch + 1;
