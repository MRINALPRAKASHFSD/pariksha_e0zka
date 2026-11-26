import { Router } from "express";
import {
  AuditAction,
  changePasswordSchema,
  loginSchema,
  type ApiSuccessResponse,
  type AuthSessionPayload,
} from "@pariksha/shared";
import { getEnv } from "../config/env.js";
import { writeAuditLog } from "../lib/audit.js";
import { disconnectUserSockets } from "../lib/realtime.js";
import {
  DUMMY_PASSWORD_HASH,
  generateOpaqueToken,
  hashPassword,
  hashToken,
  sha256Hex,
  verifyPassword,
} from "../lib/crypto.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import { getPrismaClient } from "../lib/prisma.js";
import { toAuthenticatedUserDto } from "../lib/serializers.js";
import {
  PRE_AUTH_CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  clearPreAuthCsrfCookie,
  clearSessionCookie,
  requireAuth,
  requireCsrf,
  resolveSessionFromToken,
  setPreAuthCsrfCookie,
  setSessionCookie,
  verifyLoginCsrfAndOrigin,
} from "../middleware/auth.js";
import { validateBody } from "../middleware/errorAndValidation.js";
import { createAuthRateLimiter } from "../middleware/security.js";

export function createAuthRouter(): Router {
  const authRouter = Router();

authRouter.get("/csrf", async (req, res, next) => {
  try {
    const env = getEnv();
    const rawSessionToken = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    if (rawSessionToken) {
      const resolved = await resolveSessionFromToken(rawSessionToken);
      if (resolved && resolved.user.status === "ACTIVE") {
        const payload: ApiSuccessResponse<{ csrfToken: string }> = {
          success: true,
          data: { csrfToken: resolved.csrfToken },
          requestId: res.locals.requestId as string | undefined,
        };
        res.json(payload);
        return;
      }
    }

    const existingNonce = req.cookies?.[PRE_AUTH_CSRF_COOKIE_NAME] as string | undefined;
    const nonce =
      existingNonce && /^[a-f0-9]{64}$/i.test(existingNonce)
        ? existingNonce
        : generateOpaqueToken(32);

    setPreAuthCsrfCookie(res, nonce);
    const csrfToken = hashToken(nonce, env.CSRF_SECRET);

    const payload: ApiSuccessResponse<{ csrfToken: string }> = {
      success: true,
      data: { csrfToken },
      requestId: res.locals.requestId as string | undefined,
    };
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

authRouter.post(
  "/login",
  createAuthRateLimiter(),
  verifyLoginCsrfAndOrigin,
  validateBody(loginSchema),
  async (req, res, next) => {
    try {
      const env = getEnv();
      const prisma = getPrismaClient();
      const { email, password } = req.body as { email: string; password: string };
      const ipAddress = req.ip ?? null;
      const userAgent = req.get("user-agent") ?? null;

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        await verifyPassword(password, DUMMY_PASSWORD_HASH);
        await writeAuditLog({
          action: AuditAction.AUTH_LOGIN_FAILED,
          entityType: "User",
          ipAddress,
          userAgent,
          metadata: { reason: "INVALID_CREDENTIALS" },
        });
        next(unauthorized("Invalid email or password", "INVALID_CREDENTIALS"));
        return;
      }

      const passwordValid = await verifyPassword(password, user.passwordHash);
      if (!passwordValid) {
        await writeAuditLog({
          actorId: user.id,
          actorRole: user.role,
          action: AuditAction.AUTH_LOGIN_FAILED,
          entityType: "User",
          entityId: user.id,
          ipAddress,
          userAgent,
          metadata: { reason: "INVALID_CREDENTIALS" },
        });
        next(unauthorized("Invalid email or password", "INVALID_CREDENTIALS"));
        return;
      }

      if (user.status !== "ACTIVE") {
        await writeAuditLog({
          actorId: user.id,
          actorRole: user.role,
          action: AuditAction.AUTH_LOGIN_FAILED,
          entityType: "User",
          entityId: user.id,
          ipAddress,
          userAgent,
          metadata: { reason: "ACCOUNT_INACTIVE", status: user.status },
        });
        next(
          forbidden(
            "Your account is currently inactive or suspended. Contact an administrator.",
            "ACCOUNT_INACTIVE",
          ),
        );
        return;
      }

      const now = new Date();
      if (user.mustChangePassword) {
        if (user.temporaryPasswordExpiresAt && user.temporaryPasswordExpiresAt <= now) {
          await writeAuditLog({
            actorId: user.id,
            actorRole: user.role,
            action: AuditAction.AUTH_LOGIN_FAILED,
            entityType: "User",
            entityId: user.id,
            ipAddress,
            userAgent,
            metadata: { reason: "TEMPORARY_PASSWORD_EXPIRED" },
          });
          next(
            forbidden(
              "Your temporary password has expired. Please request a new password reset from an administrator.",
              "TEMPORARY_PASSWORD_EXPIRED",
            ),
          );
          return;
        }
        if (user.temporaryPasswordUsedAt) {
          await writeAuditLog({
            actorId: user.id,
            actorRole: user.role,
            action: AuditAction.AUTH_LOGIN_FAILED,
            entityType: "User",
            entityId: user.id,
            ipAddress,
            userAgent,
            metadata: { reason: "TEMPORARY_PASSWORD_ALREADY_USED" },
          });
          next(
            forbidden(
              "This single-use temporary password has already been used. Please request a new reset.",
              "TEMPORARY_PASSWORD_USED",
            ),
          );
          return;
        }
      }

      const rawSessionToken = generateOpaqueToken(32);
      const tokenHash = hashToken(rawSessionToken, env.SESSION_SECRET);
      const csrfToken = hashToken(rawSessionToken, env.CSRF_SECRET);
      const csrfTokenHash = sha256Hex(csrfToken);
      const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 60 * 60 * 1000);

      const updatedUser = await prisma.$transaction(async (tx) => {
        await tx.session.create({
          data: {
            userId: user.id,
            tokenHash,
            csrfTokenHash,
            ipAddress,
            userAgent: userAgent?.slice(0, 512) ?? null,
            expiresAt,
          },
        });
        const nextUser = await tx.user.update({
          where: { id: user.id },
          data: {
            lastLoginAt: now,
            temporaryPasswordUsedAt: user.mustChangePassword ? now : undefined,
          },
        });
        await writeAuditLog(
          {
            actorId: user.id,
            actorRole: user.role,
            action: AuditAction.AUTH_LOGIN_SUCCESS,
            entityType: "User",
            entityId: user.id,
            ipAddress,
            userAgent,
          },
          tx,
        );
        return nextUser;
      });

      clearPreAuthCsrfCookie(res);
      setSessionCookie(res, rawSessionToken);

      const payload: ApiSuccessResponse<AuthSessionPayload> = {
        success: true,
        data: {
          user: toAuthenticatedUserDto(updatedUser),
          csrfToken,
        },
        requestId: res.locals.requestId as string | undefined,
      };
      res.json(payload);
    } catch (err) {
      next(err);
    }
  },
);

authRouter.get("/me", requireAuth, (req, res) => {
  const auth = req.auth!;
  const payload: ApiSuccessResponse<AuthSessionPayload> = {
    success: true,
    data: {
      user: toAuthenticatedUserDto(auth.user),
      csrfToken: auth.csrfToken,
    },
    requestId: res.locals.requestId as string | undefined,
  };
  res.json(payload);
});

authRouter.post("/logout", requireAuth, requireCsrf, async (req, res, next) => {
  try {
    const auth = req.auth!;
    const prisma = getPrismaClient();

    await prisma.$transaction(async (tx) => {
      await tx.session.update({
        where: { id: auth.sessionId },
        data: { revokedAt: new Date() },
      });
      await writeAuditLog(
        {
          actorId: auth.user.id,
          actorRole: auth.user.role,
          action: AuditAction.AUTH_LOGOUT,
          entityType: "Session",
          entityId: auth.sessionId,
          ipAddress: req.ip ?? null,
          userAgent: req.get("user-agent") ?? null,
        },
        tx,
      );
    });

    clearSessionCookie(res);
    await disconnectUserSockets(auth.user.id, "LOGOUT");
    res.json({
      success: true,
      data: { loggedOut: true },
      requestId: res.locals.requestId as string | undefined,
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post(
  "/change-password",
  requireAuth,
  requireCsrf,
  validateBody(changePasswordSchema),
  async (req, res, next) => {
    try {
      const auth = req.auth!;
      const prisma = getPrismaClient();
      const { currentPassword, newPassword } = req.body as {
        currentPassword: string;
        newPassword: string;
      };

      const validCurrent = await verifyPassword(currentPassword, auth.user.passwordHash);
      if (!validCurrent) {
        next(unauthorized("Current password is incorrect", "INVALID_CURRENT_PASSWORD"));
        return;
      }

      const newHash = await hashPassword(newPassword);
      const now = new Date();

      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: auth.user.id },
          data: {
            passwordHash: newHash,
            mustChangePassword: false,
            temporaryPasswordExpiresAt: null,
            temporaryPasswordUsedAt: null,
          },
        });
        await tx.session.updateMany({
          where: { userId: auth.user.id, revokedAt: null },
          data: { revokedAt: now },
        });
        await writeAuditLog(
          {
            actorId: auth.user.id,
            actorRole: auth.user.role,
            action: AuditAction.AUTH_PASSWORD_CHANGED,
            entityType: "User",
            entityId: auth.user.id,
            ipAddress: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
            metadata: { sessionsRevoked: true },
          },
          tx,
        );
      });

      clearSessionCookie(res);
      await disconnectUserSockets(auth.user.id, "PASSWORD_CHANGED");
      res.json({
        success: true,
        data: { passwordChanged: true, reauthRequired: true },
        requestId: res.locals.requestId as string | undefined,
      });
    } catch (err) {
      next(err);
    }
  },
);

  return authRouter;
}
