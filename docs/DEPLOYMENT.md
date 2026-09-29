# Deploying Nexus — Supabase + Railway (API) + Vercel (web)

```
 Browser ── https://acme-4821.yourdomain.com ──► Vercel (Next.js web)
                                                   │  /api/* rewrite
                                                   ▼
                                    Railway: one container, 13 processes
                                    gateway on $PORT ─► identity, tenancy,
                                    billing, crm, hr, tasks, … on localhost
                                                   │
                                                   ▼
                          Supabase Postgres (one schema per service + nexus_bus)
```

The browser only ever talks to the web domain. Vercel forwards `/api/*` to the
Railway gateway, so cookies are first-party on the apex and on every company
subdomain, and no CORS list has to know each company's address.

---

## 1. Supabase

1. **Rotate the database password** (Project settings → Database). The current
   one was shared in chat while setting this up.
2. Copy the **Transaction pooler** connection string (Connect → Transaction
   pooler, port **6543**). It is IPv4; the direct `db.<ref>.supabase.co` host
   is IPv6-only and Railway cannot reach it.
3. Migrations run automatically when each service starts (one schema each). To
   run them by hand: `node scripts/migrate-all.js` with `DATABASE_URL` set.
4. Capacity: the free "Nano" instance has 0.5 GB RAM and 60 connections, and
   free projects **pause after a week without traffic**. For customers, move to
   the Pro plan (Micro or Small compute). With `DB_POOL_MAX=2` the API uses
   about 40 database connections at peak.

## 2. Railway — the API

1. New project → **Deploy from GitHub repo** → this repository. `railway.json`
   tells Railway to build the root `Dockerfile`; the container runs
   `scripts/start-api.js`, which starts every service and puts the gateway on
   `$PORT`. Health check: `/healthz`.
2. **Region: Singapore** (`asia-southeast1`) — the closest Railway region to a
   Supabase project in Mumbai. Every request makes several database round
   trips, so distance matters.
3. **Volume**: mount one at `/app/services/documents/.data` (uploaded files).
4. **Variables**:

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | Supabase transaction-pooler URL (password URL-encoded) |
   | `DB_POOL_MAX` | `2` |
   | `BUS_DRIVER` | `postgres` |
   | `COOKIE_SECRET` | 32+ random characters |
   | `SERVICE_TOKEN` | 32+ random characters (never shared with browsers) |
   | `APP_URL` | `https://yourdomain.com` |
   | `WEB_ORIGIN` | `https://yourdomain.com` |
   | `ROOT_DOMAIN` | `yourdomain.com` |
   | `COOKIE_DOMAIN` | `yourdomain.com` |
   | `COOKIE_SECURE` | `true` |
   | `REGISTER_PER_HOUR` | `10` |
   | `TRIAL_DAYS` | `14` (or `0` to take payment before anything unlocks) |
   | `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` | from Razorpay |
   | `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | ZeptoMail: `smtp.zeptomail.in`, `587`, and the Mail Agent's SMTP user/password |
   | `MAIL_FROM` | e.g. `FLP Worldwide <noreply@flpworldwide.com>` — a domain verified in ZeptoMail |

   Leave `BILLING_TEST_MODE` unset in production. Generate secrets with
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
5. Give the service a domain (Railway's `*.up.railway.app` is fine, or
   `api.yourdomain.com`). Note it for Vercel.

## 3. Vercel — the web app

1. Import the repository. **Root Directory: `apps/web`** (leave "include files
   outside the root directory" on — the app imports `packages/contracts`).
   `apps/web/vercel.json` sets the install and build commands.
2. **Environment variables**:

   | Variable | Value |
   |---|---|
   | `API_URL` | `https://<your-railway-domain>` |
   | `NEXT_PUBLIC_ROOT_DOMAIN` | `yourdomain.com` |

3. **Domains**: add `yourdomain.com` **and** the wildcard `*.yourdomain.com`.
   Vercel issues wildcard certificates only when the domain uses Vercel's
   nameservers — point the domain's nameservers at Vercel first.

## 4. Razorpay

Settings → Webhooks → add `https://yourdomain.com/api/billing-webhooks/razorpay`
with events `payment.captured` and `order.paid`, and the same secret as
`RAZORPAY_WEBHOOK_SECRET`. The browser callback and the webhook both settle the
invoice; settling is idempotent, so receiving both is safe.

## 5. Importing Notion boards

`scripts/import-notion.js` turns exported Notion task databases into private
boards for a workspace owner (idempotent — safe to re-run). See the header of
the script for the export format; `--dry-run` previews without writing.

## 6. After the first deploy

1. Open `https://yourdomain.com/signup`, create a company — you land on
   `https://<company>-<digits>.yourdomain.com/dashboard`.
2. Settings → People → invite someone; confirm the email arrives and the link
   opens on the company's address.
3. Settings → Plan & billing → pay the first invoice with a Razorpay **test**
   key before switching to live keys.

## Local development

```bash
pnpm install
cp .env.example .env          # then set DATABASE_URL (Supabase) or use docker
pnpm dev                      # every service + the web app
```

- With Supabase, services start 1.5 s apart (`STARTUP_STAGGER_MS`) so the
  connection spike stays under the free tier's limit.
- Company subdomains locally: set the `lvh.me` values shown in `.env.example`
  and open `http://lvh.me:<WEB_PORT>`. Each company is then at
  `http://<slug>.lvh.me:<WEB_PORT>`.
- `pnpm test` runs the API regression suite against the running stack.
