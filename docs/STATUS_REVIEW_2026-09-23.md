# Nexus — implementation and flow review

Reviewed on 23 September 2026 against the current working tree, including uncommitted and untracked additions. This is an implementation assessment, not a claim that every module is production-ready. No application code was changed during this review.

## Where the product stands

Nexus has a working platform core and five implemented business apps: CRM, HR, Payroll, Documents and Invoicing. The employee portal is an additional interface over HR and Payroll. There are 10 service directories in total: five platform services and five business services, plus the Next.js web app.

The registry contains 39 entries including core, or 38 business apps. Only five business services exist. Of the 33 remaining apps, 13 are marked coming soon and **20 currently default to available despite having no implementation**. A catalogue entry, permissions list, price and fallback page do not constitute a completed module.

The best description is **an integrated development MVP with release blockers**, not Phase 1 and not a completed Odoo/Zoho replacement. The original sellable MVP is still incomplete because Tasks & Projects and important shared/commercial capabilities are missing.

## Verification performed

| Check | Result |
|---|---|
| `pnpm smoke:all` against the running local stack | All seven suites passed; 398 checks |
| `pnpm --filter @nexus/web build` | Passed |
| `pnpm lint` | Failed: ESLint 9 configuration is absent |
| `pnpm test` | Exited successfully but discovered zero tests |
| Additional employee billing-permission probe | Failed the intended security boundary; employee changed seats |
| Additional uninstall enforcement probe | Uninstalled CRM remained accessible through its API |
| Additional logout replay probe | Saved pre-logout cookie remained usable |

Smoke tests and additional probes created fresh local test accounts/workspaces and business records. They did not use existing customer workspaces. The review covered source and local API flows; it did not include a full interactive browser, accessibility, load, disaster-recovery or statutory-compliance audit. Passing arithmetic checks is not independent validation of payroll or tax compliance.

## Current user and business flows

1. **Workspace owner:** register/login → workspace and industry/size onboarding → select apps and plan → create subscription → provision apps → dashboard/sidebar generated from the workspace response.
2. **Sales:** lead → conversion into company/contact/deal → pipeline stages → won deal → event-driven draft invoice → issue/print → payment allocations and receivables ageing.
3. **People:** employee → department/shift → attendance or device punches → leave/balances → payroll roster and attendance snapshot → process/review/approve/pay run → payslip/register/bank advice.
4. **Employee access:** HR invitation → identity/tenancy acceptance → HR links the account from the member-joined event → employee portal for own attendance, leave, approved payslips, letters and reviews.
5. **Documents/import:** upload → versioned local blob storage → spreadsheet analysis → column mapping → dry run → owner-service import into CRM leads/contacts or HR employees.
6. **Performance and letters:** goals → staged review cycle → share with employee; salary-revision event updates HR's salary snapshot → template-generated employment letter → frozen issued content → employee acknowledgement.

These flows are implemented and covered to varying extents by the smoke suites. The permission, uninstall and logout exceptions below remain material.

## Priority findings

### P1 — Employees can modify the workspace subscription

`services/billing/src/routes/subscriptions.js:412` uses `app.authenticateOrg` for subscription changes, without `loadContext` and a billing permission check. The same guard pattern appears on subscription creation, reads, app changes and cancellation. The gateway resolves permissions but does not enforce a route-specific billing permission on their behalf.

**Reproduced:** invited a fresh user with only the employee role; its permission list contained only HR/payroll self-service permissions. `PATCH /api/subscriptions/current` with `{ "seats": 6 }` returned 200. The owner's subsequent read confirmed the seat count changed from 5 to 6.

**Next action:** enforce billing permissions on each protected billing operation, including reads; preserve a clearly authorized first-subscription path. Add negative tests for employee, guest, member and admin roles, including cancellation and app purchases.

### P1 — Logout does not invalidate an already-issued access token

`packages/service-kit/src/auth.js:41` verifies JWT validity but does not check whether its session has been revoked. Logout updates the session database and clears the browser cookies; existing access JWTs are still accepted. The configured default access-token lifetime is 600 seconds.

**Reproduced:** saved the cookie before logout, successfully logged out, then replayed the old cookie against `/api/crm/leads`; the API returned 200. This is distinct from testing a browser whose cookies were cleared.

