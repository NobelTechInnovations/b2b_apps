# Nexus Platform — Build Roadmap

Ships one phase at a time. Each phase is independently demoable and leaves the
platform in a working state.

---

## Phase 0 — Architecture ✅

`docs/ARCHITECTURE.md`. Topology, tenancy, SSO, entitlements, event contracts,
data ownership.

---

## Phase 1 — Foundation 🔨 (in progress)

Infrastructure and the seams every service depends on.
- `infra/docker-compose.yml` — Postgres, Redis, NATS JetStream, MinIO, Mailpit
- `packages/service-kit` — Fastify bootstrap, config schema, error envelope,
  auth guard, tenant guard, permission guard, health probes, logging
- `packages/db-kit` — pooled pg client, forward-only migration runner,
  transaction helper, tenant-scoped query builder, outbox writer
- `packages/bus` — NATS publish/subscribe, outbox relay, idempotent consumers
- `packages/contracts` — event envelope + per-domain event schemas

---

## Phase 2 — Identity (SSO)

`services/identity` — the single sign-in for every app.
- signup, login, logout, refresh with rotation, session listing + revoke
- argon2id credentials, RS256 JWT signing, published JWKS
- email verification, password reset, invitation acceptance
- org switching, membership epoch revocation
- ready for TOTP / passkeys / OIDC / SAML without route changes

---

## Phase 3 — Tenancy

`services/tenancy` — organizations, members, roles, permissions, teams,
invitations, org settings, the permission registry itself.

---

## Phase 4 — Catalog + Billing (the commercial engine)

- `services/catalog` — app registry, categories, marketplace, install /
  uninstall, dependency resolution, per-app settings
- `services/billing` — plans, per-app pricing, subscriptions, subscription
  items, app + feature entitlements, trials, upgrade / downgrade / cancel,
  invoices, the Redis entitlement projection

---

## Phase 5 — Gateway

`services/gateway` — the only public surface. Token verification, tenant
resolution, entitlement + permission enforcement, rate limiting, request
audit, service routing, `GET /me/workspace`.

---

## Phase 6 — Web shell

`apps/web` — Next.js. Auth flows, onboarding wizard (industry → size → app
selection → plan → workspace), dynamic sidebar, modular dashboard, app
marketplace, settings, command palette, the full design system.

## The app catalogue

39 apps across 13 categories. Every entry below is already live in
`packages/contracts/src/apps.js` — the marketplace, pricing, sidebar, dashboard
widgets, permission editor and gateway routing are all generated from it.

Apps marked *(planned)* appear in the marketplace as "Coming soon": they are
priced and described, but cannot yet be installed.

### Sales

- **CRM** — Leads, deals and the pipeline that closes them
- **Quotations & Orders** — From quote to signed order — needs crm
- **Partner Portal** — Sell through your channel — needs crm *(planned)*

### Marketing

- **Marketing** — Campaigns that fill the pipeline — needs crm
- **Social** — One inbox for every channel *(planned)*
- **Surveys & Forms** — Ask, and actually use the answers

### Commerce & POS

- **Online Store** — Your storefront, wired to your stock — needs erp
- **Point of Sale** — Counter sales that keep working offline — needs erp
- **Recurring Billing** — Recurring revenue, handled — needs invoicing *(planned)*

### Customer Service

- **Helpdesk** — Every customer issue, answered
- **Field Service** — Dispatch, track, close the job — needs helpdesk *(planned)*
- **Knowledge Base** — The answers, written down once

### Finance

- **Invoicing** — Get paid, on time
- **Accounting** — A real general ledger, not a spreadsheet — needs invoicing
- **Expenses** — Claims without the paper chase
- **Asset Management** — Know what you own and what it is worth — needs accounting *(planned)*

### Operations

- **Inventory & Purchasing** — Products, stock and suppliers
- **Manufacturing** — From bill of materials to finished goods — needs erp
- **Quality** — Catch it before the customer does — needs erp *(planned)*
- **Maintenance** — Keep the machines running *(planned)*

### Human Resources

