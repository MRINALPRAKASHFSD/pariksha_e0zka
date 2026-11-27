import type { Prisma, PrismaClient, UserRole } from "@prisma/client";
import { getPrismaClient } from "./prisma.js";

export interface AuditLogInput {
  actorId?: string | null;
  actorRole?: UserRole | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Prisma.InputJsonValue;
}

export async function writeAuditLog(
  input: AuditLogInput,
  tx?: Prisma.TransactionClient | PrismaClient,
): Promise<void> {
  const client = tx ?? getPrismaClient();
  await client.auditLog.create({
    data: {
      actorId: input.actorId ?? null,
      actorRole: input.actorRole ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent?.slice(0, 512) ?? null,
      metadata: input.metadata,
    },
  });
}
