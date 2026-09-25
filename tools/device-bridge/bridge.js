#!/usr/bin/env node
/**
 * Nexus device bridge — gets punches from a biometric terminal into Nexus.
 *
 * Most terminals (eSSL, ZKTeco, Realtime, Mantra …) do not call web APIs.
 * They keep punches in memory and export them — to a USB stick as
 * `attlog.dat`/`1_attlog.dat`, or as a CSV from their desktop software. This
 * bridge reads those files and posts the punches to Nexus.
 *
 *   node bridge.js --file ./1_attlog.dat --key nxd_... --url https://…/api/device-sync/punches
 *   node bridge.js --watch ./exports --key nxd_... --url …        (keeps running)
 *
 * Safe to run as often as you like: Nexus ignores a punch it already has, and
 * the bridge remembers what it has sent so it does not re-send whole files.
 *
 * No dependencies beyond Node 18+.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// ─── arguments ───────────────────────────────────────────────────────────────
function args(argv) {
  const out = { tz: '+05:30', batch: 200, interval: 60 };
  for (let i = 2; i < argv.length; i += 1) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--file') { out.file = value; i += 1; }
    else if (flag === '--watch') { out.watch = value; i += 1; }
    else if (flag === '--key') { out.key = value; i += 1; }
    else if (flag === '--url') { out.url = value; i += 1; }
    else if (flag === '--tz') { out.tz = value; i += 1; }
    else if (flag === '--interval') { out.interval = Number(value); i += 1; }
    else if (flag === '--state') { out.state = value; i += 1; }
    else if (flag === '--dry-run') { out.dryRun = true; }
    else if (flag === '--help' || flag === '-h') { out.help = true; }
  }
  out.key ??= process.env.NEXUS_DEVICE_KEY;
  out.url ??= process.env.NEXUS_DEVICE_URL;
  return out;
}

// ─── parsing ─────────────────────────────────────────────────────────────────
/**
 * The terminal's clock is local time with no zone attached, so the bridge
 * attaches one. Get this wrong and every punch is off by hours — which is why
 * it is a flag, not a guess.
 */
function toInstant(local, tz) {
  const match = local.trim().match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s = '00'] = match;
  const iso = `${y}-${mo}-${d}T${h.padStart(2, '0')}:${mi}:${s}${tz}`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * ZKTeco / eSSL `attlog.dat`: tab-separated, one punch per line.
 *
 *   <enrolment no> \t <YYYY-MM-DD HH:MM:SS> \t <verify> \t <state> \t <workcode> …
 *
 * `state` is 0 = check-in, 1 = check-out on most firmware. Some terminals are
 * never configured to ask, and record everything as 0; in that case Nexus
 * pairs the punches itself, so the bridge sends no direction at all.
 */
function parseAttlog(text, tz, { trustState }) {
  const punches = [];
  for (const raw of text.split(/\r?\n/)) {
    const cols = raw.split('\t').map((c) => c.trim());
    if (cols.length < 2 || !cols[0] || !/^\d{4}/.test(cols[1])) continue;
    const at = toInstant(cols[1], tz);
    if (!at) continue;
    const state = cols[3];
    punches.push({
      employee_ref: cols[0],
      punched_at: at,
      ...(trustState && (state === '0' || state === '1') ? { direction: state === '0' ? 'in' : 'out' } : {}),
      raw: { verify: cols[2] ?? null, state: state ?? null, workcode: cols[4] ?? null },
    });
  }
  return punches;
}

/**
 * A CSV from the terminal's desktop software (eTimeTrackLite, ZKTime …).
 * Column names differ between vendors, so they are matched loosely.
 */
function parseCsv(text, tz) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const split = (line) => line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
  const header = split(lines[0]).map((h) => h.toLowerCase());

  const find = (...names) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const idCol = find('employee code', 'emp code', 'enroll', 'user id', 'userid', 'ac-no', 'badge', 'employee id');
  const whenCol = find('punch time', 'log date', 'datetime', 'date time', 'time');
  const dateCol = find('date');
  const directionCol = find('direction', 'in/out', 'status', 'state');

  if (idCol < 0 || (whenCol < 0 && dateCol < 0)) {
    throw new Error(`Could not find an employee column and a time column in: ${lines[0]}`);
  }

  const punches = [];
  for (const line of lines.slice(1)) {
    const cols = split(line);
    const when = whenCol >= 0 && /\d{1,2}:\d{2}/.test(cols[whenCol] ?? '') && /\d{4}/.test(cols[whenCol])
      ? cols[whenCol]
      : `${cols[dateCol]} ${cols[whenCol]}`;
    const at = toInstant(when.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1'), tz);
    if (!cols[idCol] || !at) continue;
    const dir = String(cols[directionCol] ?? '').toLowerCase();
    punches.push({
      employee_ref: cols[idCol],
      punched_at: at,
      ...(/^(in|check.?in|c\/in|0)$/.test(dir) ? { direction: 'in' }
        : /^(out|check.?out|c\/out|1)$/.test(dir) ? { direction: 'out' } : {}),
    });
  }
  return punches;
}

