/**
 * Log a recurring failure once, then at most once a minute while it repeats.
 * A service polling a database that has gone away would otherwise write the
 * same stack trace every few seconds — enough to fill a disk overnight.
 */
export function quietErrors(logger, windowMs = 60_000) {
  const seen = new Map();
  return (error, message) => {
    const key = `${message}:${error?.code ?? error?.message}`;
    const now = Date.now();
    const last = seen.get(key);
    if (last && now - last.at < windowMs) {
      last.suppressed += 1;
      return;
    }
    const suppressed = last?.suppressed ?? 0;
    seen.set(key, { at: now, suppressed: 0 });
    logger.error?.({ err: error, ...(suppressed ? { repeated: suppressed } : {}) }, message);
  };
}
