/**
 * One error shape for the entire platform:
 *   { error: { code, message, details, request_id } }
 * Clients only ever have to learn this once.
 */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

export const badRequest = (message, details) => new ApiError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') => new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have access to this', details) =>
  new ApiError(403, 'forbidden', message, details);
export const notFound = (resource = 'Resource') => new ApiError(404, 'not_found', `${resource} not found`);
export const conflict = (message, details) => new ApiError(409, 'conflict', message, details);
export const tooMany = (message = 'Too many requests') => new ApiError(429, 'rate_limited', message);

export function errorHandler(error, request, reply) {
  const status = error.status ?? error.statusCode ?? 500;
  const requestId = request.id;

  if (status >= 500) {
    request.log.error({ err: error, url: request.url }, 'request failed');
  } else {
    request.log.warn({ code: error.code, msg: error.message, url: request.url }, 'request rejected');
  }

  // Fastify schema validation
  if (error.validation) {
    return reply.status(400).send({
      error: {
        code: 'validation_failed',
        message: 'The request did not pass validation',
        details: error.validation.map((v) => ({
          field: (v.instancePath || v.params?.missingProperty || '').replace(/^\//, ''),
          message: v.message,
        })),
        request_id: requestId,
      },
    });
  }

  const safe = status < 500 && error.expose !== false;

  return reply.status(status).send({
    error: {
      code: error.code ?? (status >= 500 ? 'internal_error' : 'request_failed'),
      message: safe ? error.message : 'Something went wrong on our side.',
      details: safe ? error.details : undefined,
      request_id: requestId,
    },
  });
}
