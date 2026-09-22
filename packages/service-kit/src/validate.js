/**
 * Thin helpers over Fastify's built-in JSON-schema validation, so route files
 * read as declarations rather than boilerplate.
 */
const S = {
  id: (prefix) => ({ type: 'string', pattern: `^${prefix}_[0-9a-hjkmnp-tv-z]{26}$` }),
  email: { type: 'string', format: 'email', maxLength: 254 },
  text: (max = 255, min = 1) => ({ type: 'string', minLength: min, maxLength: max }),
  longText: { type: 'string', maxLength: 20_000 },
  money: { type: 'string', pattern: '^-?\\d+(\\.\\d{1,4})?$' },
  date: { type: 'string', format: 'date' },
  datetime: { type: 'string', format: 'date-time' },
  bool: { type: 'boolean' },
  int: (min = 0, max = 2_147_483_647) => ({ type: 'integer', minimum: min, maximum: max }),
  enum: (values) => ({ type: 'string', enum: values }),
  slug: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 64 },
};

export const validate = S;

export const body = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const params = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const query = (properties) => ({
  type: 'object',
  properties: {
    page: { type: 'integer', minimum: 1, default: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    sort: { type: 'string', maxLength: 40 },
    order: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
    q: { type: 'string', maxLength: 200 },
    ...properties,
  },
  additionalProperties: false,
});
