import http from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { createApp } from "./app.js";
import { getEnv } from "./config/env.js";
import { checkDatabaseHealth, disconnectPrisma, getPrismaClient } from "./lib/prisma.js";
import { setRealtimeServer, validateSocketSession } from "./lib/realtime.js";
import {
  SESSION_COOKIE_NAME,
  parseCookieHeader,
  resolveSessionFromToken,
} from "./middleware/auth.js";
import { isValidUuid } from "./services/examSerialization.js";
import {
  startExamExpirationWorker,
  stopExamExpirationWorker,
} from "./services/examExpirationWorker.js";

export function configureSocketServer(server: http.Server, clientOrigin: string): SocketIOServer {
  const io = new SocketIOServer(server, {
    cors: {
      origin: clientOrigin,
      credentials: true,
    },
  });

  setRealtimeServer(io);

  io.use(async (socket, next) => {
    try {
      const cookies = parseCookieHeader(socket.handshake.headers.cookie);
      const rawSessionToken = cookies[SESSION_COOKIE_NAME];
      if (!rawSessionToken) {
        next(new Error("UNAUTHORIZED"));
        return;
      }
      const resolved = await resolveSessionFromToken(rawSessionToken);
      if (!resolved || resolved.user.status !== "ACTIVE") {
        next(new Error("UNAUTHORIZED"));
        return;
      }
      socket.data.userId = resolved.user.id;
      socket.data.role = resolved.user.role;
      socket.data.sessionId = resolved.sessionId;
      next();
    } catch {
      next(new Error("UNAUTHORIZED"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.data.userId as string;
    const role = socket.data.role as string;
    const sessionId = socket.data.sessionId as string;
    void socket.join(`user:${userId}`);
    void socket.join(`session:${sessionId}`);
    if (role === "ADMIN") {
      void socket.join("admin:proctoring");
    }

    // Re-validate session on every incoming client event instead of trusting handshake alone
    socket.use(async (_packet, next) => {
      try {
        const valid = await validateSocketSession(sessionId);
        if (!valid) {
          socket.emit("auth:session-invalidated", { reason: "SESSION_INVALID" });
          socket.disconnect(true);
          next(new Error("UNAUTHORIZED"));
          return;
        }
        next();
      } catch {
        next(new Error("UNAUTHORIZED"));
      }
    });

    socket.on("proctoring:join-attempt", async (payload: unknown, ack?: (res: { ok: boolean; error?: string }) => void) => {
      try {
        const attemptId =
          typeof payload === "object" && payload !== null && typeof (payload as { attemptId?: unknown }).attemptId === "string"
            ? (payload as { attemptId: string }).attemptId
            : "";
        if (!isValidUuid(attemptId)) {
          ack?.({ ok: false, error: "INVALID_ATTEMPT_ID" });
          return;
        }
        const validSession = await validateSocketSession(sessionId);
        if (!validSession) {
          socket.emit("auth:session-invalidated", { reason: "SESSION_INVALID" });
          socket.disconnect(true);
          ack?.({ ok: false, error: "UNAUTHORIZED" });
          return;
        }

        const prisma = getPrismaClient();
        const attempt = await prisma.examAttempt.findUnique({
          where: { id: attemptId },
          select: {
            id: true,
            studentId: true,
            exam: { select: { course: { select: { teacherId: true } } } },
          },
        });
        if (!attempt) {
          ack?.({ ok: false, error: "ATTEMPT_NOT_FOUND" });
          return;
        }
        const allowed =
          role === "ADMIN" ||
          (role === "STUDENT" && attempt.studentId === userId) ||
          (role === "TEACHER" && attempt.exam.course.teacherId === userId);
        if (!allowed) {
          ack?.({ ok: false, error: "FORBIDDEN" });
          return;
        }

        await socket.join(`attempt:${attempt.id}`);
        ack?.({ ok: true });
      } catch {
        ack?.({ ok: false, error: "JOIN_FAILED" });
      }
    });

    socket.on("proctoring:join-admin-monitor", async (ack?: (res: { ok: boolean; error?: string }) => void) => {
      const validSession = await validateSocketSession(sessionId);
      if (!validSession) {
        socket.emit("auth:session-invalidated", { reason: "SESSION_INVALID" });
        socket.disconnect(true);
        ack?.({ ok: false, error: "UNAUTHORIZED" });
        return;
      }
      if (role !== "ADMIN") {
        ack?.({ ok: false, error: "FORBIDDEN" });
        return;
      }
      await socket.join("admin:proctoring");
      ack?.({ ok: true });
    });

    socket.emit("system:connected", {
      service: "pariksha-realtime",
      userId,
      role: socket.data.role,
      timestamp: new Date().toISOString(),
    });
  });

  // Periodic background sweep disconnects sockets whose sessions expired or were revoked
  const sweepTimer = setInterval(() => {
    void (async () => {
      const sockets = await io.fetchSockets();
      for (const socket of sockets) {
        const sid = socket.data.sessionId as string | undefined;
        if (!sid || !(await validateSocketSession(sid))) {
          socket.emit("auth:session-invalidated", { reason: "SESSION_EXPIRED" });
          socket.disconnect(true);
        }
      }
    })();
  }, 30_000);
  sweepTimer.unref();

  return io;
}

async function startServer() {
  const env = getEnv();
  const app = createApp();
  const server = http.createServer(app);
  const io = configureSocketServer(server, env.CLIENT_ORIGIN);

  const dbHealth = await checkDatabaseHealth();
  if (!dbHealth.connected) {
    console.warn("[pariksha-api] Warning: Database connectivity check failed on startup.");
  } else {
    startExamExpirationWorker();
  }

  server.listen(env.PORT, () => {
    console.log(`[pariksha-api] Listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[pariksha-api] Received ${signal}, shutting down cleanly...`);
    stopExamExpirationWorker();
    setRealtimeServer(null);
    io.close();
    server.close(async () => {
      await disconnectPrisma();
      process.exit(0);
    });
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (process.env.NODE_ENV !== "test") {
  void startServer();
}
