# flyrank-capstone-metering-billing

Usage metering and billing engine.

## Known limitations

- **`stripe_customer_id` is trusted without validation.** If the stored id is stale or
  belongs to a different Stripe account, `POST /checkout` passes it to Stripe, Stripe
  fails to find it, and the error surfaces as a generic 500. Production handling would
  catch Stripe's `resource_missing` error specifically, clear the stored id, and retry
  session creation without it so the customer is recreated.
- **Cancellation does not downgrade the plan.** `customer.subscription.deleted` sets
  `subscription_status` to `canceled`, which blocks metering with 402, but leaves
  `plan_id` pointing at the paid plan.
- **Checkout builds prices inline.** `line_items` uses `price_data` from
  `plans.price_cents` rather than referencing a pre-created Stripe Price, so no
  dashboard setup is needed and there is no `stripe_price_id` on the plan row.
- **No overages.** A tenant at their limit is blocked until the period resets or they
  upgrade. This is a deliberate non-goal, not an omission (DESIGN.md section 9).
