require('dotenv').config();

const express = require('express');
const { recordUsage } = require('./lib/meter');

const app = express();

app.use(express.json());

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

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`listening on ${port}`);
});
