-- The full catalogue is shipping, and its permissions use verbs beyond the
-- original seven (post, reconcile, fulfil, refund, open, close, perform…).
--
-- Administrators: every permission of every app, still no billing. Listing
-- verbs one by one meant each new app silently locked admins out of its new
-- actions.
UPDATE roles
   SET permission_patterns = ARRAY(SELECT DISTINCT unnest(permission_patterns || ARRAY['*.*.*']))
 WHERE is_system = true AND slug = 'admin';

-- Members do the day-to-day work: ring up a sale, close a shift, perform a
-- quality check, send a quote, complete a field job. They do not mail the
-- whole customer list, close non-conformance reports, or see identity,
-- security and API-key settings.
UPDATE roles
   SET permission_patterns = ARRAY(SELECT DISTINCT unnest(permission_patterns || ARRAY[
         '*.*.send', '*.*.complete', '*.*.perform', '*.*.reply', '*.*.upload', '*.*.open', '*.*.close',
         '*.*.log', '*.*.fulfil', '*.*.schedule', '*.*.confirm'])),
       denied_patterns = ARRAY(SELECT DISTINCT unnest(denied_patterns || ARRAY[
         'marketing.campaigns.send', 'quality.ncr.close', 'iam.*.*', 'integrations.keys.*', 'integrations.webhooks.manage',
         'accounting.journal.delete', 'devices.actions.wipe']))
 WHERE is_system = true AND slug = 'member';

-- Guests read what they are shown — never the ledger or the security setup.
UPDATE roles
   SET denied_patterns = ARRAY(SELECT DISTINCT unnest(denied_patterns || ARRAY['iam.*.*', 'integrations.*.*', 'accounting.*.*', 'assets.*.*']))
 WHERE is_system = true AND slug = 'guest';

-- Employees: take the training assigned to them, chat with the team and see
-- the calendar. Learning shows people their own enrolments unless they
-- manage courses; Discuss shows only the channels they belong to.
UPDATE roles
   SET permission_patterns = ARRAY(SELECT DISTINCT unnest(permission_patterns || ARRAY[
         'learning.courses.view', 'discuss.channels.view', 'discuss.messages.send', 'meetings.calendar.view']))
 WHERE is_system = true AND slug = 'employee';

UPDATE organizations SET epoch = epoch + 1;
