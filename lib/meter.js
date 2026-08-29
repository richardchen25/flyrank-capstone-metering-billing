'use strict';

const { pool } = require('./db');
const { costMicros } = require('./pricing');

function meterError(status, code) {
  const err = new Error(code);
  err.status = status;
  return err;
}

async function periodUsage(client, tenantId, periodStart, periodEnd) {
  const apiCallsResult = await client.query(
    `SELECT COALESCE(SUM(quantity), 0) AS api_calls
       FROM usage_events
      WHERE tenant_id = $1
        AND event_type = 'api_call'
        AND created_at >= $2
        AND created_at < $3`,
    [tenantId, periodStart, periodEnd]
  );

  const tokensResult = await client.query(
    `SELECT COALESCE(SUM(input_tokens + cached_input_tokens + output_tokens + reasoning_tokens), 0) AS tokens
       FROM usage_events
      WHERE tenant_id = $1
        AND event_type = 'tokens'
        AND created_at >= $2
        AND created_at < $3`,
    [tenantId, periodStart, periodEnd]
  );

  return {
    apiCalls: Number(apiCallsResult.rows[0].api_calls),
    tokens: Number(tokensResult.rows[0].tokens),
  };
}

function remainingQuota(tenant, usedApiCalls, usedTokens) {
  return {
    apiCalls: Math.max(0, Number(tenant.api_calls_limit) - usedApiCalls),
    tokens: Math.max(0, Number(tenant.tokens_limit) - usedTokens),
  };
}

async function recordUsage({ tenantId, eventType, quantity = 0, tokens = {}, idempotencyKey }) {
  const inputTokens = tokens.inputTokens || 0;
  const cachedInputTokens = tokens.cachedInputTokens || 0;
  const outputTokens = tokens.outputTokens || 0;
  const reasoningTokens = tokens.reasoningTokens || 0;
  const tokenTotal = inputTokens + cachedInputTokens + outputTokens + reasoningTokens;
  const cost = costMicros({ inputTokens, cachedInputTokens, outputTokens, reasoningTokens });

  const client = await pool.connect();

  let tenant = null;

  try {
    await client.query('BEGIN');

    const tenantResult = await client.query(
      `SELECT t.id,
              t.subscription_status,
              p.api_calls_limit,
              p.tokens_limit,
              COALESCE(s.current_period_start, date_trunc('month', now())) AS period_start,
              COALESCE(s.current_period_end, date_trunc('month', now()) + interval '1 month') AS period_end
         FROM tenants t
         JOIN plans p ON p.id = t.plan_id
         LEFT JOIN subscriptions s
                ON s.tenant_id = t.id
               AND now() >= s.current_period_start
               AND now() < s.current_period_end
        WHERE t.id = $1
        ORDER BY s.current_period_end DESC
        LIMIT 1
          FOR UPDATE OF t`,
      [tenantId]
    );

    if (tenantResult.rowCount === 0) {
      throw meterError(404, 'tenant_not_found');
    }

    tenant = tenantResult.rows[0];

    const used = await periodUsage(client, tenantId, tenant.period_start, tenant.period_end);

    const existing = await client.query(
      `SELECT * FROM usage_events
        WHERE tenant_id = $1
          AND idempotency_key = $2`,
      [tenantId, idempotencyKey]
    );

    if (existing.rowCount > 0) {
      await client.query('COMMIT');

      return {
        event: existing.rows[0],
        costMicros: Number(existing.rows[0].cost_micros),
        duplicate: true,
        remaining: remainingQuota(tenant, used.apiCalls, used.tokens),
      };
    }

    if (tenant.subscription_status !== 'active') {
      throw meterError(402, 'subscription_inactive');
    }

    const usedApiCalls = used.apiCalls;
    const usedTokens = used.tokens;

    if (eventType === 'api_call' && usedApiCalls + quantity > Number(tenant.api_calls_limit)) {
      throw meterError(429, 'quota_exceeded');
    }

    if (eventType === 'tokens' && usedTokens + tokenTotal > Number(tenant.tokens_limit)) {
      throw meterError(429, 'quota_exceeded');
    }

    const insertResult = await client.query(
      `INSERT INTO usage_events
              (tenant_id, event_type, quantity, input_tokens, cached_input_tokens,
               output_tokens, reasoning_tokens, cost_micros, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        tenantId,
        eventType,
        quantity,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningTokens,
        cost,
        idempotencyKey,
      ]
    );

    await client.query('COMMIT');

    return {
      event: insertResult.rows[0],
      costMicros: cost,
      duplicate: false,
      remaining: remainingQuota(
        tenant,
        usedApiCalls + (eventType === 'api_call' ? quantity : 0),
        usedTokens + (eventType === 'tokens' ? tokenTotal : 0)
      ),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});

    if (err.code === '23505') {
      const raced = await client.query(
        `SELECT * FROM usage_events
          WHERE tenant_id = $1
            AND idempotency_key = $2`,
        [tenantId, idempotencyKey]
      );

      const used = await periodUsage(client, tenantId, tenant.period_start, tenant.period_end);

      return {
        event: raced.rows[0],
        costMicros: Number(raced.rows[0].cost_micros),
        duplicate: true,
        remaining: remainingQuota(tenant, used.apiCalls, used.tokens),
      };
    }

    throw err;
  } finally {
    client.release();
  }
}

module.exports = { recordUsage };
