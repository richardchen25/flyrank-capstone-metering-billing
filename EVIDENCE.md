# EVIDENCE

One proof per requirement checkbox from DESIGN.md / the capstone brief.

## Cost calculation

### AI token pricing handles cached input, reasoning tokens, and output correctly
### Pricing constants pinned in config, with proof of correct totals

Constants live in `lib/pricing.js`: input $0.10/M, cached input $0.025/M (25% of
input), output $0.40/M, reasoning priced identically to output. The command below
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

`CACHED_INPUT_RATE` prints as `0.025` although it is written as
`INPUT_RATE * 0.25` — the ratio is what is pinned, and it evaluates to the rate
in the table.

The reasoning case is the important one: 1,000 output + 1,000 reasoning costs 800
micros, identical to the 2,000 output tokens printed on the next line. Reasoning
folds into output before multiplying rather than being ignored or priced on a
separate line.

The cached case is the other one worth reading: 1M cached input costs 25,000
micros, not the 100,000 that 1M plain input costs. Summing the categories before
pricing would charge the input rate on cached tokens and overcharge by 4x.

## Metering

### A duplicate request returns the original response rather than billing twice

Server running against the database in `.env` (port 5433), tenant 1 on the Free
plan. The same `Idempotency-Key` is sent twice with the same body.

```
$ curl -s -X POST http://localhost:3000/generate \
    -H 'X-Tenant-Id: 1' -H 'Idempotency-Key: rem-1' \
    -H 'Content-Type: application/json' \
    -d '{"event_type":"tokens","input_tokens":1000,"output_tokens":2500}'
{"event":{"id":"8","tenant_id":"1","event_type":"tokens","quantity":0,"input_tokens":1000,"cached_input_tokens":0,"output_tokens":2500,"reasoning_tokens":0,"cost_micros":"1100","idempotency_key":"rem-1","created_at":"2026-08-29T06:55:24.346Z"},"cost_micros":1100,"duplicate":false,"remaining":{"api_calls":999,"tokens":88000}} [200]

$ # identical request replayed
{"event":{"id":"8","tenant_id":"1","event_type":"tokens","quantity":0,"input_tokens":1000,"cached_input_tokens":0,"output_tokens":2500,"reasoning_tokens":0,"cost_micros":"1100","idempotency_key":"rem-1","created_at":"2026-08-29T06:55:24.346Z"},"cost_micros":1100,"duplicate":true,"remaining":{"api_calls":999,"tokens":88000}} [200]
```

Event id stays `8` and `created_at` stays at the first request's timestamp, so no
second row was written; only `duplicate` changes. `remaining` is identical across
the two, which is the point — the replay reports the quota state the original
request left behind, not a second deduction.

The cost is also the cross-check on section 5's rule: 1,000 input at $0.10/M is
100 micros, 2,500 output at $0.40/M is 1,000 micros, total 1,100.

An earlier run proved the same key beats a changed body — replaying a key with
`output_tokens` raised to 999,999 returned the original 2,500-token event
unchanged, not a second charge.

### The database holds one row, not two, after a retry

Run from an emptied `usage_events` table, so the row ids and the quota figures
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

Four things line up. The event id is `14` in both responses and `created_at` is
identical, so the second request returned the first request's row rather than
writing its own. `duplicate` flips from `false` to `true`. The row count is 1.
And `remaining.tokens` is 96,500 in both — 100,000 minus the 3,500 tokens of a
single event, not the 7,000 two events would have consumed, which is the
quota-side confirmation that nothing was billed twice.

`DELETE 0` reports zero rows because the table had already been cleared before
this run; the end state is a table holding exactly one row, which is what the
count asserts.

The count is only meaningful alongside the cost. An earlier version of this probe
returned `count = 1` with `SUM(cost_micros) = 0`: a malformed body had been
metered as zero on a previous run, and both requests in that probe had failed
outright without writing anything. One row is not proof on its own — one row
billed 1,100 micros is.

### Remaining quota is reported against the plan limit

```
$ curl -s -X POST http://localhost:3000/generate \
    -H 'X-Tenant-Id: 1' -H 'Idempotency-Key: rem-call' \
    -H 'Content-Type: application/json' \
    -d '{"event_type":"api_call","quantity":5}'
{"event":{"id":"9",...,"event_type":"api_call","quantity":5,...,"cost_micros":"0","idempotency_key":"rem-call",...},"cost_micros":0,"duplicate":false,"remaining":{"api_calls":994,"tokens":88000}} [200]
```

Free allows 1,000 calls and 100,000 tokens. One call had been recorded before
this request, so five more leaves 994; the token figure is untouched at 88,000
because an `api_call` event carries no tokens. The two dimensions are metered
independently.

## Quotas

### A request that would exceed the plan limit is rejected with 429

Tenant 1 is on Free (100,000 tokens/month) with 8,500 tokens already recorded in
the period. The request below asks for 100,000 more, which would land at 108,500.

```
$ curl -s -X POST http://localhost:3000/generate \
    -H 'X-Tenant-Id: 1' -H 'Idempotency-Key: quota-flat' \
    -H 'Content-Type: application/json' \
    -d '{"event_type":"tokens","input_tokens":100000}'
{"error":"quota_exceeded"} [429]
```

Rejected whole rather than partially fulfilled, per the boundary rule in
DESIGN.md section 8. 429 rather than 402 because the subscription is active and
it is the quota that is spent. No row was written, so the rejected request did
not consume quota either.

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

Each failure names the field that caused it, and none of them returns a stack
trace. The 400 on a missing `Idempotency-Key` is the policy from DESIGN.md
section 7 — the header is mandatory rather than server-generated.

### Both request shapes meter identically, and mixing them is rejected

Flat is canonical; the nested `tokens` object is accepted as an alias. The same
usage sent either way produces the same stored row and the same cost.

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

The stored row is identical whichever shape arrives, and the response is always
flat. The failure modes around the alias:

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

Mixing the shapes is a 400 rather than a precedence rule. Two sources for one
number is how a wrong bill gets written quietly, so the request is refused
instead of resolved.

## Stripe integration

_(pending)_

## Data model

### The idempotency guarantee is a database constraint, not application code

`init.sql` has been applied to the running database. Indexes on `usage_events`,
read back from `pg_indexes`:

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

The unique index is on the pair `(tenant_id, idempotency_key)`, not on the key
alone, so one tenant's key cannot collide with another tenant's. The second
index covers the rollup query, which always filters on tenant and period.
