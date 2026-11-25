import { PrismaClient } from "@prisma/client";
import { getEnv } from "../config/env.js";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export function getPrismaClient(): PrismaClient {
  if (!globalForPrisma.prisma) {
    const env = getEnv();
    globalForPrisma.prisma = new PrismaClient({
      log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
  }
  return globalForPrisma.prisma;
}

export async function checkDatabaseHealth(): Promise<{ connected: boolean; latencyMs: number | null }> {
  const start = performance.now();
  try {
    const prisma = getPrismaClient();
    await prisma.$queryRaw`SELECT 1`;
    return {
      connected: true,
      latencyMs: Math.round((performance.now() - start) * 100) / 100,
    };
  } catch {
    return {
      connected: false,
      latencyMs: null,
    };
  }
}

export async function disconnectPrisma(): Promise<void> {
  if (globalForPrisma.prisma) {
    await globalForPrisma.prisma.$disconnect();
    globalForPrisma.prisma = undefined;
  }
}
