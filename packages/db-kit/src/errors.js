export class DbError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'DbError';
  }
}

export class UniqueViolation extends DbError {
  constructor(constraint, cause) {
    super(`unique constraint violated: ${constraint}`, cause);
    this.name = 'UniqueViolation';
    this.constraint = constraint;
    this.status = 409;
    this.code = 'conflict';
  }
}

export class NotFound extends DbError {
  constructor(resource) {
    super(`${resource} not found`);
    this.name = 'NotFound';
    this.resource = resource;
    this.status = 404;
    this.code = 'not_found';
  }
}
