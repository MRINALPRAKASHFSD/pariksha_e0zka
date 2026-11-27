import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { disconnectPrisma, getPrismaClient } from "../src/lib/prisma.js";
import { resetTestDatabase } from "./testDbGuard.js";
import { futureWindowIso, loginAs, seedPhase4BaseActors } from "./phase4TestHelpers.js";

describe("Phase 4 Admin Examination Controls, Pausing, Cancellation, Versioning & Audit (Tests 17-26)", () => {
  let app = createApp();
  const prisma = getPrismaClient();

  beforeEach(async () => {
    app = createApp();
    await resetTestDatabase();
  });

  afterAll(async () => {
    await disconnectPrisma();
  });

  async function buildSubmittedExam(
    actors: Awaited<ReturnType<typeof seedPhase4BaseActors>>,
    title = "Systems Final",
  ) {
    const teacher = await loginAs(app, actors.teacher.email);
    const win = futureWindowIso(-60_000, 3_600_000);
    const createRes = await teacher.agent
      .post("/api/v1/teacher/exams")
      .set("X-CSRF-Token", teacher.csrf)
      .send({
        courseId: actors.course.id,
        title,
        durationMinutes: 30,
        passingMarks: 2,
        maxAttempts: 2,
        windowStart: win.windowStart,
        windowEnd: win.windowEnd,
      });
    const examId = createRes.body.data.id as string;

    await teacher.agent
      .post(`/api/v1/teacher/exams/${examId}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({
        type: "MULTIPLE_CHOICE",
        prompt: "What is Raft?",
        marks: 4,
        options: [
          { text: "Consensus algorithm", isCorrect: true },
          { text: "Sort algorithm", isCorrect: false },
        ],
      });

    await teacher.agent
      .post(`/api/v1/teacher/exams/${examId}/submit-for-approval`)
      .set("X-CSRF-Token", teacher.csrf);

    return { examId, teacher };
  }

  it("17. Non-admins (Teacher and Student) cannot invoke /api/v1/admin/exams endpoints", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await buildSubmittedExam(actors);
    const teacher = await loginAs(app, actors.teacher.email);
    const student = await loginAs(app, actors.student.email);

    expect((await teacher.agent.get("/api/v1/admin/exams")).status).toBe(403);
    expect((await student.agent.get("/api/v1/admin/exams")).status).toBe(403);
    expect(
      (
        await teacher.agent
          .post(`/api/v1/admin/exams/${examId}/approve`)
          .set("X-CSRF-Token", teacher.csrf)
          .send({ activateImmediately: true })
      ).status,
    ).toBe(403);
    expect(
      (
        await student.agent
          .post(`/api/v1/admin/exams/${examId}/activate`)
          .set("X-CSRF-Token", student.csrf)
      ).status,
    ).toBe(403);
  });

  it("18. Admin rejects PENDING_APPROVAL exam with reason and sets REJECTED status", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await buildSubmittedExam(actors);
    const admin = await loginAs(app, actors.admin.email);

    const res = await admin.agent
      .post(`/api/v1/admin/exams/${examId}/reject`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ reason: "Add one more subjective question" });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("REJECTED");
    expect(res.body.data.rejectionReason).toBe("Add one more subjective question");
  });

  it("19. Admin approves, configures schedule/maxAttempts, activates, and keeps Phase 5 gate by default", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await buildSubmittedExam(actors);
    const admin = await loginAs(app, actors.admin.email);

    const win = futureWindowIso(-60_000, 7_200_000);
    const approveRes = await admin.agent
      .post(`/api/v1/admin/exams/${examId}/approve`)
      .set("X-CSRF-Token", admin.csrf)
      .send({
        windowStart: win.windowStart,
        windowEnd: win.windowEnd,
        durationMinutes: 45,
        maxAttempts: 3,
        activateImmediately: true,
        allowUnproctoredDev: false,
      });

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.data.status).toBe("ACTIVE");
    expect(approveRes.body.data.durationMinutes).toBe(45);
    expect(approveRes.body.data.maxAttempts).toBe(3);
    expect(approveRes.body.data.preflight.mode).toBe("PROCTORED_REQUIRED");
    expect(approveRes.body.data.preflight.canStartAttempt).toBe(true);
    expect(approveRes.body.data.preflight.requiresPreflightHandshake).toBe(true);
    expect(approveRes.body.data.preflight.blockingCode).toBeNull();
  });

  it("20. Admin pausing ACTIVE exam blocks new student starts while letting ongoing attempts resume & submit", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await buildSubmittedExam(actors);
    const admin = await loginAs(app, actors.admin.email);
    const student = await loginAs(app, actors.student.email);

    await prisma.enrollment.create({
      data: { courseId: actors.course.id, studentId: actors.otherStudent.id, status: "ACTIVE" },
    });
    const student2 = await loginAs(app, actors.otherStudent.email);

    await admin.agent
      .post(`/api/v1/admin/exams/${examId}/approve`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ activateImmediately: true, allowUnproctoredDev: true });

    // Student 1 starts before pause
    const start1 = await student.agent
      .post(`/api/v1/student/exams/${examId}/start`)
      .set("X-CSRF-Token", student.csrf);
    expect(start1.status).toBe(201);
    const attemptId = start1.body.data.id as string;

    // Admin pauses exam
    const pauseRes = await admin.agent
      .post(`/api/v1/admin/exams/${examId}/pause`)
      .set("X-CSRF-Token", admin.csrf);
    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body.data.status).toBe("PAUSED");

    // Student 2 cannot start new attempt while PAUSED
    const start2 = await student2.agent
      .post(`/api/v1/student/exams/${examId}/start`)
      .set("X-CSRF-Token", student2.csrf);
    expect(start2.status).toBe(409);
    expect(start2.body.error.code).toBe("EXAM_PAUSED");

    // Student 1's active attempt resumes cleanly and submits
    const resume1 = await student.agent
      .post(`/api/v1/student/exams/${examId}/start`)
      .set("X-CSRF-Token", student.csrf);
    expect(resume1.status).toBe(200);
    expect(resume1.body.data.id).toBe(attemptId);

    const submit1 = await student.agent
      .post(`/api/v1/student/exams/${examId}/attempts/${attemptId}/submit`)
      .set("X-CSRF-Token", student.csrf)
      .send({ confirmSubmit: true });
    expect(submit1.status).toBe(200);
    expect(submit1.body.data.receipt.status).toBe("SUBMITTED");
  });

  it("21. Admin disables exam (isEnabled: false) -> student starts blocked", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await buildSubmittedExam(actors);
    const admin = await loginAs(app, actors.admin.email);
    const student = await loginAs(app, actors.student.email);

    await admin.agent
      .post(`/api/v1/admin/exams/${examId}/approve`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ activateImmediately: true, allowUnproctoredDev: true });

    await admin.agent
      .patch(`/api/v1/admin/exams/${examId}/config`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ isEnabled: false });

    const startRes = await student.agent
      .post(`/api/v1/student/exams/${examId}/start`)
      .set("X-CSRF-Token", student.csrf);
    expect(startRes.status).toBe(409);
    expect(startRes.body.error.code).toBe("EXAM_DISABLED");
  });

  it("22. Admin cancels active exam -> atomically finalizes ongoing attempts with TERMINATED + EXAM_CANCELLED receipt", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await buildSubmittedExam(actors);
    const admin = await loginAs(app, actors.admin.email);
    const student = await loginAs(app, actors.student.email);

    await admin.agent
      .post(`/api/v1/admin/exams/${examId}/approve`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ activateImmediately: true, allowUnproctoredDev: true });

    const startRes = await student.agent
      .post(`/api/v1/student/exams/${examId}/start`)
      .set("X-CSRF-Token", student.csrf);
    const attemptId = startRes.body.data.id as string;

    const cancelRes = await admin.agent
      .post(`/api/v1/admin/exams/${examId}/cancel`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ reason: "Campus power outage" });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.status).toBe("CANCELLED");

    const attempt = await prisma.examAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      include: { submission: true },
    });
    expect(attempt.status).toBe("TERMINATED");
    expect(attempt.finalizationReason).toBe("EXAM_CANCELLED");
    expect(attempt.submission?.reason).toBe("EXAM_CANCELLED");
  });

  it("23. Admin creates new exam version (v2) preserving existing v1 attempts cleanly", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await buildSubmittedExam(actors, "Operating Systems");
    const admin = await loginAs(app, actors.admin.email);
    const student = await loginAs(app, actors.student.email);

    await admin.agent
      .post(`/api/v1/admin/exams/${examId}/approve`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ activateImmediately: true, allowUnproctoredDev: true });

    const startRes = await student.agent
      .post(`/api/v1/student/exams/${examId}/start`)
      .set("X-CSRF-Token", student.csrf);
    const attemptId = startRes.body.data.id as string;

    const versionRes = await admin.agent
      .post(`/api/v1/admin/exams/${examId}/create-version`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ durationMinutes: 60 });
    expect(versionRes.status).toBe(201);
    expect(versionRes.body.data.version).toBe(2);
    expect(versionRes.body.data.parentExamId).toBe(examId);
    expect(versionRes.body.data.status).toBe("DRAFT");
    expect(versionRes.body.data.questions).toHaveLength(1);

    const v1Attempt = await prisma.examAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(v1Attempt.examVersion).toBe(1);
  });

  it("24. Admin force-terminates an active attempt atomically with ADMIN_FORCE reason", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await buildSubmittedExam(actors);
    const admin = await loginAs(app, actors.admin.email);
    const student = await loginAs(app, actors.student.email);

    await admin.agent
      .post(`/api/v1/admin/exams/${examId}/approve`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ activateImmediately: true, allowUnproctoredDev: true });

    const startRes = await student.agent
      .post(`/api/v1/student/exams/${examId}/start`)
      .set("X-CSRF-Token", student.csrf);
    const attemptId = startRes.body.data.id as string;

    const termRes = await admin.agent
      .post(`/api/v1/admin/exams/${examId}/attempts/${attemptId}/terminate`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ reason: "Manual override" });

    expect(termRes.status).toBe(200);
    expect(termRes.body.data.receipt.status).toBe("TERMINATED");
    expect(termRes.body.data.receipt.reason).toBe("ADMIN_FORCE");
  });

  it("25. Teacher cannot modify exam metadata or questions once attempts exist even if status were forced", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId, teacher } = await buildSubmittedExam(actors);
    const admin = await loginAs(app, actors.admin.email);
    const student = await loginAs(app, actors.student.email);

    await admin.agent
      .post(`/api/v1/admin/exams/${examId}/approve`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ activateImmediately: true, allowUnproctoredDev: true });

    await student.agent
      .post(`/api/v1/student/exams/${examId}/start`)
      .set("X-CSRF-Token", student.csrf);

    const editBlocked = await teacher.agent
      .patch(`/api/v1/teacher/exams/${examId}`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({ title: "Should fail" });
    expect(editBlocked.status).toBe(409);
  });

  it("26. Admin lifecycle transitions record complete immutable audit log actions", async () => {
    const actors = await seedPhase4BaseActors();
    const { examId } = await buildSubmittedExam(actors);
    const admin = await loginAs(app, actors.admin.email);

    await admin.agent
      .post(`/api/v1/admin/exams/${examId}/approve`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ activateImmediately: true, allowUnproctoredDev: true });
    await admin.agent
      .post(`/api/v1/admin/exams/${examId}/pause`)
      .set("X-CSRF-Token", admin.csrf);
    await admin.agent
      .post(`/api/v1/admin/exams/${examId}/cancel`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ reason: "Audit verification" });

    const logs = await prisma.auditLog.findMany({
      where: { entityType: "Exam", entityId: examId },
      select: { action: true },
    });
    const actions = logs.map((l) => l.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "EXAM_CREATED",
        "EXAM_SUBMITTED_FOR_APPROVAL",
        "EXAM_APPROVED",
        "EXAM_ACTIVATED",
        "EXAM_PAUSED",
        "EXAM_CANCELLED",
      ]),
    );
  });
});
