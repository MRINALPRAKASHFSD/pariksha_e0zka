import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import type { ZodSchema } from "zod";
import { AppError, badRequest } from "../lib/errors.js";
import type { ApiErrorResponse } from "@pariksha/shared";

export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      next(badRequest("Validation failed", "VALIDATION_ERROR", parsed.error.flatten()));
      return;
    }
    req.body = parsed.data;
    next();
  };
}

export function validateQuery<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      next(badRequest("Invalid query parameters", "VALIDATION_ERROR", parsed.error.flatten()));
      return;
    }
    res.locals.validatedQuery = parsed.data;
    next();
  };
}

export function notFoundHandler(req: Request, res: Response): void {
  const payload: ApiErrorResponse = {
    success: false,
    error: {
      code: "ROUTE_NOT_FOUND",
      message: `Route ${req.method} ${req.originalUrl} not found`,
    },
    requestId: res.locals.requestId as string | undefined,
  };
  res.status(404).json(payload);
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const requestId = res.locals.requestId as string | undefined;

  if (err instanceof multer.MulterError) {
    const code =
      err.code === "LIMIT_FILE_SIZE"
        ? "FILE_TOO_LARGE"
        : err.code === "LIMIT_FILE_COUNT"
          ? "TOO_MANY_FILES"
          : "UPLOAD_ERROR";
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    const payload: ApiErrorResponse = {
      success: false,
      error: {
        code,
        message: err.message,
      },
      requestId,
    };
    res.status(status).json(payload);
    return;
  }

  if (err instanceof AppError) {
    const payload: ApiErrorResponse = {
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
      requestId,
    };
    res.status(err.statusCode).json(payload);
    return;
  }

  console.error("[pariksha-api] Unhandled error:", err);

  const payload: ApiErrorResponse = {
    success: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred",
    },
    requestId,
  };
  res.status(500).json(payload);
}