**Next action:** define and implement the required revocation latency using session checks or a revocation projection/cache, and test logout, remote session revoke, logout-all and password reset using retained access tokens.

### P1 — Uninstall affects navigation but does not disable API access

`services/gateway/src/routes/proxy.js:79` checks billing entitlements, not installation state. It forwards the entitled apps downstream. The workspace navigation separately intersects entitlements with installed apps, creating inconsistent behaviour.

**Reproduced:** CRM uninstall returned 200; `/api/me/workspace` reported CRM absent from `installed`; `/api/crm/leads` still returned 200.

**Next action:** use entitled AND installed apps for business-route access and downstream context, with invalidation on install/uninstall. Keep subscription management accessible so a customer can recover or reinstall.

### P1 — Unbuilt apps can be presented as available and added to subscriptions

`services/catalog/src/lib/sync.js:28` defaults an omitted status to `available`. Twenty registry entries without services use that default. Tasks, ERP, Accounting and Manufacturing are examples. The existing platform smoke suite explicitly succeeds in adding Accounting even though there is no accounting service.

**Next action:** mark unshipped apps coming soon and enforce availability consistently in initial subscriptions, dependency resolution, later app additions and installation. Do not count a fallback page as released functionality. Align onboarding suggestions and plan copy with actual delivery.

### P2 — Plan/cycle changes leave subscription line pricing stale

`services/billing/src/routes/subscriptions.js:441` updates the plan, seats and cycle, then changes per-user quantities. It does not rebuild item unit prices or plan/add-on classifications for the new plan/cycle.

**Code finding:** switching monthly to annual can leave monthly unit prices on subscription items; moving between plans does not reconcile newly included apps. This was identified by source inspection, not a separate pricing probe.

**Next action:** reconcile line items, included apps, price snapshots, billing periods and any proration policy in one explicit subscription-change workflow. Test monthly/annual and upgrade/downgrade transitions.

### P2 — Server-rendered navigation does not refresh expired sessions

`apps/web/lib/api.js` can refresh after a client-side 401. `apps/web/lib/server-api.js` does not refresh, and both workspace and portal layouts redirect to login on 401.

**Code finding:** a direct page load with an expired access token and otherwise valid refresh cookie takes the login path before the client refresh code can help. Not reproduced through an interactive browser in this review.

**Next action:** add a safe refresh-and-return flow that updates cookies before protected server rendering. Test idle reload, deep links, workspace switching and concurrent tabs.

### P2 — Automated checks do not yet provide a release gate

There is no root ESLint configuration, no discovered service unit-test suite, and no checked-in CI workflow found. The smoke suites are useful, but all 398 checks passed while the three reproduced access-control/lifecycle gaps remained. The logout smoke currently exercises cleared cookies rather than retained-token replay.

**Next action:** repair lint/test scripts; add targeted regression tests for these failures and critical money/tenant boundaries; run lint, tests, migrations, build and smoke suites in CI.

## Implemented upgrades and remaining work

| Area | Implemented | Still pending or incomplete |
|---|---|---|
| Foundation | Compose, service/db kits, migrations, outbox, NATS, event names/envelope | Per-event payload schemas; explicit failed-event recovery/replay; operational monitoring |
| Identity | Password auth, RS256/JWKS, refresh rotation, verification/reset, invitations, org switch, session listing/revoke routes | Effective access-token revocation; server-rendered refresh; MFA/passkeys/OIDC/SAML |
| Tenancy | Organizations, members, roles, permissions, invitations, settings | Teams API/UI; purchased-seat enforcement on membership growth |
| Catalogue | Registry, categories, dependencies, install/uninstall, settings, generated navigation | Accurate release statuses and API enforcement of uninstall |
| Platform billing | Plans, quotes, trial subscriptions, app items, entitlement calculations | Payment provider/webhooks, renewals, subscription invoice lifecycle, overdue handling, full cancellation scheduling, pricing reconciliation, Redis projection |
| Web shell | Auth, onboarding, dashboard, marketplace, settings, command palette, tours, app fallback | Complete failure/retry and browser coverage; command palette currently searches destinations, not cross-app records |
| CRM | Leads, conversion, contacts, companies, deals, drag/drop pipeline, activities | Cross-app Tasks integration and release hardening |
| HR | Employees, departments, attendance, leave, shifts/devices, performance/goals, letters, portal | Assets and announcements; broader HR requirements beyond the implemented flows |
| Payroll | Structures, dated salaries, calculations, runs, payslips, salary register, bank advice | Production acceptance of statutory rules, operational edge cases and payout reconciliation; bank advice is not bank payment execution |
| Documents | Local content-addressed blobs, folders, versions, quotas, spreadsheet import | Shared object-storage deployment, sharing UI, approvals, general attachment integration |
| Customer invoicing | Draft/issue, numbering, tax calculations, payments/allocations, ageing, template design/printing, CRM events | Credit notes, recurring invoices, reminders, e-invoice integration; full Accounting remains absent |
| Shared services | Some functionality embedded in existing modules, including identity email | Dedicated files/notifier/search/audit services absent; Documents is not yet the planned shared files service |
| Tasks & Projects | Registry and fallback only | Actual service, data model, UI, permissions, events and cross-app task creation |
| ERP onward | Primarily registry/planning | Inventory/purchase/sales, Accounting, Helpdesk/Knowledge, Discuss, Manufacturing, BI, Automation, Integrations and AI assistant |

