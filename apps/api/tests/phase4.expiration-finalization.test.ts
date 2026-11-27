import { SubmissionReason } from "@pariksha/shared";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { disconnectPrisma, getPrismaClient } from "../src/lib/prisma.js";
import { sweepExpiredExamAttempts } from "../src/services/examExpirationWorker.js";
import { finalizeExamAttempt } from "../src/services/examFinalization.js";
import { resetTestDatabase } from "./testDbGuard.js";
import { futureWindowIso, loginAs, seedPhase4BaseActors } from "./phase4TestHelpers.js";

describe("Phase 4 Finalization, Timer Expiration Worker, Triggers & Auth Hardening (Tests 37-42)", () => {
  let app = createApp();
  const prisma = getPrismaClient();

  beforeEach(async () => {
    app = createApp();
    await resetTestDatabase();
  });

  afterAll(async () => {
    await disconnectPrisma();
  });

  async function setupStartedAttempt() {
    const actors = await seedPhase4BaseActors();
    const teacher = await loginAs(app, actors.teacher.email);
    const admin = await loginAs(app, actors.admin.email);
    const student = await loginAs(app, actors.student.email);

    const win = futureWindowIso(-60_000, 3_600_000);
    const createRes = await teacher.agent
      .post("/api/v1/teacher/exams")
      .set("X-CSRF-Token", teacher.csrf)
      .send({
        courseId: actors.course.id,
        title: "Finalization & Expiry Test",
        durationMinutes: 30,
        passingMarks: 1,
        windowStart: win.windowStart,
        windowEnd: win.windowEnd,
      });
    const examId = createRes.body.data.id as string;

    const qRes = await teacher.agent
      .post(`/api/v1/teacher/exams/${examId}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({
        type: "TRUE_FALSE",
        prompt: "Triggers protect immutable submissions.",
        marks: 2,
        options: [
          { text: "True", isCorrect: true },
          { text: "False", isCorrect: false },
        ],
      });
    const question = qRes.body.data.question;

    await teacher.agent
      .post(`/api/v1/teacher/exams/${examId}/submit-for-approval`)
      .set("X-CSRF-Token", teacher.csrf);

    await admin.agent
      .post(`/api/v1/admin/exams/${examId}/approve`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ activateImmediately: true, allowUnproctoredDev: true });

    const startRes = await student.agent
      .post(`/api/v1/student/exams/${examId}/start`)
      .set("X-CSRF-Token", student.csrf);
    const attemptId = startRes.body.data.id as string;

    await student.agent
      .put(`/api/v1/student/exams/${examId}/attempts/${attemptId}/answers`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        questionId: question.id,
        selectedOptionIds: [question.options[0].id],
        clientSequence: 1,
      });

    return { actors, admin, teacher, student, examId, attemptId, question };
  }

  it("37. Manual submission atomically finalizes answers, creates immutable receipt, and is idempotent", async () => {
    const { student, examId, attemptId } = await setupStartedAttempt();

    const sub1 = await student.agent
      .post(`/api/v1/student/exams/${examId}/attempts/${attemptId}/submit`)
      .set("X-CSRF-Token", student.csrf)
      .send({ confirmSubmit: true });
    expect(sub1.status).toBe(200);
    expect(sub1.body.data.alreadyFinalized).toBe(false);
    expect(sub1.body.data.receipt.status).toBe("SUBMITTED");
    expect(sub1.body.data.receipt.reason).toBe("MANUAL");
    expect(sub1.body.data.receipt.answeredCount).toBe(1);

    const sub2 = await student.agent
      .post(`/api/v1/student/exams/${examId}/attempts/${attemptId}/submit`)
      .set("X-CSRF-Token", student.csrf)
      .send({ confirmSubmit: true });
    expect(sub2.status).toBe(200);
    expect(sub2.body.data.alreadyFinalized).toBe(true);
    expect(sub2.body.data.receipt.receiptCode).toBe(sub1.body.data.receipt.receiptCode);

    const receiptGet = await student.agent.get(
      `/api/v1/student/exams/${examId}/attempts/${attemptId}/receipt`,
    );
    expect(receiptGet.status).toBe(200);
    expect(receiptGet.body.data.receiptCode).toBe(sub1.body.data.receipt.receiptCode);
  });

  it("38. Finalized attempts block subsequent API writes AND PostgreSQL triggers block raw answer/submission mutations", async () => {
    const { student, examId, attemptId, question } = await setupStartedAttempt();

    await student.agent
      .post(`/api/v1/student/exams/${examId}/attempts/${attemptId}/submit`)
      .set("X-CSRF-Token", student.csrf)
      .send({ confirmSubmit: true });

    const lateSave = await student.agent
      .put(`/api/v1/student/exams/${examId}/attempts/${attemptId}/answers`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        questionId: question.id,
        selectedOptionIds: [question.options[1].id],
        clientSequence: 2,
      });
    expect(lateSave.status).toBe(409);
    expect(lateSave.body.error.code).toBe("ATTEMPT_LOCKED");

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "ExamAnswer" SET "selectedOptionIds" = ARRAY[]::text[] WHERE "attemptId" = '${attemptId}'::uuid`,
      ),
    ).rejects.toThrow();

    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM "ExamSubmission" WHERE "attemptId" = '${attemptId}'::uuid`,
      ),
    ).rejects.toThrow();
  });

  it("39. Inline expiration check finalizes overdue attempt on autosave and rejects with ATTEMPT_EXPIRED", async () => {
    const { student, examId, attemptId, question } = await setupStartedAttempt();

    await prisma.examAttempt.update({
      where: { id: attemptId },
      data: { expiresAt: new Date(Date.now() - 5_000) },
    });

    const lateSave = await student.agent
      .put(`/api/v1/student/exams/${examId}/attempts/${attemptId}/answers`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        questionId: question.id,
        selectedOptionIds: [question.options[1].id],
        clientSequence: 2,
      });
    expect(lateSave.status).toBe(409);
    expect(lateSave.body.error.code).toBe("ATTEMPT_EXPIRED");

    const attempt = await prisma.examAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      include: { submission: true },
    });
    expect(attempt.status).toBe("EXPIRED");
    expect(attempt.finalizationReason).toBe("TIMER_EXPIRED");
    expect(attempt.submission?.reason).toBe("TIMER_EXPIRED");
  });

  it("40. Background expiration worker sweeps overdue active attempts cleanly after simulated restart", async () => {
    const { attemptId } = await setupStartedAttempt();

    await prisma.examAttempt.update({
      where: { id: attemptId },
      data: { expiresAt: new Date(Date.now() - 10_000) },
    });

    const sweptCount = await sweepExpiredExamAttempts(25);
    expect(sweptCount).toBe(1);

    const attempt = await prisma.examAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      include: { submission: true },
    });
    expect(attempt.status).toBe("EXPIRED");
    expect(attempt.isLocked).toBe(true);
    expect(attempt.submission?.reason).toBe("TIMER_EXPIRED");

    // Second sweep finds nothing left to finalize
    expect(await sweepExpiredExamAttempts(25)).toBe(0);
  });

  it("41. Concurrent finalizeExamAttempt calls serialize safely on FOR UPDATE lock with exactly 1 submission", async () => {
    const { attemptId } = await setupStartedAttempt();

    const [r1, r2] = await Promise.all([
      finalizeExamAttempt({ attemptId, reason: SubmissionReason.MANUAL }),
      finalizeExamAttempt({ attemptId, reason: SubmissionReason.TIMER_EXPIRED }),
    ]);

    expect(r1.receipt.receiptCode).toBe(r2.receipt.receiptCode);
    expect(r1.alreadyFinalized !== r2.alreadyFinalized).toBe(true);

    const submissionCount = await prisma.examSubmission.count({ where: { attemptId } });
    expect(submissionCount).toBe(1);
  });

  it("42. Rejects unauthenticated requests and missing/invalid CSRF tokens across Phase 4 exam mutations", async () => {
    const { teacher, examId, attemptId, student, question } = await setupStartedAttempt();

    expect((await request(app).get("/api/v1/teacher/exams")).status).toBe(401);
    expect((await request(app).get("/api/v1/admin/exams")).status).toBe(401);
    expect((await request(app).get("/api/v1/student/exams")).status).toBe(401);

    const noCsrfTeacher = await teacher.agent
      .post(`/api/v1/teacher/exams/${examId}/duplicate`)
      .send({});
    expect(noCsrfTeacher.status).toBe(403);

    const noCsrfSave = await student.agent
      .put(`/api/v1/student/exams/${examId}/attempts/${attemptId}/answers`)
      .send({
        questionId: question.id,
        selectedOptionIds: [question.options[0].id],
        clientSequence: 9,
      });
    expect(noCsrfSave.status).toBe(403);
  });
});
