/**
 * Time accounting: shifts in, overtime out.
 *
 * Every function here is pure and takes minutes as its unit. Attendance is
 * derived, never authoritative — given the same punches and the same shift you
 * must get the same day back, because that is what makes a rebuild safe.
 */

/** `HH:MM` or `HH:MM:SS` → minutes since midnight. */
export function minutesOfDay(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatMinutes(total) {
  if (total == null) return null;
  const sign = total < 0 ? '-' : '';
  const abs = Math.abs(Math.round(total));
  return `${sign}${Math.floor(abs / 60)}h ${String(abs % 60).padStart(2, '0')}m`;
}

/**
 * Paid minutes a shift is worth.
 *
 * A shift whose end time is at or before its start time runs past midnight —
 * 22:00→06:00 is eight hours, not minus sixteen.
 */
export function shiftMinutes(shift) {
  const start = minutesOfDay(shift.starts_at) ?? 540;
  const end = minutesOfDay(shift.ends_at) ?? 1080;
  const span = end > start ? end - start : 1440 - start + end;
  return Math.max(0, span - (shift.break_minutes ?? 0));
}

/** ISO weekday, 1 = Monday … 7 = Sunday, for a `YYYY-MM-DD` string. */
export function isoWeekday(isoDate) {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export function isWorkingDay(shift, isoDate) {
  const days = shift?.working_days?.length ? shift.working_days : [1, 2, 3, 4, 5];
  return days.includes(isoWeekday(isoDate));
}

/** Minutes past the scheduled start, after the grace period is spent. */
function lateness(shift, isoDate, checkIn) {
  if (!checkIn) return 0;
  const scheduled = minutesOfDay(shift.starts_at);
  if (scheduled == null) return 0;

  const arrival = new Date(checkIn);
  const arrivalMinutes = arrival.getHours() * 60 + arrival.getMinutes();
  // A night-shift arrival after midnight is early, not fourteen hours late.
  const delta = shift.is_night_shift && arrivalMinutes < scheduled - 720
    ? arrivalMinutes + 1440 - scheduled
    : arrivalMinutes - scheduled;

  return Math.max(0, delta - (shift.grace_minutes ?? 0));
}

function earlyExit(shift, checkOut) {
  if (!checkOut) return 0;
  const scheduled = minutesOfDay(shift.ends_at);
  if (scheduled == null) return 0;

  const exit = new Date(checkOut);
  const exitMinutes = exit.getHours() * 60 + exit.getMinutes();
  const delta = shift.is_night_shift && exitMinutes > scheduled + 720
    ? scheduled + 1440 - exitMinutes
    : scheduled - exitMinutes;

  return Math.max(0, delta);
}

/**
 * Work out one person's one day.
 *
 * `workMinutes` is what they actually worked; everything else falls out of
 * comparing that to the shift. Overtime only starts once the whole shift is
 * covered — leaving two hours early and staying two hours late on the same
 * day nets to zero, not to two hours of each.
 */
export function deriveDay({ shift, onDate, checkIn, checkOut, workMinutes, status }) {
  const fallback = { starts_at: '09:00', ends_at: '18:00', break_minutes: 60, grace_minutes: 10, half_day_minutes: 240 };
  const s = shift ?? fallback;

  const working = isWorkingDay(s, onDate);
  const expected = working ? shiftMinutes(s) : 0;

  let worked = workMinutes;
  if (worked == null && checkIn && checkOut) {
    worked = Math.max(0, Math.round((new Date(checkOut) - new Date(checkIn)) / 60000) - (s.break_minutes ?? 0));
  }
  worked = worked == null ? null : Math.max(0, worked);

  // Overtime is measured against the shift, but only past any threshold the
  // policy sets — many workplaces do not pay the first fifteen loose minutes.
  const threshold = expected + (s.overtime_after_minutes ?? 0);
  const overtime = worked == null ? 0 : Math.max(0, worked - threshold);
  const shortfall = worked == null ? 0 : Math.max(0, expected - worked);

  let resolved = status;
  if (!resolved) {
    if (!working) resolved = 'weekend';
    else if (worked == null) resolved = 'absent';
    else if (worked >= expected - (s.grace_minutes ?? 0)) resolved = 'present';
    else if (worked >= (s.half_day_minutes ?? 240)) resolved = 'half_day';
    else if (worked > 0) resolved = 'half_day';
    else resolved = 'absent';
  }

  return {
    status: resolved,
    expected_minutes: expected,
    work_minutes: worked,
    overtime_minutes: overtime,
    shortfall_minutes: shortfall,
    late_minutes: working ? lateness(s, onDate, checkIn) : 0,
    early_exit_minutes: working ? earlyExit(s, checkOut) : 0,
  };
}

/**
 * Fold a day's raw punches into a first-in / last-out pair plus worked time.
 *
 * Devices are messy: people badge in twice, badge out for lunch, or forget
 * entirely. Alternating the direction and summing only complete in→out spans
 * handles the common cases; an odd trailing punch is reported rather than
 * guessed at, because inventing a check-out would fabricate paid minutes.
 */
export function foldPunches(punches, { breakMinutes = 0 } = {}) {
  const sorted = [...punches].sort((a, b) => new Date(a.punched_at) - new Date(b.punched_at));

  let openedAt = null;
  let spanMinutes = 0;
  let firstIn = null;
  let lastOut = null;
  let unpaired = 0;

  for (const punch of sorted) {
    // An explicit direction wins; otherwise alternate from whatever is open.
    const direction = punch.direction ?? (openedAt ? 'out' : 'in');

    if (direction === 'in') {
      // Two consecutive 'in' punches: keep the earliest, ignore the re-badge.
      if (!openedAt) openedAt = punch.punched_at;
      if (!firstIn) firstIn = punch.punched_at;
    } else {
      if (!openedAt) { unpaired += 1; continue; }
      spanMinutes += Math.max(0, Math.round((new Date(punch.punched_at) - new Date(openedAt)) / 60000));
      lastOut = punch.punched_at;
      openedAt = null;
    }
  }

  if (openedAt) unpaired += 1;

  return {
    check_in_at: firstIn,
    check_out_at: lastOut,
    // Multiple spans already exclude the gaps between them, so a break is only
    // deducted when the whole day came through as one uninterrupted span.
    work_minutes: firstIn ? Math.max(0, spanMinutes - (spanMinutes && lastOut && sorted.length <= 2 ? breakMinutes : 0)) : null,
    punch_count: sorted.length,
    open: Boolean(openedAt),
    unpaired,
  };
}