- **HR** — Your whole team, from offer letter to exit
- **Payroll** — Salaries, statutory and payslips — needs hr
- **Recruitment** — From job post to joining date — needs hr
- **Learning** — Train the team, prove the training — needs hr *(planned)*

### Project Management

- **Projects & Tasks** — Everything the team is working on
- **Resource Planning** — Who is free, and when — needs tasks

### Email, Storage & Collaboration

- **Documents** — One place for every file
- **Mail** — Business email on your own domain *(planned)*
- **Discuss** — Team chat that knows your records *(planned)*
- **Calendar & Meetings** — Shared calendars and booking pages *(planned)*
- **E-Signature** — Signed, sealed, audited — needs documents

### Legal

- **Contracts** — Never miss a renewal again — needs documents
- **Compliance** — Evidence, not hope *(planned)*

### Security & IT

- **Identity & Access** — SSO, MFA and who touched what
- **Device Management** — Every laptop accounted for — needs hr *(planned)*

### BI & Analytics

- **Business Intelligence** — Every app, one set of numbers

### Developer Platform

- **Automation** — If this, then that — across every app
- **Integrations** — Connect the tools you already pay for

---

## Phase 7 — Shared services — in progress

Local milestone delivered: in-app notifications and an append-only, tenant-scoped
published-event audit log. Settings → Audit log supports type/date filters and
cursor pagination with `core.audit.view` enforcement. New task assignments now
notify recipients even when assigned during creation.

Remaining: durable shared file storage, cross-app search, email delivery and
preferences, full mutation audit coverage, failed-event replay and tested restores.
See `SHARED_SERVICES_STATUS.md` for scope and validation.

---

## Phase 8 — CRM ✅

`services/crm` + `apps/web/app/(app)/crm`. **System of record for `customer`.**

- Leads with completeness scoring, and one-transaction conversion into
  company + contact + deal (timeline carried across, never orphaned)
- Pipeline board with drag-and-drop; dropping into a won/lost stage closes the
  deal and promotes the company to customer
- Deals, contacts, companies, activities — list, filter, search, record drawers
- Default pipeline seeded on first use, so the board is never an empty shell
- Fractional `board_position`: a drag writes one row, not a whole column
- `scripts/smoke-crm.js` — 32 checks covering the full sales motion and
  cross-tenant isolation

---

## Phase 8.5 — App route fallback ✅

`apps/web/app/(app)/[...appRoute]`. An installed app whose screens are not
built yet shows what it does and where it stands, instead of a 404. Three
states: not on your plan (with price and an add button), active but in
development, and not released to anyone yet.

---

## Phase 9 — HR ✅

`services/hr` + `apps/web/app/(app)/hr`. **System of record for `employee`.**

- Employees with auto-generated codes, reporting lines (cycle-checked) and
  offboarding that reassigns reports and cancels pending leave
- Departments with headcount rollup; a staffed department cannot be deleted
- Attendance: check in/out with worked minutes, a daily board, and days
  locked when approved leave owns them
- Leave: four seeded types, per-person balances, overlap detection, balance
  enforcement, approval that deducts and blocks the calendar, cancellation
  that returns the days
- An employee is not a platform user — `user_id` is an optional link, so
  people who never sign in are still first-class
- `scripts/smoke-hr.js` — 46 checks covering the full people motion and
  cross-tenant isolation

Still to come in HR: performance, goals, assets, announcements, and documents
(the last needs the files service from Phase 7).

---

## Phase 10 — Documents & spreadsheet import ✅

`services/documents` + `apps/web/app/(app)/documents`.

- **Content-addressed storage**: blobs keyed by SHA-256, so identical bytes
  are stored once however many documents reference them. Quota counts unique
  bytes and is enforced against the plan's allowance before a write.
- **Versioning**: uploading onto an existing document creates a version;
  history is kept and downloadable.
- **Spreadsheet engine**: reads .xlsx/.xls/.csv/.tsv, flattens formulas,
  hyperlinks and rich text, finds the header row beneath title junk, and
  profiles every column — type, fill rate, distinct count, uniqueness,
  sample values.
