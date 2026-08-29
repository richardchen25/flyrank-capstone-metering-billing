# BUILDLOG

This is how I built the project with AI assistance, what the AI got wrong, and what I
changed. I wrote it to be accurate rather than flattering to either of us.

Tool: Claude Code (Opus). I drove the design decisions and reviewed every file, and the
model wrote most of the code and the evidence transcripts.

## What the AI did well

**It caught bugs I would not have found by reading.** Three of them were the kind that
pass a casual review and fail in production:

- `node-postgres` returns `BIGINT` and `SUM()` as JavaScript **strings** rather than
  numbers. My quota check `usedApiCalls + quantity > limit` would have evaluated
  `"999" + 1 = "9991"` and compared strings. The fix is the `Number()` casts in
  `lib/meter.js`.
- Removing the `COALESCE` fallback on the billing period does not crash, it silently
  returns zero. `created_at >= NULL` matches no rows, so `COALESCE(SUM(...), 0)` returns
  `0` and every quota check passes forever. A tenant with no subscription row would have
  had unlimited usage and nothing would have looked broken.
- Unknown request fields were being ignored, so a body in the wrong shape metered as zero
  and returned 200. A client sending `output_token` in the singular would have been
  billed nothing and seen success. That is a 400 now.

**It read the installed library rather than assuming.** The Stripe SDK pins API version
`2026-08-26.dahlia`, where `current_period_start` and `current_period_end` have moved off
the Subscription object onto its items. Code written from memory would have written NULL
periods, but the model checked the installed version first and wrote the fallback.

**It found the false pass in my own probe.** My idempotency check asserted `COUNT(*) = 1`
and passed, but the single row had `cost_micros = 0`, written by an earlier malformed
request, and neither request in the probe had written anything at all. The model noticed
the count was right for the wrong reason and paired it with `SUM(cost_micros)`, which is
now the assertion in EVIDENCE.md.

## Where the AI was wrong

**It insisted for several turns that no database was available.** It ran `pg_isready`,
which defaults to port 5432, found nothing there, saw that `psql` was not installed, and
concluded the schema had never been applied. My Postgres was on **5433**, and the `pg`
driver had been connecting to it without trouble the whole time. This false claim made it
into EVIDENCE.md as "the schema has not been applied to a running Postgres yet" before a
successful `POST /generate` returned a real inserted row and exposed it. A tool answering
on a default port is not evidence about a service on a different one.

**It changed the request body format based on my description instead of my probe.** I
said my probe sent flat `input_tokens`, but it actually sent nested `tokens.inputTokens`.
The model switched the API to flat, my probe started returning 400, and it took two round
trips to land on accepting both shapes, which is where it should have started given that
the two facts were in conflict.

**It printed my live Stripe test key into the terminal.** It ran `cat -n .env` to find a
line number after I had pasted a real `sk_test_` value. It flagged this itself and used a
masking read afterwards, but the key was already in the transcript by then.

**It deleted four load-bearing mechanisms when I told it to.** I wrote "remove these"
above four bullet points that were actually praise. The model flagged the contradiction
and asked before acting, which was correct, but when I confirmed it removed row locking,
the period fallback, the single-query rollup, and the duplicate-mirroring catch, and then
wrote DESIGN.md sections describing the now-weaker behavior as deliberate. I had it
restore three of them in the next message. Asking was the right call, but carrying out a
confirmed instruction that gutted the file was still the wrong outcome, and it took my
review to undo.

## What I changed in its work

- **I restored `FOR UPDATE OF t`, the `23505` catch, and the `COALESCE` period fallback**
  after the removal above. Without the row lock, two concurrent requests both pass the
  quota check and a tenant can exceed their limit, which is the exact race I identify in
  DESIGN.md section 8. Without the `23505` catch the code is pure check-then-insert,
  which my design doc argues against by name.
- **I reordered the duplicate check ahead of the subscription and quota checks**, so a
  tenant at their ceiling retrying an already-successful request gets the mirrored
  response instead of a 429.
- **I required the `Idempotency-Key` header** rather than generating one server-side. A
  server-generated key is unique per attempt, so a retry would get a fresh key and bill
  twice, which is the exact failure the mechanism exists to prevent.
- **I rejected the AI's first evidence transcripts**, where a command sent the same key
  twice and the output read as though a fresh key had returned a duplicate. The behavior
  was correct but the artifact was misleading, so I had it re-run with one request per
  case.
- **I chose flat snake_case as canonical** with nested accepted as an alias, and required
  that mixing the two shapes be a 400 rather than something resolved by precedence.

## A correction to my own notes

My working notes list three AI errors that did not happen in this project: a
"three-argument `createFunction` signature", a "wrong-file `.env` diagnosis", and
"several stale-server misdiagnoses". There is no `createFunction` in this codebase, the
`.env` and `.env.example` explanation was correct, and the one stale-server issue was my
own command re-using an idempotency key, which the model diagnosed correctly. I am
leaving this note in rather than quietly dropping those items, because a log of AI
mistakes is only worth anything if the mistakes in it are real ones.

## Honest state of the project

These are working and verified against a live database and real Stripe test-mode events:
`POST /generate`, `GET /usage`, `POST /checkout`, `POST /webhooks/stripe`, idempotency,
quota boundaries, 402 and 429 precedence, webhook signature verification, and replay
defense.

These are not done. There is no automated test suite, so verification is the reproducible
commands in EVIDENCE.md rather than `npm test`. Webhook ordering is unhandled.
`stripe_customer_id` is trusted without checking that it still exists in Stripe. The full
list is in the README.
