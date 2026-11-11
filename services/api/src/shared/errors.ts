/** An error with a stable machine-readable code and an HTTP status. */
export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** Thrown by skeleton code that a later iteration implements. Maps to HTTP 501. */
export class NotImplementedError extends AppError {
  constructor(feature: string, iteration: number) {
    super('not_implemented', `${feature} is planned for iteration ${iteration}`, 501);
    this.name = 'NotImplementedError';
  }
}
