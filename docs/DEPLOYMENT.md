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
   | `SMTP_HOST` / `SMTP_PORT` | Gmail: `smtp.gmail.com`, `587` |
   | `SMTP_USER` / `SMTP_PASS` | the Gmail address, and a 16-letter **App Password** (Google Account → Security → 2-Step Verification → App passwords) — never the normal password |
   | `MAIL_FROM` | `FLP Worldwide <that-gmail-address>` — Gmail rewrites any other sender |

   Email is optional: without the SMTP variables, invitations and password
   resets are written to the logs, and Settings → People shows the invite link
   to copy. Gmail sends about 500 messages a day (2,000 on Google Workspace), so
   keep marketing campaigns small or move to a transactional provider later.

   **Leads app, optional:** `META_APP_SECRET` and `META_VERIFY_TOKEN` turn on
   real-time Meta (Facebook/Instagram) lead ads. In the Meta app's Webhooks
   settings, subscribe the Page `leadgen` field to
   `https://yourdomain.com/api/lead-hooks/meta` with the same verify token.
   Without them, connected Pages are polled every 15 minutes, which needs
   nothing set here. Google Sheets and webhook sources need no settings.

   Leave `BILLING_TEST_MODE` unset in production. Generate secrets with
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
5. Give the service a domain (Railway's `*.up.railway.app` is fine, or
   `api.yourdomain.com`). Note it for Vercel.

### Hostinger

The API runs every service inside **one Node process** by default
(`API_PROCESS_MODE=single`, about 400 MB), so it fits Hostinger's process and
memory limits. A whole-site **403** (or 503) from Hostinger means its web server
has no running app to pass requests to: the app crashed, never started, or the
domain points at a folder instead of the Node app.

**Managed Node.js web app (Business / Cloud plans)**

| Setting | Value |
|---|---|
| Framework | Other |
| Root directory | `./` |
| Node version | `22.x` |
| Package manager | pnpm |
| Build command | None |
| Entry file | `scripts/start-api.js` |

Environment: `NODE_ENV=production`, `PORT=3000`, `API_STARTUP_PROXY=true`
(answers within Hostinger's 3-second start check while the services load), the
database, bus and auth variables above, and `STORAGE_ROOT` pointing outside the
app folder (e.g. `/home/<user>/nexus-files`), because each deploy replaces it.
With the startup proxy on, the services also skip internal ports entirely and
call each other in memory, because Hostinger refuses loopback connections
between an app's own servers (`API_INTERNAL_TRANSPORT=tcp` turns this off).
Attach the API's domain/subdomain **to this Node.js app**, not to a website
folder. Redeploy, then open `https://<api-domain>/healthz`: it should answer
JSON `{"status":"ok"…}` within about 10 seconds.

**Hostinger VPS** (any Linux server works the same way)

```bash
git clone <repo> nexus && cd nexus && corepack enable
pnpm install --prod --frozen-lockfile --filter "./packages/*" --filter "./services/*"
cp .env.example .env   # fill in the production values
npx pm2 start scripts/start-api.js --name nexus-api && npx pm2 save
```

Or with Docker: `docker build -t nexus-api . && docker run -d --env-file .env
-p 8080:8080 -v nexus-files:/app/services/documents/.data nexus-api`. Put Nginx
or Caddy in front for HTTPS and proxy to the port.

**Where the API can and cannot run.** Railway, Render, Fly.io, a Hostinger VPS,
Hostinger's managed Node.js apps or any Docker host can run it. Vercel cannot:
its functions stop after each request, and the API keeps background work running
(reminders, the event bus, email retries). Host the web app on Vercel and point
its `API_URL` at wherever the API runs.

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
