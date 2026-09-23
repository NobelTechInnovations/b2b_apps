#!/usr/bin/env node
/**
 * Invoicing end-to-end check.
 *
 * Proves the money maths (GST splits, rounding, mixed rates), the legal
 * constraints (gap-free numbering, immutable issued invoices), the payment
 * lifecycle — and the claim this whole architecture rests on: that winning a
 * deal in CRM raises an invoice here, over the bus, with no direct call.
 */
const GATEWAY = process.env.API_URL ?? 'http://localhost:4000';

let cookies = '';
let failures = 0;

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${GATEWAY}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: cookies },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const [name] = pair.split('=');
    cookies = [...cookies.split('; ').filter((x) => x && !x.startsWith(`${name}=`)), pair].join('; ');
  }
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function check(label, condition, detail) {
  if (condition) console.log(`  ${c.ok('✔')} ${label}`);
  else {
    failures += 1;
    console.log(`  ${c.bad('✘')} ${label}${detail ? c.dim(`  → ${detail}`) : ''}`);
  }
  return condition;
}

const step = (n, label) => console.log(`\n${c.bold(`${n}. ${label}`)}`);
const settle = (ms = 2500) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const stamp = Date.now();
  console.log(c.bold('\n  Invoicing smoke test\n'));

  step(0, 'Workspace with Invoicing and CRM');
  const reg = await call('/auth/register', {
    method: 'POST',
    body: { email: `inv+${stamp}@nexus.test`, password: 'correct-horse-battery-7', name: 'Invoicing Tester' },
  });
  check('registered', reg.status === 201, `status ${reg.status}`);

  await call('/organizations', { method: 'POST', body: { name: `Sterling Works ${stamp}` } });
  await call('/auth/refresh', { method: 'POST', body: {} });

  // A Maharashtra GSTIN — state code 27 — so the tax split is decidable.
  await call('/organizations/current', { method: 'PATCH', body: { tax_id: '27AAAAA0000A1Z5' } });

  const sub = await call('/subscriptions', {
    method: 'POST',
    body: { plan: 'growth', app_slugs: ['invoicing', 'crm'], seats: 10, cycle: 'monthly' },
  });
  check('subscribed', sub.status === 201, `status ${sub.status}`);
  await settle(1800);

  // ── 1 ── GST maths ──────────────────────────────────────────────────────
  step(1, 'GST is split correctly');
  const intra = await call('/invoicing/invoices', {
    method: 'POST',
    body: {
      customer_name: 'Pune Traders',
      customer_gstin: '27BBBBB1111B1Z5',        // same state as seller
      lines: [{ description: 'Consulting', quantity: 1, unit_price: '100000', tax_rate: 18 }],
    },
  });
  check('draft created', intra.status === 201, `status ${intra.status}`);
  check('same state → CGST + SGST',
    Number(intra.body?.data?.cgst_total) === 9000 && Number(intra.body?.data?.sgst_total) === 9000,
    `cgst ${intra.body?.data?.cgst_total} sgst ${intra.body?.data?.sgst_total}`);
  check('no IGST on an intra-state supply', Number(intra.body?.data?.igst_total) === 0);
  check('total adds up', Number(intra.body?.data?.total) === 118000, intra.body?.data?.total);

  const inter = await call('/invoicing/invoices', {
    method: 'POST',
    body: {
      customer_name: 'Bengaluru Systems',
      customer_gstin: '29CCCCC2222C1Z5',        // Karnataka
      lines: [{ description: 'Consulting', quantity: 1, unit_price: '100000', tax_rate: 18 }],
    },
  });
  check('different state → IGST only',
    Number(inter.body?.data?.igst_total) === 18000 && Number(inter.body?.data?.cgst_total) === 0,
    `igst ${inter.body?.data?.igst_total}`);
  check('same total either way', Number(inter.body?.data?.total) === 118000);

  const mixed = await call('/invoicing/invoices', {
    method: 'POST',
    body: {
      customer_name: 'Mixed Rates Ltd',
      customer_gstin: '27DDDDD3333D1Z5',
      lines: [
        { description: 'Goods', quantity: 3, unit_price: '2500', tax_rate: 12, discount_percent: 10 },
        { description: 'Service', quantity: 1.5, unit_price: '4000', tax_rate: 18 },
      ],
    },
  });
  check('mixed rates taxed per line', Number(mixed.body?.data?.tax_total) === 1890,
    `tax ${mixed.body?.data?.tax_total}`);
  check('discount applied before tax', Number(mixed.body?.data?.discount_total) === 750,
    mixed.body?.data?.discount_total);
  check('total rounded to whole rupees', Number(mixed.body?.data?.total) % 1 === 0,
    mixed.body?.data?.total);

  // ── 2 ── numbering ──────────────────────────────────────────────────────
  step(2, 'Numbering is gap-free and issued at issue time');
  check('a draft carries no number', intra.body?.data?.number === null,
    String(intra.body?.data?.number));

  const issued1 = await call(`/invoicing/invoices/${intra.body.data.id}/issue`, { method: 'POST' });
  check('issuing assigns a number', Boolean(issued1.body?.data?.number), issued1.body?.data?.number);
  check('number is fiscal-year scoped', /^INV\/\d{4}-\d{2}\/0001$/.test(issued1.body?.data?.number ?? ''),
    issued1.body?.data?.number);

  const issued2 = await call(`/invoicing/invoices/${inter.body.data.id}/issue`, { method: 'POST' });
  check('numbers increment', issued2.body?.data?.number?.endsWith('/0002'),
    issued2.body?.data?.number);

  const reissue = await call(`/invoicing/invoices/${intra.body.data.id}/issue`, { method: 'POST' });
  check('an invoice cannot be issued twice', reissue.status === 409, `status ${reissue.status}`);

  // ── 3 ── an issued invoice is immutable ─────────────────────────────────
  step(3, 'An issued invoice is a legal document');
  const edit = await call(`/invoicing/invoices/${intra.body.data.id}`, {
    method: 'PATCH', body: { lines: [{ description: 'Changed', unit_price: '1' }] },
  });
  check('issued invoices cannot be edited', edit.status === 400, `status ${edit.status}`);

  const editDraft = await call(`/invoicing/invoices/${mixed.body.data.id}`, {
    method: 'PATCH',
    body: { lines: [{ description: 'Revised', quantity: 1, unit_price: '1000', tax_rate: 18 }] },
  });
  check('drafts can still be edited', editDraft.status === 200 &&
    Number(editDraft.body?.data?.total) === 1180, editDraft.body?.data?.total);

  // ── 4 ── payments ───────────────────────────────────────────────────────
  step(4, 'Partial payment, then settlement');
  const partial = await call('/invoicing/payments', {
    method: 'POST',
    body: {
      amount: '50000', method: 'upi', reference: 'UPI-001',
      allocations: [{ invoice_id: intra.body.data.id, amount: '50000' }],
    },
  });
  check('payment recorded', partial.status === 201, `status ${partial.status}`);
  check('invoice becomes partially paid',
    partial.body?.data?.settled?.[0]?.status === 'partially_paid',
    partial.body?.data?.settled?.[0]?.status);
  check('balance is right', Number(partial.body?.data?.settled?.[0]?.amount_due) === 68000,
    partial.body?.data?.settled?.[0]?.amount_due);

  const over = await call('/invoicing/payments', {
    method: 'POST',
    body: { amount: '200000', allocations: [{ invoice_id: intra.body.data.id, amount: '200000' }] },
  });
  check('cannot allocate more than is outstanding', over.status === 400, `status ${over.status}`);

  const rest = await call('/invoicing/payments', {
    method: 'POST',
    body: {
      amount: '68000', method: 'bank_transfer',
      allocations: [{ invoice_id: intra.body.data.id, amount: '68000' }],
    },
  });
  check('invoice settles fully', rest.body?.data?.settled?.[0]?.status === 'paid',
    rest.body?.data?.settled?.[0]?.status);
  check('nothing left due', Number(rest.body?.data?.settled?.[0]?.amount_due) === 0);

  const voidPaid = await call(`/invoicing/invoices/${intra.body.data.id}/void`, {
    method: 'POST', body: { reason: 'test' },
  });
  check('a paid invoice cannot be voided', voidPaid.status === 400, `status ${voidPaid.status}`);

  // ── 5 ── the cross-app workflow ─────────────────────────────────────────
  step(5, 'Winning a deal in CRM raises an invoice here');
  const lead = await call('/crm/leads', {
    method: 'POST',
    body: {
      first_name: 'Anil', last_name: 'Verma', company_name: 'Crestwood Industries',
      email: 'anil@crestwood.test', estimated_value: '275000.00',
    },
  });
  const converted = await call(`/crm/leads/${lead.body.data.id}/convert`, {
    method: 'POST',
    body: { create_deal: true, deal_title: 'Crestwood — annual contract', deal_value: '275000.00' },
  });
  check('deal created in CRM', Boolean(converted.body?.data?.deal_id));

  await settle(2500);
  const projected = await call('/invoicing/customers');
  check('CRM customer projected into invoicing',
    projected.body?.data?.some((x) => x.name === 'Crestwood Industries'),
    projected.body?.data?.map((x) => x.name).join(', '));

  const board = await call('/crm/pipeline');
  const wonStage = board.body?.data?.columns?.find((s) => s.kind === 'won');
  const won = await call(`/crm/deals/${converted.body.data.deal_id}/move`, {
    method: 'POST', body: { stage_id: wonStage.id },
  });
  check('deal marked won', won.body?.data?.status === 'won');

  await settle(3000);
  const afterWin = await call('/invoicing/invoices', { method: 'GET' });
  const auto = afterWin.body?.data?.find((i) => i.source === 'deal_won');
  check('a draft invoice appeared, with no direct call from CRM', Boolean(auto),
    `${afterWin.body?.data?.length} invoices`);
  check('it carries the deal value plus tax', auto && Number(auto.total) === 324500,
    auto?.total);
  check('it is a draft, awaiting review', auto?.status === 'draft', auto?.status);
  check('it is traceable to the deal', auto?.source_ref === converted.body.data.deal_id);

  // ── 6 ── redelivery is harmless ─────────────────────────────────────────
  step(6, 'At-least-once delivery does not double-bill');
  const stageBefore = won.body?.data?.stage_id;
  const openStage = board.body?.data?.columns?.find((s) => s.kind === 'open');
  await call(`/crm/deals/${converted.body.data.deal_id}/move`, {
    method: 'POST', body: { stage_id: openStage.id },
  });
  await call(`/crm/deals/${converted.body.data.deal_id}/move`, {
    method: 'POST', body: { stage_id: wonStage.id },
  });
  await settle(3000);

  const afterRewin = await call('/invoicing/invoices');
  const autoCount = afterRewin.body?.data?.filter((i) => i.source === 'deal_won').length ?? 0;
  check('winning the same deal twice raises one invoice', autoCount === 1,
    `${autoCount} deal-won invoices`);

  // ── 7 ── ageing ─────────────────────────────────────────────────────────
  step(7, 'Receivables ageing');
  const ageing = await call('/invoicing/ageing');
  check('ageing report loads', ageing.status === 200);
  check('outstanding bucketed', Number(ageing.body?.data?.total) === 118000,
    `₹${ageing.body?.data?.total} outstanding`);
  check('grouped by customer', (ageing.body?.data?.by_customer?.length ?? 0) >= 1);

  const overdue = await call('/invoicing/invoices/mark-overdue', { method: 'POST' });
  check('overdue sweep runs', overdue.status === 200, `${overdue.body?.data?.marked_overdue} marked`);

  // ── 8 ── isolation ──────────────────────────────────────────────────────
  // ── 8 ── the document and its design ────────────────────────────────────
  step(8, 'The invoice as a document');

  const designs = await call('/invoicing/templates');
  check('a default design exists without configuring one',
    designs.body?.data?.some((t) => t.is_default),
    JSON.stringify(designs.body?.error ?? designs.body?.data ?? '').slice(0, 140));

  const standard = designs.body.data.find((t) => t.is_default);

  const branded = await call('/invoicing/templates', {
    method: 'POST',
    body: {
      name: 'Bold', layout: 'modern', accent: '#0f766e',
      seller_name: 'Meridian Works LLP', seller_gstin: '27AABCM1234N1Z5',
      bank_name: 'HDFC Bank', bank_account: '50100123456789', bank_ifsc: 'HDFC0001234',
      show_hsn: false, footer_note: 'Built in Kolhapur.',
    },
  });
  check('a second design can be created', branded.status === 201,
    JSON.stringify(branded.body?.error ?? '').slice(0, 140));

  const dupeDesign = await call('/invoicing/templates', { method: 'POST', body: { name: 'bold' } });
  check('duplicate design name refused', dupeDesign.status === 409, `status ${dupeDesign.status}`);

  const clearDefault = await call(`/invoicing/templates/${standard.id}`, {
    method: 'PATCH', body: { is_default: false },
  });
  check('the last default design cannot be cleared', clearDefault.status === 400,
    `status ${clearDefault.status}`);

  const doc = await call(`/invoicing/invoices/${intra.body.data.id}/document`);
  check('the document loads', doc.status === 200,
    JSON.stringify(doc.body?.error ?? '').slice(0, 140));
  check('it carries the invoice, its lines and a design',
    Boolean(doc.body?.data?.invoice && doc.body?.data?.lines?.length && doc.body?.data?.template),
    JSON.stringify(Object.keys(doc.body?.data ?? {})));
  check('the amount is written out in words',
    /rupees/i.test(doc.body?.data?.amount_in_words ?? ''), doc.body?.data?.amount_in_words);
  check('tax is grouped by rate, as a GST invoice must present it',
    doc.body?.data?.tax_groups?.length > 0,
    JSON.stringify(doc.body?.data?.tax_groups));

  const group = doc.body.data.tax_groups[0];
  check('each rate group reconstitutes its own tax exactly',
    (Number(group.cgst) + Number(group.sgst) + Number(group.igst)).toFixed(2) === Number(group.total).toFixed(2),
    `${group.cgst} + ${group.sgst} + ${group.igst} ≠ ${group.total}`);

  check('an issued invoice is stamped with the design it went out under',
    doc.body?.data?.invoice?.template_id === standard.id,
    `${doc.body?.data?.invoice?.template_id} vs ${standard.id}`);

  // Rebranding must not rewrite an invoice the customer already holds.
  await call(`/invoicing/templates/${branded.body.data.id}`, {
    method: 'PATCH', body: { is_default: true },
  });

  const reread = await call(`/invoicing/invoices/${intra.body.data.id}/document`);
  check('changing the default does not restyle an invoice already sent',
    reread.body?.data?.template?.id === standard.id,
    `rendered with ${reread.body?.data?.template?.name}`);

  const preview = await call(
    `/invoicing/invoices/${intra.body.data.id}/document?template_id=${branded.body.data.id}`,
  );
  check('but it can still be previewed under another design',
    preview.body?.data?.template?.layout === 'modern' && preview.body?.data?.template?.show_hsn === false,
    JSON.stringify({ layout: preview.body?.data?.template?.layout }));
  check('previewing does not change what the invoice was issued under',
    preview.body?.data?.invoice?.template_id === standard.id);

  const newInvoice = await call('/invoicing/invoices', {
    method: 'POST',
    body: { customer_name: 'Later Co', lines: [{ description: 'y', unit_price: '500', tax_rate: 18 }] },
  });
  const laterIssued = await call(`/invoicing/invoices/${newInvoice.body.data.id}/issue`, { method: 'POST' });
  check('an invoice issued afterwards picks up the new default design',
    laterIssued.body?.data?.template_id === branded.body.data.id,
    `${laterIssued.body?.data?.template_id}`);

  const removeDefault = await call(`/invoicing/templates/${branded.body.data.id}`, { method: 'DELETE' });
  check('the default design cannot be deleted', removeDefault.status === 400,
    `status ${removeDefault.status}`);

  step(9, 'Tenant isolation');
  await call('/auth/logout', { method: 'POST' });
  cookies = '';
  await call('/auth/register', {
    method: 'POST',
    body: { email: `invother+${stamp}@nexus.test`, password: 'correct-horse-battery-7', name: 'Other' },
  });
  await call('/organizations', { method: 'POST', body: { name: `Other Inv ${stamp}` } });
  await call('/auth/refresh', { method: 'POST', body: {} });
  await call('/subscriptions', {
    method: 'POST', body: { plan: 'growth', app_slugs: ['invoicing'], seats: 5, cycle: 'monthly' },
  });
  await settle(1500);

  const leak = await call('/invoicing/invoices');
  check('a new workspace sees no other tenant’s invoices',
    (leak.body?.data?.length ?? -1) === 0, `${leak.body?.data?.length} visible`);

  const leakRead = await call(`/invoicing/invoices/${intra.body.data.id}`);
  check('cannot read another tenant’s invoice', leakRead.status === 404, `status ${leakRead.status}`);

  const leakDesigns = await call('/invoicing/templates');
  check('a new workspace gets its own design, not the other tenant’s',
    leakDesigns.body?.data?.length === 1 && !leakDesigns.body.data.some((t) => t.name === 'Bold'),
    leakDesigns.body?.data?.map((t) => t.name).join(', '));

  const leakDoc = await call(`/invoicing/invoices/${intra.body.data.id}/document`);
  check('cannot render another tenant’s invoice as a document',
    leakDoc.status === 404, `status ${leakDoc.status}`);

  const freshNumber = await call('/invoicing/invoices', {
    method: 'POST',
    body: { customer_name: 'Fresh Co', lines: [{ description: 'x', unit_price: '100', tax_rate: 18 }] },
  });
  const freshIssued = await call(`/invoicing/invoices/${freshNumber.body.data.id}/issue`, { method: 'POST' });
  check('each workspace has its own number sequence',
    freshIssued.body?.data?.number?.endsWith('/0001'), freshIssued.body?.data?.number);

  console.log('');
  if (failures === 0) {
    console.log(c.ok(c.bold('  ✔ everything passed\n')));
    process.exit(0);
  }
  console.log(c.bad(c.bold(`  ✘ ${failures} check${failures === 1 ? '' : 's'} failed\n`)));
  process.exit(1);
}

main().catch((error) => {
  console.error(`\n  ${c.bad('invoicing smoke crashed:')} ${error.stack}\n`);
  process.exit(1);
});
