export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message: string, code = "BAD_REQUEST", details?: unknown): AppError {
  return new AppError(400, code, message, details);
}

export function unauthorized(message = "Authentication required", code = "UNAUTHORIZED"): AppError {
  return new AppError(401, code, message);
}

export function forbidden(message = "Access denied", code = "FORBIDDEN"): AppError {
  return new AppError(403, code, message);
}

export function notFound(message = "Resource not found", code = "NOT_FOUND"): AppError {
  return new AppError(404, code, message);
}

export function conflict(message: string, code = "CONFLICT", details?: unknown): AppError {
  return new AppError(409, code, message, details);
}
