import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API, workspace, invite, ok } from './helpers.js';

const APPS = ['erp', 'manufacturing', 'quality', 'maintenance', 'pos', 'ecommerce'];
const publicCall = async (path, method = 'GET', body) => {
  const response = await fetch(`${API}/api${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  return { status: response.status, ...(text && text.startsWith('{') ? JSON.parse(text) : { text }) };
};
const onHand = async (client, productId) => Number(ok(await client.call(`/erp/products/${productId}`)).on_hand);

test('Inventory & Purchasing', async (t) => {
  const { client: owner, stamp } = await workspace(APPS);
  const { client: other } = await workspace(['erp']);
  const member = await invite(owner, 'member', `${stamp}-clerk`);
  let pen, vendor, po;

  await t.test('products and vendors; a default warehouse appears on first look', async () => {
    const warehouses = ok(await owner.call('/erp/warehouses'));
    assert.equal(warehouses.length, 1);
    assert.equal(warehouses[0].is_default, true);
    pen = ok(await owner.call('/erp/products', 'POST', { name: 'Gel pen (blue)', sku: 'PEN-BLU', sale_price: 20, cost_price: '8.50', tax_rate: 18, reorder_level: 50 }), 201);
    assert.equal((await owner.call('/erp/products', 'POST', { name: 'Duplicate', sku: 'pen-blu' })).status, 409, 'SKUs are unique regardless of case');
    vendor = ok(await owner.call('/erp/vendors', 'POST', { name: `Stationery Mart ${stamp}`, gstin: '07AABCS1429B1Z5', payment_terms_days: 15 }), 201);
    assert.equal((await other.call(`/erp/products/${pen.id}`)).status, 404, 'another workspace cannot see it');
  });

  await t.test('a purchase order is priced on the server, approved, then received into stock', async () => {
    po = ok(await member.call('/erp/purchase-orders', 'POST', { vendor_id: vendor.id, lines: [{ product_id: pen.id, quantity: 200, unit_price: 8, tax_rate: 18 }] }), 201);
    assert.match(po.number, /^PO-\d{4}$/);
    assert.equal(po.total, '1888.00');
    assert.equal((await member.call(`/erp/purchase-orders/${po.id}/approve`, 'POST', {})).status, 403, 'members cannot approve spend');
    assert.equal((await owner.call(`/erp/purchase-orders/${po.id}/receive`, 'POST', {})).status, 400, 'approve before receiving');
    ok(await owner.call(`/erp/purchase-orders/${po.id}/approve`, 'POST', {}));
    const line = po.lines[0];
    const part = ok(await owner.call(`/erp/purchase-orders/${po.id}/receive`, 'POST', { lines: [{ line_id: line.id, quantity: 120 }] }));
    assert.equal(part.status, 'partially_received');
    assert.equal((await owner.call(`/erp/purchase-orders/${po.id}/receive`, 'POST', { lines: [{ line_id: line.id, quantity: 100 }] })).status, 400, 'cannot receive more than ordered');
    const done = ok(await owner.call(`/erp/purchase-orders/${po.id}/receive`, 'POST', {}));
    assert.equal(done.status, 'received');
    assert.equal(await onHand(owner, pen.id), 200);
    assert.equal((await owner.call(`/erp/purchase-orders/${po.id}/cancel`, 'POST', {})).status, 400);
  });

  await t.test('counts, transfers and history', async () => {
    const shop = ok(await owner.call('/erp/warehouses', 'POST', { code: 'shop', name: 'Shop floor' }), 201);
    assert.equal(shop.code, 'SHOP');
    ok(await owner.call('/erp/stock/transfer', 'POST', { product_id: pen.id, from_warehouse_id: (await defaultWh(owner)).id, to_warehouse_id: shop.id, quantity: 30 }));
    const tooMany = await owner.call('/erp/stock/transfer', 'POST', { product_id: pen.id, from_warehouse_id: shop.id, to_warehouse_id: (await defaultWh(owner)).id, quantity: 31 });
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.error.details.code, 'insufficient_stock');
    const counted = ok(await owner.call('/erp/stock/adjust', 'POST', { product_id: pen.id, warehouse_id: shop.id, counted_quantity: 28, note: 'Two missing' }));
    assert.equal(counted.difference, -2);
    assert.equal(await onHand(owner, pen.id), 198);
    const detail = ok(await owner.call(`/erp/products/${pen.id}`));
    assert.deepEqual(detail.moves.map((m) => m.kind).slice(0, 3), ['adjustment_out', 'transfer', 'receipt']);
    assert.equal((await owner.call(`/erp/products/${pen.id}`, 'DELETE')).status, 400, 'history keeps a product from being deleted');
    const stock = await owner.call('/erp/stock');
    assert.equal(stock.data.find((r) => r.id === pen.id).value, '1683.00');
  });

  await t.test('overview and widgets', async () => {
    const overview = ok(await owner.call('/erp/overview'));
    assert.equal(overview.products, 1);
    assert.equal(ok(await owner.call('/erp/widgets'))['erp.open_pos'], 0);
  });
});

async function defaultWh(client) {
  return ok(await client.call('/erp/warehouses')).find((w) => w.is_default);
}

test('Manufacturing, Quality and Maintenance', async (t) => {
  const { client: owner } = await workspace(APPS);
  const make = async (fields) => ok(await owner.call('/erp/products', 'POST', fields), 201);
  const wood = await make({ name: 'Teak plank', cost_price: 400, uom: 'pcs' });
  const screws = await make({ name: 'Screw', cost_price: '0.50' });
  const table = await make({ name: 'Coffee table', sale_price: 6500, cost_price: 0 });
  const wh = await defaultWh(owner);
  ok(await owner.call('/erp/stock/adjust', 'POST', { product_id: wood.id, warehouse_id: wh.id, counted_quantity: 10 }));
  ok(await owner.call('/erp/stock/adjust', 'POST', { product_id: screws.id, warehouse_id: wh.id, counted_quantity: 100 }));
  let bom, mo;

  await t.test('a bill of materials is costed from its components', async () => {
    assert.equal((await owner.call('/manufacturing/boms', 'POST', { product_id: table.id, lines: [{ product_id: table.id, quantity: 1 }] })).status, 400);
    const bench = ok(await owner.call('/manufacturing/work-centers', 'POST', { name: 'Carpentry bench', hours_per_day: 8 }), 201);
    bom = ok(await owner.call('/manufacturing/boms', 'POST', {
      product_id: table.id, quantity: 1, work_center_id: bench.id, hours: 3,
      lines: [{ product_id: wood.id, quantity: 2 }, { product_id: screws.id, quantity: 16 }],
    }), 201);
    assert.equal(bom.unit_cost, '808.00');
  });

  await t.test('a production order checks, consumes and produces through the stock ledger', async () => {
    const quality = ok(await owner.call('/quality/plans', 'POST', { name: 'Finished furniture', trigger: 'production', product_id: table.id, checklist: [{ label: 'Surface smooth' }, { label: 'Legs level' }] }), 201);
    assert.equal(quality.checklist.length, 2);
    mo = ok(await owner.call('/manufacturing/orders', 'POST', { product_id: table.id, quantity: 6 }), 201);
    assert.equal(mo.components.find((c) => c.product_id === wood.id).short, true, '12 planks needed, 10 held');
    ok(await owner.call(`/manufacturing/orders/${mo.id}/confirm`, 'POST', {}));
    assert.equal((await owner.call(`/manufacturing/orders/${mo.id}/complete`, 'POST', {})).status, 400, 'not enough wood for 6');
    ok(await owner.call(`/manufacturing/orders/${mo.id}`, 'PATCH', { notes: 'Reduced to what we can make' }));
    const smaller = ok(await owner.call('/manufacturing/orders', 'POST', { product_id: table.id, quantity: 4 }), 201);
    ok(await owner.call(`/manufacturing/orders/${smaller.id}/confirm`, 'POST', {}));
    ok(await owner.call(`/manufacturing/orders/${smaller.id}/start`, 'POST', {}));
    const done = ok(await owner.call(`/manufacturing/orders/${smaller.id}/complete`, 'POST', { produced_quantity: 4 }));
    assert.equal(done.status, 'done');
    assert.equal(done.unit_cost, '808.00');
    assert.equal(await onHand(owner, table.id), 4);
    assert.equal(await onHand(owner, wood.id), 2);
    assert.equal(await onHand(owner, screws.id), 36);
    ok(await owner.call(`/manufacturing/orders/${mo.id}/cancel`, 'POST', {}));
  });

  await t.test('the production run raised a check; failing it opens a report that needs a corrective action', async () => {
    const pending = ok(await owner.call('/quality/checks?status=pending'));
    assert.equal(pending.length, 1);
    const check = pending[0];
    assert.equal((await owner.call(`/quality/checks/${check.id}/perform`, 'POST', { results: [{ label: 'Surface smooth', passed: true }] })).status, 400, 'every checkpoint needs a result');
    const failed = ok(await owner.call(`/quality/checks/${check.id}/perform`, 'POST', { results: [{ label: 'Surface smooth', passed: true }, { label: 'Legs level', passed: false, note: '2 mm wobble' }] }));
    assert.equal(failed.status, 'failed');
    const [ncr] = ok(await owner.call('/quality/ncr'));
    assert.match(ncr.number, /^NCR-/);
    assert.match(ncr.description, /2 mm wobble/);
    assert.equal((await owner.call(`/quality/ncr/${ncr.id}`, 'PATCH', { status: 'closed' })).status, 400);
    const closed = ok(await owner.call(`/quality/ncr/${ncr.id}`, 'PATCH', { status: 'closed', corrective_action: 'Leg jig re-cut; batch re-levelled.' }));
    assert.ok(closed.closed_at);
  });

  await t.test('preventive maintenance is raised once, and parts come out of stock', async () => {
    const lathe = ok(await owner.call('/maintenance/equipment', 'POST', { name: 'Wood lathe', code: 'LTH-1', preventive_every_days: 30, last_maintained_on: new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10) }), 201);
    assert.ok(lathe.next_due);
    assert.equal(ok(await owner.call('/maintenance/preventive/generate', 'POST', {})).created, 1);
    assert.equal(ok(await owner.call('/maintenance/preventive/generate', 'POST', {})).created, 0, 'never twice');
    const [request] = ok(await owner.call('/maintenance/requests?kind=preventive'));
    ok(await owner.call(`/maintenance/requests/${request.id}/start`, 'POST', { equipment_down: true }));
    assert.equal(ok(await owner.call(`/maintenance/equipment/${lathe.id}`)).status, 'down');
    const done = ok(await owner.call(`/maintenance/requests/${request.id}/complete`, 'POST', { resolution: 'Belt replaced, bearings greased', downtime_hours: 2, parts: [{ product_id: screws.id, quantity: 4 }] }));
    assert.equal(done.status, 'repaired');
    assert.equal(done.parts[0].quantity, 4);
    assert.equal(await onHand(owner, screws.id), 32);
    const machine = ok(await owner.call(`/maintenance/equipment/${lathe.id}`));
    assert.equal(machine.status, 'operational');
    assert.equal(machine.last_maintained_on.slice(0, 10), new Date().toISOString().slice(0, 10));
  });
});

test('Point of Sale and Online Store', async (t) => {
  const { client: owner, stamp } = await workspace(APPS);
  const cashier = await invite(owner, 'member', `${stamp}-cashier`);
  const slug = ok(await owner.call('/organizations/current')).slug;
  const wh = await defaultWh(owner);
  const tea = ok(await owner.call('/erp/products', 'POST', { name: 'Masala chai 250g', sale_price: 100, tax_rate: 5, barcode: '8901234567890' }), 201);
  ok(await owner.call('/erp/stock/adjust', 'POST', { product_id: tea.id, warehouse_id: wh.id, counted_quantity: 20 }));
  let register, session, sale;

  await t.test('a shift opens with a float; a sale is priced from the catalogue and is idempotent', async () => {
    register = ok(await owner.call('/pos/registers', 'POST', { name: 'Counter 1' }), 201);
    assert.equal(register.warehouse_id, wh.id);
    session = ok(await cashier.call(`/pos/registers/${register.id}/open`, 'POST', { opening_cash: 500 }), 201);
    assert.equal((await cashier.call(`/pos/registers/${register.id}/open`, 'POST', {})).status, 400, 'one open session per till');
    ok(await cashier.call(`/erp/products/lookup/8901234567890`));
    const body = { session_id: session.id, client_ref: `till-${stamp}-0001`, lines: [{ product_id: tea.id, quantity: 3 }], payment_method: 'cash', amount_tendered: 400 };
    assert.equal((await cashier.call('/pos/sales', 'POST', { ...body, client_ref: `till-${stamp}-x`, lines: [{ product_id: tea.id, quantity: 1, discount_percent: 50 }] })).status, 403, 'big discounts need a manager');
    sale = ok(await cashier.call('/pos/sales', 'POST', body), 201);
    assert.equal(sale.total, '315.00');
    assert.equal(sale.change_due, '85.00');
    const again = await cashier.call('/pos/sales', 'POST', body);
    assert.equal(again.status, 200);
    assert.equal(again.data.id, sale.id, 'a resent offline sale is one sale');
    assert.equal(await onHand(owner, tea.id), 17);
  });

  await t.test('refunds return stock; closing counts the cash', async () => {
    assert.equal((await cashier.call(`/pos/sales/${sale.id}/refund`, 'POST', { reason: 'Wrong flavour' })).status, 403, 'cash back needs a manager');
    const refunded = ok(await owner.call(`/pos/sales/${sale.id}/refund`, 'POST', { reason: 'Wrong flavour' }));
    assert.equal(refunded.status, 'refunded');
    assert.equal((await owner.call(`/pos/sales/${sale.id}/refund`, 'POST', { reason: 'Again' })).status, 400);
    assert.equal(await onHand(owner, tea.id), 20);
    const again = ok(await cashier.call('/pos/sales', 'POST', { session_id: session.id, client_ref: `till-${stamp}-0002`, lines: [{ product_id: tea.id, quantity: 2 }], payment_method: 'upi' }), 201);
    assert.equal(again.total, '210.00');
    const closed = ok(await cashier.call(`/pos/sessions/${session.id}/close`, 'POST', { counted_cash: 490 }));
    assert.equal(closed.expected_cash, '500.00', 'the refunded cash sale does not count');
    assert.equal(closed.difference, '-10.00');
    const report = await owner.call('/pos/sales');
    assert.equal(report.meta.revenue, '210.00');
  });

  await t.test('the storefront is private until published, and prices itself', async () => {
    assert.equal((await publicCall(`/store/${slug}`)).status, 404);
    ok(await owner.call('/ecommerce/settings', 'PUT', { name: 'Chai Co.', published: true, shipping_fee: 50, free_shipping_over: 1000 }));
    ok(await owner.call(`/ecommerce/products/${tea.id}`, 'PUT', { online: true }));
    ok(await owner.call('/ecommerce/promotions', 'POST', { code: 'first10', kind: 'percent', value: 10, usage_limit: 1 }), 201);
    const page = await publicCall(`/store/${slug}`);
    assert.equal(page.status, 200);
    assert.equal(page.data.products[0].price_with_tax, '105.00');
    assert.equal(page.data.products[0].available, undefined, 'shoppers never see the stock count');
    const quote = await publicCall(`/store/${slug}/quote`, 'POST', { items: [{ product_id: tea.id, quantity: 4 }], promo_code: 'FIRST10' });
    // 400 − 10% = 360, + 5% GST = 18, + 50 shipping.
    assert.equal(quote.data.total, '428.00');
    assert.equal((await publicCall(`/store/${slug}/quote`, 'POST', { items: [{ product_id: tea.id, quantity: 99 }] })).status, 400);
  });

  await t.test('checkout, confirm (stock taken), cancel (stock returned)', async () => {
    const order = { items: [{ product_id: tea.id, quantity: 4 }], promo_code: 'FIRST10', customer: { name: 'Ritu', phone: '+91 98111 22233', email: `ritu-${stamp}@example.com` }, address: { line1: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' } };
    const placed = await publicCall(`/store/${slug}/checkout`, 'POST', order);
    assert.equal(placed.status, 201);
    assert.equal(placed.data.total, '428.00');
    assert.equal((await publicCall(`/store/${slug}/checkout`, 'POST', order)).status, 400, 'the one-use code is spent');
    const [row] = ok(await owner.call('/ecommerce/orders'));
    assert.equal(row.status, 'pending');
    assert.equal(await onHand(owner, tea.id), 18, 'pending orders hold nothing (20 less the 2 sold at the till)');
    ok(await owner.call(`/ecommerce/orders/${row.id}/status`, 'POST', { status: 'confirmed' }));
    assert.equal(await onHand(owner, tea.id), 14);
    assert.equal((await owner.call(`/ecommerce/orders/${row.id}/status`, 'POST', { status: 'delivered' })).status, 400, 'ship before delivering');
    ok(await owner.call(`/ecommerce/orders/${row.id}/status`, 'POST', { status: 'cancelled', note: 'Customer called' }));
    assert.equal(await onHand(owner, tea.id), 18);
  });
});
