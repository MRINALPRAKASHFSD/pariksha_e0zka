import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import request from "supertest";
import { io as ioClient } from "socket.io-client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { IntegrityEventType } from "@pariksha/shared";
import { createApp } from "../src/app.js";
import { getEnv } from "../src/config/env.js";
import { disconnectPrisma, getPrismaClient } from "../src/lib/prisma.js";
import { setRealtimeServer } from "../src/lib/realtime.js";
import { configureSocketServer } from "../src/server.js";
import { resetTestDatabase } from "./testDbGuard.js";
import { loginAs, seedPhase4BaseActors } from "./phase4TestHelpers.js";
import {
  createActiveProctoredExam,
  issuePreflightAndStartAttempt,
} from "./phase5TestHelpers.js";

async function loginWithCookie(app: ReturnType<typeof createApp>, email: string) {
  const agent = request.agent(app);
  const csrfRes = await agent.get("/api/v1/auth/csrf");
  const csrf = csrfRes.body.data.csrfToken as string;
  const loginRes = await agent
    .post("/api/v1/auth/login")
    .set("X-CSRF-Token", csrf)
    .send({ email, password: "Phase4Pass!2026" });
  const rawCookie = (loginRes.headers["set-cookie"] as unknown as string[]).find((c) =>
    c.startsWith("pariksha_session="),
  )!;
  return {
    agent,
    csrf: loginRes.body.data.csrfToken as string,
    cookieHeader: rawCookie.split(";")[0]!,
  };
}

