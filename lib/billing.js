'use strict';

const Stripe = require('stripe');
const { pool } = require('./db');

const SUBSCRIPTION_EVENTS = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
];

let stripeClient = null;

function billingError(status, code) {
  const err = new Error(code);
  err.status = status;
  return err;
}

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw billingError(500, 'stripe_not_configured');
  }

  if (!stripeClient) {
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }

  return stripeClient;
}

async function createCheckoutSession({ tenantId, planId, successUrl, cancelUrl }) {
  const stripe = getStripe();

  const tenantResult = await pool.query(
    'SELECT id, stripe_customer_id FROM tenants WHERE id = $1',
    [tenantId]
  );

  if (tenantResult.rowCount === 0) {
    throw billingError(404, 'tenant_not_found');
  }

  const planResult = await pool.query(
    'SELECT id, name, price_cents FROM plans WHERE id = $1',
    [planId]
  );

  if (planResult.rowCount === 0) {
    throw billingError(400, 'unknown_plan');
  }

  const tenant = tenantResult.rows[0];
  const plan = planResult.rows[0];

  if (Number(plan.price_cents) === 0) {
    throw billingError(400, 'plan_not_purchasable');
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    client_reference_id: String(tenant.id),
    customer: tenant.stripe_customer_id || undefined,
    success_url: successUrl,
    cancel_url: cancelUrl,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: Number(plan.price_cents),
          recurring: { interval: 'month' },
          product_data: { name: `${plan.name} plan` },
        },
      },
    ],
    metadata: { tenant_id: String(tenant.id), plan_id: plan.id },
    subscription_data: {
      metadata: { tenant_id: String(tenant.id), plan_id: plan.id },
    },
  });

  return { id: session.id, url: session.url };
}

function constructEvent(rawBody, signature) {
  const stripe = getStripe();

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    throw billingError(500, 'stripe_not_configured');
  }

  return stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

function customerId(value) {
  if (typeof value === 'string') {
    return value;
  }

  return value && value.id ? value.id : null;
}

function periodBounds(subscription) {
  const item = subscription.items && subscription.items.data && subscription.items.data[0];

  return {
    start: subscription.current_period_start ?? (item ? item.current_period_start : null),
    end: subscription.current_period_end ?? (item ? item.current_period_end : null),
  };
}

async function resolveTenantId(client, subscription) {
  if (subscription.metadata && subscription.metadata.tenant_id) {
    return subscription.metadata.tenant_id;
  }

  const customer = customerId(subscription.customer);

  if (!customer) {
    return null;
  }

  const result = await client.query('SELECT id FROM tenants WHERE stripe_customer_id = $1', [
    customer,
  ]);

  return result.rowCount > 0 ? result.rows[0].id : null;
}

async function applyCheckoutSession(client, session) {
  const tenantId = session.client_reference_id;

  if (!tenantId) {
    return;
  }

  const planId = session.metadata ? session.metadata.plan_id : null;

  await client.query(
    `UPDATE tenants
        SET stripe_customer_id = COALESCE($2, stripe_customer_id),
            plan_id = COALESCE($3, plan_id),
            updated_at = now()
      WHERE id = $1`,
    [tenantId, customerId(session.customer), planId || null]
  );
}

async function applySubscription(client, subscription, eventType) {
  const tenantId = await resolveTenantId(client, subscription);

  if (!tenantId) {
    return;
  }

  const status = eventType === 'customer.subscription.deleted' ? 'canceled' : subscription.status;
  const planId = subscription.metadata ? subscription.metadata.plan_id : null;
  const { start, end } = periodBounds(subscription);

  if (start && end) {
    await client.query(
      `INSERT INTO subscriptions
              (stripe_subscription_id, tenant_id, status, current_period_start, current_period_end)
       VALUES ($1, $2, $3, to_timestamp($4), to_timestamp($5))
       ON CONFLICT (stripe_subscription_id) DO UPDATE
          SET status = EXCLUDED.status,
              current_period_start = EXCLUDED.current_period_start,
              current_period_end = EXCLUDED.current_period_end,
              updated_at = now()`,
      [subscription.id, tenantId, status, start, end]
    );
  }

  await client.query(
    `UPDATE tenants
        SET subscription_status = $2,
            plan_id = COALESCE($3, plan_id),
            stripe_customer_id = COALESCE($4, stripe_customer_id),
            updated_at = now()
      WHERE id = $1`,
    [tenantId, status, planId || null, customerId(subscription.customer)]
  );
}

async function handleStripeEvent(event) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO processed_webhooks (stripe_event_id) VALUES ($1)', [event.id]);

    if (event.type === 'checkout.session.completed') {
      await applyCheckoutSession(client, event.data.object);
    } else if (SUBSCRIPTION_EVENTS.includes(event.type)) {
      await applySubscription(client, event.data.object, event.type);
    }

    await client.query('COMMIT');

    return { duplicate: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});

    if (err.code === '23505') {
      return { duplicate: true };
    }

    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createCheckoutSession, constructEvent, handleStripeEvent };
