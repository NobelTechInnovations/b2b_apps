-- Extend existing system roles for the released Tasks module. Custom roles are unchanged.
UPDATE roles SET permission_patterns = array_append(permission_patterns, 'tasks.time.log')
WHERE is_system = true AND slug IN ('admin','member') AND NOT ('tasks.time.log' = ANY(permission_patterns));
UPDATE roles SET permission_patterns = array_append(permission_patterns, 'tasks.tasks.assign')
WHERE is_system = true AND slug = 'admin' AND NOT ('tasks.tasks.assign' = ANY(permission_patterns));
UPDATE organizations SET epoch = epoch + 1;