describe("Phase 5 Privacy, Admin/Teacher Analytics, CSV Export, RBAC & Socket.IO Authorization (Tests 45-55)", () => {
  let app = createApp();
  const prisma = getPrismaClient();

  beforeEach(async () => {
    app = createApp();
    await resetTestDatabase();
  });

  afterAll(async () => {
    setRealtimeServer(null);
    await disconnectPrisma();
  });

  it("45. Admin live proctoring attempts monitor exposes status, strike counts, and client-reported media disclaimer", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.CAMERA_INTERRUPTED,
      });

    const admin = await loginAs(app, actors.admin.email);
    const monRes = await admin.agent.get("/api/v1/admin/proctoring/attempts?status=PAUSED");
    expect(monRes.status).toBe(200);
    expect(monRes.body.data.mediaStatusDisclaimer).toContain("client-reported");
    expect(monRes.body.data.items).toHaveLength(1);
    expect(monRes.body.data.items[0].id).toBe(attemptId);
    expect(monRes.body.data.items[0].violationCount).toBe(1);
    expect(monRes.body.data.items[0].cameraActive).toBe(false);
  });

  it("46. Admin proctoring events endpoint filters by eventType, severity, examId, attemptId, and search query", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.EXTENSION_HEURISTIC,
      });
    await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.COPY_ATTEMPT,
      });

    const admin = await loginAs(app, actors.admin.email);
    const byType = await admin.agent.get(
      `/api/v1/admin/proctoring/events?examId=${examId}&attemptId=${attemptId}&eventType=COPY_ATTEMPT`,
    );
    expect(byType.status).toBe(200);
    expect(byType.body.data.items).toHaveLength(1);
    expect(byType.body.data.items[0].eventType).toBe("COPY_ATTEMPT");

    const bySeverity = await admin.agent.get(
      `/api/v1/admin/proctoring/events?severity=WARNING`,
    );
    expect(bySeverity.status).toBe(200);
    expect(bySeverity.body.data.items[0].eventType).toBe("EXTENSION_HEURISTIC");
  });

  it("47. Admin integrity CSV export neutralizes spreadsheet formula prefixes and logs audit event", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.TAB_SWITCH,
        description: "=HYPERLINK(\"http://evil.example\") Attempt",
      });

    const admin = await loginAs(app, actors.admin.email);
    const csvRes = await admin.agent.get("/api/v1/admin/proctoring/events/export");
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers["content-type"]).toContain("text/csv");
    expect(csvRes.text).toContain("'=HYPERLINK");

    const exportAudit = await prisma.auditLog.findFirst({
      where: { action: "PROCTORING_EVENTS_EXPORTED" },
    });
    expect(exportAudit).not.toBeNull();
  });

  it("48. Admin can manually terminate an active or paused attempt from proctoring workflow cleanly", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.CAMERA_INTERRUPTED,
      });

    const admin = await loginAs(app, actors.admin.email);
    const termRes = await admin.agent
      .post(`/api/v1/admin/exams/${examId}/attempts/${attemptId}/terminate`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ reason: "Terminated after review" });
    expect(termRes.status).toBe(200);
    expect(termRes.body.data.receipt.reason).toBe("ADMIN_FORCE");

    const attempt = await prisma.examAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.status).toBe("TERMINATED");
    expect(attempt.isLocked).toBe(true);
  });

  it("49. Assigned course teacher can read exam-scoped integrity timelines and attempt events (read-only)", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.FULLSCREEN_EXIT,
      });

    const teacher = await loginAs(app, actors.teacher.email);
    const listRes = await teacher.agent.get(`/api/v1/teacher/exams/${examId}/integrity-events`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);

    const attemptEventsRes = await teacher.agent.get(
      `/api/v1/teacher/exams/${examId}/attempts/${attemptId}/events`,
    );
    expect(attemptEventsRes.status).toBe(200);
    expect(attemptEventsRes.body.data).toHaveLength(1);
    expect(attemptEventsRes.body.data[0].attemptId).toBe(attemptId);
  });

  it("50. Unassigned teachers get 403 on foreign exam timelines and teachers cannot mutate policies", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const otherTeacher = await loginAs(app, actors.otherTeacher.email);
    const teacher = await loginAs(app, actors.teacher.email);

    expect(
      (await otherTeacher.agent.get(`/api/v1/teacher/exams/${examId}/integrity-events`)).status,
    ).toBe(403);

    expect(
      (
        await teacher.agent
          .patch(`/api/v1/admin/proctoring/exams/${examId}/policy`)
          .set("X-CSRF-Token", teacher.csrf)
          .send({ violationThreshold: 9 })
      ).status,
    ).toBe(403);
  });

  it("51. Student cannot view admin/teacher integrity logs, exports, or another student's telemetry", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });
    const otherStudent = await loginAs(app, actors.otherStudent.email);

    expect((await student.agent.get("/api/v1/admin/proctoring/attempts")).status).toBe(403);
    expect((await student.agent.get("/api/v1/admin/proctoring/events/export")).status).toBe(403);
    expect(
      (await student.agent.get(`/api/v1/teacher/exams/${examId}/integrity-events`)).status,
    ).toBe(403);

    const hijackEvent = await otherStudent.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", otherStudent.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.COPY_ATTEMPT,
      });
    expect(hijackEvent.status).toBe(403);

    const hijackHb = await otherStudent.agent
      .post(`/api/v1/student/attempts/${attemptId}/heartbeat`)
      .set("X-CSRF-Token", otherStudent.csrf)
      .send({
        sequence: 1,
        cameraActive: true,
        screenShareActive: true,
        fullscreenActive: true,
      });
    expect(hijackHb.status).toBe(403);
  });

  it("52. Privacy guarantee: zero video/audio media blobs persisted in DB or upload directories", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    // Oversized / media payload rejected or never persisted as binary stream
    const ev = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.CAMERA_INTERRUPTED,
        metadata: { reason: "ended" },
      });
    expect(ev.status).toBe(200);

    const dbHandshake = await prisma.preflightHandshake.findFirst({
      where: { consumedAttemptId: attemptId },
    });
    const dbAttempt = await prisma.examAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    const serialized = JSON.stringify({ dbHandshake, dbAttempt });
    expect(serialized).not.toContain("data:video/");
    expect(serialized).not.toContain("data:image/");

    const uploadDir = getEnv().UPLOAD_DIR;
    if (uploadDir && fs.existsSync(uploadDir)) {
      const files = fs.readdirSync(uploadDir);
      expect(files.some((f) => f.includes(attemptId) || f.endsWith(".webm") || f.endsWith(".mp4"))).toBe(
        false,
      );
    }
  });

  it("53. Non-production allowUnproctoredDev=true remains fully functional with zero camera/screen handshakes", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({
      app,
      actors,
      allowUnproctoredDev: true,
    });
    const student = await loginAs(app, actors.student.email);

    const startRes = await student.agent
      .post(`/api/v1/student/exams/${examId}/start`)
      .set("X-CSRF-Token", student.csrf)
      .send({});

    expect(startRes.status).toBe(201);
    expect(startRes.body.data.allowUnproctoredDev).toBe(true);
    expect(startRes.body.data.policy.requireWebcam).toBe(false);
    expect(startRes.body.data.policy.requireScreenShare).toBe(false);
  });

  it("54. Socket.IO room authorization enforces attempt ownership and rejects foreign users / non-admins", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const studentAuth = await loginWithCookie(app, actors.student.email);
    const otherStudentAuth = await loginWithCookie(app, actors.otherStudent.email);
    const teacherAuth = await loginWithCookie(app, actors.teacher.email);
    const otherTeacherAuth = await loginWithCookie(app, actors.otherTeacher.email);
    const adminAuth = await loginWithCookie(app, actors.admin.email);

    const { attemptId } = await issuePreflightAndStartAttempt({
      student: { agent: studentAuth.agent, csrf: studentAuth.csrf },
      examId,
    });

    const server = http.createServer(app);
    const io = configureSocketServer(server, "http://localhost:5173");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;

    const connectClient = async (cookieHeader: string) => {
      const sock = ioClient(`http://127.0.0.1:${port}`, {
        extraHeaders: { cookie: cookieHeader },
        reconnection: false,
      });
      await new Promise<void>((resolve, reject) => {
        sock.on("system:connected", () => resolve());
        sock.on("connect_error", (e) => reject(e));
      });
      return sock;
    };

    try {
      const [sSock, oSock, tSock, otSock, aSock] = await Promise.all([
        connectClient(studentAuth.cookieHeader),
        connectClient(otherStudentAuth.cookieHeader),
        connectClient(teacherAuth.cookieHeader),
        connectClient(otherTeacherAuth.cookieHeader),
        connectClient(adminAuth.cookieHeader),
      ]);

      const emitAck = (sock: ReturnType<typeof ioClient>, event: string, payload?: unknown) =>
        new Promise<{ ok: boolean; error?: string }>((resolve) => {
          if (payload !== undefined) {
            sock.emit(event, payload, (res: { ok: boolean; error?: string }) => resolve(res));
          } else {
            sock.emit(event, (res: { ok: boolean; error?: string }) => resolve(res));
          }
        });

      expect((await emitAck(sSock, "proctoring:join-attempt", { attemptId })).ok).toBe(true);
      expect((await emitAck(tSock, "proctoring:join-attempt", { attemptId })).ok).toBe(true);
      expect((await emitAck(aSock, "proctoring:join-attempt", { attemptId })).ok).toBe(true);

      expect(await emitAck(oSock, "proctoring:join-attempt", { attemptId })).toEqual({
        ok: false,
        error: "FORBIDDEN",
      });
      expect(await emitAck(otSock, "proctoring:join-attempt", { attemptId })).toEqual({
        ok: false,
        error: "FORBIDDEN",
      });
      expect(await emitAck(sSock, "proctoring:join-admin-monitor")).toEqual({
        ok: false,
        error: "FORBIDDEN",
      });
      expect((await emitAck(aSock, "proctoring:join-admin-monitor")).ok).toBe(true);

      sSock.close();
      oSock.close();
      tSock.close();
      otSock.close();
      aSock.close();
    } finally {
      io.close();
      setRealtimeServer(null);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("55. Post-commit real-time emissions deliver warning and auto-finalization events to authorized clients", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const studentAuth = await loginWithCookie(app, actors.student.email);
    const adminAuth = await loginWithCookie(app, actors.admin.email);

    const { attemptId } = await issuePreflightAndStartAttempt({
      student: { agent: studentAuth.agent, csrf: studentAuth.csrf },
      examId,
    });

    const server = http.createServer(app);
    const io = configureSocketServer(server, "http://localhost:5173");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;

    const sSock = ioClient(`http://127.0.0.1:${port}`, {
      extraHeaders: { cookie: studentAuth.cookieHeader },
      reconnection: false,
    });
    const aSock = ioClient(`http://127.0.0.1:${port}`, {
      extraHeaders: { cookie: adminAuth.cookieHeader },
      reconnection: false,
    });

    try {
      await Promise.all([
        new Promise<void>((res) => sSock.on("system:connected", () => res())),
        new Promise<void>((res) => aSock.on("system:connected", () => res())),
      ]);
      await new Promise<void>((res) => sSock.emit("proctoring:join-attempt", { attemptId }, () => res()));
      await new Promise<void>((res) => aSock.emit("proctoring:join-admin-monitor", () => res()));

      const warningReceived = new Promise<{ violationCount: number }>((res) =>
        sSock.once("proctoring:warning", (payload) => res(payload)),
      );
      const finalizedReceived = new Promise<{ attemptId: string; reason: string }>((res) =>
        sSock.once("exam:attempt-finalized", (payload) => res(payload)),
      );
      const adminEventReceived = new Promise<{ attemptId: string; autoSubmitted: boolean }>((res) =>
        aSock.on("proctoring:event", (payload) => {
          if (payload.autoSubmitted) res(payload);
        }),
      );

      // Strike 1
      await studentAuth.agent
        .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
        .set("X-CSRF-Token", studentAuth.csrf)
        .send({ clientEventId: crypto.randomUUID(), eventType: IntegrityEventType.COPY_ATTEMPT });

      const warn = await warningReceived;
      expect(warn.violationCount).toBe(1);

      // Strike 2 (distinct FOCUS_LOSS group) -> AUTO_SUBMITTED
      await studentAuth.agent
        .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
        .set("X-CSRF-Token", studentAuth.csrf)
        .send({ clientEventId: crypto.randomUUID(), eventType: IntegrityEventType.TAB_SWITCH });

      const finalized = await finalizedReceived;
      const adminNotif = await adminEventReceived;
      expect(finalized.attemptId).toBe(attemptId);
      expect(finalized.reason).toBe("VIOLATION_THRESHOLD");
      expect(adminNotif.autoSubmitted).toBe(true);
    } finally {
      sSock.close();
      aSock.close();
      io.close();
      setRealtimeServer(null);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
