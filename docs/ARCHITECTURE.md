# Nexus Platform — System Architecture

> A modular, service-oriented business SaaS. One account, one workspace, many
> independently deployable apps. Customers subscribe to only the apps they need.

Status: **Phase 0 — Architecture (approved for build)**
Last updated: 2026-09-22

---

## 0. Non-negotiable principles

1. **Service-per-domain.** Every app (CRM, HR, Tasks, Accounting…) is its own
   Node service, own process, own database, own deploy, own scaling profile.
   No shared tables across service boundaries. Ever.
2. **One identity, everywhere.** A single sign-in issues one token that every
   service trusts. Users never authenticate per-app.
3. **Tenant isolation is enforced server-side.** `org_id` is derived from the
   verified token + membership check, never from a request body or query param.
4. **Entitlements gate everything.** A route is reachable only if the org has
   an active entitlement for the app AND the app is installed AND the user
   holds the permission. Enforced at the edge and again inside the service.
5. **Apps talk through contracts, not tables.** Synchronous → REST over the
   internal mesh. Asynchronous → domain events on NATS JetStream.
6. **JavaScript only.** ESM, Node 22+. No TypeScript anywhere.

---

## 1. Topology

```
                            ┌──────────────┐
                            │   Browser    │
                            │  Next.js UI  │
                            └──────┬───────┘
                                   │ HTTPS, httpOnly cookie
                            ┌──────▼───────┐
                            │  API GATEWAY │  ← authN, tenant ctx, entitlement,
                            │   (edge)     │    rate limit, routing, audit tap
                            └──────┬───────┘
                                   │ internal mTLS / service tokens
        ┌──────────┬──────────┬────┴─────┬──────────┬──────────┬──────────┐
        ▼          ▼          ▼          ▼          ▼          ▼          ▼
   ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
   │identity│ │tenancy │ │catalog │ │billing │ │  crm   │ │   hr   │ │ tasks  │
   └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘
       │          │          │          │          │          │          │
    ┌──▼──┐    ┌──▼──┐    ┌──▼──┐    ┌──▼──┐    ┌──▼──┐    ┌──▼──┐    ┌──▼──┐
    │ PG  │    │ PG  │    │ PG  │    │ PG  │    │ PG  │    │ PG  │    │ PG  │
    │ db  │    │ db  │    │ db  │    │ db  │    │ db  │    │ db  │    │ db  │
    └─────┘    └─────┘    └─────┘    └─────┘    └─────┘    └─────┘    └─────┘

        ═══════════════ NATS JetStream (domain event bus) ═══════════════
        ┌────────────┬────────────┬────────────┬────────────┐
        │  files     │ notifier   │  search    │   audit    │  platform services
        └────────────┘────────────┘────────────┘────────────┘
```

### Repository shape

One repository, N independently deployable units. Services share **no runtime
and no data** — only published contract packages. Any service can be lifted
into its own repo without a code change.

```
nexus/
  apps/
    web/                     Next.js 15 App Router (JS), the single frontend
  services/
    gateway/                 edge: auth, tenant, entitlement, proxy
    identity/                users, credentials, sessions, MFA, invitations
    tenancy/                 organizations, members, roles, permissions, teams
    catalog/                 app registry, marketplace, install/uninstall
    billing/                 plans, subscriptions, entitlements, invoices
    files/                   object storage abstraction + attachments
    notifier/                in-app + email notifications
    audit/                   append-only audit log
    search/                  cross-app search index
    crm/  hr/  tasks/  erp/  billing-app/  accounting/  helpdesk/  docs/ ...
  packages/
    contracts/               event + API schemas, shared by producers/consumers
    service-kit/             Fastify bootstrap, auth guard, tenant guard, errors
    db-kit/                  pg pool, migration runner, tx helper, tenant scope
    bus/                     NATS publish/subscribe with outbox support
    ui/                      design system (React components, tokens)
  infra/
    docker-compose.yml       local: postgres, redis, nats, mailpit, minio
    k8s/                     production manifests (later)
```

