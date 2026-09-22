-- ════════════════════════════════════════════════════════════════════════════
-- IDENTITY — the only service that holds credentials.
-- Users are global: one person, one login, many organizations.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE users (
  id                text PRIMARY KEY,
  email             text NOT NULL,
  email_normalized  text NOT NULL,
  email_verified_at timestamptz,
  password_hash     text,
  name              text NOT NULL,
  avatar_url        text,
  phone             text,
  locale            text NOT NULL DEFAULT 'en-IN',
  timezone          text NOT NULL DEFAULT 'Asia/Kolkata',
  status            text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'suspended', 'deleted')),
  mfa_enabled       boolean NOT NULL DEFAULT false,
  mfa_secret        text,
  last_login_at     timestamptz,
  failed_attempts   integer NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  last_org_id       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_normalized_key ON users (email_normalized)
  WHERE status <> 'deleted';
CREATE INDEX users_created_at_idx ON users (created_at DESC);

-- ── sessions ────────────────────────────────────────────────────────────────
-- One row per signed-in device. Refresh tokens rotate on every use; presenting
-- a rotated token means the family is compromised, so the whole family dies.
CREATE TABLE sessions (
  id              text PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id       text NOT NULL,
  refresh_hash    text NOT NULL,
  previous_hash   text,
  user_agent      text,
  ip              inet,
  device_label    text,
  active_org_id   text,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_reason  text,
  last_used_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_idx    ON sessions (user_id, created_at DESC);
CREATE UNIQUE INDEX sessions_refresh_key ON sessions (refresh_hash);
CREATE INDEX sessions_family_idx  ON sessions (family_id);
CREATE INDEX sessions_expiry_idx  ON sessions (expires_at) WHERE revoked_at IS NULL;

-- ── one-time email tokens ───────────────────────────────────────────────────
CREATE TABLE email_tokens (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password', 'magic_link')),
  token_hash  text NOT NULL,
  email       text NOT NULL,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX email_tokens_hash_key ON email_tokens (token_hash);
CREATE INDEX email_tokens_user_idx ON email_tokens (user_id, purpose)
  WHERE consumed_at IS NULL;

-- ── JWT signing keys ────────────────────────────────────────────────────────
-- Stored so every replica signs with the same key and the JWKS is stable
-- across restarts. Rotation: insert a new active key, retire the old one after
-- the longest access-token lifetime has passed.
CREATE TABLE signing_keys (
  id          text PRIMARY KEY,
  kid         text NOT NULL UNIQUE,
  algorithm   text NOT NULL DEFAULT 'RS256',
  public_jwk  jsonb NOT NULL,
  private_pem text NOT NULL,
  status      text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'retiring', 'retired')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  retired_at  timestamptz
);

CREATE INDEX signing_keys_status_idx ON signing_keys (status, created_at DESC);

-- ── login audit ─────────────────────────────────────────────────────────────
CREATE TABLE login_attempts (
  id         bigserial PRIMARY KEY,
  email      text NOT NULL,
  user_id    text,
  success    boolean NOT NULL,
  reason     text,
  ip         inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX login_attempts_email_idx ON login_attempts (email, created_at DESC);
CREATE INDEX login_attempts_ip_idx    ON login_attempts (ip, created_at DESC);

-- ── transactional outbox ────────────────────────────────────────────────────
CREATE TABLE outbox (
  id           text PRIMARY KEY,
  type         text NOT NULL,
  org_id       text,
  actor_id     text,
  data         jsonb NOT NULL DEFAULT '{}',
  version      integer NOT NULL DEFAULT 1,
  attempts     integer NOT NULL DEFAULT 0,
  claimed_at   timestamptz,
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_unpublished_idx ON outbox (created_at)
  WHERE published_at IS NULL;

-- ── updated_at maintenance ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
