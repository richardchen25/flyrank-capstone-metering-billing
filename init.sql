-- Schema for the metering and billing service. See DESIGN.md section 3.

CREATE TABLE IF NOT EXISTS plans (
  id              TEXT        PRIMARY KEY,
  name            TEXT        NOT NULL,
  api_calls_limit INTEGER     NOT NULL CHECK (api_calls_limit >= 0),
  tokens_limit    BIGINT      NOT NULL CHECK (tokens_limit >= 0),
  price_cents     INTEGER     NOT NULL CHECK (price_cents >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenants (
  id                  BIGSERIAL   PRIMARY KEY,
  name                TEXT        NOT NULL,
  plan_id             TEXT        NOT NULL REFERENCES plans (id),
  stripe_customer_id  TEXT        UNIQUE,
  subscription_status TEXT        NOT NULL DEFAULT 'inactive',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                     BIGSERIAL   PRIMARY KEY,
  stripe_subscription_id TEXT        NOT NULL UNIQUE,
  tenant_id              BIGINT      NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  status                 TEXT        NOT NULL,
  current_period_start   TIMESTAMPTZ NOT NULL,
  current_period_end     TIMESTAMPTZ NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (current_period_end > current_period_start)
);

CREATE INDEX IF NOT EXISTS subscriptions_tenant_id_idx
  ON subscriptions (tenant_id);

CREATE TABLE IF NOT EXISTS usage_events (
  id                  BIGSERIAL   PRIMARY KEY,
  tenant_id           BIGINT      NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  event_type          TEXT        NOT NULL CHECK (event_type IN ('api_call', 'tokens')),
  quantity            INTEGER     NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  input_tokens        INTEGER     NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  cached_input_tokens INTEGER     NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  output_tokens       INTEGER     NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  reasoning_tokens    INTEGER     NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  cost_micros         BIGINT      NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  -- NOT NULL because Postgres treats NULLs as distinct, which would exempt
  -- keyless requests from the unique constraint below.
  idempotency_key     TEXT        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT usage_events_tenant_idempotency_key UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS usage_events_tenant_id_created_at_idx
  ON usage_events (tenant_id, created_at);

CREATE TABLE IF NOT EXISTS processed_webhooks (
  stripe_event_id TEXT        PRIMARY KEY,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- price_cents for Pro is a placeholder; reconcile with the Stripe Price used by
-- POST /checkout.
INSERT INTO plans (id, name, api_calls_limit, tokens_limit, price_cents) VALUES
  ('free', 'Free', 1000,    100000,  0),
  ('pro',  'Pro',  50000, 5000000, 2000)
ON CONFLICT (id) DO NOTHING;

-- A tenant to meter against before any Stripe customer exists. The id is fixed
-- so local curl commands can hardcode it; setval then stops BIGSERIAL from
-- handing the same id to the next real tenant.
INSERT INTO tenants (id, name, plan_id, subscription_status) VALUES
  (1, 'Test Tenant', 'free', 'active')
ON CONFLICT (id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('tenants', 'id'), (SELECT MAX(id) FROM tenants));
