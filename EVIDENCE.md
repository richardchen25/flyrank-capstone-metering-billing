# EVIDENCE

One proof per requirement checkbox from DESIGN.md and the capstone brief.

## Cost calculation

### AI token pricing handles cached input, reasoning tokens, and output correctly
### Pricing constants pinned in config, with proof of correct totals

My constants live in `lib/pricing.js`: input $0.10/M, cached input $0.025/M (25% of
input), output $0.40/M, and reasoning priced identically to output. The command below
prints the constants straight off the module, so the totals underneath are proven
against the same values the service prices with.

```
$ node -e "
const p = require('./lib/pricing');
console.log('INPUT_RATE:', p.INPUT_RATE);
console.log('CACHED_INPUT_RATE:', p.CACHED_INPUT_RATE);
console.log('OUTPUT_RATE:', p.OUTPUT_RATE);
console.log('REASONING_RATE:', p.REASONING_RATE);
console.log('2500 output (expect 1000):', p.costMicros({ outputTokens: 2500 }));
console.log('1M input (expect 100000):', p.costMicros({ inputTokens: 1000000 }));
console.log('1M cached (expect 25000):', p.costMicros({ cachedInputTokens: 1000000 }));
console.log('1000 output + 1000 reasoning (expect 800):', p.costMicros({ outputTokens: 1000, reasoningTokens: 1000 }));
console.log('2000 output (expect 800):', p.costMicros({ outputTokens: 2000 }));
console.log('empty (expect 0):', p.costMicros({}));
"
INPUT_RATE: 0.1
CACHED_INPUT_RATE: 0.025
OUTPUT_RATE: 0.4
REASONING_RATE: 0.4
2500 output (expect 1000): 1000
1M input (expect 100000): 100000
1M cached (expect 25000): 25000
1000 output + 1000 reasoning (expect 800): 800
2000 output (expect 800): 800
empty (expect 0): 0
```

`CACHED_INPUT_RATE` prints as `0.025` even though I wrote it as `INPUT_RATE * 0.25`,
since the ratio is what I pinned and it evaluates to the rate in the table.

The reasoning case is the important one. 1,000 output plus 1,000 reasoning costs 800
micros, which is identical to the 2,000 output tokens printed on the next line, so
reasoning folds into output before multiplying rather than being ignored or priced on a
separate line.

The cached case is the other one worth reading. 1M cached input costs 25,000 micros
rather than the 100,000 that 1M plain input costs, so summing the categories before
pricing would charge the input rate on cached tokens and overcharge by 4x.

## Metering

### A duplicate request returns the original response rather than billing twice

The server is running against the database in `.env` on port 5433, with tenant 1 on the
Free plan. I sent the same `Idempotency-Key` twice with the same body.

```
$ curl -s -X POST http://localhost:3000/generate \
    -H 'X-Tenant-Id: 1' -H 'Idempotency-Key: rem-1' \
    -H 'Content-Type: application/json' \
    -d '{"event_type":"tokens","input_tokens":1000,"output_tokens":2500}'
{"event":{"id":"8","tenant_id":"1","event_type":"tokens","quantity":0,"input_tokens":1000,"cached_input_tokens":0,"output_tokens":2500,"reasoning_tokens":0,"cost_micros":"1100","idempotency_key":"rem-1","created_at":"2026-08-29T06:55:24.346Z"},"cost_micros":1100,"duplicate":false,"remaining":{"api_calls":999,"tokens":88000}} [200]

$ # identical request replayed
{"event":{"id":"8","tenant_id":"1","event_type":"tokens","quantity":0,"input_tokens":1000,"cached_input_tokens":0,"output_tokens":2500,"reasoning_tokens":0,"cost_micros":"1100","idempotency_key":"rem-1","created_at":"2026-08-29T06:55:24.346Z"},"cost_micros":1100,"duplicate":true,"remaining":{"api_calls":999,"tokens":88000}} [200]
```

The event id stays `8` and `created_at` stays at the first request's timestamp, so no
second row was written and only `duplicate` changes. `remaining` is identical across the
two, which is the point, because the replay reports the quota state the original request
left behind rather than a second deduction.

The cost is also the cross-check on section 5's rule: 1,000 input at $0.10/M is 100
micros, 2,500 output at $0.40/M is 1,000 micros, and the total is 1,100.

In an earlier run I proved the same key beats a changed body, since replaying a key with
`output_tokens` raised to 999,999 returned the original 2,500-token event unchanged
rather than a second charge.

