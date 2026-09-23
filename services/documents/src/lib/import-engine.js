import { importTarget } from '@nexus/contracts';

/**
 * Turn spreadsheet cells into records another app will accept.
 *
 * Every row is coerced and validated BEFORE anything is written, so the
 * wizard can show exactly what will happen — created, updated, skipped or
 * failed — and why, line by line. A person should never discover a bad import
 * by finding 200 broken records afterwards.
 */

const TRUE_VALUES = new Set(['true', 'yes', 'y', '1']);
const FALSE_VALUES = new Set(['false', 'no', 'n', '0']);

/** Coerce one cell to a field's type, or explain why it cannot be. */
export function coerce(value, field) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return { ok: true, value: field.default ?? null, empty: true };
  }

  const raw = value instanceof Date ? value : String(value).trim();

  switch (field.type) {
    case 'email': {
      const text = String(raw).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(text)) {
        return { ok: false, message: `“${raw}” is not a valid email address` };
      }
      return { ok: true, value: text };
    }

    case 'phone': {
      // Keep the digits and a leading +; drop the decoration people type.
      const text = String(raw).replace(/[^\d+]/g, '');
      if (text.replace(/\D/g, '').length < 6) {
        return { ok: false, message: `“${raw}” is too short to be a phone number` };
      }
      return { ok: true, value: text.slice(0, 32) };
    }

    case 'number':
    case 'money': {
      const text = String(raw).replace(/[,\s₹$€£]/g, '');
      const number = Number(text);
      if (!Number.isFinite(number)) {
        return { ok: false, message: `“${raw}” is not a number` };
      }
      return { ok: true, value: field.type === 'money' ? number.toFixed(2) : number };
    }

    case 'date': {
      const parsed = toDate(raw);
      if (!parsed) return { ok: false, message: `“${raw}” is not a date we recognise` };
      return { ok: true, value: parsed };
    }

    case 'boolean': {
      const text = String(raw).toLowerCase();
      if (TRUE_VALUES.has(text)) return { ok: true, value: true };
      if (FALSE_VALUES.has(text)) return { ok: true, value: false };
      return { ok: false, message: `“${raw}” is not a yes/no value` };
    }

    case 'enum': {
      const text = String(raw).toLowerCase().replace(/[\s-]+/g, '_');
      const match = (field.options ?? []).find((o) => o.toLowerCase() === text);
      if (match) return { ok: true, value: match };
      // Accept a close-enough label ("Full Time" → full_time) before failing.
      const loose = (field.options ?? []).find((o) => o.replace(/_/g, '') === text.replace(/_/g, ''));
      if (loose) return { ok: true, value: loose };
      return {
        ok: false,
        message: `“${raw}” is not one of: ${(field.options ?? []).join(', ')}`,
      };
    }

    default: {
      const text = String(raw).trim();
      if (text.length > 2000) {
        return { ok: true, value: text.slice(0, 2000), warning: 'Trimmed to 2000 characters' };
      }
      return { ok: true, value: text };
    }
  }
}

/**
 * Date parsing that covers what people actually put in spreadsheets:
 * real Date cells, ISO, DD/MM/YYYY and DD-MM-YY. Day-first, because this is
 * built for India — an ambiguous 03/04/2026 is 3 April, not 4 March.
 */
function toDate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }

  const text = String(value).trim();

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dmy = text.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (dmy) {
    let [, day, month, year] = dmy;
    if (year.length === 2) year = Number(year) > 50 ? `19${year}` : `20${year}`;
    const d = Number(day);
    const m = Number(month);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime()) && /\d{4}/.test(text)) {
    return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
  }

  return null;
}

/**
 * Validate every row against the target and report what would happen.
 *
 * Catches three classes of problem the person can actually act on:
 *   - a required field left empty
 *   - a value that cannot be coerced to the field's type
 *   - the same dedupe key appearing twice inside the file itself
 */
export function validateRows({ rows, mapping, targetKey, existingKeys = new Set() }) {
  const target = importTarget(targetKey);
  if (!target) throw new Error(`unknown import target: ${targetKey}`);

  const fieldsByKey = new Map(target.fields.map((f) => [f.key, f]));
  const mapped = Object.entries(mapping).filter(([, fieldKey]) => fieldKey && fieldsByKey.has(fieldKey));

  const missingRequired = target.fields
    .filter((f) => f.required)
    .filter((f) => !mapped.some(([, key]) => key === f.key));

  const seenKeys = new Map();
  const results = [];

  for (const row of rows) {
    const payload = {};
    const issues = [];

    for (const [header, fieldKey] of mapped) {
      const field = fieldsByKey.get(fieldKey);
      const result = coerce(row[header], field);

      if (!result.ok) {
        issues.push({ severity: 'error', field: fieldKey, column: header, message: result.message });
        continue;
      }
      if (result.warning) {
        issues.push({ severity: 'warning', field: fieldKey, column: header, message: result.warning });
      }
      if (result.value !== null && result.value !== undefined) payload[fieldKey] = result.value;
    }

    // Defaults for anything the sheet does not carry.
    for (const field of target.fields) {
      if (payload[field.key] === undefined && field.default !== undefined) {
        payload[field.key] = field.default;
      }
    }

    for (const field of target.fields.filter((f) => f.required)) {
      if (payload[field.key] === undefined || payload[field.key] === null || payload[field.key] === '') {
        issues.push({
          severity: 'error',
          field: field.key,
          message: `${field.label} is required but empty`,
        });
      }
    }

    // Duplicates inside the file, and rows that already exist in the target.
    let outcome = 'created';
    const dedupeValue = target.dedupeOn ? payload[target.dedupeOn] : null;

    if (dedupeValue) {
      const key = String(dedupeValue).toLowerCase();
      if (seenKeys.has(key)) {
        issues.push({
          severity: 'warning',
          field: target.dedupeOn,
          message: `Same ${target.dedupeOn} as row ${seenKeys.get(key)} — this row will be skipped`,
        });
        outcome = 'skipped';
      } else {
        seenKeys.set(key, row.__row);
        if (existingKeys.has(key)) {
          issues.push({
            severity: 'warning',
            field: target.dedupeOn,
            message: `A record with this ${target.dedupeOn} already exists — it will be updated`,
          });
          outcome = 'updated';
        }
      }
    }

    const severity = issues.some((i) => i.severity === 'error')
      ? 'error'
      : issues.some((i) => i.severity === 'warning')
        ? 'warning'
        : 'ok';

    results.push({
      row_number: row.__row,
      severity,
      outcome: severity === 'error' ? 'failed' : outcome,
      issues,
      payload,
    });
  }

  return {
    target: target.key,
    missing_required: missingRequired.map((f) => ({ key: f.key, label: f.label })),
    mapped_fields: mapped.map(([header, key]) => ({ column: header, field: key })),
    unmapped_columns: Object.keys(mapping).filter((h) => !mapping[h]),
    rows: results,
    summary: {
      total: results.length,
      ok: results.filter((r) => r.severity === 'ok').length,
      warnings: results.filter((r) => r.severity === 'warning').length,
      errors: results.filter((r) => r.severity === 'error').length,
      will_create: results.filter((r) => r.outcome === 'created').length,
      will_update: results.filter((r) => r.outcome === 'updated').length,
      will_skip: results.filter((r) => r.outcome === 'skipped').length,
      will_fail: results.filter((r) => r.outcome === 'failed').length,
    },
  };
}
