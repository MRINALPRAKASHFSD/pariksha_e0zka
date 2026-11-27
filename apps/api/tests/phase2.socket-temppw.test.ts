import http from "node:http";
import request from "supertest";
import { io as ioClient } from "socket.io-client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/lib/crypto.js";
import { disconnectPrisma, getPrismaClient } from "../src/lib/prisma.js";
import { configureSocketServer } from "../src/server.js";
import { resetTestDatabase } from "./testDbGuard.js";

describe("Phase 2 Corrective Audit: Temporary Passwords & Socket.IO Revocation", () => {
  const prisma = getPrismaClient();
  const app = createApp();

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await resetTestDatabase();
    await disconnectPrisma();
  });

  async function loginAgent(email: string, password: string, targetApp = app) {
    const agent = request.agent(targetApp);
    const csrfRes = await agent.get("/api/v1/auth/csrf");
    const csrfToken = csrfRes.body.data.csrfToken as string;
    const loginRes = await agent
      .post("/api/v1/auth/login")
      .set("X-CSRF-Token", csrfToken)
      .send({ email, password });
    return { agent, loginRes };
  }

  it("enforces temporary password expiry, single-use, and mandatory password change", async () => {
    const adminHash = await hashPassword("AdminPass!2026");
    const studentHash = await hashPassword("StudentPass!2026");

    await prisma.user.create({
      data: {
        email: "admin@pariksha.test",
        fullName: "Admin",
        passwordHash: adminHash,
        role: "ADMIN",
      },
    });
    const student = await prisma.user.create({
      data: {
        email: "student@pariksha.test",
        fullName: "Student",
        passwordHash: studentHash,
        role: "STUDENT",
      },
    });

    const { agent: adminAgent, loginRes: adminLogin } = await loginAgent(
      "admin@pariksha.test",
      "AdminPass!2026",
    );
    const adminCsrf = adminLogin.body.data.csrfToken as string;

    // 1. Admin issues temporary password
    const resetRes = await adminAgent
      .post(`/api/v1/admin/users/${student.id}/reset-password`)
      .set("X-CSRF-Token", adminCsrf)
      .send({});
    expect(resetRes.status).toBe(200);
    const tempPassword = resetRes.body.data.temporaryPassword as string;
    expect(tempPassword).toBeTruthy();

    // 2. First login with temporary password succeeds with mustChangePassword=true
    const { agent: tempAgent, loginRes: tempLogin } = await loginAgent(
      "student@pariksha.test",
      tempPassword,
    );
    expect(tempLogin.status).toBe(200);
    expect(tempLogin.body.data.user.mustChangePassword).toBe(true);

    // 3. Reusing the single-use temporary password in a second login is rejected
    const { loginRes: reuseLogin } = await loginAgent("student@pariksha.test", tempPassword);
    expect(reuseLogin.status).toBe(403);
    expect(reuseLogin.body.error.code).toBe("TEMPORARY_PASSWORD_USED");

    // 4. Restricted session cannot access /student/dashboard until password changed
    const blockedDash = await tempAgent.get("/api/v1/student/dashboard");
    expect(blockedDash.status).toBe(403);
    expect(blockedDash.body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");

    // 5. Mandatory password change succeeds and unlocks full access on re-login
    const changeRes = await tempAgent
      .post("/api/v1/auth/change-password")
      .set("X-CSRF-Token", tempLogin.body.data.csrfToken as string)
      .send({
        currentPassword: tempPassword,
        newPassword: "PermanentPass!2026",
      });
    expect(changeRes.status).toBe(200);

    const { agent: finalAgent, loginRes: finalLogin } = await loginAgent(
      "student@pariksha.test",
      "PermanentPass!2026",
    );
    expect(finalLogin.status).toBe(200);
    expect(finalLogin.body.data.user.mustChangePassword).toBe(false);
    expect((await finalAgent.get("/api/v1/student/dashboard")).status).toBe(200);

    // 6. Expired temporary password login is rejected
    await prisma.user.update({
      where: { id: student.id },
      data: {
        mustChangePassword: true,
        temporaryPasswordExpiresAt: new Date(Date.now() - 60_000),
        temporaryPasswordUsedAt: null,
      },
    });
    const { loginRes: expiredLogin } = await loginAgent(
      "student@pariksha.test",
      "PermanentPass!2026",
    );
    expect(expiredLogin.status).toBe(403);
    expect(expiredLogin.body.error.code).toBe("TEMPORARY_PASSWORD_EXPIRED");
  });

  it("disconnects active Socket.IO clients upon account deactivation or session revocation", async () => {
    const adminHash = await hashPassword("AdminPass!2026");
    const studentHash = await hashPassword("StudentPass!2026");
    await prisma.user.create({
      data: { email: "admin@pariksha.test", fullName: "Admin", passwordHash: adminHash, role: "ADMIN" },
    });
    const student = await prisma.user.create({
      data: {
        email: "student@pariksha.test",
        fullName: "Socket Student",
        passwordHash: studentHash,
        role: "STUDENT",
      },
    });

    const server = http.createServer(app);
    const io = configureSocketServer(server, "http://localhost:5173");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;

    try {
      // Login via HTTP to obtain HttpOnly session cookie
      const studentAgent = request.agent(app);
      const csrfRes = await studentAgent.get("/api/v1/auth/csrf");
      const loginRes = await studentAgent
        .post("/api/v1/auth/login")
        .set("X-CSRF-Token", csrfRes.body.data.csrfToken as string)
        .send({ email: "student@pariksha.test", password: "StudentPass!2026" });
      const rawCookie = (loginRes.headers["set-cookie"] as unknown as string[]).find((c) =>
        c.startsWith("pariksha_session="),
      )!;
      const cookieHeader = rawCookie.split(";")[0]!;

      const socket = ioClient(`http://127.0.0.1:${port}`, {
        extraHeaders: { cookie: cookieHeader },
        reconnection: false,
      });

      await new Promise<void>((resolve, reject) => {
        socket.on("system:connected", () => resolve());
        socket.on("connect_error", (err) => reject(err));
      });

      const disconnectedPromise = new Promise<string>((resolve) => {
        socket.on("disconnect", (reason) => resolve(reason));
      });

      // Admin deactivates student -> active socket must be disconnected immediately
      const { agent: adminAgent, loginRes: adminLogin } = await loginAgent(
        "admin@pariksha.test",
        "AdminPass!2026",
      );
      const deactivate = await adminAgent
        .patch(`/api/v1/admin/users/${student.id}/status`)
        .set("X-CSRF-Token", adminLogin.body.data.csrfToken as string)
        .send({ status: "INACTIVE" });
      expect(deactivate.status).toBe(200);

      const reason = await disconnectedPromise;
      expect(reason).toBeTruthy();
      socket.close();
    } finally {
      io.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