- **Cross-app import**: map spreadsheet columns to CRM contacts, CRM leads or
  HR employees, dry-run every row, then write. Documents never learns another
  app's schema — it reads `packages/contracts/src/import-targets.js` and posts
  to the declared internal endpoint, so the owning service still applies its
  own rules (lead scoring, company matching, leave balances).
- `scripts/smoke-documents.js` — 50 checks driving a deliberately messy
  workbook all the way into HR and CRM.

Still to come: sharing UI, approval workflows, and Discuss.

---

## Phase 11 — Invoicing ✅

`services/invoicing` + `apps/web/app/(app)/invoicing`.

- **Money in integer paise.** Every calculation converts to paise, works in
  integers, and converts back only at the edges. CGST + SGST always
  reconstitutes the tax total exactly, including on odd amounts.
- **GST done properly**: per-line rates and HSN codes, CGST/SGST within a
  state versus IGST across states (decided by the GSTIN's first two digits),
  discount before tax, and an explicit round-off line.
- **Gap-free numbering** per financial year (`INV/2026-27/0001`). A number is
  spent at issue, not at creation, so abandoned drafts leave no hole. The
  counter row is locked inside the issuing transaction.
- **Issued invoices are immutable.** Editing is refused; voiding keeps the
  number; a paid invoice cannot be voided at all.
- **Payments**: partial and multiple, allocated explicitly or oldest-first,
  with invoice status derived from allocations rather than set by hand.
- **Receivables ageing** bucketed and grouped by customer.
- **The first event-driven cross-app workflow**: `crm.deal.won` raises a
  draft invoice here, over the bus, with no direct call from CRM. Customers
  are a projection kept current by `crm.customer.*`. Redelivery is idempotent
  — a consumed-events table plus a unique index on the source reference.
- **The invoice as a document** (phase 12). A designer with a live preview —
  three layouts, an accent colour, a logo, seller and bank details, and
  toggles for HSN codes, the tax summary and the signature block. The same
  component renders the preview and the printed page, so what you design is
  what prints; the browser's own print pipeline produces the PDF, which is why
  there is no headless renderer to keep in step.
  **Issuing stamps the design onto the invoice.** Rebranding never restyles an
  invoice the customer already holds; a different design can still be
  previewed against it without changing what it was issued under.
- `scripts/smoke-invoicing.js` — 57 checks.

Still to come: credit notes, recurring invoices, reminders, e-invoice IRN.

---

## Phase 12 — Time, attendance devices and payroll ✅

`services/hr` (migration 0002) + new `services/payroll` on port 4031.

### Working hours — HR owns time
- **Shifts** carry start and end times, an unpaid break, working days, a late
  grace period, a half-day threshold and an overtime threshold. A shift whose
  end time is at or before its start runs past midnight and is detected as a
  night shift without anybody ticking a box — 22:00→06:00 is seven and a half
  hours, not minus sixteen.
- **Assignment is dated.** Moving somebody to a new shift closes the previous
  assignment the day before rather than deleting it, so last month's payslip
  still explains itself with last month's hours. Anyone with no assignment
  follows the workspace default, which is what makes the whole feature
  optional.
- **Overtime and short time are derived, never typed.** `deriveDay()` is one
  pure function over (shift, check-in, check-out); overtime only begins once
  the whole shift is covered, so two hours early and two hours late on the
  same day nets to zero rather than to two hours of each.
- Changing a shift's hours **recomputes** the current month's attendance
  rather than leaving stale overtime behind, and says how many records moved.

### Punch terminals
- A device is registered and handed an endpoint and a **key shown exactly
  once** — only its SHA-256 digest is stored, so there is no recovery, only
  rotation.
- `POST /api/device-sync/punches` is the one gateway route that carries no
  user token: terminals have no user. It passes two independent gates — the
  gateway's internal service token proves the request came through us, and the
  device key resolves the workspace. A key only ever unlocks the one workspace
  it was minted in.
- **Raw punches are never edited.** Attendance is derived from them and can be
  rebuilt at any time, which is what makes a late correction safe.
- Terminals replay their buffer after a network drop, so a unique index on
  `(org_id, employee_ref, punched_at)` makes a repeat a no-op rather than a
  duplicate day.
- A punch from an id nobody is enrolled with is **parked, not dropped**.
  Mapping that card to a person later adopts every punch it already sent and
  rebuilds those days — enrolling somebody a week late should not cost them a
  week of attendance.

### Payroll — payroll owns money
A separate service with its own database. It never touches HR's tables: it
reads the roster and a per-period attendance summary over HTTP at the moment a
run is processed, and **snapshots** what it needs onto the payslip. A payslip
must still read correctly in three years when the person has left, the shift
has been retimed and the salary revised twice.

- **Salary structures**: components resolved in dependency order, not display
  order — basic before anything that is a percentage of it, and the balancing
  component last. Exactly one component may absorb the balance of gross, so
  the earnings always add up to gross to the paisa.
- **Dated salary history.** A revision closes the standing row the day before
  the new one starts; statutory identifiers carry forward so nobody re-types a
  PAN to give a raise.
- **Statutory deductions are data, not literals** (`lib/statutory.js`, stated
  for FY 2026-27): PF at 12% of the ₹15,000 ceiling with the employer's share
  split 8.33% to pension; ESI at 0.75%/3.25% below ₹21,000 gross, rounded up
  to the rupee as the regulations require; professional tax by state slab with
  the February instalment; income tax projected over the remaining months of
  the financial year, with the 87A rebate, marginal relief, surcharge and cess.
- **Every payslip line carries its working** — "12% of ₹15,000 (PF wage
  ceiling)". A payslip nobody can check by hand is a payslip nobody trusts.