export function parseFile(file, { tz = '+05:30', trustState = true } = {}) {
  const text = readFileSync(file, 'utf8');
  return file.toLowerCase().endsWith('.csv') ? parseCsv(text, tz) : parseAttlog(text, tz, { trustState });
}

// ─── memory of what was sent ─────────────────────────────────────────────────
const STATE_FILE = (dir) => path.join(dir, '.nexus-bridge-state.json');

function loadState(dir) {
  try { return JSON.parse(readFileSync(STATE_FILE(dir), 'utf8')); } catch { return { sent: {} }; }
}
function saveState(dir, state) {
  writeFileSync(STATE_FILE(dir), JSON.stringify(state, null, 2));
}
const keyOf = (p) => `${p.employee_ref}|${p.punched_at}`;

// ─── sending ─────────────────────────────────────────────────────────────────
async function send(punches, { url, key, batch, dryRun }) {
  const totals = { accepted: 0, duplicate: 0, unmatched: 0, days_rebuilt: 0 };
  for (let i = 0; i < punches.length; i += batch) {
    const chunk = punches.slice(i, i + batch);
    if (dryRun) { totals.accepted += chunk.length; continue; }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-key': key },
      body: JSON.stringify({ punches: chunk }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Nexus refused the batch (${response.status}): ${body?.error?.message ?? 'unknown error'}`);
    }
    for (const k of Object.keys(totals)) totals[k] += body.data?.[k] ?? 0;
  }
  return totals;
}

async function syncFile(file, options, state) {
  const all = parseFile(file, options);
  const fresh = all.filter((p) => !state.sent[keyOf(p)]);
  if (!fresh.length) return { file, read: all.length, sent: 0 };

  const totals = await send(fresh, options);
  const now = new Date().toISOString();
  for (const p of fresh) state.sent[keyOf(p)] = now;
  return { file, read: all.length, sent: fresh.length, ...totals };
}

function report(result) {
  const parts = [`${path.basename(result.file)}: ${result.read} read, ${result.sent} new`];
  if (result.sent) {
    parts.push(`${result.accepted} accepted`, `${result.duplicate} already in Nexus`);
    if (result.unmatched) parts.push(`${result.unmatched} UNMATCHED — map these ids under HR → Devices → Enrolment`);
  }
  console.log(`  ${parts.join(' · ')}`);
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  const options = args(process.argv);
  options.trustState = options.state !== 'ignore';

  if (options.help || (!options.file && !options.watch)) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 18).join('\n'));
    process.exit(options.help ? 0 : 1);
  }
  if (!options.dryRun && (!options.key || !options.url)) {
    console.error('  A device key (--key) and the Nexus endpoint (--url) are required. See HR → Devices.');
    process.exit(1);
  }

  if (options.file) {
    const dir = path.dirname(path.resolve(options.file));
    const state = loadState(dir);
    report(await syncFile(options.file, options, state));
    if (!options.dryRun) saveState(dir, state);
    return;
  }

  // Watch a folder the terminal's software exports into.
  const dir = path.resolve(options.watch);
  console.log(`  Watching ${dir} every ${options.interval}s. Ctrl+C to stop.`);
  for (;;) {
    const state = loadState(dir);
    for (const name of readdirSync(dir)) {
      if (!/\.(dat|txt|csv)$/i.test(name)) continue;
      const file = path.join(dir, name);
      if (!statSync(file).isFile()) continue;
      try { report(await syncFile(file, options, state)); }
      catch (error) { console.error(`  ${name}: ${error.message}`); }
    }
    if (!options.dryRun) saveState(dir, state);
    await new Promise((r) => setTimeout(r, options.interval * 1000));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => { console.error(`  ${error.message}`); process.exit(1); });
}
