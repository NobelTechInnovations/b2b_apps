import pino from 'pino';

const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-nexus-service-token"]',
  'body.password',
  'body.current_password',
  'body.new_password',
  'body.token',
  'body.refresh_token',
  '*.password_hash',
];

export function createLogger({ name, level = process.env.LOG_LEVEL ?? 'info', pretty }) {
  const usePretty = pretty ?? process.env.NODE_ENV !== 'production';
  return pino({
    name,
    level,
    redact: { paths: REDACT, remove: true },
    base: { service: name },
    transport: usePretty
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' },
        }
      : undefined,
  });
}
