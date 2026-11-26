import type { Server as SocketIOServer } from "socket.io";
import { getPrismaClient } from "./prisma.js";

let activeIo: SocketIOServer | null = null;

export function setRealtimeServer(io: SocketIOServer | null): void {
  activeIo = io;
}

export function getRealtimeServer(): SocketIOServer | null {
  return activeIo;
}

/**
 * Immediately notify and disconnect active Socket.IO sockets when a user's session
 * is revoked, expired, or deactivated.
 */
export async function disconnectUserSockets(userId: string, reason = "SESSION_REVOKED"): Promise<void> {
  if (!activeIo) return;
  const sockets = await activeIo.in(`user:${userId}`).fetchSockets();
  for (const socket of sockets) {
    socket.emit("auth:session-invalidated", { reason });
    socket.disconnect(true);
  }
}

export async function disconnectSessionSockets(
  sessionId: string,
  reason = "SESSION_REVOKED",
): Promise<void> {
  if (!activeIo) return;
  const sockets = await activeIo.in(`session:${sessionId}`).fetchSockets();
  for (const socket of sockets) {
    socket.emit("auth:session-invalidated", { reason });
    socket.disconnect(true);
  }
}

export async function validateSocketSession(sessionId: string): Promise<boolean> {
  if (!sessionId) return false;
  const prisma = getPrismaClient();
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: { select: { status: true } } },
  });
  if (!session) return false;
  if (session.revokedAt !== null || session.expiresAt <= new Date()) return false;
  if (session.user.status !== "ACTIVE") return false;
  return true;
}