### The database holds one row, not two, after a retry

I ran this from an emptied `usage_events` table, so the row ids and the quota figures
are unambiguous rather than carried over from earlier runs.

```
$ docker compose exec db psql -U billing -d billing -P pager=off -c "DELETE FROM usage_events"
DELETE 0

=== run 1 ===
$ curl -s -X POST http://localhost:3000/generate -H "Content-Type: application/json" \
    -H "X-Tenant-Id: 1" -H "Idempotency-Key: evidence-idem-1" \
    -d '{"event_type":"tokens","tokens":{"inputTokens":1000,"outputTokens":2500}}'
{"event":{"id":"14","tenant_id":"1","event_type":"tokens","quantity":0,"input_tokens":1000,"cached_input_tokens":0,"output_tokens":2500,"reasoning_tokens":0,"cost_micros":"1100","idempotency_key":"evidence-idem-1","created_at":"2026-08-29T07:04:22.692Z"},"cost_micros":1100,"duplicate":false,"remaining":{"api_calls":1000,"tokens":96500}}

=== run 2 (same key) ===
{"event":{"id":"14","tenant_id":"1","event_type":"tokens","quantity":0,"input_tokens":1000,"cached_input_tokens":0,"output_tokens":2500,"reasoning_tokens":0,"cost_micros":"1100","idempotency_key":"evidence-idem-1","created_at":"2026-08-29T07:04:22.692Z"},"cost_micros":1100,"duplicate":true,"remaining":{"api_calls":1000,"tokens":96500}}

=== row count ===
$ docker compose exec db psql -U billing -d billing -P pager=off \
    -c "SELECT COUNT(*) FROM usage_events WHERE idempotency_key = 'evidence-idem-1'"
 count
-------
     1
(1 row)
```

Four things line up here. The event id is `14` in both responses and `created_at` is
identical, so the second request returned the first request's row rather than writing its
own. `duplicate` flips from `false` to `true`. The row count is 1. And `remaining.tokens`
is 96,500 in both, which is 100,000 minus the 3,500 tokens of a single event rather than
the 7,000 two events would have consumed, so the quota side confirms nothing was billed
twice.

`DELETE 0` reports zero rows because the table had already been cleared before this run.
The end state is a table holding exactly one row, which is what the count asserts.

The count is only meaningful alongside the cost. An earlier version of this probe
returned `count = 1` with `SUM(cost_micros) = 0`, because a malformed body had been
metered as zero on a previous run and both requests in that probe had failed outright
without writing anything. One row is not proof on its own, but one row billed 1,100
micros is.

### Remaining quota is reported against the plan limit

```
$ curl -s -X POST http://localhost:3000/generate \
    -H 'X-Tenant-Id: 1' -H 'Idempotency-Key: rem-call' \
    -H 'Content-Type: application/json' \
    -d '{"event_type":"api_call","quantity":5}'
{"event":{"id":"9",...,"event_type":"api_call","quantity":5,...,"cost_micros":"0","idempotency_key":"rem-call",...},"cost_micros":0,"duplicate":false,"remaining":{"api_calls":994,"tokens":88000}} [200]
```

Free allows 1,000 calls and 100,000 tokens. One call had been recorded before this
request, so five more leaves 994. The token figure is untouched at 88,000 because an
`api_call` event carries no tokens, which shows the two dimensions are metered
independently.

## Quotas

### A request that would exceed the plan limit is rejected with 429

Tenant 1 is on Free with 100,000 tokens per month, and already has 8,500 tokens recorded
in the period. The request below asks for 100,000 more, which would land at 108,500.

```
$ curl -s -X POST http://localhost:3000/generate \
    -H 'X-Tenant-Id: 1' -H 'Idempotency-Key: quota-flat' \
    -H 'Content-Type: application/json' \
    -d '{"event_type":"tokens","input_tokens":100000}'
{"error":"quota_exceeded"} [429]
```

It is rejected whole rather than partially fulfilled, following the boundary rule in
DESIGN.md section 8. It returns 429 rather than 402 because the subscription is active
and it is the quota that is spent. No row was written, so the rejected request did not
consume quota either.

### The three boundary cases from DESIGN.md section 8

Free allows 1,000 API calls. Each block starts from an emptied `usage_events`, and every
case is a single `curl` reporting both body and status, so no key is sent twice and no
response below is a mirrored duplicate.

