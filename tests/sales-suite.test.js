import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API, workspace, invite, ok } from './helpers.js';

const APPS = ['crm', 'quotes', 'partners', 'marketing', 'social', 'invoicing', 'erp'];
const publicCall = async (path, method = 'GET', body) => {
  const response = await fetch(`${API}/api${path}`, {
    method, redirect: 'manual', headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  return { status: response.status, location: response.headers.get('location'), ...(text && text.startsWith('{') ? JSON.parse(text) : { text }) };
};
const tokenOf = (url) => url.split('/').pop();

test('Quotations & Orders: approval, the customer’s page, order, delivery and invoice', async (t) => {
  const { client: owner, stamp } = await workspace(APPS);
  const rep = await invite(owner, 'member', `${stamp}-rep`);
  let product, quote;

  await t.test('a big discount needs someone else’s approval', async () => {
    product = ok(await owner.call('/erp/products', 'POST', { name: 'Solar inverter 5kW', sale_price: 50000, tax_rate: 18 }), 201);
    const wh = ok(await owner.call('/erp/warehouses'))[0];
    ok(await owner.call('/erp/stock/adjust', 'POST', { product_id: product.id, warehouse_id: wh.id, counted_quantity: 5 }));
    quote = ok(await rep.call('/quotes/quotations', 'POST', {
      customer_name: 'Sunrise Hotels', customer_email: `buyer-${stamp}@example.com`, title: 'Rooftop solar',
      lines: [{ product_id: product.id, description: 'Solar inverter 5kW', quantity: 2, unit_price: '50000', discount_percent: 20, tax_rate: 18 }],
    }), 201);
    assert.match(quote.number, /^QT-\d{4}$/);
    assert.equal(quote.total, '94400.00', '2 × 50,000 − 20% + 18% GST');
    assert.equal((await rep.call(`/quotes/quotations/${quote.id}/send`, 'POST', {})).status, 400, 'over the 15% limit');
    assert.equal(ok(await rep.call(`/quotes/quotations/${quote.id}/submit`, 'POST', {})).status, 'pending_approval');
    assert.equal((await rep.call(`/quotes/quotations/${quote.id}/approve`, 'POST', {})).status, 403, 'members cannot approve');
    assert.equal(ok(await owner.call(`/quotes/quotations/${quote.id}/approve`, 'POST', {})).status, 'approved');
    quote = ok(await rep.call(`/quotes/quotations/${quote.id}/send`, 'POST', {}));
    assert.equal(quote.status, 'sent');
  });

  await t.test('the customer sees it by link, and accepts it with their name', async () => {
    const token = tokenOf(quote.public_url);
    const view = await publicCall(`/quote-view/${token}`);
    assert.equal(view.status, 200);
    assert.equal(view.data.total, '94400.00');
    assert.ok(view.data.seller.name);
    assert.equal(view.data.lines.length, 1);
    assert.equal((await publicCall('/quote-view/not-a-real-token-at-all')).status, 404);
    const accepted = await publicCall(`/quote-view/${token}/accept`, 'POST', { name: 'R. Mehta' });
    assert.equal(accepted.data.status, 'accepted');
    assert.equal((await publicCall(`/quote-view/${token}/decline`, 'POST', {})).status, 400, 'already accepted');
  });

  await t.test('accepted → order → delivered from stock → invoiced once', async () => {
    const order = ok(await owner.call(`/quotes/quotations/${quote.id}/order`, 'POST', {}), 201);
    assert.match(order.number, /^SO-/);
    assert.equal((await owner.call(`/quotes/quotations/${quote.id}/order`, 'POST', {})).status, 400, 'one order per quote');
    ok(await owner.call(`/quotes/orders/${order.id}/deliver`, 'POST', {}));
    assert.equal(Number(ok(await owner.call(`/erp/products/${product.id}`)).on_hand), 3);
    const invoiced = ok(await owner.call(`/quotes/orders/${order.id}/invoice`, 'POST', {}));
    assert.equal(invoiced.status, 'invoiced');
    assert.match(invoiced.invoice_number, /\//);
    const invoice = ok(await owner.call(`/invoicing/invoices/${invoiced.invoice_id}`));
    assert.equal(invoice.total, '94400.00');
    assert.equal((await owner.call(`/quotes/orders/${order.id}/invoice`, 'POST', {})).status, 400);
    assert.equal(ok(await owner.call('/quotes/widgets'))['quotes.win_rate'], '100%');
  });
});

test('Partner Portal: register through the portal, approve into CRM, win, earn', async (t) => {
  const { client: owner } = await workspace(APPS);
  let partner, registration;

  await t.test('a partner gets a private portal and registers a deal there', async () => {
    partner = ok(await owner.call('/partners/accounts', 'POST', { name: 'Kumar Solar Dealers', tier: 'gold', commission_percent: 8, email: 'kumar@example.com' }), 201);
    const token = tokenOf(partner.portal_url);
    const portal = await publicCall(`/partner-portal/${token}`);
    assert.equal(portal.status, 200);
    assert.equal(portal.data.partner.tier, 'gold');
    const reg = await publicCall(`/partner-portal/${token}/deals`, 'POST', { customer_company: 'Green Farms Pvt Ltd', customer_contact: 'Anita Rao', expected_value: '250000' });
    assert.equal(reg.status, 201);
    assert.equal((await publicCall(`/partner-portal/${token}/deals`, 'POST', { customer_company: 'green farms pvt ltd' })).status, 409, 'no double registration');
    [registration] = ok(await owner.call('/partners/deals?status=submitted'));
    assert.equal(registration.customer_company, 'Green Farms Pvt Ltd');
  });

  await t.test('approval creates the CRM lead; winning creates the commission', async () => {
    assert.equal((await owner.call(`/partners/deals/${registration.id}/decision`, 'POST', { decision: 'won' })).status, 400, 'approve first');
    const approved = ok(await owner.call(`/partners/deals/${registration.id}/decision`, 'POST', { decision: 'approve' }));
    const lead = ok(await owner.call(`/crm/leads/${approved.lead_id}`));
    assert.equal(lead.source, 'partner');
    assert.equal(lead.company_name, 'Green Farms Pvt Ltd');
    ok(await owner.call(`/partners/deals/${registration.id}/decision`, 'POST', { decision: 'won', won_value: '300000' }));
    const commissions = await owner.call('/partners/commissions');
    assert.equal(commissions.data[0].amount, '24000.00', '8% of 3,00,000');
    assert.equal((await owner.call(`/partners/commissions/${commissions.data[0].id}/status`, 'POST', { status: 'paid' })).status, 400, 'approve before paying');
    ok(await owner.call(`/partners/commissions/${commissions.data[0].id}/status`, 'POST', { status: 'approved' }));
    ok(await owner.call(`/partners/commissions/${commissions.data[0].id}/status`, 'POST', { status: 'paid', reference: 'NEFT 991' }));
    const portal = await publicCall(`/partner-portal/${tokenOf(partner.portal_url)}`);
    assert.equal(portal.data.commissions[0].status, 'paid');
  });

  await t.test('rotating the link locks the old one out', async () => {
    const old = tokenOf(partner.portal_url);
    ok(await owner.call(`/partners/accounts/${partner.id}/rotate-link`, 'POST', {}));
    assert.equal((await publicCall(`/partner-portal/${old}`)).status, 404);
  });
});

test('Marketing: segments, sending, tracking without an open redirect, unsubscribe', async (t) => {
  const { client: owner, stamp } = await workspace(APPS);
  let segment, campaign;

  await t.test('a segment is a live filter over leads', async () => {
    for (const [name, rating] of [['Asha', 'hot'], ['Bhavesh', 'hot'], ['Chitra', 'cold']]) {
      ok(await owner.call('/crm/leads', 'POST', { first_name: name, email: `${name.toLowerCase()}-${stamp}@example.com`, rating }), 201);
    }
    ok(await owner.call('/crm/leads', 'POST', { first_name: 'NoEmail', rating: 'hot' }), 201);
    segment = ok(await owner.call('/marketing/segments', 'POST', { name: 'Hot leads', source: 'leads', rules: { rating: ['hot'] } }), 201);
    const preview = ok(await owner.call(`/marketing/segments/${segment.id}/preview`));
    assert.equal(preview.count, 2, 'hot and with an email');
  });

  await t.test('sending fixes the audience; the counters count honestly', async () => {
    campaign = ok(await owner.call('/marketing/campaigns', 'POST', { name: 'Diwali offer', segment_id: segment.id, subject: 'Hi {{first_name}}, 10% off', body: 'Hello {{first_name}},\n\nSee https://example.com/offer for details.' }), 201);
    campaign = ok(await owner.call(`/marketing/campaigns/${campaign.id}/send`, 'POST', {}));
    assert.equal(campaign.status, 'sent');
    assert.equal(campaign.recipients, 2);
    assert.equal((await owner.call(`/marketing/campaigns/${campaign.id}/send`, 'POST', {})).status, 400, 'never twice');
  });

  await t.test('opens and clicks are counted once; foreign links are refused', async () => {
    // Pull a recipient token the way a mail client would see it.
    const { rows } = await import('./db-peek.js').then((m) => m.peek(`SELECT token FROM nexus_crm.marketing_recipients WHERE campaign_id = $1 ORDER BY email LIMIT 1`, [campaign.id]));
    const token = rows[0].token;
    const pixel = await fetch(`${API}/api/mkt/o/${token}`);
    assert.equal(pixel.headers.get('content-type'), 'image/gif');
    await fetch(`${API}/api/mkt/o/${token}`);
    const evil = await publicCall(`/mkt/c/${token}?u=${encodeURIComponent('https://evil.example/phish')}`);
    assert.equal(evil.status, 400, 'not an open redirect');
    const click = await publicCall(`/mkt/c/${token}?u=${encodeURIComponent('https://example.com/offer')}`);
    assert.equal(click.status, 302);
    assert.equal(click.location, 'https://example.com/offer');
    const stats = ok(await owner.call(`/marketing/campaigns/${campaign.id}`));
    assert.equal(stats.opened, 1);
    assert.equal(stats.clicked, 1);
    assert.equal(stats.open_rate, 50);

    assert.equal((await publicCall(`/mkt/u/${token}`, 'POST', {})).status, 200);
    const preview = ok(await owner.call(`/marketing/segments/${segment.id}/preview`));
    assert.equal(preview.count, 1, 'the unsubscribed address is never mailed again');
  });
});

test('Social: plan, approve, publish; inbox to lead', async (t) => {
  const { client: owner, stamp } = await workspace(APPS);
  const writer = await invite(owner, 'member', `${stamp}-writer`);

  await t.test('posts respect each network’s length and need approval', async () => {
    const x = ok(await owner.call('/social/accounts', 'POST', { network: 'x', handle: 'sunrise_hotels' }), 201);
    assert.equal((await writer.call('/social/posts', 'POST', { content: 'a'.repeat(300), account_ids: [x.id] })).status, 400, 'too long for X');
    const post = ok(await writer.call('/social/posts', 'POST', { content: 'Monsoon offer: 20% off weekend stays.', account_ids: [x.id], scheduled_at: new Date(Date.now() + 86_400_000).toISOString() }), 201);
    ok(await writer.call(`/social/posts/${post.id}/submit`, 'POST', {}));
    assert.equal((await writer.call(`/social/posts/${post.id}/approve`, 'POST', {})).status, 403, 'publishing is its own permission');
    assert.equal(ok(await owner.call(`/social/posts/${post.id}/approve`, 'POST', {})).status, 'scheduled');
    const done = ok(await owner.call(`/social/posts/${post.id}/published`, 'POST', { urls: { [x.id]: 'https://x.com/sunrise_hotels/status/1' } }));
    assert.equal(done.status, 'published');
    const cal = ok(await owner.call('/social/calendar'));
    assert.equal(cal.posts[0].status, 'published', 'on the calendar on the day it went out');
  });

  await t.test('an inbox message becomes a lead', async () => {
    const m = ok(await writer.call('/social/inbox', 'POST', { kind: 'message', author_name: 'Priya Nair', author_handle: 'priya', body: 'Do you have rooms for 12 in December?' }), 201);
    ok(await writer.call(`/social/inbox/${m.id}/reply`, 'POST', { reply: 'Yes! Sharing rates on DM.' }));
    const converted = ok(await owner.call(`/social/inbox/${m.id}/lead`, 'POST', {}));
    const lead = ok(await owner.call(`/crm/leads/${converted.lead_id}`));
    assert.equal(lead.first_name, 'Priya');
    assert.match(lead.notes, /12 in December/);
  });
});
