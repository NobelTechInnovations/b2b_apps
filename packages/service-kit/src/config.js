/**
 * Config is validated at boot. A service with bad configuration refuses to
 * start rather than failing on the first request at 3am.
 */
const COERCE = {
  string: (v) => String(v),
  number: (v) => {
    const n = Number(v);
    if (Number.isNaN(n)) throw new Error('expected a number');
    return n;
  },
  boolean: (v) => ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()),
  list: (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean),
};

export function env(type, { required = false, default: fallback, secret = false } = {}) {
  return { type, required, default: fallback, secret };
}

export function defineConfig(schema, source = process.env) {
  const config = {};
  const problems = [];

  for (const [key, spec] of Object.entries(schema)) {
    const envKey = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
    const raw = source[envKey];

    if (raw === undefined || raw === '') {
      if (spec.required && spec.default === undefined) {
        problems.push(`${envKey} is required`);
        continue;
      }
      config[key] = spec.default;
      continue;
    }

    try {
      config[key] = COERCE[spec.type](raw);
    } catch (error) {
      problems.push(`${envKey}: ${error.message} (got "${raw}")`);
    }
  }

  if (problems.length) {
    console.error('\n  ✖ Invalid configuration:\n' + problems.map((p) => `    - ${p}`).join('\n') + '\n');
    throw new Error(`configuration invalid: ${problems.length} problem(s)`);
  }

  Object.defineProperty(config, 'redacted', {
    enumerable: false,
    value: () =>
      Object.fromEntries(
        Object.entries(config).map(([k, v]) => [k, schema[k]?.secret && v ? '••••••' : v]),
      ),
  });

  return config;
}
