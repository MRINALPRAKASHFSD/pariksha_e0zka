import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetEnvCacheForTest } from "../src/config/env.js";
import { hashPassword } from "../src/lib/crypto.js";
import { disconnectPrisma, getPrismaClient } from "../src/lib/prisma.js";
import { resetTestDatabase } from "./testDbGuard.js";

describe("Phase 2 Authentication, RBAC & Admin User Management", () => {
  const prisma = getPrismaClient();
  const app = createApp();

  async function seedActors() {
    const adminHash = await hashPassword("AdminPass!2026");
    const teacherHash = await hashPassword("TeacherPass!2026");
    const studentHash = await hashPassword("StudentPass!2026");

    const admin = await prisma.user.create({
      data: {
        email: "admin@pariksha.test",
        fullName: "System Admin",
        passwordHash: adminHash,
        role: "ADMIN",
        status: "ACTIVE",
      },
    });
    const teacher = await prisma.user.create({
      data: {
        email: "teacher@pariksha.test",
        fullName: "Prof. Rao",
        passwordHash: teacherHash,
        role: "TEACHER",
        status: "ACTIVE",
      },
    });
    const student = await prisma.user.create({
      data: {
        email: "student@pariksha.test",
        fullName: "Rohan Student",
        passwordHash: studentHash,
        role: "STUDENT",
        status: "ACTIVE",
      },
    });
    const inactive = await prisma.user.create({
      data: {
        email: "inactive@pariksha.test",
        fullName: "Inactive User",
        passwordHash: studentHash,
        role: "STUDENT",
        status: "INACTIVE",
      },
    });
    return { admin, teacher, student, inactive };
  }

  async function loginAgent(email: string, password: string, targetApp = app) {
    const agent = request.agent(targetApp);
    const csrfRes = await agent.get("/api/v1/auth/csrf");
    expect(csrfRes.status).toBe(200);
    const csrfToken = csrfRes.body.data.csrfToken as string;

    const loginRes = await agent
      .post("/api/v1/auth/login")
      .set("X-CSRF-Token", csrfToken)
      .send({ email, password });

    return { agent, csrfRes, loginRes };
  }

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await resetTestDatabase();
    await disconnectPrisma();
  });

  it("1 & 5 & 18. Valid login sets HttpOnly cookie, restores session via /me, and excludes sensitive fields", async () => {
    await seedActors();
    const { agent, loginRes } = await loginAgent("admin@pariksha.test", "AdminPass!2026");

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.success).toBe(true);
    expect(loginRes.body.data.user.email).toBe("admin@pariksha.test");
    expect(loginRes.body.data.user.passwordHash).toBeUndefined();
    expect(loginRes.body.data.csrfToken).toBeTruthy();

    const cookies = (loginRes.headers["set-cookie"] as unknown as string[]) ?? [];
    const sessionCookie = cookies.find((c) => c.startsWith("pariksha_session=")) ?? "";
    expect(sessionCookie).toContain("pariksha_session=");
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("SameSite=Lax");

    const meRes = await agent.get("/api/v1/auth/me");
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.user.email).toBe("admin@pariksha.test");
    expect(meRes.body.data.user.passwordHash).toBeUndefined();

    const listRes = await agent.get("/api/v1/admin/users");
    expect(listRes.status).toBe(200);
    expect(JSON.stringify(listRes.body)).not.toContain("passwordHash");
    expect(JSON.stringify(listRes.body)).not.toContain("tokenHash");
    expect(JSON.stringify(listRes.body)).not.toContain("csrfTokenHash");
  });

  it("2. Invalid credentials return uniform 401 without user enumeration", async () => {
    await seedActors();
    const wrongPass = await loginAgent("admin@pariksha.test", "WrongPass!999");
    const unknownEmail = await loginAgent("missing@pariksha.test", "WrongPass!999");

    expect(wrongPass.loginRes.status).toBe(401);
    expect(unknownEmail.loginRes.status).toBe(401);
    expect(wrongPass.loginRes.body.error.message).toBe("Invalid email or password");
    expect(unknownEmail.loginRes.body.error.message).toBe("Invalid email or password");
  });

  it("3. Inactive account login is rejected", async () => {
    await seedActors();
    const { loginRes } = await loginAgent("inactive@pariksha.test", "StudentPass!2026");
    expect(loginRes.status).toBe(403);
    expect(loginRes.body.error.code).toBe("ACCOUNT_INACTIVE");
  });

  it("4. Expired session is rejected with 401", async () => {
    const { admin } = await seedActors();
    const { agent } = await loginAgent("admin@pariksha.test", "AdminPass!2026");

    await prisma.session.updateMany({
      where: { userId: admin.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const meRes = await agent.get("/api/v1/auth/me");
    expect(meRes.status).toBe(401);
  });

  it("6. Logout revokes session in database and rejects subsequent /me", async () => {
    await seedActors();
    const { agent, loginRes } = await loginAgent("teacher@pariksha.test", "TeacherPass!2026");
    const csrfToken = loginRes.body.data.csrfToken as string;

    const logoutRes = await agent.post("/api/v1/auth/logout").set("X-CSRF-Token", csrfToken);
    expect(logoutRes.status).toBe(200);

    const meAfter = await agent.get("/api/v1/auth/me");
    expect(meAfter.status).toBe(401);
  });

  it("7. Missing or invalid CSRF token and cross-site login origins are rejected", async () => {
    await seedActors();

    // Missing pre-auth CSRF on login
    const noCsrfLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@pariksha.test", password: "AdminPass!2026" });
    expect(noCsrfLogin.status).toBe(403);

    // Cross-site Origin blocked on login
    const agent = request.agent(app);
    const csrfRes = await agent.get("/api/v1/auth/csrf");
    const preCsrf = csrfRes.body.data.csrfToken as string;
    const crossOriginLogin = await agent
      .post("/api/v1/auth/login")
      .set("Origin", "https://evil.example")
      .set("X-CSRF-Token", preCsrf)
      .send({ email: "admin@pariksha.test", password: "AdminPass!2026" });
    expect(crossOriginLogin.status).toBe(403);
    expect(crossOriginLogin.body.error.code).toBe("ORIGIN_MISMATCH");

    // Authenticated mutation without CSRF token
    const { agent: authed } = await loginAgent("admin@pariksha.test", "AdminPass!2026");
    const badCreate = await authed.post("/api/v1/admin/users").send({
      email: "newstudent@pariksha.test",
      fullName: "New Student",
      password: "Password1234",
      role: "STUDENT",
    });
    expect(badCreate.status).toBe(403);
    expect(badCreate.body.error.code).toBe("CSRF_INVALID");
  });

  it("8, 9, 10, 11. Enforces 401 unauthenticated and 403 RBAC isolation across roles", async () => {
    await seedActors();

    const unauth = await request(app).get("/api/v1/admin/users");
    expect(unauth.status).toBe(401);

    const { agent: studentAgent } = await loginAgent("student@pariksha.test", "StudentPass!2026");
    expect((await studentAgent.get("/api/v1/admin/users")).status).toBe(403);
    expect((await studentAgent.get("/api/v1/teacher/dashboard")).status).toBe(403);
    expect((await studentAgent.get("/api/v1/student/dashboard")).status).toBe(200);

    const { agent: teacherAgent } = await loginAgent("teacher@pariksha.test", "TeacherPass!2026");
    expect((await teacherAgent.get("/api/v1/admin/users")).status).toBe(403);
    expect((await teacherAgent.get("/api/v1/student/dashboard")).status).toBe(403);
    expect((await teacherAgent.get("/api/v1/teacher/dashboard")).status).toBe(200);

    const { agent: adminAgent } = await loginAgent("admin@pariksha.test", "AdminPass!2026");
    expect((await adminAgent.get("/api/v1/teacher/dashboard")).status).toBe(403);
    expect((await adminAgent.get("/api/v1/student/dashboard")).status).toBe(403);
  });

  it("12, 13, 16. Admin creates teacher/student, rejects duplicate email, and blocks privilege escalation", async () => {
    const { student } = await seedActors();
    const { agent, loginRes } = await loginAgent("admin@pariksha.test", "AdminPass!2026");
    const csrf = loginRes.body.data.csrfToken as string;

    const createTeacher = await agent
      .post("/api/v1/admin/users")
      .set("X-CSRF-Token", csrf)
      .send({
        email: "new.teacher@pariksha.test",
        fullName: "New Teacher",
        password: "TeacherNew!2026",
        role: "TEACHER",
      });
    expect(createTeacher.status).toBe(201);
    expect(createTeacher.body.data.role).toBe("TEACHER");

    const createStudent = await agent
      .post("/api/v1/admin/users")
      .set("X-CSRF-Token", csrf)
      .send({
        email: "new.student@pariksha.test",
        fullName: "New Student",
        password: "StudentNew!2026",
        role: "STUDENT",
      });
    expect(createStudent.status).toBe(201);

    // Duplicate email
    const dupRes = await agent
      .post("/api/v1/admin/users")
      .set("X-CSRF-Token", csrf)
      .send({
        email: "new.student@pariksha.test",
        fullName: "Dup Student",
        password: "StudentNew!2026",
        role: "STUDENT",
      });
    expect(dupRes.status).toBe(409);

    // Privilege escalation via role=ADMIN blocked on create & update
    const escalateCreate = await agent
      .post("/api/v1/admin/users")
      .set("X-CSRF-Token", csrf)
      .send({
        email: "rogue.admin@pariksha.test",
        fullName: "Rogue Admin",
        password: "RoguePass!2026",
        role: "ADMIN",
      });
    expect(escalateCreate.status).toBe(400);

    const escalateUpdate = await agent
      .patch(`/api/v1/admin/users/${student.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ role: "ADMIN" });
    expect(escalateUpdate.status).toBe(400);
  });

  it("14, 15, 17. Deactivation invalidates active sessions and protects the last active admin", async () => {
    const { admin, student } = await seedActors();
    const { agent: adminAgent, loginRes: adminLogin } = await loginAgent(
      "admin@pariksha.test",
      "AdminPass!2026",
    );
    const adminCsrf = adminLogin.body.data.csrfToken as string;

    const { agent: studentAgent } = await loginAgent("student@pariksha.test", "StudentPass!2026");
    expect((await studentAgent.get("/api/v1/auth/me")).status).toBe(200);

    // Deactivate student
    const deactivate = await adminAgent
      .patch(`/api/v1/admin/users/${student.id}/status`)
      .set("X-CSRF-Token", adminCsrf)
      .send({ status: "INACTIVE" });
    expect(deactivate.status).toBe(200);
    expect(deactivate.body.data.status).toBe("INACTIVE");

    // Existing student session immediately revoked and rejected with 401
    const studentMeAfter = await studentAgent.get("/api/v1/auth/me");
    expect(studentMeAfter.status).toBe(401);

    // Reactivate student
    const reactivate = await adminAgent
      .patch(`/api/v1/admin/users/${student.id}/status`)
      .set("X-CSRF-Token", adminCsrf)
      .send({ status: "ACTIVE" });
    expect(reactivate.status).toBe(200);
    expect(reactivate.body.data.status).toBe("ACTIVE");

    // Protect last active admin from deactivation
    const deactivateLastAdmin = await adminAgent
      .patch(`/api/v1/admin/users/${admin.id}/status`)
      .set("X-CSRF-Token", adminCsrf)
      .send({ status: "INACTIVE" });
    expect(deactivateLastAdmin.status).toBe(409);
    expect(deactivateLastAdmin.body.error.code).toBe("LAST_ADMIN_PROTECTED");
  });

  it("19. Enforces login rate limiting", async () => {
    await seedActors();
    const prevMax = process.env.AUTH_RATE_LIMIT_MAX_REQUESTS;
    process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = "5";
    resetEnvCacheForTest();
    const rateLimitedApp = createApp();

    try {
      const agent = request.agent(rateLimitedApp);
      const csrfRes = await agent.get("/api/v1/auth/csrf");
      const csrf = csrfRes.body.data.csrfToken as string;

      for (let i = 0; i < 5; i++) {
        const res = await agent
          .post("/api/v1/auth/login")
          .set("X-CSRF-Token", csrf)
          .send({ email: "admin@pariksha.test", password: "WrongPassword!1" });
        expect(res.status).toBe(401);
      }

      const blocked = await agent
        .post("/api/v1/auth/login")
        .set("X-CSRF-Token", csrf)
        .send({ email: "admin@pariksha.test", password: "WrongPassword!1" });
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
    } finally {
      if (prevMax === undefined) delete process.env.AUTH_RATE_LIMIT_MAX_REQUESTS;
      else process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = prevMax;
      resetEnvCacheForTest();
    }
  });

  it("22. Password change invalidates existing sessions and accepts the new password", async () => {
    await seedActors();
    const freshApp = createApp();
    const { agent: sessionA, loginRes: loginA } = await loginAgent(
      "student@pariksha.test",
      "StudentPass!2026",
      freshApp,
    );
    expect(loginA.status).toBe(200);
    const { agent: sessionB, loginRes: loginB } = await loginAgent(
      "student@pariksha.test",
      "StudentPass!2026",
      freshApp,
    );
    expect(loginB.status).toBe(200);

    const changeRes = await sessionA
      .post("/api/v1/auth/change-password")
      .set("X-CSRF-Token", loginA.body.data.csrfToken as string)
      .send({
        currentPassword: "StudentPass!2026",
        newPassword: "StudentUpdated!2026",
      });
    expect(changeRes.status).toBe(200);

    // Both old sessions invalidated
    expect((await sessionA.get("/api/v1/auth/me")).status).toBe(401);
    expect((await sessionB.get("/api/v1/auth/me")).status).toBe(401);

    // Old password rejected, new password accepted
    const oldLogin = await loginAgent("student@pariksha.test", "StudentPass!2026", freshApp);
    expect(oldLogin.loginRes.status).toBe(401);

    const newLogin = await loginAgent("student@pariksha.test", "StudentUpdated!2026", freshApp);
    expect(newLogin.loginRes.status).toBe(200);
  });
});
