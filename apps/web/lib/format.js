const CURRENCY_LOCALE = { INR: 'en-IN', USD: 'en-US', EUR: 'de-DE', GBP: 'en-GB' };

export function money(amount, currency = 'INR', { compact = false, decimals } = {}) {
  const value = Number(amount ?? 0);
  return new Intl.NumberFormat(CURRENCY_LOCALE[currency] ?? 'en-IN', {
    style: 'currency',
    currency,
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: decimals ?? (compact ? 1 : value % 1 === 0 ? 0 : 2),
    minimumFractionDigits: decimals ?? 0,
  }).format(value);
}

export const number = (value, options) =>
  new Intl.NumberFormat('en-IN', options).format(Number(value ?? 0));

export const percent = (value, decimals = 0) =>
  `${Number(value ?? 0).toFixed(decimals)}%`;

export function date(value, style = 'medium') {
  if (!value) return '—';
  const formats = {
    short: { day: 'numeric', month: 'short' },
    medium: { day: 'numeric', month: 'short', year: 'numeric' },
    long: { day: 'numeric', month: 'long', year: 'numeric' },
    time: { hour: 'numeric', minute: '2-digit' },
    datetime: { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' },
  };
  return new Intl.DateTimeFormat('en-IN', formats[style]).format(new Date(value));
}

export function relativeTime(value) {
  if (!value) return '—';
  const diff = Date.now() - new Date(value).getTime();
  const units = [
    [60_000, 'minute', 1_000],
    [3_600_000, 'hour', 60_000],
    [86_400_000, 'day', 3_600_000],
    [604_800_000, 'week', 86_400_000],
    [2_592_000_000, 'month', 604_800_000],
    [Infinity, 'year', 2_592_000_000],
  ];

  if (Math.abs(diff) < 45_000) return 'just now';

  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [limit, unit, divisor] of units) {
    if (Math.abs(diff) < limit) {
      return formatter.format(-Math.round(diff / divisor), unit);
    }
  }
  return '';
}

export const pluralize = (count, singular, plural) =>
  `${count} ${count === 1 ? singular : plural ?? `${singular}s`}`;
