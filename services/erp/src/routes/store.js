import { createHash } from 'node:crypto';
import { id } from '@nexus/db-kit';
import {
  body, params, query, validate as v, requireApp, requirePermission, badRequest, notFound, resource, nullable, amount, ApiError,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { nextNumber } from '../lib/numbers.js';
import { moveStock, warehouseOrDefault, onHand } from '../lib/stock.js';
import { toPaise, toRupees } from '../lib/money.js';

const ORDER_FLOW = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['packed', 'shipped', 'cancelled'],
  packed: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

/**
 * Online Store: the same products, prices and stock as the rest of the
 * workspace, sold to the public at /shop/<company-address>.
 *
 * The storefront never trusts the browser for a price or a total: checkout
 * sends product ids and quantities, and everything else is read from the
 * catalogue here. Stock is taken when an order is confirmed (and given back
 * if it is cancelled), so an abandoned cart never holds anything.
 */
export async function storeRoutes(app) {
  const { db, config } = app;
  const guard = (permission) => [app.loadContext, requireApp('ecommerce'), requirePermission(permission)];

  async function settings(store, orgId) {
    await store.query(`INSERT INTO store_settings (org_id) VALUES ($1) ON CONFLICT DO NOTHING`, [orgId]);
    return store.one(`SELECT s.*, w.name AS warehouse_name FROM store_settings s LEFT JOIN warehouses w ON w.id = s.warehouse_id WHERE s.org_id = $1`, [orgId]);
  }

  app.get('/ecommerce/settings', { preHandler: guard('ecommerce.store.view') }, async (request) => ({ data: await settings(db, request.ctx.orgId) }));

  app.put('/ecommerce/settings', {
    preHandler: guard('ecommerce.store.manage'),
    schema: {
      body: body({
        name: v.text(120, 0), tagline: v.text(300, 0), published: v.bool, shipping_fee: amount, free_shipping_over: nullable(amount),
        cod_enabled: v.bool, contact_email: nullable(v.email), contact_phone: nullable(v.text(32)), warehouse_id: nullable(v.id('wh')),
      }),
    },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const b = request.body;
    const row = await db.transaction(async (tx) => {
      const old = await settings(tx, orgId);
      if (b.warehouse_id) await warehouseOrDefault(tx, orgId, b.warehouse_id);
      const next = { ...old, ...b };
      if (b.published && !next.name?.trim()) throw badRequest('Give the store a name before publishing it.');
      await tx.query(
        `UPDATE store_settings SET name = $2, tagline = $3, published = $4, shipping_fee = $5, free_shipping_over = $6, cod_enabled = $7,
                contact_email = $8, contact_phone = $9, warehouse_id = $10, updated_by = $11, updated_at = now() WHERE org_id = $1`,
        [orgId, next.name ?? '', next.tagline ?? '', next.published, toRupees(toPaise(next.shipping_fee)),
          next.free_shipping_over === null || next.free_shipping_over === undefined ? null : toRupees(toPaise(next.free_shipping_over)),
          next.cod_enabled, next.contact_email, next.contact_phone, next.warehouse_id, userId],
      );
      return settings(tx, orgId);
    });
    return { data: row };
  });

  // Which products are on sale online. Publishing is a store decision, so it
  // needs store rights, not catalogue-editing rights.
  app.get('/ecommerce/products', { preHandler: guard('ecommerce.store.view'), schema: { querystring: query({ online: v.bool }) } }, async (request) => {
    const { orgId } = request.ctx;
    const store = await settings(db, orgId);
    const values = [orgId, store.warehouse_id];
    const where = [`p.org_id = $1`, `p.active`, `p.type <> 'service'`];
    if (request.query.online !== undefined) { values.push(request.query.online); where.push(`p.online = $${values.length}`); }
    if (request.query.q) { values.push(`%${request.query.q}%`); where.push(`(p.name ILIKE $${values.length} OR p.sku ILIKE $${values.length})`); }
    const rows = await db.rows(
      `SELECT p.id, p.name, p.sku, p.sale_price, p.tax_rate, p.online, p.image_url, p.description, c.name AS category_name,
              COALESCE((SELECT sum(quantity) FROM stock_quants q WHERE q.org_id = p.org_id AND q.product_id = p.id
                         AND ($2::text IS NULL OR q.warehouse_id = $2)), 0) AS on_hand
         FROM products p LEFT JOIN product_categories c ON c.id = p.category_id WHERE ${where.join(' AND ')} ORDER BY p.online DESC, p.name LIMIT 500`,
      values,
    );
    return { data: rows };
  });

  app.put('/ecommerce/products/:productId', {
    preHandler: guard('ecommerce.store.manage'),
    schema: { params: params({ productId: v.id('prd') }), body: body({ online: v.bool, image_url: nullable({ type: 'string', format: 'uri', maxLength: 1000 }) }) },
  }, async (request) => {
    const row = await db.one(
      `UPDATE products SET online = COALESCE($3, online), image_url = CASE WHEN $5 THEN $4 ELSE image_url END, updated_at = now()
        WHERE org_id = $1 AND id = $2 AND type <> 'service' RETURNING id, name, online, image_url`,
      [request.ctx.orgId, request.params.productId, request.body.online ?? null, request.body.image_url ?? null, 'image_url' in request.body],
    );
    if (!row) throw notFound('Product');
    return { data: row };
  });

  resource(app, {
    path: '/ecommerce/promotions', table: 'store_promotions', prefix: 'promo', appSlug: 'ecommerce', label: 'Promotion',
    permissions: { view: 'ecommerce.promotions.view', manage: 'ecommerce.promotions.manage' },
    fields: {
      code: { type: 'string', pattern: '^[A-Za-z0-9_-]{3,24}$' }, kind: v.enum(['percent', 'amount']), value: amount, min_order: amount,
      starts_on: nullable(v.date), ends_on: nullable(v.date), usage_limit: nullable(v.int(1, 1000000)), active: v.bool,
    },
    required: ['code', 'value'], search: ['code'], filters: { active: v.bool }, defaultSort: 'created_at DESC',
    uniqueMessage: 'A promotion with that code already exists.',
    hooks: {
      async beforeCreate(tx, data) { return check({ ...data, code: data.code.toUpperCase() }); },
      async beforeUpdate(tx, data, old) { check({ ...old, ...data }); return data.code ? { ...data, code: data.code.toUpperCase() } : data; },
    },
  });
  function check(p) {
    if ((p.kind ?? 'percent') === 'percent' && Number(p.value) > 100) throw badRequest('A percentage discount cannot exceed 100%.');
    if (p.starts_on && p.ends_on && p.ends_on < p.starts_on) throw badRequest('The promotion ends before it starts.');
    return p;
  }

  // ── orders ────────────────────────────────────────────────────────────────
  const orderParams = { params: params({ orderId: v.id('sord') }) };
  async function order(store, orgId, orderId, lock = false) {
    const row = await store.one(`SELECT * FROM store_orders WHERE org_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [orgId, orderId]);
    if (!row) throw notFound('Order');
    return row;
  }
  const orderLines = (store, row) => store.rows(`SELECT * FROM store_order_lines WHERE org_id = $1 AND order_id = $2 ORDER BY id`, [row.org_id, row.id]);

  app.get('/ecommerce/orders', {
    preHandler: guard('ecommerce.orders.view'),
    schema: { querystring: query({ status: v.enum(['pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'open']) }) },
  }, async (request) => {
    const qs = request.query;
    const values = [request.ctx.orgId];
    const where = ['o.org_id = $1'];
    if (qs.status === 'open') where.push(`o.status IN ('pending', 'confirmed', 'packed', 'shipped')`);
    else if (qs.status) { values.push(qs.status); where.push(`o.status = $${values.length}`); }
    if (qs.q) { values.push(`%${qs.q}%`); where.push(`(o.number ILIKE $${values.length} OR o.customer_name ILIKE $${values.length} OR o.customer_phone ILIKE $${values.length})`); }
    const limit = qs.limit ?? 25;
    const offset = ((qs.page ?? 1) - 1) * limit;
    const clause = where.join(' AND ');
    const [rows, total] = await Promise.all([
      db.rows(`SELECT o.*, (SELECT count(*)::int FROM store_order_lines l WHERE l.order_id = o.id) AS items FROM store_orders o
                WHERE ${clause} ORDER BY o.placed_at DESC LIMIT ${limit} OFFSET ${offset}`, values),
      db.one(`SELECT count(*)::int AS n FROM store_orders o WHERE ${clause}`, values),
    ]);
    return { data: rows, meta: { total: total.n, page: qs.page ?? 1, limit, pages: Math.ceil(total.n / limit) || 1 } };
  });

  app.get('/ecommerce/orders/:orderId', { preHandler: guard('ecommerce.orders.view'), schema: orderParams }, async (request) => {
    const row = await order(db, request.ctx.orgId, request.params.orderId);
    return { data: { ...row, lines: await orderLines(db, row) } };
  });

  app.post('/ecommerce/orders/:orderId/status', {
    preHandler: guard('ecommerce.orders.edit'),
    schema: { ...orderParams, body: body({ status: v.enum(['confirmed', 'packed', 'shipped', 'delivered', 'cancelled']), tracking_number: nullable(v.text(80)), note: v.text(1000, 0) }, ['status']) },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const to = request.body.status;
    if (['packed', 'shipped', 'delivered'].includes(to)) request.ctx.assert('ecommerce.orders.fulfil');
    const row = await db.transaction(async (tx) => {
      const old = await order(tx, orgId, request.params.orderId, true);
      if (!ORDER_FLOW[old.status].includes(to)) throw badRequest(`An order that is ${old.status} cannot be marked ${to}.`);
      const store = await settings(tx, orgId);
      const wh = await warehouseOrDefault(tx, orgId, store.warehouse_id);
      const lines = await orderLines(tx, old);
      let reserved = old.stock_reserved;
      if (to === 'confirmed' || (['packed', 'shipped'].includes(to) && !reserved)) {
        for (const line of lines) {
          if (!line.product_id) continue;
          await moveStock(tx, { orgId, userId, productId: line.product_id, fromWarehouseId: wh.id, quantity: line.quantity, kind: 'online_sale', reference: old.number, sourceType: 'store_order', sourceId: old.id });
        }
        reserved = true;
      }
      if (to === 'cancelled' && reserved) {
        for (const line of lines) {
          if (!line.product_id) continue;
          await moveStock(tx, { orgId, userId, productId: line.product_id, toWarehouseId: wh.id, quantity: line.quantity, kind: 'online_return', reference: old.number, sourceType: 'store_order', sourceId: old.id });
        }
        reserved = false;
      }
      const stamp = { confirmed: 'confirmed_at', shipped: 'shipped_at', delivered: 'delivered_at', cancelled: 'cancelled_at' }[to];
      await tx.query(
        `UPDATE store_orders SET status = $3, stock_reserved = $4, tracking_number = COALESCE($5, tracking_number),
                payment_status = CASE WHEN $3 = 'delivered' AND payment_method = 'cod' THEN 'paid' ELSE payment_status END,
                notes = CASE WHEN $6 = '' THEN notes ELSE concat_ws(E'\\n', NULLIF(notes, ''), $6::text) END,
                ${stamp ? `${stamp} = now(),` : ''} updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, old.id, to, reserved, request.body.tracking_number ?? null, request.body.note ?? ''],
      );
      const updated = await order(tx, orgId, old.id);
      if (to === 'delivered') {
        tx.emit({ type: EVENTS.STORE_ORDER_DELIVERED, org_id: orgId, actor_id: userId, data: { order_id: updated.id, number: updated.number, total: updated.total, tax_total: updated.tax_total, payment_method: updated.payment_method } });
      }
      if (to === 'cancelled') {
        tx.emit({ type: EVENTS.STORE_ORDER_CANCELLED, org_id: orgId, actor_id: userId, data: { order_id: updated.id, number: updated.number, customer_email: updated.customer_email } });
      }
      return updated;
    });
    return { data: { ...row, lines: await orderLines(db, row) } };
  });

  app.post('/ecommerce/orders/:orderId/payment', {
    preHandler: guard('ecommerce.orders.edit'),
    schema: { ...orderParams, body: body({ payment_status: v.enum(['unpaid', 'paid', 'refunded']) }, ['payment_status']) },
  }, async (request) => {
    const row = await db.one(
      `UPDATE store_orders SET payment_status = $3, updated_at = now() WHERE org_id = $1 AND id = $2 RETURNING *`,
      [request.ctx.orgId, request.params.orderId, request.body.payment_status],
    );
    if (!row) throw notFound('Order');
    return { data: row };
  });

  async function storeStats(orgId) {
    return db.one(
      `SELECT COALESCE(sum(total) FILTER (WHERE status NOT IN ('pending', 'cancelled') AND placed_at >= date_trunc('month', now())), 0)::numeric(14,2) AS revenue_month,
              count(*) FILTER (WHERE placed_at >= current_date)::int AS orders_today,
              count(*) FILTER (WHERE status = 'pending')::int AS pending,
              count(*) FILTER (WHERE status IN ('confirmed', 'packed'))::int AS to_ship
         FROM store_orders WHERE org_id = $1`,
      [orgId],
    );
  }
  app.get('/ecommerce/overview', { preHandler: guard('ecommerce.store.view') }, async (request) => {
    const { orgId } = request.ctx;
    const [stats, store, online] = await Promise.all([
      storeStats(orgId), settings(db, orgId),
      db.one(`SELECT count(*)::int AS n FROM products WHERE org_id = $1 AND online AND active`, [orgId]),
    ]);
    return { data: { ...stats, store, online_products: online.n } };
  });
  app.get('/ecommerce/widgets', { preHandler: guard('ecommerce.orders.view') }, async (request) => {
    const s = await storeStats(request.ctx.orgId);
    return { data: { 'ecommerce.revenue': s.revenue_month, 'ecommerce.orders_today': s.orders_today } };
  });

  // ══════════════════════════════════════════════════════════ PUBLIC STOREFRONT
  const slugParam = { type: 'string', pattern: '^[a-z0-9-]{1,64}$' };
  async function publicStore(slug) {
    const response = await fetch(`${config.tenancyUrl}/workspace-lookup/${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(8000) });
    if (response.status === 404) throw notFound('Store');
    if (!response.ok) throw app.httpErrors.serviceUnavailable('Try again in a moment.');
    const org = (await response.json()).data;
    const store = await db.one(`SELECT * FROM store_settings WHERE org_id = $1 AND published`, [org.id]);
    if (!store) throw notFound('Store');
    const wh = await warehouseOrDefault(db, org.id, store.warehouse_id);
    return { org, store, warehouseId: wh.id };
  }
  const shopProducts = (orgId, warehouseId, productId = null) => db.rows(
    `SELECT p.id, p.name, p.description, p.sale_price, p.tax_rate, p.image_url, p.uom, p.type, c.name AS category_name,
            CASE WHEN p.type = 'stockable' THEN COALESCE((SELECT quantity FROM stock_quants q WHERE q.org_id = p.org_id AND q.product_id = p.id AND q.warehouse_id = $2), 0)
                 ELSE 999999 END AS available
       FROM products p LEFT JOIN product_categories c ON c.id = p.category_id
      WHERE p.org_id = $1 AND p.online AND p.active AND p.type <> 'service' AND ($3::text IS NULL OR p.id = $3)
      ORDER BY c.name NULLS LAST, p.name LIMIT 500`,
    [orgId, warehouseId, productId],
  );
  // Shoppers see "in stock", "only 3 left" or "sold out" — never the count.
  const shopView = (p) => {
    const available = Number(p.available);
    const { available: _hidden, type: _type, ...rest } = p;
    return { ...rest, price_with_tax: toRupees(Math.round(toPaise(p.sale_price) * (1 + Number(p.tax_rate) / 100))), in_stock: available > 0, low_stock: available > 0 && available <= 5 ? available : null };
  };
  const storeView = ({ org, store }) => ({
    name: store.name || org.name, tagline: store.tagline, slug: org.slug, logo_url: org.logo_url ?? null,
    shipping_fee: store.shipping_fee, free_shipping_over: store.free_shipping_over, cod_enabled: store.cod_enabled,
    contact_email: store.contact_email, contact_phone: store.contact_phone,
  });

  app.get('/store/:slug', { schema: { params: { type: 'object', properties: { slug: slugParam }, required: ['slug'] } } }, async (request) => {
    const ctx = await publicStore(request.params.slug);
    const products = await shopProducts(ctx.org.id, ctx.warehouseId);
    return { data: { store: storeView(ctx), products: products.map(shopView) } };
  });

  app.get('/store/:slug/products/:productId', {
    schema: { params: { type: 'object', properties: { slug: slugParam, productId: v.id('prd') }, required: ['slug', 'productId'] } },
  }, async (request) => {
    const ctx = await publicStore(request.params.slug);
    const [row] = await shopProducts(ctx.org.id, ctx.warehouseId, request.params.productId);
    if (!row) throw notFound('Product');
    return { data: { store: storeView(ctx), product: shopView(row) } };
  });

  async function promotion(store, orgId, code, subtotalPaise, { lock = false } = {}) {
    if (!code) return null;
    const promo = await store.one(
      `SELECT * FROM store_promotions WHERE org_id = $1 AND upper(code) = upper($2) AND active
          AND (starts_on IS NULL OR starts_on <= current_date) AND (ends_on IS NULL OR ends_on >= current_date)${lock ? ' FOR UPDATE' : ''}`,
      [orgId, code.trim()],
    );
    if (!promo) throw badRequest('That code is not valid.', { code: 'invalid_promo' });
    if (promo.usage_limit && promo.used_count >= promo.usage_limit) throw badRequest('That code has been fully used.', { code: 'invalid_promo' });
    if (subtotalPaise < toPaise(promo.min_order)) throw badRequest(`That code needs an order of at least ₹${promo.min_order}.`, { code: 'invalid_promo' });
    const discount = promo.kind === 'percent' ? Math.round((subtotalPaise * Number(promo.value)) / 100) : Math.min(subtotalPaise, toPaise(promo.value));
    return { promo, discount };
  }

  /** Price a basket from the catalogue: lines, promotion, tax and shipping. */
  async function price(store, ctx, items, promoCode, { lock = false } = {}) {
    const products = new Map((await shopProducts(ctx.org.id, ctx.warehouseId)).map((p) => [p.id, p]));
    const merged = new Map();
    for (const item of items) merged.set(item.product_id, (merged.get(item.product_id) ?? 0) + Number(item.quantity));
    const lines = [];
    for (const [productId, quantity] of merged) {
      const p = products.get(productId);
      if (!p) throw badRequest('Something in your cart is no longer for sale.', { code: 'unavailable', product_id: productId });
      if (quantity > Number(p.available)) {
        throw badRequest(Number(p.available) > 0 ? `Only ${Number(p.available)} of ${p.name} left.` : `${p.name} is sold out.`, { code: 'insufficient_stock', product_id: productId });
      }
      lines.push({ product: p, quantity, gross: Math.round(toPaise(p.sale_price) * quantity) });
    }
    const subtotal = lines.reduce((s, l) => s + l.gross, 0);
    const promo = await promotion(store, ctx.org.id, promoCode, subtotal, { lock });
    const discount = promo?.discount ?? 0;
    // The discount reduces each line's taxable value in proportion.
    let tax = 0;
    for (const line of lines) {
      const taxable = subtotal ? line.gross - Math.round((discount * line.gross) / subtotal) : 0;
      line.tax = Math.round((taxable * Number(line.product.tax_rate)) / 100);
      line.total = taxable + line.tax;
      tax += line.tax;
    }
    const afterDiscount = subtotal - discount;
    const freeOver = ctx.store.free_shipping_over === null ? null : toPaise(ctx.store.free_shipping_over);
    const shipping = freeOver !== null && afterDiscount >= freeOver ? 0 : toPaise(ctx.store.shipping_fee);
    return { lines, promo: promo?.promo ?? null, subtotal, discount, tax, shipping, total: afterDiscount + tax + shipping };
  }

  app.post('/store/:slug/quote', {
    schema: {
      params: { type: 'object', properties: { slug: slugParam }, required: ['slug'] },
      body: body({ items: { type: 'array', minItems: 1, maxItems: 50, items: body({ product_id: v.id('prd'), quantity: v.int(1, 1000) }, ['product_id', 'quantity']) }, promo_code: v.text(24, 0) }, ['items']),
    },
  }, async (request) => {
    const ctx = await publicStore(request.params.slug);
    const p = await price(db, ctx, request.body.items, request.body.promo_code || null);
    return {
      data: {
        subtotal: toRupees(p.subtotal), discount: toRupees(p.discount), tax: toRupees(p.tax), shipping: toRupees(p.shipping), total: toRupees(p.total),
        promo_code: p.promo?.code ?? null,
      },
    };
  });

  app.post('/store/:slug/checkout', {
    schema: {
      params: { type: 'object', properties: { slug: slugParam }, required: ['slug'] },
      body: body({
        items: { type: 'array', minItems: 1, maxItems: 50, items: body({ product_id: v.id('prd'), quantity: v.int(1, 1000) }, ['product_id', 'quantity']) },
        customer: body({ name: v.text(120, 1), email: nullable(v.email), phone: { type: 'string', pattern: '^[+0-9 ()-]{8,20}$' } }, ['name', 'phone']),
        address: body({ line1: v.text(200, 1), line2: v.text(200, 0), city: v.text(80, 1), state: v.text(80, 1), pincode: { type: 'string', pattern: '^[0-9]{6}$' } }, ['line1', 'city', 'state', 'pincode']),
        promo_code: v.text(24, 0), notes: v.text(1000, 0),
        // Never shown to people; anything that fills it is a bot.
        website: v.text(200, 0),
      }, ['items', 'customer', 'address']),
    },
  }, async (request, reply) => {
    const b = request.body;
    if (b.website) return reply.status(201).send({ data: { received: true } });
    const ctx = await publicStore(request.params.slug);
    if (!ctx.store.cod_enabled) throw badRequest('This store is not taking orders online yet. Contact the store to order.');
    const ipHash = createHash('sha256').update(`${request.ip}:${config.serviceToken}`).digest('hex').slice(0, 32);
    const recent = await db.one(`SELECT count(*)::int AS n FROM store_orders WHERE org_id = $1 AND ip_hash = $2 AND placed_at > now() - interval '10 minutes'`, [ctx.org.id, ipHash]);
    if (recent.n >= 5) throw new ApiError(429, 'rate_limited', 'Too many orders from this connection. Try again in a few minutes.');

    const placed = await db.transaction(async (tx) => {
      const p = await price(tx, ctx, b.items, b.promo_code || null, { lock: true });
      if (p.promo) await tx.query(`UPDATE store_promotions SET used_count = used_count + 1 WHERE id = $1`, [p.promo.id]);
      const created = await tx.one(
        `INSERT INTO store_orders (id, org_id, number, customer_name, customer_email, customer_phone, shipping_address, subtotal, discount_total,
                                   shipping_fee, tax_total, total, promo_code, payment_method, notes, ip_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'cod',$14,$15) RETURNING *`,
        [id('sord'), ctx.org.id, await nextNumber(tx, ctx.org.id, 'store', 'WEB'), b.customer.name.trim(), b.customer.email?.toLowerCase() ?? null,
          b.customer.phone.trim(), JSON.stringify(b.address), toRupees(p.subtotal), toRupees(p.discount), toRupees(p.shipping), toRupees(p.tax),
          toRupees(p.total), p.promo?.code ?? null, b.notes ?? '', ipHash],
      );
      for (const line of p.lines) {
        await tx.query(
          `INSERT INTO store_order_lines (id, org_id, order_id, product_id, name, quantity, unit_price, tax_rate, line_total) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id('sol'), ctx.org.id, created.id, line.product.id, line.product.name, line.quantity, line.product.sale_price, line.product.tax_rate, toRupees(line.total)],
        );
      }
      tx.emit({
        type: EVENTS.STORE_ORDER_PLACED, org_id: ctx.org.id, actor_id: null,
        data: { order_id: created.id, number: created.number, total: created.total, customer_name: created.customer_name, customer_email: created.customer_email },
      });
      return created;
    });
    return reply.status(201).send({ data: { received: true, number: placed.number, total: placed.total, payment_method: 'cod' } });
  });

  // For the storefront: is this product still available at this quantity?
  app.get('/store/:slug/availability', {
    schema: {
      params: { type: 'object', properties: { slug: slugParam }, required: ['slug'] },
      querystring: { type: 'object', properties: { product_id: v.id('prd') }, required: ['product_id'], additionalProperties: false },
    },
  }, async (request) => {
    const ctx = await publicStore(request.params.slug);
    const available = await onHand(db, ctx.org.id, request.query.product_id, ctx.warehouseId);
    return { data: { in_stock: available > 0 } };
  });
}
