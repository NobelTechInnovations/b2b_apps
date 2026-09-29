#!/usr/bin/env node
/**
 * Time and money, end to end.
 *
 * Defines a shift, sends punches from a biometric terminal, checks that
 * overtime and short time fall out correctly, then puts a salary against the
 * person and runs a payroll — verifying that PF, ESI, PT and TDS come out at
 * the statutory figures and that the payslip adds up.
 *
 * Everything goes through the public gateway, including the device endpoint,
 * so the three gates and the device-key gate are both exercised for real.
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

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${GATEWAY}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: cookies, ...headers },
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
const money = (value) => Number(value ?? 0);

/**
 * The Nth working day back from today.
 *
 * Counting weekdays rather than nudging a calendar offset off a weekend —
 * two different offsets must never resolve to the same Friday, or every
 * punch in this test lands on one day and the arithmetic looks broken.
 */
function pastWeekday(n) {
  const d = new Date();
  let found = 0;
  while (found < n) {
    d.setDate(d.getDate() - 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) found += 1;
  }
  return d.toISOString().slice(0, 10);
}

/** An ISO instant on `date` at local `hh:mm`, which is how a terminal reports. */
function at(date, hh, mm = 0) {
  const d = new Date(`${date}T00:00:00`);
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
}

async function main() {
  const stamp = Date.now();
  console.log(c.bold('\n  Payroll & time smoke test\n'));

  // ── 0 ── a workspace with HR and payroll ────────────────────────────────
  step(0, 'Workspace with HR and Payroll');
  const reg = await call('/auth/register', {
    method: 'POST',
    body: { email: `pay+${stamp}@nexus.test`, password: 'correct-horse-battery-7', name: 'Payroll Tester' },
  });
  check('registered', reg.status === 201, `status ${reg.status}`);

  await call('/organizations', { method: 'POST', body: { name: `Kolhapur Forge ${stamp}`, size_band: '11-50' } });
  await call('/auth/refresh', { method: 'POST', body: {} });

  const sub = await call('/subscriptions', {
    method: 'POST',
    body: { plan: 'business', app_slugs: ['hr', 'payroll'], seats: 25, cycle: 'monthly' },
  });
  check('subscribed to HR + Payroll', sub.status === 201, JSON.stringify(sub.body?.error ?? '').slice(0, 120));
  await new Promise((r) => setTimeout(r, 1500));

  // ── 1 ── working hours ──────────────────────────────────────────────────
  step(1, 'Working hours');
  const shifts = await call('/hr/shifts');
  check('a default shift exists without configuring one',
    shifts.body?.data?.some((s) => s.is_default), JSON.stringify(shifts.body?.data ?? []).slice(0, 120));

  const general = shifts.body.data.find((s) => s.is_default);
  check('default shift is a standard 8-hour day', general?.paid_minutes === 480, `${general?.paid_minutes} minutes`);

  const night = await call('/hr/shifts', {
    method: 'POST',
    body: {
      name: 'Night shift', code: 'NIGHT', starts_at: '22:00', ends_at: '06:00',
      break_minutes: 30, grace_minutes: 15, working_days: [1, 2, 3, 4, 5, 6],
    },
  });
  check('night shift created', night.status === 201, `status ${night.status}`);
  check('a shift crossing midnight is 7h30m, not negative',
    night.body?.data?.paid_minutes === 450, `${night.body?.data?.paid_minutes} minutes`);
  check('crossing midnight is detected without being told',
    night.body?.data?.is_night_shift === true);

  const dupe = await call('/hr/shifts', { method: 'POST', body: { name: 'night SHIFT' } });
  check('duplicate shift name refused', dupe.status === 409, `status ${dupe.status}`);

  const preview = await call('/hr/shifts/preview', {
    method: 'POST',
    body: {
      starts_at: '09:00', ends_at: '18:00', break_minutes: 60, grace_minutes: 10,
      on_date: pastWeekday(3), check_in_at: at(pastWeekday(3), 9, 25), check_out_at: at(pastWeekday(3), 20, 0),
    },
  });
  check('preview: 09:25 arrival with 10 min grace is 15 minutes late',
    preview.body?.data?.late_minutes === 15, `${preview.body?.data?.late_minutes}`);
  check('preview: 09:25→20:00 less a 1h break is 95 minutes of overtime',
    preview.body?.data?.overtime_minutes === 95, `${preview.body?.data?.overtime_minutes}`);

  // ── 2 ── people ─────────────────────────────────────────────────────────
  step(2, 'People to pay');
  const alpha = await call('/hr/employees', {
    method: 'POST',
    body: {
      first_name: 'Rajeev', last_name: 'Kulkarni', email: `rajeev+${stamp}@nexus.test`,
      designation: 'Machine operator', joined_on: '2023-04-01',
    },
  });
  check('employee created', alpha.status === 201, JSON.stringify(alpha.body?.error ?? '').slice(0, 120));
  const alphaId = alpha.body?.data?.id;
  const alphaCode = alpha.body?.data?.employee_code;

  const beta = await call('/hr/employees', {
    method: 'POST',
    body: {
      first_name: 'Sneha', last_name: 'Pawar', email: `sneha+${stamp}@nexus.test`,
      designation: 'Quality lead', joined_on: '2022-06-15',
    },
  });
  const betaId = beta.body?.data?.id;
  check('second employee created', beta.status === 201);

  // ── 3 ── the punching machine ───────────────────────────────────────────
  step(3, 'Biometric terminal');
  const device = await call('/hr/devices', {
    method: 'POST',
    body: { name: 'Gate 1 terminal', location: 'Main gate', serial: `ZK-${stamp}`, kind: 'biometric' },
  });
  check('device registered', device.status === 201, JSON.stringify(device.body?.error ?? '').slice(0, 120));

  const deviceKey = device.body?.data?.api_key;
  check('a plaintext key is returned exactly once', typeof deviceKey === 'string' && deviceKey.startsWith('nxd_'));

  const listed = await call('/hr/devices');
  check('the key hash is never served back',
    !JSON.stringify(listed.body ?? {}).includes('api_key_hash'));
  check('only a hint of the key is stored for recognition',
    Boolean(listed.body?.data?.[0]?.api_key_hint));

  const noKey = await call('/device-sync/punches', {
    method: 'POST',
    body: { punches: [{ employee_ref: alphaCode, punched_at: new Date().toISOString() }] },
  });
  check('ingestion without a device key is rejected', noKey.status === 401, `status ${noKey.status}`);

  const badKey = await call('/device-sync/punches', {
    method: 'POST',
    headers: { 'x-device-key': 'nxd_not-a-real-key' },
    body: { punches: [{ employee_ref: alphaCode, punched_at: new Date().toISOString() }] },
  });
  check('an unknown device key is rejected', badKey.status === 401, `status ${badKey.status}`);

  // ── 4 ── punches become attendance ──────────────────────────────────────
  step(4, 'Punches become attendance');
  const dayLong = pastWeekday(3);   // 09:00 → 20:30, well over the shift
  const dayShort = pastWeekday(4);  // 10:30 → 15:00, well under it

  const ingest = await call('/device-sync/punches', {
    method: 'POST',
    headers: { 'x-device-key': deviceKey },
    body: {
      punches: [
        { employee_ref: alphaCode, punched_at: at(dayLong, 9, 0), direction: 'in' },
        { employee_ref: alphaCode, punched_at: at(dayLong, 20, 30), direction: 'out' },
        { employee_ref: alphaCode, punched_at: at(dayShort, 10, 30), direction: 'in' },
        { employee_ref: alphaCode, punched_at: at(dayShort, 15, 0), direction: 'out' },
        { employee_ref: 'CARD-9999', punched_at: at(dayLong, 9, 5), direction: 'in' },
      ],
    },
  });
  check('terminal accepted the batch', ingest.status === 200, JSON.stringify(ingest.body?.error ?? '').slice(0, 160));
  check('four punches matched by employee code', ingest.body?.data?.accepted === 5, `${ingest.body?.data?.accepted}`);
  check('an unenrolled card is parked, not dropped', ingest.body?.data?.unmatched === 1, `${ingest.body?.data?.unmatched}`);
  check('two days were rebuilt from the punches', ingest.body?.data?.days_rebuilt === 2, `${ingest.body?.data?.days_rebuilt}`);

  const replay = await call('/device-sync/punches', {
    method: 'POST',
    headers: { 'x-device-key': deviceKey },
    body: {
      punches: [
        { employee_ref: alphaCode, punched_at: at(dayLong, 9, 0), direction: 'in' },
        { employee_ref: alphaCode, punched_at: at(dayLong, 20, 30), direction: 'out' },
      ],
    },
  });
  check('a replayed buffer creates no duplicates',
    replay.body?.data?.duplicate === 2 && replay.body?.data?.accepted === 0,
    JSON.stringify(replay.body?.data));

  const log = await call(`/hr/attendance?employee_id=${alphaId}&from=${dayShort}&to=${dayLong}`);
  const longDay = log.body?.data?.find((r) => r.on_date === dayLong);
  const shortDay = log.body?.data?.find((r) => r.on_date === dayShort);

  check('the long day is 10h30m worked (1h break deducted)',
    longDay?.work_minutes === 630, `${longDay?.work_minutes} minutes`);
  check('the long day yields 2h30m of overtime',
    longDay?.overtime_minutes === 150, `${longDay?.overtime_minutes} minutes`);
  check('the long day records no shortfall', longDay?.shortfall_minutes === 0);
  check('the short day is 3h30m worked', shortDay?.work_minutes === 210, `${shortDay?.work_minutes}`);
  check('the short day is 4h30m short', shortDay?.shortfall_minutes === 270, `${shortDay?.shortfall_minutes}`);
  check('the short day is marked half day, not present',
    shortDay?.status === 'half_day', shortDay?.status);
  check('arriving at 10:30 is 80 minutes late', shortDay?.late_minutes === 80, `${shortDay?.late_minutes}`);
  check('attendance knows it came from a device', longDay?.source === 'device', longDay?.source);

  // ── 5 ── enrolling a card adopts its history ────────────────────────────
  step(5, 'Late enrolment');
  const enrol = await call('/hr/devices/identities', {
    method: 'POST',
    body: { employee_ref: 'CARD-9999', employee_id: betaId },
  });
  check('card mapped to a person', enrol.status === 201, JSON.stringify(enrol.body?.error ?? '').slice(0, 120));
  check('the punch that arrived before the mapping is adopted',
    enrol.body?.data?.punches === 1, `${enrol.body?.data?.punches}`);

  const orphans = await call('/hr/punches?status=unmatched');
  check('no punches are left unmatched', (orphans.body?.data?.length ?? -1) === 0);

  // ── 6 ── the overtime report ────────────────────────────────────────────
  step(6, 'Overtime report');
  const report = await call(`/hr/attendance/overtime?from=${dayShort}&to=${dayLong}`);
  const rajeev = report.body?.data?.find((r) => r.employee_id === alphaId);
  check('report totals the month per person',
    rajeev?.overtime_minutes === 150 && rajeev?.shortfall_minutes === 270,
    JSON.stringify({ ot: rajeev?.overtime_minutes, short: rajeev?.shortfall_minutes }));
  check('net time is overtime less shortfall, not just overtime',
    rajeev?.net_minutes === -120, `${rajeev?.net_minutes}`);
  check('hours are formatted for reading', rajeev?.overtime_hours === '2h 30m', rajeev?.overtime_hours);

  // ── 7 ── salary structure ───────────────────────────────────────────────
  step(7, 'Salary structure');
  const structures = await call('/payroll/structures');
  check('a standard structure exists out of the box',
    structures.body?.data?.some((s) => s.is_default), JSON.stringify(structures.body?.error ?? '').slice(0, 160));
  const standard = structures.body?.data?.find((s) => s.is_default);
  check('the standard structure has five components',
    standard?.component_count === 5, `${standard?.component_count}`);

  const breakdown = await call(`/payroll/structures/${standard.id}/breakdown`, {
    method: 'POST', body: { monthly_gross: '50000' },
  });
  const lines = breakdown.body?.data?.lines ?? [];
  const find = (code) => money(lines.find((l) => l.code === code)?.amount);
  check('basic is 50% of gross', find('BASIC') === 25000, `${find('BASIC')}`);
  check('HRA is 40% of basic', find('HRA') === 10000, `${find('HRA')}`);
  check('special allowance absorbs the remainder',
    find('SPECIAL') === 50000 - 25000 - 10000 - 1600 - 1250, `${find('SPECIAL')}`);
  check('the components add up to gross exactly',
    lines.reduce((sum, l) => sum + money(l.amount), 0) === 50000,
    `${lines.reduce((sum, l) => sum + money(l.amount), 0)}`);

  // ── 8 ── recording a salary ─────────────────────────────────────────────
  step(8, 'Recording a salary');
  const unpaid = await call('/payroll/salaries');
  check('everyone starts off payroll', unpaid.body?.meta?.on_payroll === 0, `${unpaid.body?.meta?.on_payroll}`);
  check('the roster comes from HR, not from payroll',
    unpaid.body?.data?.length === 2, `${unpaid.body?.data?.length}`);

  const salary = await call('/payroll/salaries', {
    method: 'POST',
    body: {
      employee_id: alphaId, monthly_gross: '50000',
      pan: 'ABCDE1234F', uan: '100200300400',
      bank_account: '50100123456789', bank_ifsc: 'HDFC0001234', bank_name: 'HDFC Bank',
      effective_from: '2024-04-01',
    },
  });
  check('salary recorded', salary.status === 201, JSON.stringify(salary.body?.error ?? '').slice(0, 160));

  await call('/payroll/salaries', {
    method: 'POST',
    body: {
      employee_id: betaId, monthly_gross: '18000', effective_from: '2024-04-01',
      bank_account: '50100987654321', bank_ifsc: 'HDFC0001234',
    },
  });

  const senior = await call('/hr/employees', {
    method: 'POST',
    body: {
      first_name: 'Vikram', last_name: 'Shetty', email: `vikram+${stamp}@nexus.test`,
      designation: 'Plant head', joined_on: '2021-08-02',
    },
  });
  const lateId = senior.body?.data?.id;
  await call('/payroll/salaries', {
    method: 'POST',
    body: {
      employee_id: lateId, monthly_gross: '180000', effective_from: '2024-04-01',
      pan: 'ZZZZZ9999Z', bank_account: '50100555555555', bank_ifsc: 'HDFC0001234',
    },
  });

  const raise = await call('/payroll/salaries', {
    method: 'POST',
    body: {
      employee_id: alphaId, monthly_gross: '60000',
      effective_from: '2025-04-01', revision_note: 'Annual increment',
    },
  });
  check('a raise is accepted', raise.status === 201, `status ${raise.status}`);

  const history = await call(`/payroll/salaries/${alphaId}`);
  check('the previous salary is kept, not overwritten',
    history.body?.data?.history?.length === 2, `${history.body?.data?.history?.length}`);
  check('the old row was closed the day before the new one',
    history.body?.data?.history?.[1]?.effective_to === '2025-03-31',
    history.body?.data?.history?.[1]?.effective_to);
  check('the raise is reported as a percentage',
    history.body?.data?.current?.change_percent === 20, `${history.body?.data?.current?.change_percent}`);
  check('a PAN typed once carries into the revision',
    history.body?.data?.current?.pan === 'ABCDE1234F', history.body?.data?.current?.pan);

  // ── 9 ── a payroll run ──────────────────────────────────────────────────
  step(9, 'Running payroll');
  const now = new Date();
  const runMonth = now.getMonth() === 0 ? 12 : now.getMonth();
  const runYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();

  const run = await call('/payroll/runs', { method: 'POST', body: { year: runYear, month: runMonth } });
  check('run created', run.status === 201, JSON.stringify(run.body?.error ?? '').slice(0, 160));
  const runId = run.body?.data?.id;

  const again = await call('/payroll/runs', { method: 'POST', body: { year: runYear, month: runMonth } });
  check('the same month cannot be run twice', again.status === 409, `status ${again.status}`);

  // Hired, but nobody has recorded what they earn yet.
  const pending = await call('/hr/employees', {
    method: 'POST',
    body: {
      first_name: 'Meera', last_name: 'Joshi', email: `meera+${stamp}@nexus.test`,
      designation: 'Trainee', joined_on: '2023-01-09',
    },
  });
  const pendingId = pending.body?.data?.id;

  const processed = await call(`/payroll/runs/${runId}/process`, { method: 'POST', body: {} });
  check('run processed', processed.status === 200, JSON.stringify(processed.body?.error ?? '').slice(0, 200));
  check('all three salaried people were paid', processed.body?.meta?.processed === 3, `${processed.body?.meta?.processed}`);
  check('processing moves the run to review',
    processed.body?.data?.status === 'review', processed.body?.data?.status);
  check('somebody with no salary is named, not silently skipped',
    processed.body?.meta?.skipped?.some((r) => r.employee_id === pendingId && /salary/i.test(r.reason)),
    JSON.stringify(processed.body?.meta?.skipped));

  const reprocessed = await call(`/payroll/runs/${runId}/process`, { method: 'POST', body: {} });
  check('re-processing replaces rather than duplicates',
    reprocessed.body?.meta?.processed === 3 && money(reprocessed.body?.data?.net_total) === money(processed.body?.data?.net_total),
    `${reprocessed.body?.meta?.processed} slips, net ${reprocessed.body?.data?.net_total}`);

  // ── 10 ── the statutory arithmetic ──────────────────────────────────────
  step(10, 'Statutory deductions');
  const detail = await call(`/payroll/runs/${runId}`);
  const slipRow = detail.body?.data?.payslips?.find((p) => p.employee_id === alphaId);
  check('a payslip exists for the operator', Boolean(slipRow), JSON.stringify(detail.body?.error ?? '').slice(0, 120));

  const slip = await call(`/payroll/payslips/${slipRow.id}`);
  const line = (code) => money(slip.body?.data?.deductions?.find((l) => l.code === code)?.amount);
  const earn = (code) => money(slip.body?.data?.earnings?.find((l) => l.code === code)?.amount);
  const employer = (code) => money(slip.body?.data?.employer?.find((l) => l.code === code)?.amount);

  check('basic is 50% of the ₹60,000 gross', earn('BASIC') === 30000, `${earn('BASIC')}`);
  check('PF is 12% of the ₹15,000 ceiling, not of actual basic',
    line('PF') === 1800, `${line('PF')}`);
  check('the employer pension share is 8.33% of the ceiling',
    employer('EPS') === 1249.50, `${employer('EPS')}`);
  check('employer PF is the 12% less what went to pension',
    employer('PF_ER') === 550.50, `${employer('PF_ER')}`);
  check('ESI does not apply above the ₹21,000 ceiling', line('ESI') === 0, `${line('ESI')}`);
  check('Maharashtra professional tax is ₹200', line('PT') === 200, `${line('PT')}`);
  check('no TDS at ₹7.2L — the 87A rebate covers it', line('TDS') === 0, `${line('TDS')}`);

  check('gross less deductions equals net',
    money(slip.body?.data?.gross_earnings) - money(slip.body?.data?.total_deductions)
      === money(slip.body?.data?.net_pay),
    `${slip.body?.data?.gross_earnings} - ${slip.body?.data?.total_deductions} ≠ ${slip.body?.data?.net_pay}`);
  check('every earning line is shown with its working',
    slip.body?.data?.earnings?.every((l) => l.basis));
  check('the net is written out in words',
    /rupees/i.test(slip.body?.data?.net_pay_words ?? ''), slip.body?.data?.net_pay_words);
  check('the snapshot carries the name, not a join',
    slip.body?.data?.employee_name === 'Rajeev Kulkarni', slip.body?.data?.employee_name);

  // ₹21.6L a year is well past the rebate, so tax must actually be deducted.
  const seniorRow = detail.body?.data?.payslips?.find((p) => p.employee_id === lateId);
  const seniorSlip = await call(`/payroll/payslips/${seniorRow.id}`);
  const sLine = (code) => money(seniorSlip.body?.data?.deductions?.find((l) => l.code === code)?.amount);
  check('TDS is deducted on a ₹21.6L salary', sLine('TDS') > 0, `${sLine('TDS')}`);
  check('the payslip shows how the tax was arrived at',
    /annual on/.test(seniorSlip.body?.data?.deductions?.find((l) => l.code === 'TDS')?.basis ?? ''),
    seniorSlip.body?.data?.deductions?.find((l) => l.code === 'TDS')?.basis);

  const juniorRow = detail.body?.data?.payslips?.find((p) => p.employee_id === betaId);
  const junior = await call(`/payroll/payslips/${juniorRow.id}`);
  const jLine = (code) => money(junior.body?.data?.deductions?.find((l) => l.code === code)?.amount);
  check('ESI does apply below the ceiling — 0.75% of ₹18,000',
    jLine('ESI') === 135, `${jLine('ESI')}`);
  check('no TDS on a salary below the rebate limit', jLine('TDS') === 0, `${jLine('TDS')}`);

  // ── 11 ── approval and payment ──────────────────────────────────────────
  step(11, 'Approval');
  const early = await call(`/payroll/runs/${runId}/bank-advice`);
  check('no bank advice before approval', early.status === 400, `status ${early.status}`);

  const skip = await call(`/payroll/runs/${runId}/status`, { method: 'POST', body: { status: 'paid' } });
  check('a run cannot jump straight from review to paid', skip.status === 400, `status ${skip.status}`);

  const approved = await call(`/payroll/runs/${runId}/status`, { method: 'POST', body: { status: 'approved' } });
  check('run approved', approved.body?.data?.status === 'approved', JSON.stringify(approved.body?.error ?? '').slice(0, 120));

  const advice = await call(`/payroll/runs/${runId}/bank-advice`);
  check('bank advice lists everyone with a bank account', advice.body?.data?.length === 3, `${advice.body?.data?.length}`);
  check('the advice total matches the run net',
    money(advice.body?.meta?.total) === money(approved.body?.data?.net_total),
    `${advice.body?.meta?.total} vs ${approved.body?.data?.net_total}`);

  const hold = await call(`/payroll/payslips/${juniorRow.id}/hold`, {
    method: 'POST', body: { reason: 'Bank details unconfirmed' },
  });
  check('a payslip can be held', hold.body?.data?.status === 'held', hold.body?.data?.status);

  const afterHold = await call(`/payroll/runs/${runId}/bank-advice`);
  check('a held payslip drops out of the bank advice',
    afterHold.body?.data?.length === 2, `${afterHold.body?.data?.length}`);

  const paid = await call(`/payroll/runs/${runId}/status`, { method: 'POST', body: { status: 'paid' } });
  check('run marked paid', paid.body?.data?.status === 'paid');

  const reopen = await call(`/payroll/runs/${runId}/status`, { method: 'POST', body: { status: 'review' } });
  check('a paid run cannot be reopened', reopen.status === 400, `status ${reopen.status}`);

  // ── 12 ── the register and the returns ──────────────────────────────────
  step(12, 'Register and statutory returns');
  const register = await call(`/payroll/runs/${runId}/register`);
  check('the register has one row per person', register.body?.data?.length === 3, `${register.body?.data?.length}`);
  check('component columns are discovered, not hard-coded',
    register.body?.meta?.columns?.earnings?.some((col) => col.code === 'SPECIAL'),
    JSON.stringify(register.body?.meta?.columns?.earnings));
  check('column totals tie to the run total',
    money(register.body?.meta?.totals?.net) === money(paid.body?.data?.net_total),
    `${register.body?.meta?.totals?.net} vs ${paid.body?.data?.net_total}`);

  const statutory = await call(`/payroll/reports/statutory?run_id=${runId}`);
  // Two people are capped at the ₹15,000 ceiling (₹1,800 each); Sneha's basic
  // is ₹9,000, below it, so she contributes 12% of the actual ₹9,000.
  check('the PF return sums the capped and uncapped alike',
    money(statutory.body?.meta?.pf?.employee) === 1800 + 1800 + 1080,
    `${statutory.body?.meta?.pf?.employee}`);
  check('all three are contributing to PF',
    statutory.body?.meta?.pf?.contributing === 3, `${statutory.body?.meta?.pf?.contributing}`);
  check('the ESI return counts only those below the ceiling',
    statutory.body?.meta?.esi?.contributing === 1, `${statutory.body?.meta?.esi?.contributing}`);

  // ── 13 ── tenant isolation ──────────────────────────────────────────────
  step(13, 'Tenant isolation');
  await call('/auth/register', {
    method: 'POST',
    body: { email: `payother+${stamp}@nexus.test`, password: 'correct-horse-battery-7', name: 'Other Payroll' },
  });
  await call('/organizations', { method: 'POST', body: { name: `Other Forge ${stamp}` } });
  await call('/auth/refresh', { method: 'POST', body: {} });
  await call('/subscriptions', {
    method: 'POST', body: { plan: 'business', app_slugs: ['hr', 'payroll'], seats: 5, cycle: 'monthly' },
  });
  await new Promise((r) => setTimeout(r, 1200));

  const leakSlips = await call('/payroll/payslips');
  check('a new workspace sees no other tenant’s payslips',
    (leakSlips.body?.data?.length ?? -1) === 0, `${leakSlips.body?.data?.length} visible`);

  const leakSlip = await call(`/payroll/payslips/${slipRow.id}`);
  check('cannot read another tenant’s payslip by id', leakSlip.status === 404, `status ${leakSlip.status}`);

  const leakRun = await call(`/payroll/runs/${runId}`);
  check('cannot read another tenant’s payroll run', leakRun.status === 404, `status ${leakRun.status}`);

  const leakPunch = await call('/device-sync/punches', {
    method: 'POST',
    headers: { 'x-device-key': deviceKey },
    body: { punches: [{ employee_ref: alphaCode, punched_at: at(pastWeekday(6), 9, 0), direction: 'in' }] },
  });
  check('a device key only ever unlocks its own workspace',
    leakPunch.status === 200 && leakPunch.body?.data?.accepted === 1,
    `status ${leakPunch.status}`);

  const stillEmpty = await call('/hr/punches');
  check('and that punch landed in the other workspace, not this one',
    (stillEmpty.body?.data?.length ?? -1) === 0, `${stillEmpty.body?.data?.length}`);

  console.log('');
  if (failures === 0) {
    console.log(c.ok(c.bold('  ✔ everything passed\n')));
    process.exit(0);
  }
  console.log(c.bad(c.bold(`  ✘ ${failures} check${failures === 1 ? '' : 's'} failed\n`)));
  process.exit(1);
}

main().catch((error) => {
  console.error(`\n  ${c.bad('payroll smoke crashed:')} ${error.stack}\n`);
  process.exit(1);
});
