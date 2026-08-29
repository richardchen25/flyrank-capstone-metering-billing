require('dotenv').config();

const express = require('express');
const { recordUsage, getUsage } = require('./lib/meter');
const { createCheckoutSession, constructEvent, handleStripeEvent } = require('./lib/billing');

const app = express();

const port = process.env.PORT || 3000;

// Must stay above express.json(): signature verification needs the unparsed body.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.get('stripe-signature');

  if (!signature) {
    return res.status(400).json({ error: 'missing_signature' });
  }

  let event;

  try {
    event = constructEvent(req.body, signature);
  } catch (err) {
    if (err.status === 500) {
      return res.status(500).json({ error: err.message });
    }

    return res.status(400).json({ error: 'invalid_signature' });
  }

  try {
    const result = await handleStripeEvent(event);

    return res.status(200).json({ received: true, duplicate: result.duplicate });
  } catch (err) {
    console.error(err);

    return res.status(500).json({ error: 'internal_error' });
  }
});

app.use(express.json());

app.get('/usage', async (req, res) => {
  const tenantId = req.get('X-Tenant-Id');

  if (!tenantId) {
    return res.status(401).json({ error: 'missing_tenant' });
  }

  try {
    const usage = await getUsage({ tenantId });

    return res.status(200).json({
      tenant_id: usage.tenantId,
      plan: usage.plan,
      subscription_status: usage.subscriptionStatus,
      period: {
        start: usage.period.start,
        end: usage.period.end,
        source: usage.period.source,
      },
      api_calls: usage.apiCalls,
      tokens: usage.tokens,
      cost_micros: usage.costMicros,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }

    console.error(err);

    return res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/checkout', async (req, res) => {
  const tenantId = req.get('X-Tenant-Id');

  if (!tenantId) {
    return res.status(401).json({ error: 'missing_tenant' });
  }

  const body = req.body || {};
  const planId = body.plan_id;

  if (typeof planId !== 'string' || planId.length === 0) {
    return res.status(400).json({ error: 'invalid_plan_id' });
  }

  try {
    const session = await createCheckoutSession({
      tenantId,
      planId,
      successUrl: body.success_url || `http://localhost:${port}/checkout/success`,
      cancelUrl: body.cancel_url || `http://localhost:${port}/checkout/cancel`,
    });

    return res.status(200).json(session);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }

    console.error(err);

    return res.status(500).json({ error: 'stripe_error' });
  }
});

const EVENT_TYPES = ['api_call', 'tokens'];
const TOKEN_FIELDS = [
  ['input_tokens', 'inputTokens'],
  ['cached_input_tokens', 'cachedInputTokens'],
  ['output_tokens', 'outputTokens'],
  ['reasoning_tokens', 'reasoningTokens'],
];
const NESTED_TOKEN_FIELDS = TOKEN_FIELDS.map(([, nestedField]) => nestedField);
const ALLOWED_FIELDS = ['event_type', 'quantity', 'tokens', ...TOKEN_FIELDS.map(([flatField]) => flatField)];

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

app.post('/generate', async (req, res) => {
  const tenantId = req.get('X-Tenant-Id');

  if (!tenantId) {
    return res.status(401).json({ error: 'missing_tenant' });
  }

  const idempotencyKey = req.get('Idempotency-Key');

  if (!idempotencyKey) {
    return res.status(400).json({ error: 'missing_idempotency_key' });
  }

  const body = req.body || {};
  const eventType = body.event_type;
  const quantity = body.quantity === undefined ? 0 : body.quantity;

  const unknownField = Object.keys(body).find((key) => !ALLOWED_FIELDS.includes(key));

  if (unknownField) {
    return res.status(400).json({ error: 'unknown_field', field: unknownField });
  }

  if (!EVENT_TYPES.includes(eventType)) {
    return res.status(400).json({ error: 'invalid_event_type' });
  }

  if (!isNonNegativeInteger(quantity)) {
    return res.status(400).json({ error: 'invalid_quantity' });
  }

  const nested = body.tokens;

  if (nested !== undefined) {
    if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) {
      return res.status(400).json({ error: 'invalid_tokens' });
    }

    const unknownNested = Object.keys(nested).find((key) => !NESTED_TOKEN_FIELDS.includes(key));

    if (unknownNested) {
      return res.status(400).json({ error: 'unknown_field', field: `tokens.${unknownNested}` });
    }

    const flatAlso = TOKEN_FIELDS.find(([flatField]) => body[flatField] !== undefined);

    if (flatAlso) {
      return res.status(400).json({ error: 'conflicting_token_fields', field: flatAlso[0] });
    }
  }

  const tokens = {};

  for (const [flatField, nestedField] of TOKEN_FIELDS) {
    const value = nested === undefined ? body[flatField] : nested[nestedField];

    if (value === undefined) {
      continue;
    }

    if (!isNonNegativeInteger(value)) {
      const label = nested === undefined ? flatField : `tokens.${nestedField}`;

      return res.status(400).json({ error: 'invalid_token_count', field: label });
    }

    tokens[nestedField] = value;
  }

  try {
    const result = await recordUsage({ tenantId, eventType, quantity, tokens, idempotencyKey });

    return res.status(200).json({
      event: result.event,
      cost_micros: result.costMicros,
      duplicate: result.duplicate,
      remaining: {
        api_calls: result.remaining.apiCalls,
        tokens: result.remaining.tokens,
      },
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }

    console.error(err);

    return res.status(500).json({ error: 'internal_error' });
  }
});

app.listen(port, () => {
  console.log(`listening on ${port}`);
});
