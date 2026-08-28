# DESIGN.md

## 1. Problem

This service answers three questions about any tenant using my API: how much have they used this month, what does that usage cost, and have they hit their plan's limit. Usage comes in two forms, plain API calls and AI tokens, and tokens are priced by category rather than as one number. The hard part is that none of the inputs arrive cleanly: clients retry requests, Stripe replays webhooks, and monthly quotas need a definition of "this month" that matches the billing period rather than the calendar. Getting any of those wrong means either double-billing a tenant or losing usage I should have charged for.

## 2. Plans and quotas

| Plan | API calls/month | AI tokens/month |
|---|---|---|
| Free | 1,000 | 100,000 |
| Pro | 50,000 | 5,000,000 |

Pro is exactly 50x Free on both limits. I picked a consistent multiple rather than tuning each number separately, so the ratio between calls and tokens stays the same across tiers and the reasoning is easy to state: Free is sized for evaluation, Pro is sized for a small production workload. One thing I know about these numbers: 5M tokens against 50k calls works out to roughly 100 tokens per call, which is low for real AI usage. That is a consequence of holding the multiple constant, and I would rather have a ratio I can explain than two numbers I picked independently because they felt right.

## 3. Data model

**tenants** — `id`, `name`, `plan_id` (references plans), `stripe_customer_id`, `subscription_status`, `created_at`, `updated_at`.

**plans** — `id`, `name`, `api_calls_limit`, `tokens_limit`, `price_cents`, `created_at`.

I made plans a table rather than config constants. Two reasons. First, tenants already reference a plan, so a real row is something to join against instead of a lookup in application code. Second, and this is the one that decided it: my usage events are historical. If Pro's limits change next month and the limits live in config, then last month's data silently gets reinterpreted against the new numbers. Rows let the old limits stay alive, so a quota check against March uses March's plan.

**subscriptions** — `id`, `stripe_subscription_id`, `tenant_id`, `status`, `current_period_start`, `current_period_end`, `created_at`, `updated_at`.

The period boundaries are the point of this table. Monthly quotas are meaningless without a definition of "this month," and that definition comes from Stripe's billing period, not the calendar month. A tenant who subscribed on the 14th has a quota window that runs the 14th to the 14th.

**usage_events** — `id`, `tenant_id`, `event_type` (api_call or tokens), `quantity`, `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_tokens`, `cost_micros`, `idempotency_key`, `created_at`.

I store the four token categories as separate columns instead of one JSON blob. Every rollup query I expect to write filters or sums by category, like how many cached tokens a tenant used in March, and that is plain SQL against columns versus JSON extraction against a blob. JSON would win if I expected the category list to change often, but these four are stable.

I also store `cost_micros` on the event rather than recomputing it at read time. This matters for billing specifically: if I change a rate next month, recomputing would retroactively rewrite what past usage cost, which is wrong. A usage event should record what it cost when it happened.

**processed_webhooks** — `stripe_event_id` (primary key), `processed_at`.

This table exists because Stripe delivers events at least once, not exactly once. The Stripe event id is the primary key, so a replayed event violates the constraint on insert and I skip it. Two columns, and it is the entire answer to replayed webhooks.

**Indexes**

- Unique index on `usage_events (tenant_id, idempotency_key)`. This is the guarantee itself, not a performance optimization: the database rejects the duplicate, so correctness does not depend on my application code checking first. The index has to be on the pair, not on the key alone. A unique index on `idempotency_key` by itself would mean one tenant's key could collide with another tenant's and reject a legitimate request from someone who has never seen that key.
- Index on `usage_events (tenant_id, created_at)`. Every rollup query filters on both: this tenant, this billing period.

## 4. Money representation

All money is stored as integers in micro-units, meaning millionths of a dollar. This is forced by the arithmetic rather than a style preference. At $0.10 per million input tokens, one token costs $0.0000001, which is four orders of magnitude smaller than a cent. If I stored cents as integers, every small usage event would round to zero and I would bill nothing at all.

Concretely: 2,500 output tokens at $0.40 per million is 2500 x 0.40 / 1,000,000 = $0.001, which is 1,000 micros. That lands in `cost_micros` as the integer 1000. In cents it would be 0.1, which is not an integer, and rounding it gives either 0 or 1 — a 100% error either way on a single event, compounding across thousands of them.

Floats are out for the standard reason: binary floating point cannot represent most decimal fractions exactly, so summing many small costs accumulates error, and money that does not add up exactly is a bug I would have to explain to a customer.

## 5. Token pricing rules

Four categories, four rates, pinned as constants:

| Category | Rate per 1M tokens | Notes |
|---|---|---|
| Input | $0.10 | Base rate |
| Cached input | $0.025 | 25% of input rate |
| Output | $0.40 | 4x input rate |
| Reasoning | $0.40 | Priced identically to output |

I pin cached input as a ratio of input (0.25 x input rate) rather than only as an absolute number, so the relationship is visible in the code instead of being two unrelated constants that happen to have that ratio today.

The categories cannot be summed before pricing. This is wrong:

```
total_tokens * rate
```

This is right:

```
(input * input_rate)
  + (cached * cached_rate)
  + ((output + reasoning) * output_rate)
```

Reasoning tokens fold into output before multiplying, because they are priced identically. Cached input never folds into anything, because it is cheaper than everything else and merging it would overcharge.

## 6. API surface

| Endpoint | Method | Purpose | Status codes |
|---|---|---|---|
| `/generate` | POST | The billable endpoint. Records a usage event and returns the result. | 200, 400 (bad request), 401 (no auth), 402 (subscription inactive), 429 (quota exceeded) |
| `/usage` | GET | Returns the tenant's usage and cost for the current billing period. | 200, 401 |
| `/checkout` | POST | Creates a Stripe checkout session for upgrading a plan. | 200, 401, 500 (Stripe unreachable) |
| `/webhooks/stripe` | POST | Receives Stripe subscription events. | 200 (including replays, which are a no-op), 400 (bad signature) |

**What `/generate` returns on 200.** A JSON body containing the usage event id, the four token counts as recorded, the computed `cost_micros` for that request, and the tenant's remaining quota for the current period. This matters for section 7: every field in the response is derived from the stored usage event, which is what makes mirroring a duplicate possible without storing the response separately.

The webhook endpoint returns 200 on a replayed event rather than an error, because from Stripe's side a successful delivery is a successful delivery. Returning an error would make Stripe retry an event I have already handled.

## 7. Idempotency strategy

The key comes from the client as an `Idempotency-Key` header on `POST /generate`. Its scope is per tenant, so two different tenants sending the same key are two different events and neither blocks the other.

On a duplicate, I return the original response rather than processing again or erroring. From the client's side a retry looks like the request succeeding, which is the behavior a retrying client expects.

I do not store the response body. I reconstruct it from the existing `usage_events` row, which works because every field in a `/generate` response is derived from that row: the event id, the four token counts, `cost_micros`, and the remaining quota computed from the tenant's usage for the period. Storing a `response_body` column would be the alternative, and it would be the right call if responses ever contained something not recoverable from the event. They do not, so a stored copy would be a second source of truth I would have to keep in sync with the first.

The enforcement lives in the database, not in my code. There is a unique index on `(tenant_id, idempotency_key)`, so a duplicate insert fails on the constraint. I do not check for existence first and then insert, because two concurrent requests could both pass the check before either inserts. The constraint is the guarantee; the code just handles the rejection.

## 8. Boundary rule

**The rule:** a request is allowed only if the tenant's current usage plus the full cost of this request stays at or under their plan limit. Requests are all-or-nothing — I never partially fulfill one to fit under a quota.

Three cases against a 1,000 call limit:

1. **Tenant at 999/1,000 requests 1 call.** Allowed. It lands exactly at 1,000, which is at the limit, not over it. The limit is a ceiling the tenant is allowed to reach.
2. **Tenant at 1,000/1,000 requests 1 call.** Rejected with **429**. They are on a valid, active plan and have used up the quota it grants, which is a rate/usage limit, not a payment problem.
3. **Tenant at 999/1,000 requests something costing 6 calls.** Rejected entirely with **429**, not partially fulfilled. Serving 1 of the 6 would mean billing for work I did not complete and returning a response the client did not ask for. Allowing all 6 and going to 1,005 would require an overage story, which is a non-goal (see section 9).

**429 versus 402.** 429 means the subscription is active but the quota for this period is spent — waiting for the period to reset, or upgrading, fixes it. 402 means the subscription itself is not active: Stripe has the tenant as `past_due` or `canceled`, so there is no valid plan to draw a quota from.

**When both apply** — the tenant is over quota *and* their subscription has lapsed — **402 wins.** The inactive subscription is the more fundamental problem and the more actionable message. Telling someone to wait for their quota to reset would be misleading when the subscription that would renew it no longer exists.

## 9. Non-goal

I am not building overages. A tenant who hits their limit is blocked until the period resets or they upgrade; there is no metered billing past the quota, no soft limit, and no grace allowance.