Redis is running locally but the gateway currently uses process-local Maps and reads entitlements over HTTP. MinIO exists in the optional Compose storage profile; the Documents service currently uses local filesystem storage. Request logs are not the planned immutable audit service. The event consumer code mentions dead-letter handling but no explicit dead-letter advisory handler/replay mechanism was found.

The two billing concepts must stay distinct: **platform billing** charges customers for using Nexus; **Invoicing** lets those customers bill their own customers. Completing the latter does not complete the former or double-entry Accounting.

## Recommended build order

1. **Stabilize the existing platform.** Fix the reproduced permission, session and uninstall gaps; correct app availability; repair CI checks; resolve pricing and session-refresh issues. Acceptance: regression probes fail closed and the existing 398 smoke checks still pass.
2. **Finish the minimum shared/commercial layer needed for a paid pilot.** Audit important actions; deliver notifications; deploy durable shared storage with tested restores; implement subscription collection/renewal/cancellation and seat enforcement. Add retry/reconciliation for subscription provisioning and event failures.
3. **Build Tasks & Projects as the next business module.** Projects/tasks/subtasks, assignees, status/priority/dates, kanban, comments, attachments, then milestones/time/calendar. Support source references to CRM/HR/Helpdesk without cross-database joins. Acceptance: a sales follow-up or HR onboarding action creates a permission-checked task visible in the appropriate workspace.
4. **Complete the first sellable MVP.** Core + CRM + HR + Tasks + dashboard + marketplace. Treat Payroll, Documents and Invoicing as already-started additions requiring their own acceptance criteria. Pilot real workflows and verify deployment, migrations, backups/restores and failure recovery.
5. **Expand by complete business workflow.** ERP and Accounting next if sales/purchase/inventory is the target; then Helpdesk/Knowledge and collaboration; later Manufacturing, analytics projections, automation, integrations and AI. Each module must ship with working routes/screens, tenancy/permission tests, events and recovery behaviour before being marked available.

## Roadmap and repository housekeeping

- The supplied roadmap is older than the local roadmap: local Phases 10–13 now cover Documents, Invoicing, Payroll and Portal/Performance; Tasks moved to Phase 14.
- Phase 1 still says in progress despite substantial foundation implementation. Preserve remaining hardening items rather than changing it to an unconditional complete label.
- The earlier HR section says performance, goals and documents are pending, but the later Phase 13 and the code implement them.
- The MVP still says “Phases 1–10” even though Tasks is now Phase 14. Define MVP by capabilities and acceptance tests rather than that obsolete range.
- Pricing advertises capabilities such as audit, SAML and automation that are not implemented services/features here. Reconcile product claims before a customer pilot.
- `package.json` references `scripts/migrate-all.js` and `scripts/seed.js`, which are absent. Services currently run their own migrations on boot.
- At review start, many upgraded modules were untracked and numerous existing files were modified. A new commit (`7401e61`, `cloude AI`) appeared during the review; by the final check those code changes were committed. This report and newly generated local document-test blobs remained untracked. Keep runtime uploads out of source control and retain reproducible build/test checks for each increment.

This review deliberately records current status separately from the historical roadmap so its existing implementation notes are preserved.