- **No attendance means a full month is paid**, and the payslip says so.
  Docking pay for a data-entry gap would be wage theft caused by a missing row.
- Somebody with no salary on record is **named in the run's skipped list**,
  not silently omitted.
- A run moves draft → review → approved → paid, one way. Money that has left
  the building cannot be un-sent, so there is no path back from `paid`.
- Re-processing **replaces** rather than doubles, so a run survives a salary
  correction or a late attendance fix.
- A **salary register** pivots components into columns dynamically — a
  workspace that invented a "Site allowance" gets a Site allowance column
  without anybody editing a report — and downloads as CSV.
- A **bank advice** lists net payments with account and IFSC, and names who it
  excluded and why rather than quietly dropping them.
- A **printable payslip** with earnings, deductions, employer contributions,
  year-to-date and the net in words.
- `scripts/smoke-payroll.js` — 94 checks, from shift arithmetic through a
  biometric batch to the statutory figures on a payslip.

---

## Phase 13 — Employee portal, performance and documents ✅
`services/hr` (migrations 0003, 0004), `services/tenancy` (0003),
`apps/web/app/portal` + `apps/web/app/(app)/hr/{performance,documents}`.

### The employee portal
The narrowest role on the platform: `employee` grants `*.self.*` and nothing
else. The security property is not the permission — it is that **every portal
route resolves the person from `request.ctx.userId` and no portal route takes
an employee id at all.** There is nothing to tamper with, because there is no
parameter to tamper with. A colleague's payslip id, pasted into a portal
session, simply does not match the `WHERE` clause.

- **Linking is event-driven.** HR asks tenancy to send the same invitation an
  admin would send from the members screen — one invitation mechanism, one
  acceptance path, one thing to keep secure — and learns it was accepted from
  `tenancy.member.joined`, matching on the address it invited.
- Removing somebody from the workspace suspends portal access but **keeps the
  employee record**: being taken off the system is not the same as leaving the
  job, and unlinking would orphan their payslips.
- The portal has **its own frame**, not the workspace shell with things hidden.
  Someone whose whole relationship with the product is "my payslips and my
  leave" should not be looking at chrome built for running a company.
