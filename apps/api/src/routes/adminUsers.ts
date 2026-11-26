import { Router } from "express";
import type { Prisma } from "@prisma/client";
import {
  AuditAction,
  adminCreateUserSchema,
  adminResetPasswordSchema,
  adminUpdateUserSchema,
  adminUpdateUserStatusSchema,
  adminUsersQuerySchema,
  paginationQuerySchema,
  type AdminUserListItemDto,
  type AdminUsersListResponse,
  type ApiSuccessResponse,
  type AuditLogDto,
  type PaginatedResult,
  type UserRole,
  type UserStatus,
} from "@pariksha/shared";
import { getEnv } from "../config/env.js";
import { writeAuditLog } from "../lib/audit.js";
import { generateTemporaryPassword, hashPassword } from "../lib/crypto.js";
import { disconnectUserSockets } from "../lib/realtime.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { getPrismaClient } from "../lib/prisma.js";
import { toAdminUserListItemDto, toAuditLogDto } from "../lib/serializers.js";
import { requireAuth, requireCsrf, requireRoles } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/errorAndValidation.js";

export const adminRouter = Router();

adminRouter.use(requireAuth, requireRoles("ADMIN"));

function isValidUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

adminRouter.get("/users", validateQuery(adminUsersQuerySchema), async (_req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const { page, pageSize, search, role, status } = res.locals.validatedQuery as {
      page: number;
      pageSize: number;
      search?: string;
      role?: UserRole;
      status?: UserStatus;
    };

    const where: Prisma.UserWhereInput = {};
    if (role) where.role = role;
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { fullName: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ];
    }

    const now = new Date();
    const [total, users, roleGroups, statusGroups] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: [{ createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          _count: {
            select: {
              sessions: {
                where: { revokedAt: null, expiresAt: { gt: now } },
              },
            },
          },
        },
      }),
      prisma.user.groupBy({ by: ["role"], _count: { _all: true } }),
      prisma.user.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);

    const byRole = { ADMIN: 0, TEACHER: 0, STUDENT: 0 };
    for (const grp of roleGroups) {
      byRole[grp.role] = grp._count._all;
    }

    let active = 0;
    let inactive = 0;
    let suspended = 0;
    for (const grp of statusGroups) {
      if (grp.status === "ACTIVE") active = grp._count._all;
      if (grp.status === "INACTIVE") inactive = grp._count._all;
      if (grp.status === "SUSPENDED") suspended = grp._count._all;
    }

    const response: ApiSuccessResponse<AdminUsersListResponse> = {
      success: true,
      data: {
        items: users.map((u) => toAdminUserListItemDto(u, u._count.sessions)),
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        summary: {
          total: active + inactive + suspended,
          active,
          inactive,
          suspended,
          byRole,
        },
      },
      requestId: res.locals.requestId as string | undefined,
    };

    res.json(response);
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/users/:id", async (req, res, next) => {
  try {
    if (!isValidUuid(req.params.id ?? "")) {
      next(badRequest("Invalid user identifier", "INVALID_ID"));
      return;
    }
    const prisma = getPrismaClient();
    const now = new Date();
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        _count: {
          select: {
            sessions: {
              where: { revokedAt: null, expiresAt: { gt: now } },
            },
          },
        },
      },
    });
    if (!user) {
      next(notFound("User not found", "USER_NOT_FOUND"));
      return;
    }
    const response: ApiSuccessResponse<AdminUserListItemDto> = {
      success: true,
      data: toAdminUserListItemDto(user, user._count.sessions),
      requestId: res.locals.requestId as string | undefined,
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

adminRouter.post(
  "/users",
  requireCsrf,
  validateBody(adminCreateUserSchema),
  async (req, res, next) => {
    try {
      const auth = req.auth!;
      const prisma = getPrismaClient();
      const { email, fullName, password, role, status } = req.body as {
        email: string;
        fullName: string;
        password: string;
        role: "TEACHER" | "STUDENT";
        status: "ACTIVE" | "INACTIVE";
      };

      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        next(conflict("An account with this email already exists", "EMAIL_EXISTS"));
        return;
      }

      const passwordHash = await hashPassword(password);
      const created = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email,
            fullName,
            passwordHash,
            role,
            status,
          },
        });
        await writeAuditLog(
          {
            actorId: auth.user.id,
            actorRole: auth.user.role,
            action: AuditAction.USER_CREATED,
            entityType: "User",
            entityId: user.id,
            ipAddress: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
            metadata: { role: user.role, status: user.status, email: user.email },
          },
          tx,
        );
        return user;
      });

      const response: ApiSuccessResponse<AdminUserListItemDto> = {
        success: true,
        data: toAdminUserListItemDto(created, 0),
        requestId: res.locals.requestId as string | undefined,
      };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.patch(
  "/users/:id",
  requireCsrf,
  validateBody(adminUpdateUserSchema),
  async (req, res, next) => {
    try {
      if (!isValidUuid(req.params.id ?? "")) {
        next(badRequest("Invalid user identifier", "INVALID_ID"));
        return;
      }
      const auth = req.auth!;
      const prisma = getPrismaClient();
      const targetId = req.params.id!;
      const updates = req.body as {
        email?: string;
        fullName?: string;
        role?: "TEACHER" | "STUDENT";
      };

      const target = await prisma.user.findUnique({ where: { id: targetId } });
      if (!target) {
        next(notFound("User not found", "USER_NOT_FOUND"));
        return;
      }

      if (target.role === "ADMIN" && updates.role) {
        next(conflict("Administrator accounts cannot be demoted through user updates", "ADMIN_ROLE_LOCKED"));
        return;
      }

      if (updates.email && updates.email !== target.email) {
        const dup = await prisma.user.findUnique({ where: { email: updates.email } });
        if (dup) {
          next(conflict("Another account already uses this email address", "EMAIL_EXISTS"));
          return;
        }
      }

      const now = new Date();
      const updated = await prisma.$transaction(async (tx) => {
        const user = await tx.user.update({
          where: { id: targetId },
          data: {
            email: updates.email,
            fullName: updates.fullName,
            role: target.role === "ADMIN" ? undefined : updates.role,
          },
          include: {
            _count: {
              select: {
                sessions: {
                  where: { revokedAt: null, expiresAt: { gt: now } },
                },
              },
            },
          },
        });
        await writeAuditLog(
          {
            actorId: auth.user.id,
            actorRole: auth.user.role,
            action: AuditAction.USER_UPDATED,
            entityType: "User",
            entityId: user.id,
            ipAddress: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
            metadata: {
              changedFields: Object.keys(updates),
            },
          },
          tx,
        );
        return user;
      });

      const response: ApiSuccessResponse<AdminUserListItemDto> = {
        success: true,
        data: toAdminUserListItemDto(updated, updated._count.sessions),
        requestId: res.locals.requestId as string | undefined,
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.patch(
  "/users/:id/status",
  requireCsrf,
  validateBody(adminUpdateUserStatusSchema),
  async (req, res, next) => {
    try {
      if (!isValidUuid(req.params.id ?? "")) {
        next(badRequest("Invalid user identifier", "INVALID_ID"));
        return;
      }
      const auth = req.auth!;
      const prisma = getPrismaClient();
      const targetId = req.params.id!;
      const { status } = req.body as { status: UserStatus };

      const updated = await prisma.$transaction(async (tx) => {
        // Lock target user row to serialize concurrent admin status changes
        const rows = await tx.$queryRaw<Array<{ id: string; role: UserRole; status: UserStatus }>>`
          SELECT id, role, status FROM "User" WHERE id = ${targetId}::uuid FOR UPDATE
        `;
        const target = rows[0];
        if (!target) {
          throw notFound("User not found", "USER_NOT_FOUND");
        }

        if (target.role === "ADMIN" && status !== "ACTIVE") {
          const activeAdmins = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM "User" WHERE role = 'ADMIN' AND status = 'ACTIVE' FOR UPDATE
          `;
          if (activeAdmins.length <= 1 && activeAdmins.some((a) => a.id === target.id)) {
            throw conflict(
              "Cannot deactivate or suspend the last active administrator",
              "LAST_ADMIN_PROTECTED",
            );
          }
        }

        const user = await tx.user.update({
          where: { id: targetId },
          data: { status },
        });

        let revokedCount = 0;
        if (status !== "ACTIVE") {
          const revoked = await tx.session.updateMany({
            where: { userId: targetId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          revokedCount = revoked.count;
        }

        await writeAuditLog(
          {
            actorId: auth.user.id,
            actorRole: auth.user.role,
            action: AuditAction.USER_STATUS_CHANGED,
            entityType: "User",
            entityId: targetId,
            ipAddress: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
            metadata: {
              previousStatus: target.status,
              newStatus: status,
              sessionsRevoked: revokedCount,
            },
          },
          tx,
        );

        return user;
      });

      const activeSessionCount =
        status === "ACTIVE"
          ? await prisma.session.count({
              where: { userId: targetId, revokedAt: null, expiresAt: { gt: new Date() } },
            })
          : 0;

      if (status !== "ACTIVE") {
        await disconnectUserSockets(targetId, "ACCOUNT_INACTIVE");
      }

      const response: ApiSuccessResponse<AdminUserListItemDto> = {
        success: true,
        data: toAdminUserListItemDto(updated, activeSessionCount),
        requestId: res.locals.requestId as string | undefined,
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.post("/users/:id/revoke-sessions", requireCsrf, async (req, res, next) => {
  try {
    if (!isValidUuid(req.params.id ?? "")) {
      next(badRequest("Invalid user identifier", "INVALID_ID"));
      return;
    }
    const auth = req.auth!;
    const prisma = getPrismaClient();
    const targetId = req.params.id!;

    const target = await prisma.user.findUnique({ where: { id: targetId } });
    if (!target) {
      next(notFound("User not found", "USER_NOT_FOUND"));
      return;
    }

    const revokedCount = await prisma.$transaction(async (tx) => {
      const result = await tx.session.updateMany({
        where: { userId: targetId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await writeAuditLog(
        {
          actorId: auth.user.id,
          actorRole: auth.user.role,
          action: AuditAction.USER_SESSIONS_REVOKED,
          entityType: "User",
          entityId: targetId,
          ipAddress: req.ip ?? null,
          userAgent: req.get("user-agent") ?? null,
          metadata: { revokedCount: result.count },
        },
        tx,
      );
      return result.count;
    });

    await disconnectUserSockets(targetId, "ADMIN_REVOKED_SESSIONS");

    res.json({
      success: true,
      data: { userId: targetId, revokedCount },
      requestId: res.locals.requestId as string | undefined,
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post(
  "/users/:id/reset-password",
  requireCsrf,
  validateBody(adminResetPasswordSchema),
  async (req, res, next) => {
    try {
      if (!isValidUuid(req.params.id ?? "")) {
        next(badRequest("Invalid user identifier", "INVALID_ID"));
        return;
      }
      const auth = req.auth!;
      const env = getEnv();
      const prisma = getPrismaClient();
      const targetId = req.params.id!;
      const { newPassword, expiresInHours } = req.body as {
        newPassword?: string;
        expiresInHours?: number;
      };

      const target = await prisma.user.findUnique({ where: { id: targetId } });
      if (!target) {
        next(notFound("User not found", "USER_NOT_FOUND"));
        return;
      }

      const generatedTemporary = !newPassword;
      const temporaryPassword = newPassword ?? generateTemporaryPassword();
      const passwordHash = await hashPassword(temporaryPassword);
      const ttlHours = expiresInHours ?? env.TEMP_PASSWORD_TTL_HOURS;
      const temporaryPasswordExpiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

      const revokedCount = await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: targetId },
          data: {
            passwordHash,
            mustChangePassword: true,
            temporaryPasswordExpiresAt,
            temporaryPasswordUsedAt: null,
          },
        });
        const revoked = await tx.session.updateMany({
          where: { userId: targetId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await writeAuditLog(
          {
            actorId: auth.user.id,
            actorRole: auth.user.role,
            action: AuditAction.USER_PASSWORD_RESET,
            entityType: "User",
            entityId: targetId,
            ipAddress: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
            metadata: {
              generatedTemporary,
              expiresAt: temporaryPasswordExpiresAt.toISOString(),
              sessionsRevoked: revoked.count,
            },
          },
          tx,
        );
        return revoked.count;
      });

      await disconnectUserSockets(targetId, "PASSWORD_RESET");

      res.json({
        success: true,
        data: {
          userId: targetId,
          sessionsRevoked: revokedCount,
          mustChangePassword: true,
          expiresAt: temporaryPasswordExpiresAt.toISOString(),
          temporaryPassword: generatedTemporary ? temporaryPassword : null,
        },
        requestId: res.locals.requestId as string | undefined,
      });
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.get("/audit-logs", validateQuery(paginationQuerySchema), async (_req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const { page, pageSize, search } = res.locals.validatedQuery as {
      page: number;
      pageSize: number;
      search?: string;
    };

    const where: Prisma.AuditLogWhereInput = search
      ? {
          OR: [
            { action: { contains: search, mode: "insensitive" } },
            { entityType: { contains: search, mode: "insensitive" } },
          ],
        }
      : {};

    const [total, items] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const response: ApiSuccessResponse<PaginatedResult<AuditLogDto>> = {
      success: true,
      data: {
        items: items.map(toAuditLogDto),
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
      requestId: res.locals.requestId as string | undefined,
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});
