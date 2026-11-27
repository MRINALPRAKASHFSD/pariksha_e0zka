import crypto from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { IntegrityEventType } from "@pariksha/shared";
import { createApp } from "../src/app.js";
import { disconnectPrisma, getPrismaClient } from "../src/lib/prisma.js";
import { sweepMissingHeartbeats } from "../src/services/examExpirationWorker.js";
import { resetTestDatabase } from "./testDbGuard.js";
import { loginAs, seedPhase4BaseActors } from "./phase4TestHelpers.js";
import {
  createActiveProctoredExam,
  issuePreflightAndStartAttempt,
} from "./phase5TestHelpers.js";

describe("Phase 5 Concurrency, Heartbeats, Sweeper & Pause/Resume Recovery (Tests 32-44)", () => {
  let app = createApp();
  const prisma = getPrismaClient();

  beforeEach(async () => {
    app = createApp();
    await resetTestDatabase();
  });

  afterAll(async () => {
    await disconnectPrisma();
  });

  it("32. Concurrent strike requests serialize via FOR UPDATE with single ExamSubmission and exact strike count", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    const [r1, r2, r3] = await Promise.all([
      student.agent
        .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
        .set("X-CSRF-Token", student.csrf)
        .send({ clientEventId: crypto.randomUUID(), eventType: IntegrityEventType.COPY_ATTEMPT }),
      student.agent
        .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
        .set("X-CSRF-Token", student.csrf)
        .send({ clientEventId: crypto.randomUUID(), eventType: IntegrityEventType.TAB_SWITCH }),
      student.agent
        .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
        .set("X-CSRF-Token", student.csrf)
        .send({
          clientEventId: crypto.randomUUID(),
          eventType: IntegrityEventType.RIGHT_CLICK_ATTEMPT,
        }),
    ]);

    const statuses = [r1.status, r2.status, r3.status];
    expect(statuses.filter((s) => s === 200)).toHaveLength(2);
    expect(statuses.filter((s) => s === 409)).toHaveLength(1);

    const dbAttempt = await prisma.examAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(dbAttempt.violationCount).toBe(2);
    expect(dbAttempt.status).toBe("AUTO_SUBMITTED");
    expect(dbAttempt.isLocked).toBe(true);

    const subs = await prisma.examSubmission.findMany({ where: { attemptId } });
    expect(subs).toHaveLength(1);
    expect(subs[0]?.reason).toBe("VIOLATION_THRESHOLD");
  });

  it("33. Concurrent manual submit and second strike serialize safely to exactly one ExamSubmission", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    // Strike 1
    await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({ clientEventId: crypto.randomUUID(), eventType: IntegrityEventType.TAB_SWITCH });

    // Race manual submit vs strike 2
    const [submitRes, strikeRes] = await Promise.all([
      student.agent
        .post(`/api/v1/student/exams/${examId}/attempts/${attemptId}/submit`)
        .set("X-CSRF-Token", student.csrf)
        .send({ confirmSubmit: true }),
      student.agent
        .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
        .set("X-CSRF-Token", student.csrf)
        .send({ clientEventId: crypto.randomUUID(), eventType: IntegrityEventType.PASTE_ATTEMPT }),
    ]);

    expect([submitRes.status, strikeRes.status]).toContain(200);
    const subs = await prisma.examSubmission.findMany({ where: { attemptId } });
    expect(subs).toHaveLength(1);

    const dbAttempt = await prisma.examAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(dbAttempt.isLocked).toBe(true);
    expect(["SUBMITTED", "AUTO_SUBMITTED"]).toContain(dbAttempt.status);
  });

  it("34. Monotonic heartbeat sequences advance telemetry while stale out-of-order sequences do not downgrade", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    const hb10 = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/heartbeat`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        sequence: 10,
        cameraActive: true,
        screenShareActive: true,
        fullscreenActive: true,
        connectionOnline: true,
      });
    expect(hb10.status).toBe(200);
    expect(hb10.body.data.sequence).toBe(10);

    // Delayed older packet seq=4 arrives late with false camera flags -> must NOT overwrite
    const hb4 = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/heartbeat`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        sequence: 4,
        cameraActive: false,
        screenShareActive: false,
        fullscreenActive: false,
        connectionOnline: false,
      });
    expect(hb4.status).toBe(200);

    const dbAttempt = await prisma.examAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(dbAttempt.lastHeartbeatSeq).toBe(10);
    expect(dbAttempt.cameraActive).toBe(true);
    expect(dbAttempt.screenShareActive).toBe(true);
    expect(dbAttempt.fullscreenActive).toBe(true);
  });

  it("35. Heartbeat endpoint enforces server clock expiry cleanly when deadline has passed", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    await prisma.examAttempt.update({
      where: { id: attemptId },
      data: { expiresAt: new Date(Date.now() - 2_000) },
    });

    const hb = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/heartbeat`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        sequence: 2,
        cameraActive: true,
        screenShareActive: true,
        fullscreenActive: true,
      });

    expect(hb.status).toBe(409);
    expect(hb.body.error.code).toBe("ATTEMPT_EXPIRED");
    expect(hb.body.error.details.receipt.reason).toBe("TIMER_EXPIRED");

    const dbAttempt = await prisma.examAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(dbAttempt.status).toBe("EXPIRED");
    expect(dbAttempt.isLocked).toBe(true);
  });

  it("36. Background sweepMissingHeartbeats detects missed heartbeats past timeout+grace once per outage", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    // Default policy heartbeatTimeoutSeconds=60, heartbeatGraceSeconds=30 -> stale if > 90s ago
    await prisma.examAttempt.update({
      where: { id: attemptId },
      data: { lastHeartbeatAt: new Date(Date.now() - 150_000) },
    });

    const firstSweepCount = await sweepMissingHeartbeats();
    expect(firstSweepCount).toBe(1);

    // Repeating sweep during same outage does not spam extra strikes
    const secondSweepCount = await sweepMissingHeartbeats();
    expect(secondSweepCount).toBe(0);

    const dbAttempt = await prisma.examAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(dbAttempt.violationCount).toBe(1);
    expect(dbAttempt.heartbeatOutageActive).toBe(true);
    expect(dbAttempt.status).toBe("IN_PROGRESS");

    const audit = await prisma.auditLog.findFirst({
      where: {
        action: "HEARTBEAT_TIMEOUT_DETECTED",
        entityType: "IntegrityEvent",
      },
    });
    expect(audit).not.toBeNull();
  });

  it("37. Missing heartbeat sweep reaching strike threshold atomically finalizes attempt as VIOLATION_THRESHOLD", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId, admin } = await createActiveProctoredExam({ app, actors });
    await admin.agent
      .patch(`/api/v1/admin/proctoring/exams/${examId}/policy`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ violationThreshold: 1, heartbeatTimeoutSeconds: 30, heartbeatGraceSeconds: 10 });

    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    await prisma.examAttempt.update({
      where: { id: attemptId },
      data: { lastHeartbeatAt: new Date(Date.now() - 120_000) },
    });

    const count = await sweepMissingHeartbeats();
    expect(count).toBe(1);

    const dbAttempt = await prisma.examAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      include: { submission: true },
    });
    expect(dbAttempt.status).toBe("AUTO_SUBMITTED");
    expect(dbAttempt.finalizationReason).toBe("VIOLATION_THRESHOLD");
    expect(dbAttempt.submission?.reason).toBe("VIOLATION_THRESHOLD");
  });

  it("38. Reconnecting healthy heartbeat clears heartbeatOutageActive without erasing accumulated strikes", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    await prisma.examAttempt.update({
      where: { id: attemptId },
      data: { lastHeartbeatAt: new Date(Date.now() - 150_000) },
    });
    await sweepMissingHeartbeats();

    const hbReconnect = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/heartbeat`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        sequence: 9,
        cameraActive: true,
        screenShareActive: true,
        fullscreenActive: true,
      });
    expect(hbReconnect.status).toBe(200);
    expect(hbReconnect.body.data.violationCount).toBe(1);

    const dbAttempt = await prisma.examAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(dbAttempt.heartbeatOutageActive).toBe(false);
    expect(dbAttempt.violationCount).toBe(1);
  });

  it("39. Media interruption pauses attempt when pauseOnMediaLoss=true and logs EXAM_ATTEMPT_PAUSED", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    const interruption = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.SCREEN_SHARE_INTERRUPTED,
      });

    expect(interruption.status).toBe(200);
    expect(interruption.body.data.paused).toBe(true);
    expect(interruption.body.data.attemptStatus).toBe("PAUSED");
    expect(interruption.body.data.violationCount).toBe(1);

    const pauseAudit = await prisma.auditLog.findFirst({
      where: { action: "EXAM_ATTEMPT_PAUSED", entityId: attemptId },
    });
    expect(pauseAudit).not.toBeNull();
  });

  it("40. Answer autosave is strictly blocked (409 ATTEMPT_PAUSED) while attempt is PAUSED", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId, q1Id, q1CorrectOptionId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.CAMERA_INTERRUPTED,
      });

    const saveWhilePaused = await student.agent
      .put(`/api/v1/student/exams/${examId}/attempts/${attemptId}/answers`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        questionId: q1Id,
        selectedOptionIds: [q1CorrectOptionId],
        clientSequence: 1,
      });

    expect(saveWhilePaused.status).toBe(409);
    expect(saveWhilePaused.body.error.code).toBe("ATTEMPT_PAUSED");
  });

  it("41. POST /resume rejects recovery when camera, screen share, surface, or fullscreen remain missing", async () => {
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

    const noCam = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/resume`)
      .set("X-CSRF-Token", student.csrf)
      .send({ cameraActive: false, screenShareActive: true, fullscreenActive: true });
    expect(noCam.status).toBe(409);
    expect(noCam.body.error.code).toBe("CAMERA_RECOVERY_REQUIRED");

    const noScreen = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/resume`)
      .set("X-CSRF-Token", student.csrf)
      .send({ cameraActive: true, screenShareActive: false, fullscreenActive: true });
    expect(noScreen.status).toBe(409);
    expect(noScreen.body.error.code).toBe("SCREEN_SHARE_RECOVERY_REQUIRED");

    const noFs = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/resume`)
      .set("X-CSRF-Token", student.csrf)
      .send({ cameraActive: true, screenShareActive: true, fullscreenActive: false });
    expect(noFs.status).toBe(409);
    expect(noFs.body.error.code).toBe("FULLSCREEN_RECOVERY_REQUIRED");
  });

  it("42. POST /resume restores IN_PROGRESS while strictly preserving violationCount and original expiresAt", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId, attempt } = await issuePreflightAndStartAttempt({ student, examId });
    const originalExpiresAt = attempt.expiresAt;

    await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.CAMERA_INTERRUPTED,
      });

    const resumeRes = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/resume`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        cameraActive: true,
        screenShareActive: true,
        fullscreenActive: true,
        displaySurface: "monitor",
      });

    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.data.attempt.status).toBe("IN_PROGRESS");
    expect(resumeRes.body.data.attempt.violationCount).toBe(1);
    expect(resumeRes.body.data.attempt.expiresAt).toBe(originalExpiresAt);
    expect(resumeRes.body.data.attempt.pauseReason).toBeNull();

    const resumeAudit = await prisma.auditLog.findFirst({
      where: { action: "EXAM_ATTEMPT_RESUMED", entityId: attemptId },
    });
    expect(resumeAudit).not.toBeNull();
  });

  it("43. POST /resume rejects recovery after deadline expiry and atomically finalizes as TIMER_EXPIRED", async () => {
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

    await prisma.examAttempt.update({
      where: { id: attemptId },
      data: { expiresAt: new Date(Date.now() - 3_000) },
    });

    const expiredResume = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/resume`)
      .set("X-CSRF-Token", student.csrf)
      .send({ cameraActive: true, screenShareActive: true, fullscreenActive: true });

    expect(expiredResume.status).toBe(409);
    expect(expiredResume.body.error.code).toBe("ATTEMPT_EXPIRED");

    const dbAttempt = await prisma.examAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(dbAttempt.status).toBe("EXPIRED");
    expect(dbAttempt.finalizationReason).toBe("TIMER_EXPIRED");
  });

  it("44. Combined Strike 1 pause -> resume -> Strike 2 triggers AUTO_SUBMITTED cleanly", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    // Strike 1 via camera drop (pauses)
    const s1 = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.CAMERA_INTERRUPTED,
      });
    expect(s1.body.data.paused).toBe(true);
    expect(s1.body.data.violationCount).toBe(1);

    // Resume
    await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/resume`)
      .set("X-CSRF-Token", student.csrf)
      .send({ cameraActive: true, screenShareActive: true, fullscreenActive: true });

    // Strike 2 via screen share stop -> auto-submit!
    const s2 = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.SCREEN_SHARE_INTERRUPTED,
      });

    expect(s2.status).toBe(200);
    expect(s2.body.data.violationCount).toBe(2);
    expect(s2.body.data.autoSubmitted).toBe(true);
    expect(s2.body.data.attemptStatus).toBe("AUTO_SUBMITTED");
    expect(s2.body.data.receipt.reason).toBe("VIOLATION_THRESHOLD");
  });
});
