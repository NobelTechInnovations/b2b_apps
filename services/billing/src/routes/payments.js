import { id } from '@nexus/db-kit';
import { requirePermission, body, params, validate as v, notFound, badRequest, ApiError } from '@nexus/service-kit';
import { settleInvoice, shapeInvoice } from '../lib/invoices.js';

/**
 * Paying platform invoices.
 *
 *   checkout → Razorpay order for exactly the invoice total
 *   verify   → the browser returns (order, payment, signature); we check the
 *              HMAC with our secret, confirm the payment with Razorpay, settle
 *   webhook  → Razorpay tells us directly; same settlement, idempotent
 *
 * With BILLING_TEST_MODE and no Razorpay keys, a "test payment" settles an
 * invoice without money moving — for local development only. It is refused
 * whenever real keys are configured, so it can never shadow the real flow.
 */
export async function paymentRoutes(app) {
  const { db, config, razorpay } = app;
  const manage = [app.loadContext, requirePermission('billing.subscription.manage')];
  const view = [app.loadContext, requirePermission('billing.subscription.view')];
  const invoiceParams = { params: params({ invoiceId: v.id('binv') }) };

  async function ownInvoice(orgId, invoiceId) {
    const invoice = await db.one(`SELECT * FROM invoices WHERE id = $1 AND org_id = $2`, [invoiceId, orgId]);
    if (!invoice) throw notFound('Invoice');
    return invoice;
  }

  app.get('/subscriptions/current/invoices', { preHandler: view }, async (request) => {
    const rows = await db.rows(
      `SELECT * FROM invoices WHERE org_id = $1 AND status <> 'void' ORDER BY created_at DESC LIMIT 100`,
      [request.auth.orgId],
    );
    return { data: rows.map(shapeInvoice) };
  });

  app.get('/subscriptions/current/invoices/:invoiceId', { preHandler: view, schema: invoiceParams }, async (request) => {
    const invoice = await ownInvoice(request.auth.orgId, request.params.invoiceId);
    const payments = await db.rows(
      `SELECT id, provider, provider_payment_id, amount, status, captured_at, created_at
         FROM payments WHERE invoice_id = $1 AND org_id = $2 ORDER BY created_at DESC`,
      [invoice.id, request.auth.orgId],
    );
    return { data: { ...shapeInvoice(invoice), payments } };
  });

  app.post('/subscriptions/current/invoices/:invoiceId/checkout', { preHandler: manage, schema: invoiceParams }, async (request) => {
    const orgId = request.auth.orgId;
    const invoice = await ownInvoice(orgId, request.params.invoiceId);
    if (invoice.status !== 'open') throw badRequest(`Invoice ${invoice.number} is ${invoice.status}.`);

    if (!razorpay.configured) {
      if (config.billingTestMode) {
        return { data: { provider: 'test', invoice: shapeInvoice(invoice) } };
      }
      throw new ApiError(503, 'payments_not_configured', 'Online payment is not set up yet. Contact support to pay this invoice.');
    }

    const amountPaise = Math.round(Number(invoice.total) * 100);
    // Re-use an order already raised for this invoice at this amount, so
    // reopening the checkout does not litter Razorpay with orders.
    let payment = await db.one(
      `SELECT * FROM payments WHERE invoice_id = $1 AND org_id = $2 AND provider = 'razorpay'
          AND status = 'created' AND amount = $3 ORDER BY created_at DESC LIMIT 1`,
      [invoice.id, orgId, invoice.total],
    );
    if (!payment) {
      const order = await razorpay.createOrder({
        amountPaise,
        currency: invoice.currency,
        receipt: invoice.number,
        notes: { invoice_id: invoice.id, org_id: orgId },
      });
      payment = await db.one(
        `INSERT INTO payments (id, org_id, invoice_id, provider, provider_order_id, amount, currency, status, created_by)
         VALUES ($1, $2, $3, 'razorpay', $4, $5, $6, 'created', $7) RETURNING *`,
        [id('pay'), orgId, invoice.id, order.id, invoice.total, invoice.currency, request.auth.userId],
      );
    }

    return {
      data: {
        provider: 'razorpay',
        key_id: razorpay.keyId,
        order_id: payment.provider_order_id,
        amount: amountPaise,
        currency: invoice.currency,
        name: config.billingCompanyName,
        description: `Invoice ${invoice.number}`,
        prefill: { email: request.auth.email ?? undefined },
        invoice: shapeInvoice(invoice),
      },
    };
  });

  app.post(
    '/subscriptions/current/invoices/:invoiceId/verify',
    {
      preHandler: manage,
      schema: {
        ...invoiceParams,
        body: body(
          {
            razorpay_order_id: v.text(64),
            razorpay_payment_id: v.text(64),
            razorpay_signature: v.text(256),
          },
          ['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature'],
        ),
      },
    },
    async (request) => {
      const orgId = request.auth.orgId;
      const invoice = await ownInvoice(orgId, request.params.invoiceId);
      const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = request.body;

      if (!razorpay.verifyCheckoutSignature({ orderId, paymentId, signature })) {
        throw badRequest('The payment could not be verified.', { code: 'invalid_signature' });
      }

      // The order must be one we raised for THIS invoice in THIS workspace.
      const payment = await db.one(
        `SELECT * FROM payments WHERE provider = 'razorpay' AND provider_order_id = $1 AND org_id = $2 AND invoice_id = $3`,
        [orderId, orgId, invoice.id],
      );
      if (!payment) throw badRequest('That payment does not belong to this invoice.');

      // Belt and braces: Razorpay's own record of the amount and state.
      const remote = await razorpay.fetchPayment(paymentId).catch((error) => {
        request.log.warn({ err: error }, 'razorpay payment lookup failed; relying on signature');
        return null;
      });
      if (remote) {
        if (remote.order_id !== orderId) throw badRequest('Payment and order do not match.');
        if (!['captured', 'authorized'].includes(remote.status)) {
          throw badRequest(`The payment is ${remote.status}.`, { code: 'payment_not_captured' });
        }
        if (Number(remote.amount) !== Math.round(Number(invoice.total) * 100)) {
          throw badRequest('The amount paid does not match the invoice.');
        }
      }

      const result = await db.transaction((tx) =>
        settleInvoice(tx, {
          invoiceId: invoice.id,
          provider: 'razorpay',
          providerOrderId: orderId,
          providerPaymentId: paymentId,
          amount: invoice.total,
          actorId: request.auth.userId,
        }),
      );
      return { data: { invoice: shapeInvoice(result.invoice), already_paid: result.alreadyPaid } };
    },
  );

  app.post('/subscriptions/current/invoices/:invoiceId/test-pay', { preHandler: manage, schema: invoiceParams }, async (request) => {
    if (!config.billingTestMode || razorpay.configured) {
      throw new ApiError(403, 'test_mode_disabled', 'Test payments are not enabled.');
    }
    const invoice = await ownInvoice(request.auth.orgId, request.params.invoiceId);
    const result = await db.transaction((tx) =>
      settleInvoice(tx, {
        invoiceId: invoice.id,
        provider: 'test',
        providerPaymentId: id('tpay'),
        amount: invoice.total,
        actorId: request.auth.userId,
      }),
    );
    return { data: { invoice: shapeInvoice(result.invoice), already_paid: result.alreadyPaid } };
  });

  // ── Razorpay webhook: public, authenticated by its signature alone ────────
  await app.register(async (hooks) => {
    // The signature covers the exact bytes Razorpay sent, so keep them.
    hooks.removeContentTypeParser('application/json');
    hooks.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, raw, done) => {
      request.rawBody = raw;
      try {
        done(null, JSON.parse(raw.toString('utf8') || '{}'));
      } catch (error) {
        error.statusCode = 400;
        done(error, undefined);
      }
    });

    hooks.post('/billing-webhooks/razorpay', async (request, reply) => {
      const signature = request.headers['x-razorpay-signature'];
      if (!request.rawBody || !razorpay.verifyWebhookSignature(request.rawBody, signature)) {
        return reply.status(401).send({ error: { code: 'invalid_signature', message: 'Bad signature.' } });
      }

      const event = request.body?.event;
      const entity = request.body?.payload?.payment?.entity;
      if (!['payment.captured', 'order.paid'].includes(event) || !entity?.order_id) {
        return { received: true, ignored: event };
      }

      const payment = await db.one(
        `SELECT * FROM payments WHERE provider = 'razorpay' AND provider_order_id = $1`,
        [entity.order_id],
      );
      if (!payment) return { received: true, ignored: 'unknown_order' };

      try {
        await db.transaction((tx) =>
          settleInvoice(tx, {
            invoiceId: payment.invoice_id,
            provider: 'razorpay',
            providerOrderId: entity.order_id,
            providerPaymentId: entity.id,
            amount: Number(entity.amount) / 100,
          }),
        );
      } catch (error) {
        // Acknowledge anyway: retrying will not change a mismatch, and the
        // payment row plus this log line are what support reconciles from.
        request.log.error({ err: error, order: entity.order_id }, 'webhook settlement failed');
        return { received: true, settled: false };
      }
      return { received: true, settled: true };
    });
  });
}
