import crypto from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PROCTORING_POLICY } from "@pariksha/shared";
import { createApp } from "../src/app.js";
import { resetEnvCacheForTest } from "../src/config/env.js";
import { disconnectPrisma, getPrismaClient } from "../src/lib/prisma.js";
import { resetTestDatabase } from "./testDbGuard.js";
import { futureWindowIso, loginAs, seedPhase4BaseActors } from "./phase4TestHelpers.js";
import {
  createActiveProctoredExam,
  issuePreflightAndStartAttempt,
} from "./phase5TestHelpers.js";

describe("Phase 5 Policy Inheritance, Preflight Handshakes & Production Security (Tests 1-16)", () => {
  let app = createApp();
  const prisma = getPrismaClient();

  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    resetEnvCacheForTest();
    app = createApp();
    await resetTestDatabase();
  });

  afterAll(async () => {
    process.env.NODE_ENV = "test";
    resetEnvCacheForTest();
    await disconnectPrisma();
  });

  it("1. Auto-creates institutional default policy with camera, screen share, fullscreen, and 2-strike defaults", async () => {
    const actors = await seedPhase4BaseActors();
    const admin = await loginAs(app, actors.admin.email);

    const res = await admin.agent.get("/api/v1/admin/proctoring/default-policy");
    expect(res.status).toBe(200);
    expect(res.body.data.isInstitutionalDefault).toBe(true);
    expect(res.body.data.requireWebcam).toBe(true);
    expect(res.body.data.requireScreenShare).toBe(true);
    expect(res.body.data.requireFullscreen).toBe(true);
    expect(res.body.data.violationThreshold).toBe(2);
    expect(res.body.data.pauseOnMediaLoss).toBe(true);
    expect(res.body.data.version).toBe(1);
  });

  it("2. Restricts institutional default policy endpoints strictly to ADMIN (403 for teacher/student)", async () => {
    const actors = await seedPhase4BaseActors();
    const teacher = await loginAs(app, actors.teacher.email);
    const student = await loginAs(app, actors.student.email);

    expect((await teacher.agent.get("/api/v1/admin/proctoring/default-policy")).status).toBe(403);
    expect((await student.agent.get("/api/v1/admin/proctoring/default-policy")).status).toBe(403);
    expect(
      (
        await teacher.agent
          .patch("/api/v1/admin/proctoring/default-policy")
          .set("X-CSRF-Token", teacher.csrf)
          .send({ violationThreshold: 4 })
      ).status,
    ).toBe(403);
  });

  it("3. Institutional default policy updates increment version and write PROCTORING_DEFAULT_POLICY_UPDATED audit log", async () => {
    const actors = await seedPhase4BaseActors();
    const admin = await loginAs(app, actors.admin.email);

    const updateRes = await admin.agent
      .patch("/api/v1/admin/proctoring/default-policy")
      .set("X-CSRF-Token", admin.csrf)
      .send({ violationThreshold: 3, dedupWindowSeconds: 12 });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.violationThreshold).toBe(3);
    expect(updateRes.body.data.dedupWindowSeconds).toBe(12);
    expect(updateRes.body.data.version).toBe(2);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "PROCTORING_DEFAULT_POLICY_UPDATED" },
    });
    expect(audit).not.toBeNull();
  });

  it("4. Admin can restore institutional default policy cleanly back to standard defaults", async () => {
    const actors = await seedPhase4BaseActors();
    const admin = await loginAs(app, actors.admin.email);

    await admin.agent
      .patch("/api/v1/admin/proctoring/default-policy")
      .set("X-CSRF-Token", admin.csrf)
      .send({ requireWebcam: false, violationThreshold: 5 });

    const restoreRes = await admin.agent
      .post("/api/v1/admin/proctoring/default-policy/restore")
      .set("X-CSRF-Token", admin.csrf);

    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.data.requireWebcam).toBe(DEFAULT_PROCTORING_POLICY.requireWebcam);
    expect(restoreRes.body.data.violationThreshold).toBe(
      DEFAULT_PROCTORING_POLICY.violationThreshold,
    );
    expect(restoreRes.body.data.version).toBeGreaterThanOrEqual(2);
  });

  it("5. Exam without override inherits institutional default policy dynamically", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId, admin } = await createActiveProctoredExam({ app, actors });

    await admin.agent
      .patch("/api/v1/admin/proctoring/default-policy")
      .set("X-CSRF-Token", admin.csrf)
      .send({ violationThreshold: 3 });

    const policyRes = await admin.agent.get(`/api/v1/admin/exams/${examId}/proctoring-policy`);
    expect(policyRes.status).toBe(200);
    expect(policyRes.body.data.inheritedFromDefault).toBe(true);
    expect(policyRes.body.data.effectivePolicy.violationThreshold).toBe(3);
    expect(policyRes.body.data.effectivePolicyVersion).toBe(2);
  });

  it("6. Exam override takes precedence, toggling isActive=false falls back to default, and reset deletes override", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId, admin } = await createActiveProctoredExam({ app, actors });

    const patchOverride = await admin.agent
      .patch(`/api/v1/admin/exams/${examId}/proctoring-policy`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ requireScreenShare: false, violationThreshold: 4, isActive: true });
    expect(patchOverride.status).toBe(200);
    expect(patchOverride.body.data.inheritedFromDefault).toBe(false);
    expect(patchOverride.body.data.effectivePolicy.requireScreenShare).toBe(false);
    expect(patchOverride.body.data.effectivePolicy.violationThreshold).toBe(4);

    // Disable override -> inherits default (requireScreenShare=true, threshold=2)
    const disableOverride = await admin.agent
      .patch(`/api/v1/admin/proctoring/exams/${examId}/policy`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ isActive: false });
    expect(disableOverride.status).toBe(200);
    expect(disableOverride.body.data.inheritedFromDefault).toBe(true);
    expect(disableOverride.body.data.effectivePolicy.requireScreenShare).toBe(true);

    // Reset deletes exam override record cleanly
    const resetRes = await admin.agent
      .post(`/api/v1/admin/exams/${examId}/proctoring-policy/reset`)
      .set("X-CSRF-Token", admin.csrf);
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.data.examOverride).toBeNull();
    expect(resetRes.body.data.inheritedFromDefault).toBe(true);
  });

  it("7. Started attempt retains snapshotted policyVersion and rules even if Admin mutates policy afterward", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId, admin } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);

    const started = await issuePreflightAndStartAttempt({ student, examId });
    expect(started.attempt.strikeThreshold).toBe(2);
    expect(started.attempt.policy.requireScreenShare).toBe(true);

    await admin.agent
      .patch(`/api/v1/admin/proctoring/exams/${examId}/policy`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ violationThreshold: 6, requireScreenShare: false });

    const fetched = await student.agent.get(
      `/api/v1/student/exams/${examId}/attempts/${started.attemptId}`,
    );
    expect(fetched.status).toBe(200);
    expect(fetched.body.data.strikeThreshold).toBe(2);
    expect(fetched.body.data.policy.requireScreenShare).toBe(true);
  });

  it("8. Preflight context exposes policy, privacy commitment, and honest browser limits without answer keys", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);

    const ctxRes = await student.agent.get(`/api/v1/student/exams/${examId}/preflight`);
    expect(ctxRes.status).toBe(200);
    expect(ctxRes.body.data.policy.requireWebcam).toBe(true);
    expect(ctxRes.body.data.privacyNotice).toContain("NOT recorded or uploaded");
    expect(Array.isArray(ctxRes.body.data.browserLimitations)).toBe(true);
    expect(ctxRes.body.data.browserLimitations.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(ctxRes.body.data)).not.toContain("Backend PostgreSQL transaction");
  });

  it("9. Preflight rejects failed connectivity, missing consent, denied camera, or denied screen share", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);

    const noConn = await student.agent
      .post(`/api/v1/student/exams/${examId}/preflight`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        cameraStatus: "GRANTED",
        screenShareStatus: "GRANTED",
        fullscreenStatus: "GRANTED",
        connectivityOk: false,
        consentAccepted: true,
      });
    expect(noConn.status).toBe(400);
    expect(noConn.body.error.code).toBe("PREFLIGHT_CONNECTIVITY_FAILED");

    const noConsent = await student.agent
      .post(`/api/v1/student/exams/${examId}/preflight`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        cameraStatus: "GRANTED",
        screenShareStatus: "GRANTED",
        fullscreenStatus: "GRANTED",
        connectivityOk: true,
        consentAccepted: false,
      });
    expect(noConsent.status).toBe(400);

    const camDenied = await student.agent
      .post(`/api/v1/student/exams/${examId}/preflight`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        cameraStatus: "DENIED",
        screenShareStatus: "GRANTED",
        fullscreenStatus: "GRANTED",
        connectivityOk: true,
        consentAccepted: true,
      });
    expect(camDenied.status).toBe(409);
    expect(camDenied.body.error.code).toBe("PREFLIGHT_CAMERA_REQUIRED");

    const screenDenied = await student.agent
      .post(`/api/v1/student/exams/${examId}/preflight`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        cameraStatus: "GRANTED",
        screenShareStatus: "DENIED",
        fullscreenStatus: "GRANTED",
        connectivityOk: true,
        consentAccepted: true,
      });
    expect(screenDenied.status).toBe(409);
    expect(screenDenied.body.error.code).toBe("PREFLIGHT_SCREEN_SHARE_REQUIRED");
  });

  it("10. Preflight enforces allowedScreenSurface when exam policy restricts to MONITOR", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId, admin } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);

    await admin.agent
      .patch(`/api/v1/admin/proctoring/exams/${examId}/policy`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ allowedScreenSurface: "MONITOR" });

    const tabRes = await student.agent
      .post(`/api/v1/student/exams/${examId}/preflight`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        cameraStatus: "GRANTED",
        screenShareStatus: "GRANTED",
        displaySurface: "browser",
        fullscreenStatus: "GRANTED",
        connectivityOk: true,
        consentAccepted: true,
      });
    expect(tabRes.status).toBe(409);
    expect(tabRes.body.error.code).toBe("PREFLIGHT_SURFACE_DISALLOWED");
  });

  it("11. Preflight enforces fullscreenActive when requireFullscreen is true", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);

    const noFs = await student.agent
      .post(`/api/v1/student/exams/${examId}/preflight`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        cameraStatus: "GRANTED",
        screenShareStatus: "GRANTED",
        displaySurface: "monitor",
        fullscreenStatus: "DENIED",
        connectivityOk: true,
        consentAccepted: true,
      });
    expect(noFs.status).toBe(409);
    expect(noFs.body.error.code).toBe("PREFLIGHT_FULLSCREEN_REQUIRED");
  });

  it("12. POST /start rejects missing preflight handshake on monitored exam (409 PREFLIGHT_REQUIRED)", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);

    const startWithoutToken = await student.agent
      .post(`/api/v1/student/exams/${examId}/start`)
      .set("X-CSRF-Token", student.csrf)
      .send({});

    expect(startWithoutToken.status).toBe(409);
    expect(startWithoutToken.body.error.code).toBe("PREFLIGHT_REQUIRED");
  });

  it("13. Valid single-use preflight handshake launches monitored attempt cleanly and writes PREFLIGHT_VERIFIED audit", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);

    const started = await issuePreflightAndStartAttempt({ student, examId });
    expect(started.attempt.status).toBe("IN_PROGRESS");
    expect(started.attempt.strikeThreshold).toBe(2);
    expect(started.attempt.cameraActive).toBe(true);
    expect(started.attempt.screenShareActive).toBe(true);
    expect(started.attempt.fullscreenActive).toBe(true);

    const audit = await prisma.auditLog.findFirst({ where: { action: "PREFLIGHT_VERIFIED" } });
    expect(audit).not.toBeNull();
  });

  it("14. Rejects replayed token (PREFLIGHT_HANDSHAKE_USED), expired token, and session mismatch", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({
      app,
      actors,
      maxAttempts: 3,
    });
    const student = await loginAs(app, actors.student.email);

    const first = await issuePreflightAndStartAttempt({ student, examId });
    // Submit first attempt so a second attempt would otherwise be eligible
    await student.agent
      .post(`/api/v1/student/exams/${examId}/attempts/${first.attemptId}/submit`)
      .set("X-CSRF-Token", student.csrf)
      .send({ confirmSubmit: true });

    // Replay consumed token -> PREFLIGHT_REPLAYED
    const replayRes = await student.agent
      .post(`/api/v1/student/exams/${examId}/start`)
      .set("X-CSRF-Token", student.csrf)
      .send({ preflightToken: first.preflight.preflightToken });
    expect(replayRes.status).toBe(409);
    expect(replayRes.body.error.code).toBe("PREFLIGHT_REPLAYED");

    // Expired handshake -> PREFLIGHT_EXPIRED
    const pre2 = await student.agent
      .post(`/api/v1/student/exams/${examId}/preflight`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        cameraStatus: "GRANTED",
        screenShareStatus: "GRANTED",
        fullscreenStatus: "GRANTED",
        connectivityOk: true,
        consentAccepted: true,
      });
    await prisma.preflightHandshake.update({
      where: { id: pre2.body.data.handshakeId },
      data: { expiresAt: new Date(Date.now() - 10_000) },
    });
    const expiredRes = await student.agent
      .post(`/api/v1/student/exams/${examId}/start`)
      .set("X-CSRF-Token", student.csrf)
      .send({ preflightToken: pre2.body.data.preflightToken });
    expect(expiredRes.status).toBe(409);
    expect(expiredRes.body.error.code).toBe("PREFLIGHT_EXPIRED");

    // Fresh token used in another login session of SAME student -> PREFLIGHT_SESSION_MISMATCH
    const pre3 = await student.agent
      .post(`/api/v1/student/exams/${examId}/preflight`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        cameraStatus: "GRANTED",
        screenShareStatus: "GRANTED",
        fullscreenStatus: "GRANTED",
        connectivityOk: true,
        consentAccepted: true,
      });
    const studentSecondSession = await loginAs(app, actors.student.email);
    const mismatchSessionRes = await studentSecondSession.agent
      .post(`/api/v1/student/exams/${examId}/start`)
      .set("X-CSRF-Token", studentSecondSession.csrf)
      .send({ preflightToken: pre3.body.data.preflightToken });
    expect(mismatchSessionRes.status).toBe(409);
    expect(mismatchSessionRes.body.error.code).toBe("PREFLIGHT_SESSION_MISMATCH");
  });

  it("15. Rejects cross-student, cross-exam, and forged preflight handshake tokens", async () => {
    const actors = await seedPhase4BaseActors();
    await prisma.enrollment.create({
      data: { courseId: actors.course.id, studentId: actors.otherStudent.id, status: "ACTIVE" },
    });

    const examA = await createActiveProctoredExam({ app, actors, title: "Exam A" });
    const examB = await createActiveProctoredExam({ app, actors, title: "Exam B" });

    const studentA = await loginAs(app, actors.student.email);
    const studentB = await loginAs(app, actors.otherStudent.email);

    const preA = await studentA.agent
      .post(`/api/v1/student/exams/${examA.examId}/preflight`)
      .set("X-CSRF-Token", studentA.csrf)
      .send({
        cameraStatus: "GRANTED",
        screenShareStatus: "GRANTED",
        fullscreenStatus: "GRANTED",
        connectivityOk: true,
        consentAccepted: true,
      });

    // Cross-student misuse
    const crossStudentRes = await studentB.agent
      .post(`/api/v1/student/exams/${examA.examId}/start`)
      .set("X-CSRF-Token", studentB.csrf)
      .send({ preflightToken: preA.body.data.preflightToken });
    expect(crossStudentRes.status).toBe(403);
    expect(crossStudentRes.body.error.code).toBe("PREFLIGHT_MISMATCHED");

    // Cross-exam misuse
    const crossExamRes = await studentA.agent
      .post(`/api/v1/student/exams/${examB.examId}/start`)
      .set("X-CSRF-Token", studentA.csrf)
      .send({ preflightToken: preA.body.data.preflightToken });
    expect(crossExamRes.status).toBe(403);
    expect(crossExamRes.body.error.code).toBe("PREFLIGHT_MISMATCHED");

    // Forged token
    const forgedRes = await studentA.agent
      .post(`/api/v1/student/exams/${examA.examId}/start`)
      .set("X-CSRF-Token", studentA.csrf)
      .send({ preflightToken: crypto.randomBytes(32).toString("hex") });
    expect(forgedRes.status).toBe(409);
    expect(forgedRes.body.error.code).toBe("PREFLIGHT_INVALID");
  });

  it("16. Rejects stale policyVersion handshakes and forbids allowUnproctoredDev when NODE_ENV=production", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId, admin } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);

    // Issue handshake under v1, then admin updates policy -> start rejects PREFLIGHT_POLICY_STALE
    const pre1 = await student.agent
      .post(`/api/v1/student/exams/${examId}/preflight`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        cameraStatus: "GRANTED",
        screenShareStatus: "GRANTED",
        fullscreenStatus: "GRANTED",
        connectivityOk: true,
        consentAccepted: true,
      });

    await admin.agent
      .patch("/api/v1/admin/proctoring/default-policy")
      .set("X-CSRF-Token", admin.csrf)
      .send({ violationThreshold: 3 });

    const staleRes = await student.agent
      .post(`/api/v1/student/exams/${examId}/start`)
      .set("X-CSRF-Token", student.csrf)
      .send({ preflightToken: pre1.body.data.preflightToken });
    expect(staleRes.status).toBe(409);
    expect(staleRes.body.error.code).toBe("PREFLIGHT_POLICY_MISMATCH");

    // Prepare unproctored exam in test mode, then flip NODE_ENV=production
    const teacher = await loginAs(app, actors.teacher.email);
    const win = futureWindowIso(-60_000, 3_600_000);
    const draftRes = await teacher.agent
      .post("/api/v1/teacher/exams")
      .set("X-CSRF-Token", teacher.csrf)
      .send({
        courseId: actors.course.id,
        title: "Prod Guard Exam",
        durationMinutes: 30,
        passingMarks: 1,
        maxAttempts: 1,
        windowStart: win.windowStart,
        windowEnd: win.windowEnd,
      });
    const prodExamId = draftRes.body.data.id as string;
    await teacher.agent
      .post(`/api/v1/teacher/exams/${prodExamId}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({
        type: "TRUE_FALSE",
        prompt: "Prod forbids unproctored?",
        marks: 2,
        options: [
          { text: "True", isCorrect: true },
          { text: "False", isCorrect: false },
        ],
      });
    await teacher.agent
      .post(`/api/v1/teacher/exams/${prodExamId}/submit-for-approval`)
      .set("X-CSRF-Token", teacher.csrf);

    const legacyBypassExam = await createActiveProctoredExam({
      app,
      actors,
      allowUnproctoredDev: true,
      title: "Flagged Bypass Exam",
    });

    process.env.NODE_ENV = "production";
    resetEnvCacheForTest();
    try {
      const prodApprove = await admin.agent
        .post(`/api/v1/admin/exams/${prodExamId}/approve`)
        .set("X-CSRF-Token", admin.csrf)
        .send({ activateImmediately: true, allowUnproctoredDev: true });
      expect(prodApprove.status).toBe(403);
      expect(prodApprove.body.error.code).toBe("UNPROCTORED_DEV_FORBIDDEN_IN_PRODUCTION");

      const prodConfig = await admin.agent
        .patch(`/api/v1/admin/exams/${legacyBypassExam.examId}/config`)
        .set("X-CSRF-Token", admin.csrf)
        .send({ allowUnproctoredDev: true });
      expect(prodConfig.status).toBe(403);

      const prodStartBypass = await student.agent
        .post(`/api/v1/student/exams/${legacyBypassExam.examId}/start`)
        .set("X-CSRF-Token", student.csrf)
        .send({});
      expect(prodStartBypass.status).toBe(403);
      expect(prodStartBypass.body.error.code).toBe("UNPROCTORED_FORBIDDEN_IN_PRODUCTION");
    } finally {
      process.env.NODE_ENV = "test";
      resetEnvCacheForTest();
    }
  });
});
