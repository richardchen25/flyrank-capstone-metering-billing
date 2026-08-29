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

_(pending)_

## Quotas

_(pending)_

## Stripe integration

_(pending)_

## Data model

_(pending — needs `\d usage_events` against a live database showing the
`usage_events_tenant_idempotency_key` unique constraint on
`(tenant_id, idempotency_key)`. The schema is written in `init.sql` but has not
been applied to a running Postgres yet, so there is no real psql output to
paste.)_
