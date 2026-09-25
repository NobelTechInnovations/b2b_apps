# Local delivery — 24 September 2026

This follows the assessment in `STATUS_REVIEW_2026-09-23.md`. That report is a
historical snapshot; the changes below address its findings. Nothing has been
pushed or deployed. The current milestone is stabilization plus the first
Tasks & Projects release (Phase 14 in the repository's expanded roadmap).

## Delivered

- Fixed the shared drawer's focus lifecycle. Inline close callbacks no longer
  reset focus after each character. Opening still focuses the first input;
  Escape, focus trapping and focus restoration remain supported.
- Redesigned Tasks with a muted plum header, compact live summaries, a row-based
  My work view, quieter kanban cards, project progress and more spacious drawers.
  Search is debounced and ignores stale responses. Sidebar selection uses the
  most specific matching destination.
- Added the Tasks service on port 4034, database migration and local runner
  integration. Projects, milestones, tasks/subtasks, assignments, comments,
  time entries, calendar, kanban, archive and Documents links are implemented.
- CRM leads and HR employees can create linked tasks. The API also accepts CRM
  deal references. Source reads retain the caller's permissions. Helpdesk is
  not implemented, so its integration remains pending.
- Added tenant boundaries, permission checks, task lifecycle validation,
  transactional task events and serialized task/project lifecycle mutations.
- Enforced billing permissions, immediate session revocation and installed-app
  access at the gateway. Unreleased apps are marked coming soon and cannot be
  quoted/purchased. Onboarding presets now exclude them.
- Plan/cycle changes recompute item prices. This is price reconciliation, not
  a complete proration, payment-collection or renewal implementation.
- Added a refresh-and-return page for expired sessions on protected page loads,
  safe return-path handling and serialized refresh requests where supported.
- Added root lint configuration, meaningful API regression tests, migration and
  disposable demo seed scripts, readiness checks and a PR/manual CI workflow.
  The workflow has not been run remotely.

## Local review

Open http://localhost:3000/tasks/board. The synthetic Nexus Review Workspace
contains sample projects and tasks. Existing workspaces can install Tasks from
the marketplace if their subscription includes it.

For a fresh local setup:

```sh
pnpm install --frozen-lockfile
pnpm infra:up
pnpm migrate
pnpm dev
# In another terminal, optionally create a fresh synthetic review workspace:
pnpm seed
```

The seed prints its own local review credentials. It creates a new workspace;
it does not populate an existing customer workspace. Do not run infrastructure
reset commands against data you want to keep.

Validation commands are `pnpm lint`, `pnpm test`, `pnpm smoke:all` and
`pnpm --filter @nexus/web build`. Final local results: 18 regression tests passed,
all seven smoke suites passed (398 checks), production build passed, and lint
completed with zero errors and 70 existing unused-variable warnings. The diff
whitespace check passed. API regression coverage includes permissions,
cross-tenant references, subscription repricing, unavailable apps, uninstall,
retained-cookie logout replay and Tasks workflows. Browser verification covered
separate keystrokes in title and description without refocusing, saving the
full values, and inspecting the board and My work layouts.

## Next phase and acceptance criteria

1. Shared services: immutable audit for important mutations, notifications from
   events, durable object storage, and tested backup/restore. Task assignment
   should produce a notification; actions should produce queryable audit events.
2. Commercial completion: subscription payment provider/webhooks, renewals,
   overdue handling, scheduled cancellation, proration policy, seat enforcement
   and provisioning reconciliation. A failed payment or provisioning request
   must be recoverable without duplicate charges or duplicate organizations.
3. Release hardening: event payload schemas and failed-event replay, refresh
   concurrency/browser coverage, load/failure testing and pilot acceptance.
4. Then ERP, followed by Accounting and Helpdesk in the expanded roadmap.
   Complete each as a usable flow before adding the next module.

Session verification currently calls Identity on authenticated requests and
gateway app checks read Catalog live. These fail closed but add latency and
availability dependencies; a bounded, invalidated projection is future work.
Documents still stores blobs locally. Payroll statutory acceptance, MFA/SSO
providers, teams, HR assets/announcements and other gaps in the original review
remain pending. The premium visual refresh in this delivery is scoped to Tasks
and its shared drawer/sidebar fixes; other modules have not all been redesigned.

## Follow-up milestone

See [Shared services and Tasks usability](SHARED_SERVICES_STATUS.md) for the
25 September audit service, notification checks and simplified manual time
entry/project totals. That report supersedes the earlier pending-work snapshot
for these areas.
