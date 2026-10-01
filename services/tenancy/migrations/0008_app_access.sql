-- Which apps each person may open.
--
-- A workspace switches an app on for the company; this decides who in the
-- company sees it. NULL means every app the workspace has. Owners and
-- administrators are never limited, whatever is stored here.
--
-- Permissions still decide what someone may do inside an app they can open;
-- their own self-service records (payslips, leave) stay reachable regardless.
ALTER TABLE members     ADD COLUMN app_access text[];
ALTER TABLE invitations ADD COLUMN app_access text[];

-- Until now every member saw every app. From here on people see Tasks &
-- Boards until an owner or administrator gives them more.
UPDATE members m
   SET app_access = ARRAY['tasks']
 WHERE m.status <> 'removed'
   AND NOT EXISTS (
     SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id
      WHERE mr.member_id = m.id AND r.slug IN ('owner', 'admin')
   );

UPDATE organizations SET epoch = epoch + 1;
