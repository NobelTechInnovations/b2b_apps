import { randomBytes } from 'node:crypto';
import { ApiError } from '@nexus/service-kit';

/** Money in integer paise, written back as rupee strings. */
export const toPaise = (value) => Math.round(Number(value ?? 0) * 100);
export const toRupees = (paise) => (Math.round(paise) / 100).toFixed(2);

export function lineTotals({ quantity, unit_price: unitPrice, discount_percent: discount = 0, tax_rate: taxRate = 0 }) {
  const gross = Math.round(toPaise(unitPrice) * Number(quantity));
  const off = Math.round((gross * Number(discount)) / 100);
  const taxable = gross - off;
  const tax = Math.round((taxable * Number(taxRate)) / 100);
  return { gross, discount: off, tax, total: taxable + tax };
}

export function sumLines(lines) {
  const t = lines.reduce((acc, line) => {
    const x = lineTotals(line);
    return { gross: acc.gross + x.gross, discount: acc.discount + x.discount, tax: acc.tax + x.tax, total: acc.total + x.total };
  }, { gross: 0, discount: 0, tax: 0, total: 0 });
  return {
    subtotal: toRupees(t.gross), discount_total: toRupees(t.discount), tax_total: toRupees(t.tax), total: toRupees(t.total),
    max_discount: lines.reduce((m, l) => Math.max(m, Number(l.discount_percent ?? 0)), 0),
  };
}

export async function nextSalesNumber(tx, orgId, kind, prefix, padding = 4) {
  const row = await tx.one(
    `INSERT INTO sales_counters (org_id, kind, last_value) VALUES ($1, $2, 1)
     ON CONFLICT (org_id, kind) DO UPDATE SET last_value = sales_counters.last_value + 1 RETURNING last_value`,
    [orgId, kind],
  );
  return `${prefix}-${String(row.last_value).padStart(padding, '0')}`;
}

/** An unguessable link token (128 bits), URL-safe. */
export const publicToken = () => randomBytes(16).toString('base64url');

/** Call another Nexus service over the internal network. */
export function internal(config) {
  return async function call(url, { method = 'GET', body } = {}) {
    const response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', 'x-nexus-service-token': config.serviceToken },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    }).catch(() => null);
    if (!response) throw new ApiError(503, 'unavailable', 'That service is not reachable right now. Try again in a moment.');
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Pass a 4xx through (it explains itself); anything else is ours to hide.
      if (response.status < 500) throw new ApiError(response.status, payload.error?.code ?? 'request_failed', payload.error?.message ?? 'The request was refused.', payload.error?.details);
      throw new ApiError(502, 'upstream_error', 'The other service failed. Try again in a moment.');
    }
    return payload.data;
  };
}

/** The workspace's name and logo for customer-facing pages, cached briefly. */
export function orgProfiles(config) {
  const call = internal(config);
  const cache = new Map();
  return async (orgId) => {
    const hit = cache.get(orgId);
    if (hit && hit.at > Date.now() - 60_000) return hit.value;
    const value = await call(`${config.tenancyUrl}/internal/orgs/${orgId}`).catch(() => ({ id: orgId, name: 'Our company' }));
    cache.set(orgId, { at: Date.now(), value });
    return value;
  };
}