`packages/*` are versioned libraries, not shared state. They are the seam that
keeps 15 services consistent without coupling them.

---

## 2. Identity & single sign-on

**One login for every app.** The identity service is the only holder of
credentials.

```
  POST /auth/login  ──► identity
                        verify argon2id hash
                        create session (Redis, rotating refresh token)
                        sign access JWT (RS256, 10 min)
                         │
                         ├─ Set-Cookie  nx_at  (httpOnly, Secure, SameSite=Lax)
                         └─ Set-Cookie  nx_rt  (httpOnly, path=/auth/refresh)
```

Access token claims:

```json
{
  "sub":  "usr_01J...",        "email": "kartik@acme.in",
  "org":  "org_01J...",        "mem":   "mem_01J...",
  "roles":["owner"],           "sid":   "ses_01J...",
  "ver":  7,
  "iss":  "https://id.nexus.app", "aud": "nexus", "exp": 1790000000
}
```

- Signed **RS256**. Every service verifies locally against the identity
  service's **JWKS** (`/.well-known/jwks.json`, cached 10 min). No service ever
  calls identity on the hot path — SSO stays fast under fan-out.
- `ver` is the membership epoch. Revoking a role or removing a member bumps the
  org's epoch; tokens with a stale `ver` are rejected and force a silent
  refresh. This gives near-instant revocation without a central session lookup.
- **Org switching** = refresh with a target `org_id`; the session is
  org-agnostic, the access token is org-scoped.
- Permissions are **not** in the JWT (they change often and would bloat it).
  The gateway resolves them from tenancy and caches per `(user, org, ver)`.

Planned, architecture already allows: TOTP MFA, WebAuthn passkeys, Google /
Microsoft OIDC, and SAML for enterprise tenants — all terminate in identity,
so no app service learns a new auth path.

---

## 3. Multi-tenancy

**Row-level, `org_id`-keyed, enforced in three layers.**

| Layer | Enforcement |
|---|---|
| Gateway | Resolves `org_id` from the token, verifies live membership, injects `x-nexus-org`. Strips any client-supplied tenant headers. |
| Service kit | Every handler receives `ctx.orgId`. Repository helpers refuse a query built without it. |
| Postgres | `org_id` is `NOT NULL` on every business table, first column of every index, and guarded by RLS policies using `SET LOCAL app.org_id`. |

A missing `org_id` is a startup-time lint failure, not a runtime bug.

Large tenants can be promoted to a dedicated database per service without an
application change, because access already goes through a per-tenant
connection resolver.

---

## 4. Entitlements — the commercial core

```
   Organization
        └── Subscription (active | trialing | past_due | canceled)
                └── Subscription Items      one per purchased app
                        └── App Entitlement   crm       ACTIVE   seats: 25
                                └── Feature Entitlement  crm.pipeline  ON
                                └── Feature Entitlement  crm.email     OFF (add-on)
```

Three independent gates, all required:

1. **Entitled** — billing says the org pays for (or trials) this app.
2. **Installed** — catalog says the org has switched it on.
3. **Permitted** — tenancy says this user holds `crm.leads.view`.

The gateway evaluates all three before a request ever reaches the CRM service,
and the CRM service asserts them again from its own middleware. Frontend
hiding is cosmetic only.

Entitlement reads are served from a Redis projection (`ent:{org}`) that billing
invalidates on every subscription event — sub-millisecond, and it survives a
billing outage.

Pricing lives entirely in the database (`plans`, `plan_apps`, `app_prices`).
No price is ever written into application logic.

---

## 5. Inter-service communication

**Synchronous (query-time):** REST + JSON over the internal network, with a
short-lived service token (`aud: internal`) and circuit breakers. Only for data
a request genuinely cannot proceed without.

**Asynchronous (state change):** NATS JetStream, transactional-outbox backed.

