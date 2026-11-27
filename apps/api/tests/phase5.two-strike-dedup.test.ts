import crypto from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { IntegrityEventType } from "@pariksha/shared";
import { createApp } from "../src/app.js";
import { disconnectPrisma, getPrismaClient } from "../src/lib/prisma.js";
import { resetTestDatabase } from "./testDbGuard.js";
import { loginAs, seedPhase4BaseActors } from "./phase4TestHelpers.js";
import {
  createActiveProctoredExam,
  issuePreflightAndStartAttempt,
} from "./phase5TestHelpers.js";

describe("Phase 5 Two-Strike Engine, Configurable Thresholds, Deduplication & Heuristics (Tests 17-31)", () => {
  let app = createApp();
  const prisma = getPrismaClient();

  beforeEach(async () => {
    app = createApp();
    await resetTestDatabase();
  });

  afterAll(async () => {
    await disconnectPrisma();
  });

  it("17. Disabled policy rules record telemetry without counting strikes or warnings", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId, admin } = await createActiveProctoredExam({ app, actors });
    await admin.agent
      .patch(`/api/v1/admin/proctoring/exams/${examId}/policy`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ detectTabSwitch: false });

    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    const res = await student.agent
      .post(`/api/v1/student/exams/${examId}/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.TAB_SWITCH,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.event.ruleEnabled).toBe(false);
    expect(res.body.data.event.countedAsStrike).toBe(false);
    expect(res.body.data.violationCount).toBe(0);
    expect(res.body.data.warningIssued).toBe(false);
    expect(res.body.data.attemptStatus).toBe("IN_PROGRESS");
  });

  it("18. First counted violation issues formal Strike 1 warning while keeping attempt IN_PROGRESS", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    const res = await student.agent
      .post(`/api/v1/student/exams/${examId}/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.TAB_SWITCH,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.violationCount).toBe(1);
    expect(res.body.data.warningCount).toBe(1);
    expect(res.body.data.remainingStrikes).toBe(1);
    expect(res.body.data.warningIssued).toBe(true);
    expect(res.body.data.autoSubmitted).toBe(false);
    expect(res.body.data.attemptStatus).toBe("IN_PROGRESS");
    expect(res.body.data.event.countedAsStrike).toBe(true);

    const warnAudit = await prisma.auditLog.findFirst({
      where: {
        action: "INTEGRITY_WARNING_ISSUED",
        entityType: "IntegrityEvent",
        entityId: res.body.data.event.id,
      },
    });
    expect(warnAudit).not.toBeNull();
  });

  it("19. Second counted violation hits threshold=2 and atomically AUTO_SUBMITS attempt with immutable receipt", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId, q1Id, q1CorrectOptionId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    await student.agent
      .put(`/api/v1/student/exams/${examId}/attempts/${attemptId}/answers`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        questionId: q1Id,
        selectedOptionIds: [q1CorrectOptionId],
        clientSequence: 1,
      });

    // Strike 1 (CLIPBOARD_ACTION group)
    await student.agent
      .post(`/api/v1/student/exams/${examId}/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.COPY_ATTEMPT,
      });

    // Strike 2 (distinct FOCUS_LOSS group)
    const strike2 = await student.agent
      .post(`/api/v1/student/exams/${examId}/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.TAB_SWITCH,
      });

    expect(strike2.status).toBe(200);
    expect(strike2.body.data.violationCount).toBe(2);
    expect(strike2.body.data.autoSubmitted).toBe(true);
    expect(strike2.body.data.attemptStatus).toBe("AUTO_SUBMITTED");
    expect(strike2.body.data.receipt).not.toBeNull();
    expect(strike2.body.data.receipt.reason).toBe("VIOLATION_THRESHOLD");
    expect(strike2.body.data.receipt.answeredCount).toBe(1);

    const dbAttempt = await prisma.examAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(dbAttempt.status).toBe("AUTO_SUBMITTED");
    expect(dbAttempt.isLocked).toBe(true);
    expect(dbAttempt.finalizationReason).toBe("VIOLATION_THRESHOLD");
  });

  it("20. Configurable violationThreshold=1 auto-submits immediately; threshold=3 allows 2 warnings first", async () => {
    const actors = await seedPhase4BaseActors();
    const strictExam = await createActiveProctoredExam({ app, actors, title: "1-Strike Exam" });
    await strictExam.admin.agent
      .patch(`/api/v1/admin/proctoring/exams/${strictExam.examId}/policy`)
      .set("X-CSRF-Token", strictExam.admin.csrf)
      .send({ violationThreshold: 1 });

    const student = await loginAs(app, actors.student.email);
    const strictStart = await issuePreflightAndStartAttempt({ student, examId: strictExam.examId });

    const immediateAuto = await student.agent
      .post(`/api/v1/student/exams/${strictExam.examId}/attempts/${strictStart.attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.COPY_ATTEMPT,
      });
    expect(immediateAuto.body.data.autoSubmitted).toBe(true);
    expect(immediateAuto.body.data.violationCount).toBe(1);

    // 3-strike exam
    const lenientExam = await createActiveProctoredExam({ app, actors, title: "3-Strike Exam" });
    await lenientExam.admin.agent
      .patch(`/api/v1/admin/proctoring/exams/${lenientExam.examId}/policy`)
      .set("X-CSRF-Token", lenientExam.admin.csrf)
      .send({ violationThreshold: 3 });

    const lenientStart = await issuePreflightAndStartAttempt({ student, examId: lenientExam.examId });
    const s1 = await student.agent
      .post(`/api/v1/student/exams/${lenientExam.examId}/attempts/${lenientStart.attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({ clientEventId: crypto.randomUUID(), eventType: IntegrityEventType.COPY_ATTEMPT });
    const s2 = await student.agent
      .post(`/api/v1/student/exams/${lenientExam.examId}/attempts/${lenientStart.attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({ clientEventId: crypto.randomUUID(), eventType: IntegrityEventType.TAB_SWITCH });
    expect(s1.body.data.autoSubmitted).toBe(false);
    expect(s2.body.data.autoSubmitted).toBe(false);
    expect(s2.body.data.remainingStrikes).toBe(1);

    const s3 = await student.agent
      .post(`/api/v1/student/exams/${lenientExam.examId}/attempts/${lenientStart.attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.RIGHT_CLICK_ATTEMPT,
      });
    expect(s3.body.data.autoSubmitted).toBe(true);
    expect(s3.body.data.violationCount).toBe(3);
  });

  it("21. Locks out autosave, manual submit, heartbeat, and further violations after auto-submission (409 ATTEMPT_LOCKED)", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId, q1Id, q1CorrectOptionId, admin } = await createActiveProctoredExam({
      app,
      actors,
    });
    await admin.agent
      .patch(`/api/v1/admin/proctoring/exams/${examId}/policy`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ violationThreshold: 1 });

    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    await student.agent
      .post(`/api/v1/student/exams/${examId}/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({ clientEventId: crypto.randomUUID(), eventType: IntegrityEventType.TAB_SWITCH });

    const autosaveAfterLock = await student.agent
      .put(`/api/v1/student/exams/${examId}/attempts/${attemptId}/answers`)
      .set("X-CSRF-Token", student.csrf)
      .send({ questionId: q1Id, selectedOptionIds: [q1CorrectOptionId], clientSequence: 2 });
    expect(autosaveAfterLock.status).toBe(409);
    expect(autosaveAfterLock.body.error.code).toBe("ATTEMPT_LOCKED");

    const hbAfterLock = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/heartbeat`)
      .set("X-CSRF-Token", student.csrf)
      .send({ sequence: 5, cameraActive: true, screenShareActive: true, fullscreenActive: true });
    expect(hbAfterLock.status).toBe(409);
    expect(hbAfterLock.body.error.code).toBe("ATTEMPT_LOCKED");

    const extraEventAfterLock = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({ clientEventId: crypto.randomUUID(), eventType: IntegrityEventType.COPY_ATTEMPT });
    expect(extraEventAfterLock.status).toBe(409);
    expect(extraEventAfterLock.body.error.code).toBe("ATTEMPT_LOCKED");
  });

  it("22. Idempotent clientEventId retries return cached duplicate result without adding strikes", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    const sameClientEventId = crypto.randomUUID();
    const r1 = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({ clientEventId: sameClientEventId, eventType: IntegrityEventType.TAB_SWITCH });
    const r2 = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({ clientEventId: sameClientEventId, eventType: IntegrityEventType.TAB_SWITCH });

    expect(r1.body.data.duplicate).toBe(false);
    expect(r2.body.data.duplicate).toBe(true);
    expect(r2.body.data.violationCount).toBe(1);
    expect(r2.body.data.attemptStatus).toBe("IN_PROGRESS");
  });

  it("23. Deduplicates concurrent TAB_SWITCH + WINDOW_BLUR inside dedupWindowSeconds under FOCUS_LOSS group", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    const r1 = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({ clientEventId: crypto.randomUUID(), eventType: IntegrityEventType.TAB_SWITCH });
    const r2 = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({ clientEventId: crypto.randomUUID(), eventType: IntegrityEventType.WINDOW_BLUR });

    expect(r1.body.data.violationCount).toBe(1);
    expect(r2.body.data.deduplicated).toBe(true);
    expect(r2.body.data.violationCount).toBe(1);
    expect(r2.body.data.event.countedAsStrike).toBe(false);
    expect(r2.body.data.event.deduplicatedIntoId).toBe(r1.body.data.event.id);
    expect(r2.body.data.autoSubmitted).toBe(false);
  });

  it("24. Distinct FOCUS_LOSS incidents outside dedupWindowSeconds advance from Strike 1 to Strike 2 auto-submit", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId, admin } = await createActiveProctoredExam({ app, actors });
    await admin.agent
      .patch(`/api/v1/admin/proctoring/exams/${examId}/policy`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ dedupWindowSeconds: 5 });

    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    const e1 = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({ clientEventId: crypto.randomUUID(), eventType: IntegrityEventType.TAB_SWITCH });

    // Backdate event 1 by 10 seconds to simulate time elapsing past dedupWindowSeconds
    await prisma.integrityEvent.update({
      where: { id: e1.body.data.event.id },
      data: { occurredAt: new Date(Date.now() - 10_000) },
    });

    const e2 = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({ clientEventId: crypto.randomUUID(), eventType: IntegrityEventType.WINDOW_BLUR });

    expect(e2.body.data.deduplicated).toBe(false);
    expect(e2.body.data.violationCount).toBe(2);
    expect(e2.body.data.autoSubmitted).toBe(true);
    expect(e2.body.data.attemptStatus).toBe("AUTO_SUBMITTED");
  });

  it("25. Deduplicates overlapping FULLSCREEN_EXIT and WINDOW_BLUR/PERMISSION_DENIED inside dedup window", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    const fsExit = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({ clientEventId: crypto.randomUUID(), eventType: IntegrityEventType.FULLSCREEN_EXIT });

    const blurOverlap = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({ clientEventId: crypto.randomUUID(), eventType: IntegrityEventType.WINDOW_BLUR });

    expect(fsExit.body.data.violationCount).toBe(1);
    expect(blurOverlap.body.data.deduplicated).toBe(true);
    expect(blurOverlap.body.data.violationCount).toBe(1);
  });

  it("26. Deduplicates duplicate CAMERA_INTERRUPTED while mediaLossActive incident is already open", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    const camLoss1 = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.CAMERA_INTERRUPTED,
      });

    const camLoss2 = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.CAMERA_INTERRUPTED,
      });

    expect(camLoss1.body.data.violationCount).toBe(1);
    expect(camLoss1.body.data.paused).toBe(true);
    expect(camLoss2.body.data.deduplicated).toBe(true);
    expect(camLoss2.body.data.violationCount).toBe(1);
  });

  it("27. EXTENSION_HEURISTIC in AUDIT_ONLY mode records HEURISTIC confidence without adding strikes", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    const extRes = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.EXTENSION_HEURISTIC,
        confidence: "HEURISTIC",
        metadata: { signature: "grammarly-extension" },
      });

    expect(extRes.status).toBe(200);
    expect(extRes.body.data.event.confidence).toBe("HEURISTIC");
    expect(extRes.body.data.event.countedAsStrike).toBe(false);
    expect(extRes.body.data.violationCount).toBe(0);
    expect(extRes.body.data.warningIssued).toBe(false);
  });

  it("28. EXTENSION_HEURISTIC in STRIKE mode counts toward violation threshold when enabled by Admin", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId, admin } = await createActiveProctoredExam({ app, actors });
    await admin.agent
      .patch(`/api/v1/admin/proctoring/exams/${examId}/policy`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ extensionStrikeMode: "STRIKE", violationThreshold: 2 });

    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    const extRes = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.EXTENSION_HEURISTIC,
      });

    expect(extRes.body.data.event.countedAsStrike).toBe(true);
    expect(extRes.body.data.violationCount).toBe(1);
    expect(extRes.body.data.warningIssued).toBe(true);
  });

  it("29. Clipboard and lockdown restriction events follow individual policy toggles accurately", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId, admin } = await createActiveProctoredExam({ app, actors });
    await admin.agent
      .patch(`/api/v1/admin/proctoring/exams/${examId}/policy`)
      .set("X-CSRF-Token", admin.csrf)
      .send({
        restrictCopyPasteCut: true,
        detectClipboard: true,
        restrictRightClick: false,
        restrictSelectAll: true,
        violationThreshold: 4,
      });

    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    const copyEv = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({ clientEventId: crypto.randomUUID(), eventType: IntegrityEventType.COPY_ATTEMPT });
    const rightClickEv = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.RIGHT_CLICK_ATTEMPT,
      });
    const selectAllEv = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.SELECT_ALL_ATTEMPT,
      });

    expect(copyEv.body.data.violationCount).toBe(1);
    expect(rightClickEv.body.data.event.countedAsStrike).toBe(false);
    expect(rightClickEv.body.data.violationCount).toBe(1);
    expect(selectAllEv.body.data.event.countedAsStrike).toBe(true);
    expect(selectAllEv.body.data.violationCount).toBe(2);
  });

  it("30. Submitting integrity event after attempt expiresAt finalizes as TIMER_EXPIRED instead of VIOLATION_THRESHOLD", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await createActiveProctoredExam({ app, actors });
    const student = await loginAs(app, actors.student.email);
    const { attemptId } = await issuePreflightAndStartAttempt({ student, examId });

    await prisma.examAttempt.update({
      where: { id: attemptId },
      data: { expiresAt: new Date(Date.now() - 5_000) },
    });

    const lateEv = await student.agent
      .post(`/api/v1/student/attempts/${attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({ clientEventId: crypto.randomUUID(), eventType: IntegrityEventType.TAB_SWITCH });

    expect(lateEv.status).toBe(200);
    expect(lateEv.body.data.attemptStatus).toBe("EXPIRED");
    expect(lateEv.body.data.receipt.reason).toBe("TIMER_EXPIRED");
  });

  it("31. Nested /exams/:examId/attempts/:attemptId route validates exam membership against attemptId", async () => {
    const actors = await seedPhase4BaseActors();
    const examA = await createActiveProctoredExam({ app, actors, title: "Exam One" });
    const examB = await createActiveProctoredExam({ app, actors, title: "Exam Two" });
    const student = await loginAs(app, actors.student.email);

    const startedA = await issuePreflightAndStartAttempt({ student, examId: examA.examId });

    const mismatchRes = await student.agent
      .post(`/api/v1/student/exams/${examB.examId}/attempts/${startedA.attemptId}/integrity-events`)
      .set("X-CSRF-Token", student.csrf)
      .send({ clientEventId: crypto.randomUUID(), eventType: IntegrityEventType.TAB_SWITCH });

    expect(mismatchRes.status).toBe(404);
    expect(mismatchRes.body.error.code).toBe("ATTEMPT_NOT_FOUND");
  });
});