- Applying for leave from the portal runs **the same checks HR's own screen
  runs** — the balance logic was extracted to `lib/leave.js` so an employee
  applying for themselves cannot get past a rule HR would have enforced.
- A payslip is visible **only once its run is approved**. A draft payslip is
  working material; showing somebody a figure still being calibrated and then
  changing it is worse than showing nothing.

### Performance
- A cycle moves forward only: draft → self review → manager review →
  calibration → shared → closed. **Reopening a shared cycle would let a rating
  change after the person has already read it**, which is the one thing a
  performance record must never allow.
- The manager's words are withheld from the employee until the cycle is
  shared — enforced in SQL, not in the browser.
- Sharing a cycle with unrated reviews is refused: a blank review helps nobody.
- Goals carry a weight, a metric and a target; employees update their own
  progress.
- The report shows each person's rating, **how it moved since last cycle**, and
  their goal completion, with the distribution a calibration meeting argues
  about.

### Employment documents
- Letters are **generated from the record, not retyped** — the CTC in an offer
  letter is the figure payroll will pay.
- Payroll **pushes** the salary to HR (`payroll.salary.revised` → a slim
  projection) rather than HR calling payroll, because payroll already reads
  HR's roster and attendance and a synchronous read would close the loop. A
  projection is right here in a way it is not for attendance: a salary changes
  on a revision, not continuously.
- **An issued letter is frozen.** The rendered body is stored, not the template
  reference, so editing a template never rewrites a letter somebody has signed.
  Rewording an issued letter is refused outright; revoking keeps the row,
  because a revoked offer is part of the record.
- A document can be marked internal, and then it is not in the portal at all —
  not hidden in the UI, absent from the query.
- `scripts/smoke-portal.js` — 77 checks, most of them proving what the portal
  *cannot* reach.

### Three bugs the browser found that the suites could not
1. **A signed-out invitee could not read their own invitation.** The gateway
   authenticates the whole `invitations` namespace, so previewing an invite
   required the account the invite was for. Its own public `invite` prefix now.
2. **The API client hard-redirected on 401 before the join page could catch
   it**, so a new invitee bounced to sign-in forever. It can now opt out.
3. **`<TD numeric>` sets tabular figures but does not right-align** — fifteen
   cells sat left of their right-aligned headers.

---

## Stabilisation review — 24 September ✅
A walkthrough of every flow after the Tasks module and the security hardening
landed. What it found and fixed:

- **Salary register rendered transparent over the page.** It used
  `--surface-base`, a token that does not exist; an undefined custom property
  silently resolves to nothing. It also wasn't portalled like modals are, so the
  shell painted through it. `pnpm check:tokens` now fails on any undefined token.
- **`relativeTime` was off by a unit everywhere** — each unit was paired with
  the divisor of the one below it, so five minutes read "5 hours ago". Used on
  17 screens since Phase 6. Fixed, with tests.
- **Money showed one decimal** ("₹550.5") wherever paise were involved.
- **The notification bell showed a permanent "unread" dot** that meant nothing.
- **Manual attendance now needs approval.** See Phase 15 below.
- The Tasks module was reviewed end to end in the browser — projects,
  milestones, tasks, subtasks, comments, time, board drag-and-drop, calendar,
  timesheets. No broken flows; only display polish (dates, status labels).

## Phase 14 — Tasks & Projects — local review ready

Implemented: tenant-scoped projects, tasks, subtasks, milestones, assignments,
status/priority/due dates, kanban, calendar, time entries, comments, linked
Documents attachments, dashboard counts and permission enforcement. CRM lead
and HR employee screens can create source-linked tasks; the API also supports deals.

The shared drawer focus bug is fixed. Tasks now has a muted plum header, compact
summaries, a row-based My work view and responsive board/project layouts.

Pending integrations: Helpdesk task creation awaits the Helpdesk service; direct
file uploads use Documents. Notifications and immutable audit remain shared-service
work. This phase is ready for local review, not a production-release claim.

See [local delivery and next steps](LOCAL_REVIEW.md) for validation and remaining
platform work.

---