```
  CRM: deal.won  ──►  bus  ──┬──►  tasks    creates onboarding checklist
                             ├──►  billing  drafts the invoice
                             ├──►  notifier alerts the account owner
                             ├──►  search   reindexes the customer
                             └──►  audit    records the transition
```

Event envelope (`packages/contracts`):

```json
{ "id":"evt_01J…", "type":"crm.deal.won", "version":1,
  "org_id":"org_01J…", "actor_id":"usr_01J…",
  "occurred_at":"2026-09-22T10:00:00Z", "data":{ … } }
```

Events are written to an `outbox` table inside the same transaction as the
business change, then relayed. No dual-write, no lost events, exactly-once
effective delivery via consumer-side idempotency keys.

**Read-model duplication is expected and correct.** CRM keeps a slim local
copy of the customers it needs; it does not join across a service boundary.

---

## 6. Shared platform services

These exist once and every app consumes them, which is what stops the platform
turning into 15 half-built CRMs:

| Service | Owns |
|---|---|
| `identity` | users, credentials, sessions, invitations |
| `tenancy` | orgs, members, roles, permissions, teams |
| `catalog` | app registry, install state, dependencies |
| `billing` | plans, subscriptions, entitlements, invoices |
| `files` | uploads, folders, versions, signed URLs (S3/MinIO) |
| `notifier` | in-app feed, email, digests, preferences |
| `search` | cross-app index and query |
| `audit` | immutable action log |
| `automation` | trigger → condition → action engine (Phase 16) |

Business apps **never** implement their own auth, their own org model, their
own file storage or their own notification delivery.

---

## 7. Permission model

Dotted, three-part, app-scoped: `<app>.<resource>.<action>`

```
crm.leads.view      crm.leads.create     crm.leads.edit     crm.leads.delete
crm.deals.view      crm.pipeline.manage
hr.employees.view   hr.payroll.approve
tasks.tasks.assign  accounting.journal.post
```

Roles are org-owned bundles of permissions. System roles (`owner`, `admin`,
`member`, `guest`) are seeded; custom roles are fully supported. A permission
only becomes grantable once its app is entitled — you cannot assign HR
permissions to a workspace that has not bought HR.

Never `if (user.role === 'admin')` anywhere in the codebase.

---

## 8. Frontend

Next.js 15, App Router, **JavaScript only**, Tailwind v4, one app shell that
composes app modules discovered at runtime.

- Navigation, dashboard widgets and command-palette actions are all **derived**
  from `GET /me/workspace` → `{ installedApps, entitlements, permissions }`.
  Nothing is hardcoded per customer.
- Each business app ships a `module.js` manifest (routes, nav, widgets,
  search providers, quick actions). Adding an app changes zero shell code.
- Server Components fetch through the gateway with the forwarded cookie;
  Client Components use a typed fetch wrapper with optimistic updates.
- Design language: dense, keyboard-first, calm. Graphite/indigo neutral scale,
  Inter + tabular numerals, 8px rhythm, motion under 200ms, full dark mode.
  Target feel: Linear's polish applied to Odoo's breadth.

---

## 9. Data ownership map

| Concept | Owning service | Everyone else |
|---|---|---|
| user, credentials | identity | read via token claims / API |
| organization, membership, role | tenancy | read via gateway-injected context |
| app install state | catalog | read via entitlement projection |
| subscription, price, invoice | billing | read via entitlement projection |
| customer, contact | crm (system of record) | subscribe to `crm.customer.*` |
| product, stock | erp | subscribe to `erp.product.*` |
| employee | hr | subscribe to `hr.employee.*` |
| shift, attendance, punch | hr | read the period summary over HTTP |
| salary, payslip, payroll run | payroll | subscribe to `payroll.run.*` |
| invoice, payment | invoicing | subscribe to `billing.invoice.*` |
| file blob + metadata | files | hold `file_id` references only |

Exactly one writer per concept. Everyone else holds a projection.

**The HR / payroll seam is the worked example.** HR owns time, payroll owns
money, and they share nothing but two HTTP reads:

