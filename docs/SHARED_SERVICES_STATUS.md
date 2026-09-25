# Shared services — local milestone, 25 September 2026

This continues the Tasks release without deploying or pushing changes.

## Delivered in this milestone

- `services/audit` on port 4008 consumes known workspace events from JetStream.
  Event ID deduplication makes redelivery idempotent. Events without an
  organization are excluded from workspace history.
- Append-only PostgreSQL storage rejects UPDATE, DELETE and TRUNCATE through
  a database trigger. No public mutation endpoint exists. Database administrators
  can still disable triggers: this is not an independent tamper-proof archive.
- `GET /api/audit` requires `core.audit.view` and scopes every query to the
  caller's workspace. Existing role grants apply, including the default member
  role's wildcard view grant; guests and employee-only roles are denied.
- Settings → Audit log provides type/date filters, refresh, empty/error states
  and stable cursor pagination. Dates use UTC. Rows are ordered by ingestion
  sequence; delayed events can have an older occurrence time.
- Only event metadata and a resource identifier are persisted. Raw payloads,
  salary values, leave text, document content and credentials are excluded.
- New tasks with assignees emit TASK_ASSIGNED in the same transaction as task
  creation. Existing notifier rules deliver the notice and link to the task.
  Completion notices to the creator were already wired in the current tree and
  now have regression coverage alongside the initial-assignment fix.
- Local runner, readiness checks, workspace lockfile and CI service startup
  include Audit. Readiness/CI also include the existing Notifier service.

## Verification

The full regression suite passed after the Tasks usability follow-up (27
tests). The focused shared-services suite covers initial assignment, completion,
tenant isolation, guest denial, filters, pagination, read-only API, deduplication,
and database mutation rejection. Notification smoke tests and the production web
build passed. Lint passed with zero errors and 71 existing warnings. Browser
review verified actual audit rows and event filtering in the local workspace.

Review at http://localhost:3000/settings/audit using your existing workspace.
Run `pnpm dev` for all services; `pnpm dev audit` starts just Audit. A fresh setup
needs `pnpm install --frozen-lockfile`, infrastructure and migrations as described
in `LOCAL_REVIEW.md`. The migration runner discovers Audit automatically.

## Remaining Phase 7 work

This is an event audit projection, not a complete audit of every write, failed
request, read, or sign-in across all organizations. Historical coverage is limited
to events still retained in JetStream when the consumer starts (currently 14 days).
Persisted audit rows have no automatic expiry. Five failed deliveries currently
exhaust the shared bus consumer's retry budget; operational replay/alerting remains
required before production acceptance.

Next: durable shared file storage with backup/restore checks, notification email
delivery/preferences, failed-event recovery and broader audit event coverage,
then cross-app search. Subscription payment/renewal/seat enforcement remains a
separate commercial milestone. ERP follows platform readiness; it has not been
started by this change.

## Tasks usability follow-up

Saving a new or edited task now returns to the list. The task detail no longer
contains a time-entry form; Log time is a separate, explicitly opened drawer with
hours/minutes, date, optional note and 15/30/60-minute shortcuts. It starts empty
each time so a previous task's duration cannot be accidentally reused.

Time is manual effort, not elapsed time since assignment or a running timer. Two
tasks with 30 and 45 minutes produce 1h 15m in their project's total. Each time
entry is counted once, including subtasks and archived tasks. Moving a task to
another project moves its time into the new project's total. Project cards link
to their filtered timesheet, with a separate Only my entries filter.