## Phase 15 — Notifications, and approval for manual attendance ✅
`services/notifier` on port 4006, HR migration 0005, `tools/device-bridge`.

### Manual attendance needs an approver
A punch terminal is evidence; a person typing a time is a claim. Attendance —
the table payroll reads — only ever holds evidence or approved claims.

- Device punches land directly, as before.
- HR marking a day, the check-in/out buttons, and an employee's "I forgot to
  punch" all become **requests**, unless the person acting holds
  `hr.attendance.approve`. Payroll cannot pay on an unapproved entry because an
  unapproved entry is not in the table payroll reads.
- One open claim per person per day: a check-out completes the morning's
  check-in rather than filing a second claim.
- **Nobody decides a request they raised, or one about themselves.** The same
  subject-based rule now applies to leave.
- A rejection must say why; the employee sees the reason.
- A day an approver decided by hand is **not overwritten** by punches that
  arrive afterwards — the punches stay in the log for anyone who wants to
  question the decision.

### The device bridge
Most terminals sold in India export punches as a file rather than calling a web
address, so `tools/device-bridge/bridge.js` reads `attlog.dat` or a vendor CSV
and posts it. Idempotent, remembers what it sent, handles time zones. Setup is
in `docs/DEVICE_SETUP.md`. Direct push (ADMS / `iclock`) is not supported yet.

### Notifications
The notifier listens to events and routes each to exactly the people who need
to act — "someone needs approving" is resolved to the members who **hold the
approval permission**, through the same function the gateway uses.

- Attendance corrections, leave requests and decisions, documents to
  acknowledge, review cycles opening and being shared, tasks assigned and done.
- The person who caused an event is never notified about it — enforced once in
  the consumer, not remembered in every rule.
- Redelivered events notify nobody twice (unique on event × recipient).
- The inbox is reachable without a subscription: a lapsed workspace is the one
  that most needs to read "your trial has ended".
- A task created with an assignee now emits an assignment event; previously
  only a *re*assignment did, so the commonest case was silent.
- `scripts/smoke-notifications.js` — 28 checks, most of them about who does
  **not** get told.

Still to come: email delivery for notifications, per-person mute settings, and
payslip-available notices (payroll does not yet know which employees have
portal logins).

## Phase 16 — ERP

Products, categories, inventory, warehouses, purchase, sales, vendors, stock
transfers and adjustments. **System of record for `product` and `stock`.**

---

## Phase 17 — Accounting

Invoices, recurring billing, payments, credit notes, taxes → then chart of
accounts, journal entries, ledger, AR/AP, bank, cash, expenses, P&L, balance
sheet, trial balance. Transactions flow in by event from sales, purchase,
billing and expenses.

---

## Phase 18 — Helpdesk & Knowledge

Tickets, teams, agents, SLA, canned responses, customer portal, knowledge base,
spaces, articles, public KB.

---

## Phase 19 — Discuss

Channels, DMs, mentions, attachments.

---

## Phase 20 — Manufacturing

BOM, manufacturing orders, work centers, work orders, production planning,
material consumption, finished goods, scrap, quality.

---

## Phase 21 — BI

Dashboards, charts, KPIs, reports, filters, drilldowns, scheduled reports,
export. Reads from a per-app analytics projection, never from live app tables.

---

## Phase 22 — Automation

Trigger → conditions → actions, running off the event bus. Visual builder.

---

## Phase 23 — Integrations

WhatsApp, email, Google, Microsoft, Shopify, WooCommerce, payment gateways,
shipping, calendar, storage.

---

## Phase 24 — AI assistant

Natural-language queries and actions over the declared capability descriptors,
respecting org, entitlement and permission boundaries.

---

## First sellable MVP

**Platform core + CRM + HR + Tasks + Dashboard + Marketplace.**

The phase numbers evolved as Payroll, Documents and Invoicing were added. Track
the MVP by these capabilities, plus the commercial and operational acceptance
criteria in `LOCAL_REVIEW.md`, rather than the original phases 1–10 shorthand.
That is a product a business can buy, not a demo.
