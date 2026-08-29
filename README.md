# flyrank-capstone-metering-billing

This is a usage metering and billing engine. It answers three questions about any tenant
using my API: how much have they used this period, what did that usage cost, and have
they hit their plan's limit.

Usage arrives in two forms, plain API calls and AI tokens, and tokens are priced by
category (input, cached input, output, reasoning) rather than as a single number. The
hard parts are the ones where inputs do not arrive cleanly, since clients retry
requests, Stripe redelivers webhooks, and "this month" has to mean the Stripe billing
period rather than the calendar month.

My full reasoning is in [DESIGN.md](DESIGN.md), and the command output proving each
requirement is in [EVIDENCE.md](EVIDENCE.md).

## Architecture

```
   client
     |  X-Tenant-Id, Idempotency-Key
     v
+----------------------------------+        +------------------------+
|  index.js  (routes, validation)  |        |        Stripe          |
|  POST /generate                  |        |                        |
|  GET  /usage                     |        |                        |
|  POST /checkout  ----------------|------->|  Checkout session      |
|  POST /webhooks/stripe  <--------|--------|  subscription events   |
+----------------------------------+        +------------------------+
     |                    |
     |                    +------------------+
     v                                       v
+------------------+                +--------------------+
|  lib/meter.js    |                |  lib/billing.js    |
|  quota + record  |                |  checkout, webhook |
|  lib/pricing.js  |                |  signature verify  |
|  (pure math)     |                |                    |
+------------------+                +--------------------+
     |                                       |
     +------------------+--------------------+
                        v
              +---------------------+
              |  Postgres           |
              |  tenants, plans     |
              |  subscriptions      |
              |  usage_events       |
              |  processed_webhooks |
              +---------------------+
```

I mount `POST /webhooks/stripe` with `express.raw` **before** the global
`express.json()`, because signature verification hashes the unparsed request bytes.

## Running it

Requires Docker and Node 18+.

```bash
git clone <repo> && cd flyrank-capstone-metering-billing
npm install

cp .env.example .env        # then fill in the two Stripe values

docker compose up -d        # Postgres on 5433; init.sql runs on first boot
npm start                   # http://localhost:3000
```

`init.sql` runs automatically the first time the volume is created, and it builds the
five tables, seeds the Free and Pro plans, and seeds tenant `1` on Free. To re-run it
against an existing volume:

```bash
docker compose exec -T db psql -U billing -d billing -f /docker-entrypoint-initdb.d/init.sql
```

Check it works:

```bash
curl -s localhost:3000/usage -H 'X-Tenant-Id: 1'

curl -s -X POST localhost:3000/generate \
  -H 'Content-Type: application/json' \
  -H 'X-Tenant-Id: 1' -H 'Idempotency-Key: demo-1' \
  -d '{"event_type":"tokens","input_tokens":1000,"output_tokens":2500}'
```

The second call returns `cost_micros: 1100`. If I repeat it with the same
`Idempotency-Key` it returns the identical event with `"duplicate": true`, so there is
one row and it is charged once.

### Stripe

`STRIPE_SECRET_KEY` comes from the dashboard (test mode or a sandbox).
`STRIPE_WEBHOOK_SECRET` comes from:

```bash
stripe listen --forward-to localhost:3000/webhooks/stripe
```

Both have to be from the same mode, because otherwise signature verification will pass
while API calls return 401. The server reads `.env` only at boot, so it needs a restart
after any edit.

## API

| Endpoint | Method | Purpose | Status codes |
|---|---|---|---|
| `/generate` | POST | Record usage, return cost and remaining quota | 200, 400, 401, 402, 404, 429 |
| `/usage` | GET | Usage, limits, and cost for the current period | 200, 401, 404 |
| `/checkout` | POST | Create a Stripe Checkout session for a plan | 200, 400, 401, 404, 500 |
| `/webhooks/stripe` | POST | Receive subscription events; replays are a no-op | 200, 400, 500 |

`402` means the subscription is inactive, and `429` means it is active but the quota is
spent. When both apply, 402 wins.

## Plans

| Plan | API calls/month | AI tokens/month |
|---|---|---|
| Free | 1,000 | 100,000 |
| Pro | 50,000 | 5,000,000 |

## Money and pricing

All money is stored as integers in **micro-dollars**, meaning millionths of a dollar. At
$0.10 per million input tokens a single token costs $0.0000001, which is four orders of
magnitude below a cent, so storing cents would round every small event to zero and
floats would drift.

| Category | Rate per 1M tokens |
|---|---|
| Input | $0.10 |
| Cached input | $0.025 (25% of input) |
| Output | $0.40 |
| Reasoning | $0.40 (same as output) |

I price the categories separately and never sum them first. Reasoning folds into output
because the rates match, and cached input never folds into anything because it is
cheaper.

## Known limitations

- **`stripe_customer_id` is trusted without validation.** If the stored id is stale or
  belongs to a different Stripe account, `POST /checkout` passes it to Stripe, Stripe
  fails to find it, and the error surfaces as a generic 500. To handle this properly I
  would catch Stripe's `resource_missing` error specifically, clear the stored id, and
  retry session creation without it so the customer gets recreated.
- **Webhook ordering is not guaranteed.** Stripe does not promise delivery order, and my
  handler applies each event as it arrives. If `customer.subscription.updated` overtakes
  `customer.subscription.created`, the older event arrives later and overwrites the
  newer state. To fix this I would compare the event timestamp against the stored row
  and drop stale updates.
- **Per-event rounding means sub-micro usage bills zero.** I round cost to the nearest
  micro-dollar per event and carry nothing forward, so 1,000 calls that each price at
  0.4 micros bill 0 rather than 400. The alternative is carrying a fractional balance
  per tenant, and I decided the revenue at stake did not justify the complexity. It is
  not a route to free capacity, because quota counts calls and tokens rather than
  micros.
- **Cancellation does not downgrade the plan.** `customer.subscription.deleted` sets
  `subscription_status` to `canceled`, which blocks metering with 402, but it leaves
  `plan_id` pointing at the paid plan.
- **Checkout builds prices inline.** `line_items` uses `price_data` from
  `plans.price_cents` rather than referencing a pre-created Stripe Price, so no
  dashboard setup is needed and there is no `stripe_price_id` on the plan row.
- **No overages.** A tenant at their limit is blocked until the period resets or they
  upgrade. This is a deliberate non-goal rather than something I left out, and I explain
  it in DESIGN.md section 9.
- **No automated test suite.** I verify this with the reproducible commands in
  EVIDENCE.md, run against a live database, rather than with `npm test`.
