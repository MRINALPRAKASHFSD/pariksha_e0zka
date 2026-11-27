import crypto from "node:crypto";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import type { NextFunction, Request, Response } from "express";
import { getEnv } from "../config/env.js";

export function requestIdMiddleware(_req: Request, res: Response, next: NextFunction): void {
  const requestId = crypto.randomUUID();
  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
}

export function createHelmetMiddleware() {
  const env = getEnv();
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'", env.CLIENT_ORIGIN],
        mediaSrc: ["'self'", "blob:"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: env.NODE_ENV === "production",
  });
}

export function createCorsMiddleware() {
  const env = getEnv();
  return cors({
    origin: env.CLIENT_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-CSRF-Token", "X-Request-Id"],
  });
}

export function createApiRateLimiter() {
  const env = getEnv();
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: {
        code: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests, please try again later.",
      },
    },
  });
}

export function createAuthRateLimiter() {
  const env = getEnv();
  return rateLimit({
    windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
    max: env.AUTH_RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: {
        code: "RATE_LIMIT_EXCEEDED",
        message: "Too many authentication attempts. Please wait before trying again.",
      },
    },
  });
}

export function createUploadRateLimiter() {
  const env = getEnv();
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.UPLOAD_RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: {
        code: "UPLOAD_RATE_LIMIT_EXCEEDED",
        message: "Too many file upload requests. Please wait before uploading again.",
      },
    },
  });
}
