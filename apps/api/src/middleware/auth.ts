import type { NextFunction, Request, Response } from "express";
import type { User, UserRole } from "@prisma/client";
import { getEnv } from "../config/env.js";
import { getPrismaClient } from "../lib/prisma.js";
import { hashToken, sha256Hex, timingSafeEqualHex } from "../lib/crypto.js";
import { forbidden, unauthorized } from "../lib/errors.js";

export const SESSION_COOKIE_NAME = "pariksha_session";
export const PRE_AUTH_CSRF_COOKIE_NAME = "pariksha_csrf_nonce";

export interface AuthContext {
  user: User;
  sessionId: string;
  csrfToken: string;
  csrfTokenHash: string;
}

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthContext;
  }
}

export function shouldUseSecureCookies(): boolean {
  const env = getEnv();
  return env.COOKIE_SECURE || env.NODE_ENV === "production";
}

export function setSessionCookie(res: Response, rawSessionToken: string): void {
  const env = getEnv();
  res.cookie(SESSION_COOKIE_NAME, rawSessionToken, {
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: env.SESSION_TTL_HOURS * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: "lax",
    path: "/",
  });
}

export function setPreAuthCsrfCookie(res: Response, nonce: string): void {
  res.cookie(PRE_AUTH_CSRF_COOKIE_NAME, nonce, {
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 1000,
  });
}

export function clearPreAuthCsrfCookie(res: Response): void {
  res.clearCookie(PRE_AUTH_CSRF_COOKIE_NAME, {
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: "lax",
    path: "/",
  });
}

export function parseCookieHeader(cookieHeader?: string): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      result[key] = decodeURIComponent(val);
    } catch {
      result[key] = val;
    }
  }
  return result;
}

export async function resolveSessionFromToken(rawSessionToken: string): Promise<AuthContext | null> {
  if (!rawSessionToken || rawSessionToken.length < 32) {
    return null;
  }
  const env = getEnv();
  const prisma = getPrismaClient();
  const tokenHash = hashToken(rawSessionToken, env.SESSION_SECRET);

  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!session) {
    return null;
  }
  if (session.revokedAt !== null || session.expiresAt <= new Date()) {
    return null;
  }

  const csrfToken = hashToken(rawSessionToken, env.CSRF_SECRET);
  return {
    user: session.user,
    sessionId: session.id,
    csrfToken,
    csrfTokenHash: session.csrfTokenHash,
  };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rawToken = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    if (!rawToken) {
      next(unauthorized("Authentication required", "UNAUTHENTICATED"));
      return;
    }

    const resolved = await resolveSessionFromToken(rawToken);
    if (!resolved) {
      clearSessionCookie(res);
      next(unauthorized("Session expired or invalid", "SESSION_INVALID"));
      return;
    }

    if (resolved.user.status !== "ACTIVE") {
      const prisma = getPrismaClient();
      await prisma.session.update({
        where: { id: resolved.sessionId },
        data: { revokedAt: new Date() },
      });
      clearSessionCookie(res);
      next(forbidden("Account is inactive or suspended", "ACCOUNT_INACTIVE"));
      return;
    }

    req.auth = resolved;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRoles(...allowedRoles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) {
      next(unauthorized("Authentication required", "UNAUTHENTICATED"));
      return;
    }
    if (req.auth.user.mustChangePassword) {
      next(
        forbidden(
          "You must change your temporary password before accessing platform resources.",
          "PASSWORD_CHANGE_REQUIRED",
        ),
      );
      return;
    }
    if (!allowedRoles.includes(req.auth.user.role)) {
      next(forbidden("Insufficient permissions for this resource", "FORBIDDEN"));
      return;
    }
    next();
  };
}

export function requirePasswordChanged(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth) {
    next(unauthorized("Authentication required", "UNAUTHENTICATED"));
    return;
  }
  if (req.auth.user.mustChangePassword) {
    next(
      forbidden(
        "You must change your temporary password before accessing platform resources.",
        "PASSWORD_CHANGE_REQUIRED",
      ),
    );
    return;
  }
  next();
}

export function requireCsrf(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth) {
    next(unauthorized("Authentication required", "UNAUTHENTICATED"));
    return;
  }
  const provided = req.get("x-csrf-token");
  if (!provided) {
    next(forbidden("Missing CSRF token", "CSRF_INVALID"));
    return;
  }
  const providedHash = sha256Hex(provided);
  if (!timingSafeEqualHex(providedHash, req.auth.csrfTokenHash)) {
    next(forbidden("Invalid CSRF token", "CSRF_INVALID"));
    return;
  }
  next();
}

export function verifyLoginCsrfAndOrigin(req: Request, _res: Response, next: NextFunction): void {
  const env = getEnv();
  const allowedOrigin = new URL(env.CLIENT_ORIGIN).origin;
  const originHeader = req.get("origin");
  if (originHeader && originHeader !== allowedOrigin) {
    next(forbidden("Cross-site login request blocked", "ORIGIN_MISMATCH"));
    return;
  }

  const refererHeader = req.get("referer");
  if (!originHeader && refererHeader) {
    try {
      const refererOrigin = new URL(refererHeader).origin;
      if (refererOrigin !== allowedOrigin) {
        next(forbidden("Cross-site login referer blocked", "ORIGIN_MISMATCH"));
        return;
      }
    } catch {
      next(forbidden("Invalid referer header", "ORIGIN_MISMATCH"));
      return;
    }
  }

  const provided = req.get("x-csrf-token");
  const nonce = req.cookies?.[PRE_AUTH_CSRF_COOKIE_NAME] as string | undefined;

  if (!provided || !nonce) {
    next(forbidden("Missing pre-authentication CSRF token", "CSRF_INVALID"));
    return;
  }

  const expected = hashToken(nonce, env.CSRF_SECRET);
  if (!timingSafeEqualHex(provided, expected)) {
    next(forbidden("Invalid pre-authentication CSRF token", "CSRF_INVALID"));
    return;
  }

  next();
}
