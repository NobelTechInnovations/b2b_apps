#!/usr/bin/env node
/**
 * Documents end-to-end check.
 *
 * Builds a real, deliberately messy .xlsx — a title row above the headers,
 * Indian date formats, rupee-formatted money, a duplicate, a bad email —
 * uploads it, and drives the import wizard all the way into HR and CRM.
 */
import ExcelJS from 'exceljs';

const GATEWAY = process.env.API_URL ?? 'http://localhost:4000';

let cookies = '';
let failures = 0;

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function absorb(response) {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const [name] = pair.split('=');
    cookies = [...cookies.split('; ').filter((x) => x && !x.startsWith(`${name}=`)), pair].join('; ');
  }
}

async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${GATEWAY}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: cookies },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  absorb(response);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function upload(buffer, filename) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  const response = await fetch(`${GATEWAY}/api/documents/upload`, {
    method: 'POST', headers: { cookie: cookies }, body: form,
  });
  absorb(response);
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

/** A workbook that looks like something a customer would actually send. */
async function buildEmployeeWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Staff List');

  // Junk above the headers — exports almost always have this.
  sheet.addRow(['Acme Manufacturing — Staff Register']);
  sheet.addRow([]);
  sheet.addRow(['Emp ID', 'Employee Name', 'Surname', 'Official Email', 'Mobile', 'DOJ', 'Designation', 'Dept', 'Type']);

  sheet.addRow(['A-100', 'Rohan', 'Mehta', 'rohan@acme.test', '+91 98200 11111', '01/04/2024', 'Plant Head', 'Production', 'Full Time']);
  sheet.addRow(['A-101', 'Divya', 'Shah', 'divya@acme.test', '9820022222', '15/06/2025', 'QA Lead', 'Quality', 'Full Time']);
  sheet.addRow(['A-102', 'Imran', 'Sheikh', 'imran@acme.test', '+91 98200 33333', '02/01/2026', 'Machinist', 'Production', 'Contract']);
  sheet.addRow(['A-103', 'Neha', 'Iyer', 'not-an-email', '9820044444', '10/02/2026', 'Planner', 'Production', 'Full Time']);
  sheet.addRow(['A-104', '', 'Kulkarni', 'blank@acme.test', '9820055555', '11/02/2026', 'Operator', 'Production', 'Full Time']);
  sheet.addRow(['A-105', 'Rohan', 'Duplicate', 'rohan@acme.test', '9820066666', '12/02/2026', 'Operator', 'Production', 'Full Time']);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function buildLeadWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Q3 Leads');
  sheet.addRow(['Contact Name', 'Organisation', 'Email Address', 'Telephone', 'Deal Size', 'Lead Source', 'Priority']);
  sheet.addRow(['Ayesha', 'Zenith Foods', 'ayesha@zenith.test', '+91 99000 11111', '₹ 12,50,000', 'Referral', 'Hot']);
  sheet.addRow(['Karan', 'Vertex Labs', 'karan@vertex.test', '9900022222', '450000', 'Website', 'Warm']);
  sheet.addRow(['Meera', 'Orbit Retail', 'meera@orbit.test', '9900033333', '₹ 89,999.50', 'Event', 'Cold']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function main() {
  const stamp = Date.now();
  console.log(c.bold('\n  Documents smoke test\n'));

  step(0, 'Workspace with Documents, HR and CRM');
  const reg = await call('/auth/register', {
    method: 'POST',
    body: { email: `docs+${stamp}@nexus.test`, password: 'correct-horse-battery-7', name: 'Docs Tester' },
  });
  check('registered', reg.status === 201, `status ${reg.status}`);

  await call('/organizations', { method: 'POST', body: { name: `Acme Manufacturing ${stamp}` } });
  await call('/auth/refresh', { method: 'POST', body: {} });
  const sub = await call('/subscriptions', {
    method: 'POST',
    body: { plan: 'growth', app_slugs: ['documents', 'hr', 'crm'], seats: 25, cycle: 'monthly' },
  });
  check('subscribed', sub.status === 201, `status ${sub.status}`);
  await new Promise((r) => setTimeout(r, 1800));

  // ── 1 ── folders and upload ─────────────────────────────────────────────
  step(1, 'Upload a spreadsheet');
  const folder = await call('/documents/folders', { method: 'POST', body: { name: 'HR Imports' } });
  check('folder created', folder.status === 201, `status ${folder.status}`);

  const xlsx = await buildEmployeeWorkbook();
  const uploaded = await upload(xlsx, 'staff-register.xlsx');
  check('upload accepted', uploaded.status === 201, `status ${uploaded.status}`);
  const documentId = uploaded.body?.data?.id;
  check('classified as a spreadsheet', uploaded.body?.data?.kind === 'spreadsheet',
    uploaded.body?.data?.kind);
  check('workbook profiled on upload', uploaded.body?.data?.sheets === 1,
    `${uploaded.body?.data?.sheets} sheet(s)`);
  check('marked importable', uploaded.body?.data?.importable === true);

  // ── 2 ── deduplication ──────────────────────────────────────────────────
  step(2, 'Identical bytes are stored once');
  const again = await upload(xlsx, 'staff-register-copy.xlsx');
  check('second upload accepted', again.status === 201);
  check('content deduplicated', again.body?.data?.deduplicated === true);

  const list = await call('/documents');
  check('both documents listed', (list.body?.data?.length ?? 0) === 2,
    `${list.body?.data?.length} documents`);
  check('storage counted once', list.body?.meta?.storage?.blobs === 1,
    `${list.body?.meta?.storage?.blobs} unique blob(s)`);

  // ── 3 ── header detection and profiling ─────────────────────────────────
  step(3, 'Header detection and column profiling');
  const detail = await call(`/documents/${documentId}`);
  const sheets = detail.body?.data?.sheets ?? [];
  check('sheet named correctly', sheets[0]?.name === 'Staff List', sheets[0]?.name);
  check('title rows skipped, 6 data rows found', sheets[0]?.total_rows === 6,
    `${sheets[0]?.total_rows} rows`);

  const analysis = await call(`/documents/${documentId}/import/analyse`, {
    method: 'POST', body: { target_key: 'hr.employees' },
  });
  check('analysis succeeded', analysis.status === 200, `status ${analysis.status}`);
  check('header row detected below the title', analysis.body?.data?.sheet?.header_row === 1,
    `row index ${analysis.body?.data?.sheet?.header_row}`);

  const mapping = analysis.body?.data?.suggested_mapping ?? {};
  check('messy headers auto-mapped', mapping['Official Email'] === 'email' && mapping['DOJ'] === 'joined_on',
    JSON.stringify(mapping));
  check('required field covered', (analysis.body?.data?.missing_required?.length ?? 1) === 0);

  const emailColumn = analysis.body?.data?.sheet?.columns?.find((col) => col.header === 'Official Email');
  check('email column typed', emailColumn?.type === 'email', emailColumn?.type);
  const codeColumn = analysis.body?.data?.sheet?.columns?.find((col) => col.header === 'Emp ID');
  check('unique column flagged', codeColumn?.unique === true);

  // ── 4 ── dry run ────────────────────────────────────────────────────────
  step(4, 'Dry run catches the bad rows');
  const validated = await call(`/documents/${documentId}/import/validate`, {
    method: 'POST', body: { target_key: 'hr.employees', mapping },
  });
  check('validation ran', validated.status === 200, `status ${validated.status}`);
  const summary = validated.body?.data?.summary;
  check('all 6 rows examined', summary?.total === 6, `${summary?.total}`);
  check('bad email rejected', summary?.errors === 2,
    `${summary?.errors} errors (expect bad email + blank name)`);
  check('in-file duplicate flagged', summary?.will_skip === 1, `${summary?.will_skip} skip`);
  check('4 rows will be created', summary?.will_create === 3,
    `${summary?.will_create} create`);

  const jobId = validated.body?.data?.job_id;
  check('draft job saved', Boolean(jobId));

  // ── 5 ── execute into HR ────────────────────────────────────────────────
  step(5, 'Import into HR');
  const executed = await call(`/documents/import/${jobId}/execute`, {
    method: 'POST', body: { skip_errors: true },
  });
  check('import ran', executed.status === 200, `status ${executed.status}`);
  check('employees created', executed.body?.data?.created === 3,
    `${executed.body?.data?.created} created`);

  const employees = await call('/hr/employees');
  check('employees visible in HR', (employees.body?.data?.length ?? 0) === 3,
    `${employees.body?.data?.length} in HR`);

  const rohan = employees.body?.data?.find((e) => e.email === 'rohan@acme.test');
  check('Indian date parsed day-first', rohan?.joined_on === '2024-04-01', rohan?.joined_on);
  check('sheet employee code honoured', rohan?.employee_code === 'A-100', rohan?.employee_code);
  check('phone normalised', rohan?.phone === '+919820011111', rohan?.phone);

  const departments = await call('/hr/departments');
  check('named departments created', (departments.body?.data?.length ?? 0) === 2,
    departments.body?.data?.map((d) => d.name).join(', '));

  const balances = await call(`/hr/leave-balances/${rohan.id}`);
  check('imported employee got leave balances', (balances.body?.data?.length ?? 0) === 4,
    `${balances.body?.data?.length} types`);

  const contract = employees.body?.data?.find((e) => e.email === 'imran@acme.test');
  check('enum label coerced', contract?.employment_type === 'contract', contract?.employment_type);

  // ── 6 ── re-running updates rather than duplicating ─────────────────────
  step(6, 'Re-import updates instead of duplicating');
  const revalidate = await call(`/documents/${documentId}/import/validate`, {
    method: 'POST', body: { target_key: 'hr.employees', mapping },
  });
  check('existing rows detected as updates', revalidate.body?.data?.summary?.will_update === 3,
    `${revalidate.body?.data?.summary?.will_update} updates`);

  const rerun = await call(`/documents/import/${revalidate.body?.data?.job_id}/execute`, {
    method: 'POST', body: { skip_errors: true },
  });
  check('re-run updated, did not duplicate', rerun.body?.data?.updated === 3,
    `${rerun.body?.data?.updated} updated, ${rerun.body?.data?.created} created`);

  const afterRerun = await call('/hr/employees');
  check('headcount unchanged', (afterRerun.body?.data?.length ?? 0) === 3,
    `${afterRerun.body?.data?.length} employees`);

  // ── 7 ── a different target, same engine ────────────────────────────────
  step(7, 'Same engine, different app');
  const leadsFile = await upload(await buildLeadWorkbook(), 'q3-leads.xlsx');
  const leadDoc = leadsFile.body?.data?.id;

  const leadAnalysis = await call(`/documents/${leadDoc}/import/analyse`, {
    method: 'POST', body: { target_key: 'crm.leads' },
  });
  check('lead headers auto-mapped',
    leadAnalysis.body?.data?.suggested_mapping?.['Organisation'] === 'company_name',
    JSON.stringify(leadAnalysis.body?.data?.suggested_mapping));

  const leadValidated = await call(`/documents/${leadDoc}/import/validate`, {
    method: 'POST',
    body: { target_key: 'crm.leads', mapping: leadAnalysis.body?.data?.suggested_mapping },
  });
  check('all lead rows valid', leadValidated.body?.data?.summary?.errors === 0,
    `${leadValidated.body?.data?.summary?.errors} errors`);

  const leadRun = await call(`/documents/import/${leadValidated.body?.data?.job_id}/execute`, {
    method: 'POST', body: {},
  });
  check('leads imported', leadRun.body?.data?.created === 3, `${leadRun.body?.data?.created}`);

  const leads = await call('/crm/leads');
  const ayesha = leads.body?.data?.find((l) => l.email === 'ayesha@zenith.test');
  check('rupee-formatted money parsed', Number(ayesha?.estimated_value) === 1250000,
    ayesha?.estimated_value);
  check('imported lead was scored', ayesha?.score >= 80, `score ${ayesha?.score}`);
  check('enum from label', ayesha?.rating === 'hot', ayesha?.rating);

  // ── 8 ── guards ─────────────────────────────────────────────────────────
  step(8, 'Guard rails');
  const rerunDone = await call(`/documents/import/${jobId}/execute`, { method: 'POST', body: {} });
  check('a completed job cannot run twice', rerunDone.status === 400, `status ${rerunDone.status}`);

  const pdf = await upload(Buffer.from('%PDF-1.4 not really'), 'notes.pdf');
  const notSheet = await call(`/documents/${pdf.body?.data?.id}/import/analyse`, {
    method: 'POST', body: { target_key: 'hr.employees' },
  });
  check('non-spreadsheets cannot be imported', notSheet.status === 400, `status ${notSheet.status}`);

  const targets = await call('/documents/import/targets');
  check('only entitled targets offered', (targets.body?.data?.length ?? 0) === 3,
    targets.body?.data?.map((t) => t.key).join(', '));

  // ── 9 ── isolation ──────────────────────────────────────────────────────
  step(9, 'Tenant isolation');
  await call('/auth/logout', { method: 'POST' });
  cookies = '';
  await call('/auth/register', {
    method: 'POST',
    body: { email: `docsother+${stamp}@nexus.test`, password: 'correct-horse-battery-7', name: 'Other Docs' },
  });
  await call('/organizations', { method: 'POST', body: { name: `Other Docs ${stamp}` } });
  await call('/auth/refresh', { method: 'POST', body: {} });
  await call('/subscriptions', {
    method: 'POST', body: { plan: 'growth', app_slugs: ['documents'], seats: 5, cycle: 'monthly' },
  });
  await new Promise((r) => setTimeout(r, 1500));

  const leak = await call('/documents');
  check('a new workspace sees no other tenant’s files', (leak.body?.data?.length ?? -1) === 0,
    `${leak.body?.data?.length} visible`);

  const leakRead = await call(`/documents/${documentId}`);
  check('cannot open another tenant’s document', leakRead.status === 404, `status ${leakRead.status}`);

  const leakDownload = await call(`/documents/${documentId}/download`);
  check('cannot download another tenant’s file', leakDownload.status === 404,
    `status ${leakDownload.status}`);

  console.log('');
  if (failures === 0) {
    console.log(c.ok(c.bold('  ✔ everything passed\n')));
    process.exit(0);
  }
  console.log(c.bad(c.bold(`  ✘ ${failures} check${failures === 1 ? '' : 's'} failed\n`)));
  process.exit(1);
}

main().catch((error) => {
  console.error(`\n  ${c.bad('documents smoke crashed:')} ${error.stack}\n`);
  process.exit(1);
});
