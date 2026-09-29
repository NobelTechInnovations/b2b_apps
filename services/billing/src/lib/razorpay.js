import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Razorpay, over its REST API — no SDK, so nothing new to audit.
 *
 * The browser never tells us a payment succeeded. It hands back three values
 * that we check against an HMAC only our secret can produce; the webhook
 * carries its own signature. Either path settles the invoice, and settling is
 * idempotent, so receiving both is safe.
 */
const API = 'https://api.razorpay.com/v1';

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createRazorpay({ keyId, keySecret, webhookSecret, logger }) {
  const configured = Boolean(keyId && keySecret);
  const auth = configured ? `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}` : null;

  return {
    configured,
    keyId,

    /** An order for exactly the invoice total, in paise. */
    async createOrder({ amountPaise, currency = 'INR', receipt, notes }) {
      if (!configured) throw new Error('Razorpay is not configured');
      const response = await fetch(`${API}/orders`, {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify({ amount: amountPaise, currency, receipt: receipt.slice(0, 40), notes }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        logger?.error({ status: response.status, error: body?.error }, 'razorpay order failed');
        throw new Error(body?.error?.description ?? `Razorpay responded ${response.status}`);
      }
      return body;
    },

    /** Fetch a payment to confirm its amount and state before trusting it. */
    async fetchPayment(paymentId) {
      const response = await fetch(`${API}/payments/${encodeURIComponent(paymentId)}`, {
        headers: { authorization: auth },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Razorpay payment lookup responded ${response.status}`);
      return response.json();
    },

    /** Checkout callback: HMAC_SHA256(order_id|payment_id, key_secret). */
    verifyCheckoutSignature({ orderId, paymentId, signature }) {
      if (!configured) return false;
      const expected = createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
      return safeEqualHex(expected, signature);
    },

    /** Webhook: HMAC_SHA256(raw body, webhook secret). */
    verifyWebhookSignature(rawBody, signature) {
      if (!webhookSecret) return false;
      const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
      return safeEqualHex(expected, signature);
    },
  };
}