```
$ docker compose exec db psql -U billing -d billing -P pager=off -c "DELETE FROM usage_events"
DELETE 0

=== consume 999 of 1000 ===
$ curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:3000/generate \
    -H "Content-Type: application/json" -H "X-Tenant-Id: 1" \
    -H "Idempotency-Key: b-999" -d '{"event_type":"api_call","quantity":999}'
{"event":{"id":"8","tenant_id":"1","event_type":"api_call","quantity":999,"input_tokens":0,"cached_input_tokens":0,"output_tokens":0,"reasoning_tokens":0,"cost_micros":"0","idempotency_key":"b-999","created_at":"2026-08-29T07:14:01.853Z"},"cost_micros":0,"duplicate":false,"remaining":{"api_calls":1,"tokens":100000}}
HTTP 200

=== case 1: request 1, lands exactly at limit (expect 200) ===
$ curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:3000/generate \
    -H "Content-Type: application/json" -H "X-Tenant-Id: 1" \
    -H "Idempotency-Key: b-at-limit" -d '{"event_type":"api_call","quantity":1}'
{"event":{"id":"9","tenant_id":"1","event_type":"api_call","quantity":1,"input_tokens":0,"cached_input_tokens":0,"output_tokens":0,"reasoning_tokens":0,"cost_micros":"0","idempotency_key":"b-at-limit","created_at":"2026-08-29T07:14:01.875Z"},"cost_micros":0,"duplicate":false,"remaining":{"api_calls":0,"tokens":100000}}
HTTP 200

=== case 2: one more (expect 429) ===
$ curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:3000/generate \
    -H "Content-Type: application/json" -H "X-Tenant-Id: 1" \
    -H "Idempotency-Key: b-over" -d '{"event_type":"api_call","quantity":1}'
{"error":"quota_exceeded"}
HTTP 429
```

Case 1 lands exactly on 1,000 and is allowed, because the limit is a ceiling the tenant
may reach rather than one they have to stay under. `remaining.api_calls` reads 0 rather
than a negative number, and `duplicate` is `false`, so this is a real insert rather than
a mirrored retry. Case 2 is the same request one call later and is refused with 429,
since the subscription is active and the quota is spent.

Case 3 is the all-or-nothing rule, run from an emptied table:

```
$ docker compose exec db psql -U billing -d billing -P pager=off -c "DELETE FROM usage_events"
DELETE 2
$ # consume 999 (key o-999, output discarded), then ask for 6 more

=== at 999, request 6 (expect 429, nothing recorded) ===
$ curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:3000/generate \
    -H "Content-Type: application/json" -H "X-Tenant-Id: 1" \
    -H "Idempotency-Key: o-6" -d '{"event_type":"api_call","quantity":6}'
{"error":"quota_exceeded"}
HTTP 429

$ docker compose exec db psql -U billing -d billing -P pager=off \
    -c "SELECT COALESCE(SUM(quantity),0) AS used FROM usage_events WHERE tenant_id = 1 AND event_type = 'api_call'"
 used
------
  999
(1 row)
```

One of the six calls would have fit under the limit, but none was served, since usage
stays at 999 rather than 1,000. The request is refused whole rather than partially
filled, which is the rule in DESIGN.md section 8, because serving part of a request
would mean billing for work that was not completed.

The `DELETE 0` on the first block is not a failed cleanup, since the table was already
empty when that run started. Row ids continue from earlier runs because `DELETE` does not
reset the sequence, which is why the two blocks start at 8 and at a fresh pair rather
than at 1.

### Auth, identity, and malformed bodies are separated from quota failures

```
$ # no X-Tenant-Id header
{"error":"missing_tenant"} [401]

$ # no Idempotency-Key header
{"error":"missing_idempotency_key"} [400]

$ # X-Tenant-Id: 999
{"error":"tenant_not_found"} [404]

$ # {"event_type":"nonsense"}
{"error":"invalid_event_type"} [400]

$ # {"event_type":"tokens","input_tokens":-5}
{"error":"invalid_token_count","field":"input_tokens"} [400]

$ # {"event_type":"tokens","output_tokens":1.5}
{"error":"invalid_token_count","field":"output_tokens"} [400]

$ # {"event_type":"tokens","output_token":2500}  — singular typo
{"error":"unknown_field","field":"output_token"} [400]
```

Each failure names the field that caused it, and none of them returns a stack trace. The
400 on a missing `Idempotency-Key` is the policy from DESIGN.md section 7, since I made
the header mandatory rather than server-generated.

### Both request shapes meter identically, and mixing them is rejected