```
payroll ──GET /internal/employees?active_on=…──────────▶ hr
payroll ──GET /internal/attendance/summary?from=…&to=…─▶ hr
```

Both are called once, at the moment a run is processed, with the internal
service token. What comes back is **snapshotted onto the payslip** — name,
code, designation, department, days worked — rather than referenced. That is
the whole point: a payslip must still read correctly in three years when the
person has left, their department has been renamed and their shift retimed.
Payroll never opens HR's database, and HR never learns what a day is worth in
rupees.

A read model would be the wrong tool here. Attendance is amended right up to
the moment payroll runs, so a projection kept current by events would be a
cache that is stale exactly when it matters. Reading once, synchronously, at
the point of use — and then freezing the answer — is both simpler and more
correct.

### Self-service, and the `self` namespace

One role on the platform grants `*.self.*` and nothing else: `employee`. The
permission is not what makes it safe. What makes it safe is that **every route
it can reach resolves the person from the signed-in user, and none of them
accepts an employee id.**

```
GET /api/hr/me/attendance        ← resolved from request.ctx.userId
GET /api/payroll/me/payslips/:id ← id is the PAYSLIP's, and the query
                                    also filters on the resolved employee
```

There is no parameter to tamper with, so there is no confused-deputy problem
to reason about. A colleague's payslip id pasted into a portal session does
not match the `WHERE` clause and comes back 404 — not because we checked, but
because the query never had another shape.

Two consequences worth stating:

- **A `self` route is never the same route with a weaker guard.** The portal's
  "apply for leave" is a separate endpoint from HR's, precisely so the employee
  id comes from the session rather than the body. The *rules* are shared
  (`hr/lib/leave.js`), the *identity resolution* is not.
- **Payroll does not hold the user→employee mapping.** It asks HR, which owns
  the employee record. One writer per concept applies to the mapping too.

### Machine callers

One route on the gateway carries no user token, because its caller is not a
user: `POST /api/device-sync/punches`, where attendance terminals post. It
passes two independent gates rather than one —

1. the gateway's internal service token, proving the request came through us;
2. a per-device key, whose SHA-256 digest is all that is stored, resolving
   which workspace the punch belongs to.

A device key only ever unlocks the workspace it was minted in, so a leaked
terminal key is bounded by that workspace and by rotation. The plaintext key
is displayed exactly once, at creation; there is no recovery path, only
rotation, which is the honest consequence of storing only a digest.

---

## 10. Cross-cutting

- **Migrations** — per service, forward-only, numbered SQL, run at deploy.
  A service may never migrate another service's database.
- **Config** — env-driven, validated at boot with a schema; the process
  refuses to start on a bad config rather than failing at 3am.
- **Observability** — pino structured logs, OpenTelemetry traces propagated
  through gateway → service → bus, `/healthz` + `/readyz` on every service.
- **Errors** — one envelope everywhere:
  `{ error: { code, message, details, request_id } }`.
- **Idempotency** — `Idempotency-Key` honoured on every mutating public POST.
- **Rate limits** — per org and per user at the gateway, Redis token bucket.
- **Audit** — the gateway taps every mutation; services emit semantic events.

---

## 11. AI-ready, not AI-first

No assistant in the MVP. But every service exposes a machine-readable
capability descriptor (resources, filters, actions, required permissions), so
the Phase-22 assistant plans over declared capabilities and executes through
the same gated APIs a human uses — inheriting tenant isolation, entitlements
and permissions for free. No privileged AI backdoor.

---

## 12. Scale path

| Stage | Shape |
|---|---|
| Dev | docker-compose: 1 Postgres (N databases), Redis, NATS, MinIO, Mailpit |
| Early production | Managed Postgres, services on Fly/Render/ECS, 2 replicas each |
| Growth | Postgres per service, read replicas, NATS cluster, per-app autoscaling |
| Scale | Shard heavy tenants to dedicated DBs, regional cells, CDN edge cache |

The architecture does not change between these stages. Only the topology does.
