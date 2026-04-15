const Stripe = require('stripe');
const crypto = require('crypto');
const { query, hasPostgres } = require('./db');

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

const PRICE_IDS = {
  starter: process.env.STRIPE_PRICE_STARTER || '',
  professional: process.env.STRIPE_PRICE_PROFESSIONAL || '',
  growth: process.env.STRIPE_PRICE_GROWTH || '',
};

function getPlanPriceId(plan) {
  return PRICE_IDS[plan] || PRICE_IDS.starter;
}

async function upsertSubscription(orgId, patch) {
  if (!hasPostgres) return;
  const id = patch.id || crypto.randomUUID();
  await query(
    `INSERT INTO subscriptions (id, org_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (org_id) DO UPDATE
     SET stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, subscriptions.stripe_customer_id),
         stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, subscriptions.stripe_subscription_id),
         status = EXCLUDED.status,
         current_period_end = EXCLUDED.current_period_end,
         updated_at = NOW()`,
    [
      id,
      orgId,
      patch.customerId || null,
      patch.subscriptionId || null,
      patch.status || 'trialing',
      patch.currentPeriodEnd || null,
    ],
  );
}

async function createCheckoutSession({ orgId, orgName, ownerEmail, plan, successUrl, cancelUrl }) {
  if (!stripe) {
    return { url: `${successUrl}?billing=skipped`, mode: 'mock' };
  }
  const priceId = getPlanPriceId(plan);
  if (!priceId) {
    throw new Error('Stripe price id is not configured for this plan.');
  }
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: ownerEmail,
    metadata: { orgId, orgName, plan },
    line_items: [{ price: priceId, quantity: 1 }],
  });
  return { url: session.url, mode: 'stripe' };
}

function verifyStripeWebhook(rawBody, signature) {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return null;
  try {
    return stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return null;
  }
}

module.exports = {
  createCheckoutSession,
  stripeEnabled: Boolean(stripe),
  upsertSubscription,
  verifyStripeWebhook,
};