Flat is canonical, and I accept the nested `tokens` object as an alias. The same usage
sent either way produces the same stored row and the same cost.

```
$ # nested, sent twice with one key
$ curl -s -X POST http://localhost:3000/generate -H "Content-Type: application/json" \
    -H "X-Tenant-Id: 1" -H "Idempotency-Key: probe-5" \
    -d '{"event_type":"tokens","tokens":{"inputTokens":1000,"outputTokens":2500}}'
{"event":{"id":"12",...,"input_tokens":1000,"output_tokens":2500,"cost_micros":"1100",...},"cost_micros":1100,"duplicate":false,...}
{"event":{"id":"12",...,"cost_micros":"1100",...},"cost_micros":1100,"duplicate":true,...}

$ SELECT COUNT(*), SUM(cost_micros) FROM usage_events WHERE idempotency_key = 'probe-5';
{"count":1,"total_cost_micros":1100}

$ # flat, same numbers, different key
{"event":{"id":"13",...,"input_tokens":1000,"output_tokens":2500,"cost_micros":"1100",...},"cost_micros":1100,"duplicate":false,...}
```

The stored row is identical whichever shape arrives, and the response is always flat.
These are the failure modes around the alias:

```
$ # {"event_type":"tokens","tokens":{"inputToken":1000}}  — typo inside the object
{"error":"unknown_field","field":"tokens.inputToken"} [400]

$ # {"event_type":"tokens","input_tokens":1000,"tokens":{"outputTokens":2500}}  — both at once
{"error":"conflicting_token_fields","field":"input_tokens"} [400]

$ # {"event_type":"tokens","tokens":"nope"}
{"error":"invalid_tokens"} [400]

$ # {"event_type":"tokens","tokens":{"inputTokens":-5}}
{"error":"invalid_token_count","field":"tokens.inputTokens"} [400]
```

I made mixing the shapes a 400 rather than a precedence rule, because two sources for
one number is how a wrong bill gets written quietly, so I refuse the request instead of
resolving it.

## Stripe integration

### Webhooks verify signatures

A request with a fabricated `Stripe-Signature` header:

```
=== forged webhook (expect 400) ===
{"error":"invalid_signature"}
HTTP 400
=== processed_webhooks rows (expect 0) ===
 count
-------
     0
```

Verification happens in the route itself, before any database call. `constructEvent`
recomputes the HMAC over the raw request bytes and throws unless it matches the
`Stripe-Signature` header, so the handler that writes `processed_webhooks`,
`subscriptions`, and `tenants` is never reached and the forged event leaves no trace.
This is exactly why I mount the route with `express.raw({ type: 'application/json' })`
ahead of the global `express.json()`, because a body that has been parsed and
re-serialised no longer hashes to the value Stripe signed, and every signature would
fail for reasons that look nothing like the cause.

### Webhooks ignore duplicate events

The same event redelivered with `stripe events resend`:

```
=== before ===
 count
-------
    15

$ stripe events resend evt_1U9hJPA5PfF0gj0QCxdXNNOI
(event redelivered; payload omitted)

=== after (expect same count) ===
 count
-------
    15
```

`processed_webhooks` has `stripe_event_id` as its primary key, and the first statement
inside the handler's transaction inserts the incoming event id there. A redelivery
violates that primary key, the insert raises SQLSTATE 23505, and the handler returns 200
having applied nothing, which is the right answer to Stripe since an error would only
earn another retry of an event I already handled. I put the insert first rather than last
so a replay is rejected before any tenant or subscription row is touched, and I keep it
inside the same transaction as the writes so that a failed handler rolls the marker back
too, which means Stripe's retry gets a real second attempt instead of finding a marker
for work that never happened.

### Subscription checkout works end-to-end in Stripe test mode
### Webhooks update tenant plan / status

`POST /checkout` for tenant 1 on the `pro` plan returns a Checkout session URL. Paying
with test card `4242 4242 4242 4242` in the sandbox produced these events from `stripe
listen`, all answered 200:

```
--> checkout.session.completed [evt_1U9hQ9A5PfF0gj0QBnPfAblO]
<-- [200] POST http://localhost:3000/webhooks/stripe
--> customer.subscription.created [evt_1U9hQ9A5PfF0gj0QmeWUP3Ih]
<-- [200] POST http://localhost:3000/webhooks/stripe
```

The tenant row after the webhooks were processed:

```
 id | plan_id | subscription_status | stripe_customer_id
----+---------+---------------------+--------------------
  1 | pro     | active              | cus_VA1Td5LEvdsqyK
```

The subscription row, with the billing period Stripe assigned:

```
    stripe_subscription_id    | status |  current_period_start  |   current_period_end
------------------------------+--------+------------------------+------------------------
 sub_1U9hQ7A5PfF0gj0Q3JtDmxzZ | active | 2026-08-29 08:15:21+00 | 2026-09-29 08:15:21+00
```

And the quota the metering layer now enforces:

```
$ curl -s -X POST localhost:3000/generate -H "X-Tenant-Id: 1" \
    -H "Idempotency-Key: pro-quota-1787991385" \
    -d '{"event_type":"api_call","quantity":1}'

{"event":{...},"cost_micros":0,"duplicate":false,
 "remaining":{"api_calls":49999,"tokens":5000000}}
```

The tenant row on its own only proves a string was written. `49,999` proves the whole
chain agreed, because the webhook set `plan_id` to `pro`, the meter's join to `plans`
read Pro's `api_calls_limit` of 50,000 rather than Free's 1,000, and one call inside the
period was counted against it.

The token figure is what identifies where the billing period came from. It reads
5,000,000, which is the full Pro allowance, even though 7,000 tokens were metered for
this same tenant earlier the same day at 07:32 and 07:33. Those events fall before
`current_period_start` of 08:15:21, so the rollup excludes them. A calendar-month window
would have counted them and returned 4,993,000, and the `COALESCE` fallback in
`recordUsage` would have produced exactly that. 5,000,000 is only reachable by reading
the period off the `subscriptions` row Stripe created, which is the claim I make for
that table in DESIGN.md section 3.

### An inactive subscription is 402, and flipping it back restores service

I flipped `subscription_status` directly in the database rather than through a Stripe
webhook, so this exercises the enforcement path without a live Stripe event. Each
request uses a fresh key, so no response here is a mirrored retry.

```
$ docker compose exec db psql -U billing -d billing -P pager=off -c "DELETE FROM usage_events"
DELETE 1
$ docker compose exec db psql -U billing -d billing -P pager=off \
    -c "UPDATE tenants SET subscription_status = 'past_due' WHERE id = 1"
UPDATE 1

=== subscription past_due: fresh key (expect 402) ===
$ curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:3000/generate \
    -H "Content-Type: application/json" -H "X-Tenant-Id: 1" \
    -H "Idempotency-Key: sub-402" -d '{"event_type":"api_call","quantity":1}'
{"error":"subscription_inactive"}
HTTP 402

$ docker compose exec db psql -U billing -d billing -P pager=off \
    -c "UPDATE tenants SET subscription_status = 'active' WHERE id = 1"
UPDATE 1

=== restored to active: same request, fresh key (expect 200) ===
$ curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:3000/generate \
    -H "Content-Type: application/json" -H "X-Tenant-Id: 1" \
    -H "Idempotency-Key: sub-200" -d '{"event_type":"api_call","quantity":1}'
{"event":{"id":"13","tenant_id":"1","event_type":"api_call","quantity":1,"input_tokens":0,"cached_input_tokens":0,"output_tokens":0,"reasoning_tokens":0,"cost_micros":"0","idempotency_key":"sub-200","created_at":"2026-08-29T07:21:09.714Z"},"cost_micros":0,"duplicate":false,"remaining":{"api_calls":999,"tokens":100000}}
HTTP 200

$ docker compose exec db psql -U billing -d billing -P pager=off \
    -c "SELECT COUNT(*) AS rows_written FROM usage_events WHERE tenant_id = 1"
 rows_written
--------------
            1
(1 row)
```

The flip back to `active` is what makes this a proof rather than a coincidence, since the
identical request fails and then succeeds with nothing changing but the subscription
status. The row count is 1, so the rejected request wrote nothing, meaning a 402 costs
the tenant no quota.

### When a tenant is both over quota and past due, 402 wins

DESIGN.md section 8 says the inactive subscription is the more fundamental problem and
takes precedence. I sent the same request twice against a tenant sitting at 1,000/1,000
calls, changing only the subscription status.

```
$ docker compose exec db psql -U billing -d billing -P pager=off -c "DELETE FROM usage_events"
DELETE 1
$ # consume the full 1,000 calls (key pri-1000, output discarded)

=== at 1000/1000, subscription active (expect 429) ===
$ curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:3000/generate \
    -H "Content-Type: application/json" -H "X-Tenant-Id: 1" \
    -H "Idempotency-Key: pri-429" -d '{"event_type":"api_call","quantity":1}'
{"error":"quota_exceeded"}
HTTP 429

$ docker compose exec db psql -U billing -d billing -P pager=off \
    -c "UPDATE tenants SET subscription_status = 'past_due' WHERE id = 1"
UPDATE 1

=== same request, still over quota, now also past_due (expect 402, not 429) ===
$ curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:3000/generate \
    -H "Content-Type: application/json" -H "X-Tenant-Id: 1" \
    -H "Idempotency-Key: pri-402" -d '{"event_type":"api_call","quantity":1}'
{"error":"subscription_inactive"}
HTTP 402

$ docker compose exec db psql -U billing -d billing -P pager=off \
    -c "UPDATE tenants SET subscription_status = 'active' WHERE id = 1"
UPDATE 1
```

The quota is exhausted in both cases, so 429 would be defensible either time. The
response changes to 402 because the subscription check runs first, which is the ordering
I argue for in DESIGN.md section 8, since telling a tenant to wait for a quota reset is
misleading when the subscription that would reset it has lapsed.

## Data model

### Monthly usage rolls up into a cost figure per tenant
### Database includes tenants, plans, subscriptions, and usage events

`GET /usage` for tenant 1, after the Pro upgrade and a few metered requests:

```
$ curl -s http://localhost:3000/usage -H "X-Tenant-Id: 1"

{
  "tenant_id": "1",
  "plan": { "id": "pro", "name": "Pro" },
  "subscription_status": "active",
  "period": {
    "start": "2026-08-29T08:15:21.000Z",
    "end": "2026-09-29T08:15:21.000Z",
    "source": "stripe_subscription"
  },
  "api_calls": { "used": 2, "limit": 50000, "remaining": 49998 },
  "tokens": { "used": 3500, "limit": 5000000, "remaining": 4996500 },
  "cost_micros": 1100
}

HTTP 200
```

`period.source` reports where the window came from. `stripe_subscription` means the
bounds were read off the `subscriptions` row Stripe created, and
`calendar_month_fallback` would mean no covering subscription existed and the code fell
back to the calendar month. The distinction matters because every number beside it is
relative to that window, since a tenant who subscribed on the 29th has a quota period
running the 29th to the 29th, and measuring their usage against August 1st to September
1st would give a different answer to the same question. Reporting the source turns that
from something a reviewer has to infer out of the timestamps into something the response
states.

Four tables had to agree for this one response. `tenants` supplied `plan_id` and
`subscription_status`, `plans` supplied the name and the two limits so that `50000` is
Pro's row rather than a constant in my code, `subscriptions` supplied the period bounds
that scope the rollup, and `usage_events` supplied the rows summed inside them. The fifth
table, `processed_webhooks`, is why the subscription row exists exactly once, because
Stripe delivered `customer.subscription.created` and a redelivery of it would not have
written a second row or shifted this period.

`cost_micros: 1100` traces to the constants in `lib/pricing.js`. The only token-metered
event in this period carried 1,000 input and 2,500 output tokens, so 1,000 input at $0.10
per million is 100 micros, 2,500 output at $0.40 per million is 1,000 micros, and the
categories are priced separately before being added. The two `api_call` events contribute
nothing, because calls are metered against the quota but carry no per-call rate. The
figure is a `SUM` over `usage_events.cost_micros`, which each event stored at write time
rather than a recomputation at read time, so changing a rate tomorrow leaves what this
period already cost untouched.

### The idempotency guarantee is a database constraint, not application code

`init.sql` has been applied to the running database. These are the indexes on
`usage_events`, read back from `pg_indexes`:

```
$ node -e "
require('dotenv').config({ quiet: true });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT indexdef FROM pg_indexes WHERE tablename='usage_events' ORDER BY indexname\")
  .then(r => { r.rows.forEach(x => console.log(x.indexdef)); return pool.end(); });
"
CREATE UNIQUE INDEX usage_events_pkey ON public.usage_events USING btree (id)
CREATE INDEX usage_events_tenant_id_created_at_idx ON public.usage_events USING btree (tenant_id, created_at)
CREATE UNIQUE INDEX usage_events_tenant_idempotency_key ON public.usage_events USING btree (tenant_id, idempotency_key)
```

The unique index is on the pair `(tenant_id, idempotency_key)` rather than on the key
alone, so one tenant's key cannot collide with another tenant's. The second index covers
the rollup query, which always filters on tenant and period.
