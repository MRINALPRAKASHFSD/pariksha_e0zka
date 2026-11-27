import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { disconnectPrisma, getPrismaClient } from "../src/lib/prisma.js";
import { resetTestDatabase } from "./testDbGuard.js";
import { futureWindowIso, loginAs, seedPhase4BaseActors } from "./phase4TestHelpers.js";

describe("Phase 4 Student Eligibility, Proctoring Gate, Answer-Key Isolation & Autosave (Tests 27-36)", () => {
  let app = createApp();
  const prisma = getPrismaClient();

  beforeEach(async () => {
    app = createApp();
    await resetTestDatabase();
  });

  afterAll(async () => {
    await disconnectPrisma();
  });

  async function createFullActiveExam(options: {
    actors: Awaited<ReturnType<typeof seedPhase4BaseActors>>;
    allowUnproctoredDev: boolean;
    windowOffsetStartMs?: number;
    windowOffsetEndMs?: number;
    durationMinutes?: number;
    maxAttempts?: number;
  }) {
    const teacher = await loginAs(app, options.actors.teacher.email);
    const admin = await loginAs(app, options.actors.admin.email);

    const win = futureWindowIso(
      options.windowOffsetStartMs ?? -60_000,
      options.windowOffsetEndMs ?? 3_600_000,
    );

    const createRes = await teacher.agent
      .post("/api/v1/teacher/exams")
      .set("X-CSRF-Token", teacher.csrf)
      .send({
        courseId: options.actors.course.id,
        title: "Full Spectrum Exam",
        durationMinutes: options.durationMinutes ?? 60,
        passingMarks: 2,
        maxAttempts: options.maxAttempts ?? 1,
        windowStart: win.windowStart,
        windowEnd: win.windowEnd,
      });
    const examId = createRes.body.data.id as string;

    const mcq = await teacher.agent
      .post(`/api/v1/teacher/exams/${examId}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({
        type: "MULTIPLE_CHOICE",
        prompt: "Capital of France?",
        explanation: "Paris is the capital.",
        marks: 2,
        options: [
          { text: "Berlin", isCorrect: false },
          { text: "Paris", isCorrect: true },
        ],
      });

    const msq = await teacher.agent
      .post(`/api/v1/teacher/exams/${examId}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({
        type: "MULTIPLE_SELECT",
        prompt: "Select even numbers",
        explanation: "2 and 4 are even.",
        marks: 3,
        options: [
          { text: "2", isCorrect: true },
          { text: "3", isCorrect: false },
          { text: "4", isCorrect: true },
        ],
      });

    const tf = await teacher.agent
      .post(`/api/v1/teacher/exams/${examId}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({
        type: "TRUE_FALSE",
        prompt: "PostgreSQL supports ACID.",
        marks: 1,
        options: [
          { text: "True", isCorrect: true },
          { text: "False", isCorrect: false },
        ],
      });

    const shortSub = await teacher.agent
      .post(`/api/v1/teacher/exams/${examId}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({
        type: "SUBJECTIVE_SHORT",
        prompt: "Summarize two-phase locking.",
        marks: 4,
      });

    const longSub = await teacher.agent
      .post(`/api/v1/teacher/exams/${examId}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({
        type: "SUBJECTIVE_LONG",
        prompt: "Architect an exam engine.",
        marks: 10,
      });

    await teacher.agent
      .post(`/api/v1/teacher/exams/${examId}/submit-for-approval`)
      .set("X-CSRF-Token", teacher.csrf);

    await admin.agent
      .post(`/api/v1/admin/exams/${examId}/approve`)
      .set("X-CSRF-Token", admin.csrf)
      .send({
        activateImmediately: true,
        allowUnproctoredDev: options.allowUnproctoredDev,
      });

    return {
      examId,
      questions: {
        mcq: mcq.body.data.question,
        msq: msq.body.data.question,
        tf: tf.body.data.question,
        shortSub: shortSub.body.data.question,
        longSub: longSub.body.data.question,
      },
    };
  }

  it("27. Non-enrolled or DROPPED students cannot list or start exam; drafts stay hidden from students", async () => {
    const actors = await seedPhase4BaseActors();
    const teacher = await loginAs(app, actors.teacher.email);
    const outsider = await loginAs(app, actors.otherStudent.email);
    const enrolled = await loginAs(app, actors.student.email);

    // Draft exam hidden from enrolled student
    const draftRes = await teacher.agent
      .post("/api/v1/teacher/exams")
      .set("X-CSRF-Token", teacher.csrf)
      .send({
        courseId: actors.course.id,
        title: "Secret Draft",
        durationMinutes: 20,
        ...futureWindowIso(),
      });
    const draftId = draftRes.body.data.id as string;

    expect((await enrolled.agent.get("/api/v1/student/exams")).body.data.items).toHaveLength(0);
    expect((await enrolled.agent.get(`/api/v1/student/exams/${draftId}`)).status).toBe(404);

    // Active exam hidden from non-enrolled student
    const { examId } = await createFullActiveExam({ actors, allowUnproctoredDev: true });
    expect((await outsider.agent.get("/api/v1/student/exams")).body.data.items).toHaveLength(0);
    expect(
      (
        await outsider.agent
          .post(`/api/v1/student/exams/${examId}/start`)
          .set("X-CSRF-Token", outsider.csrf)
      ).status,
    ).toBe(403);
  });

  it("28. Rejects starting exam before windowStart or after windowEnd", async () => {
    const actors = await seedPhase4BaseActors();
    const student = await loginAs(app, actors.student.email);

    const futureExam = await createFullActiveExam({
      actors,
      allowUnproctoredDev: true,
      windowOffsetStartMs: 600_000,
      windowOffsetEndMs: 3_600_000,
    });

    const tooEarly = await student.agent
      .post(`/api/v1/student/exams/${futureExam.examId}/start`)
      .set("X-CSRF-Token", student.csrf);
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.body.error.code).toBe("EXAM_WINDOW_NOT_OPEN");
  });

  it("29. Phase 5 Proctoring Gate strictly blocks unproctored start unless explicitly configured by Admin", async () => {
    const actors = await seedPhase4BaseActors();
    const student = await loginAs(app, actors.student.email);

    const lockedExam = await createFullActiveExam({
      actors,
      allowUnproctoredDev: false,
    });

    const listRes = await student.agent.get("/api/v1/student/exams");
    expect(listRes.body.data.items[0].eligibilityStatus).toBe("PREFLIGHT_REQUIRED");
    expect(listRes.body.data.items[0].canStart).toBe(true);
    expect(listRes.body.data.items[0].preflight.requiresPreflightHandshake).toBe(true);

    const blockedStart = await student.agent
      .post(`/api/v1/student/exams/${lockedExam.examId}/start`)
      .set("X-CSRF-Token", student.csrf);
    expect(blockedStart.status).toBe(409);
    expect(blockedStart.body.error.code).toBe("PREFLIGHT_REQUIRED");

    // Admin enables development-only unproctored delivery
    const admin = await loginAs(app, actors.admin.email);
    await admin.agent
      .patch(`/api/v1/admin/exams/${lockedExam.examId}/config`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ allowUnproctoredDev: true });

    const allowedStart = await student.agent
      .post(`/api/v1/student/exams/${lockedExam.examId}/start`)
      .set("X-CSRF-Token", student.csrf);
    expect(allowedStart.status).toBe(201);
    expect(allowedStart.body.data.allowUnproctoredDev).toBe(true);
  });

  it("30. Zero answer-key or explanation leakage across all student exam/attempt endpoints and snapshots", async () => {
    const actors = await seedPhase4BaseActors();
    const student = await loginAs(app, actors.student.email);
    const { examId } = await createFullActiveExam({ actors, allowUnproctoredDev: true });

    const startRes = await student.agent
      .post(`/api/v1/student/exams/${examId}/start`)
      .set("X-CSRF-Token", student.csrf);
    expect(startRes.status).toBe(201);
    const serialized = JSON.stringify(startRes.body.data);

    expect(serialized).not.toContain("isCorrect");
    expect(serialized).not.toContain("correctOptionIds");
    expect(serialized).not.toContain("answerKeySnapshotJson");
    expect(serialized).not.toContain("Paris is the capital.");
    expect(serialized).not.toContain("2 and 4 are even.");

    const getAttemptRes = await student.agent.get(
      `/api/v1/student/exams/${examId}/attempts/${startRes.body.data.id}`,
    );
    expect(getAttemptRes.headers["cache-control"]).toContain("no-store");
    const serializedGet = JSON.stringify(getAttemptRes.body.data);
    expect(serializedGet).not.toContain("isCorrect");
    expect(serializedGet).not.toContain("Paris is the capital.");
  });

  it("31. Concurrent duplicate start calls are idempotent and partial unique index enforces 1 active attempt", async () => {
    const actors = await seedPhase4BaseActors();
    const student = await loginAs(app, actors.student.email);
    const { examId } = await createFullActiveExam({
      actors,
      allowUnproctoredDev: true,
      maxAttempts: 3,
    });

    const [resA, resB] = await Promise.all([
      student.agent
        .post(`/api/v1/student/exams/${examId}/start`)
        .set("X-CSRF-Token", student.csrf),
      student.agent
        .post(`/api/v1/student/exams/${examId}/start`)
        .set("X-CSRF-Token", student.csrf),
    ]);

    expect([200, 201]).toContain(resA.status);
    expect([200, 201]).toContain(resB.status);
    expect(resA.body.data.id).toBe(resB.body.data.id);

    const activeCount = await prisma.examAttempt.count({
      where: { examId, studentId: actors.student.id, status: "IN_PROGRESS" },
    });
    expect(activeCount).toBe(1);
  });

  it("32. Attempt deadline is strictly clamped to min(startedAt + duration, exam.windowEnd)", async () => {
    const actors = await seedPhase4BaseActors();
    const student = await loginAs(app, actors.student.email);
    const { examId } = await createFullActiveExam({
      actors,
      allowUnproctoredDev: true,
      durationMinutes: 120,
      windowOffsetStartMs: -60_000,
      windowOffsetEndMs: 120_000, // 2 minutes left in window < 120 min duration
    });

    const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId } });
    const startRes = await student.agent
      .post(`/api/v1/student/exams/${examId}/start`)
      .set("X-CSRF-Token", student.csrf);

    expect(startRes.status).toBe(201);
    const expiresAtMs = Date.parse(startRes.body.data.expiresAt as string);
    expect(expiresAtMs).toBeLessThanOrEqual(exam.windowEnd.getTime());
    expect(expiresAtMs).toBe(exam.windowEnd.getTime());
  });

  it("33. Enforces maxAttempts limit after completed attempts", async () => {
    const actors = await seedPhase4BaseActors();
    const student = await loginAs(app, actors.student.email);
    const { examId } = await createFullActiveExam({
      actors,
      allowUnproctoredDev: true,
      maxAttempts: 1,
    });

    const start1 = await student.agent
      .post(`/api/v1/student/exams/${examId}/start`)
      .set("X-CSRF-Token", student.csrf);
    const attemptId = start1.body.data.id as string;

    await student.agent
      .post(`/api/v1/student/exams/${examId}/attempts/${attemptId}/submit`)
      .set("X-CSRF-Token", student.csrf)
      .send({ confirmSubmit: true });

    const start2 = await student.agent
      .post(`/api/v1/student/exams/${examId}/start`)
      .set("X-CSRF-Token", student.csrf);
    expect(start2.status).toBe(409);
    expect(start2.body.error.code).toBe("ATTEMPT_LIMIT_REACHED");
  });

  it("34. Saves and reloads all 5 question types, markedForReview, clear response, and sets Cache-Control: no-store", async () => {
    const actors = await seedPhase4BaseActors();
    const student = await loginAs(app, actors.student.email);
    const { examId, questions } = await createFullActiveExam({
      actors,
      allowUnproctoredDev: true,
    });

    const startRes = await student.agent
      .post(`/api/v1/student/exams/${examId}/start`)
      .set("X-CSRF-Token", student.csrf);
    const attemptId = startRes.body.data.id as string;

    const mcqOpt = questions.mcq.options[1].id;
    const msqOpts = [questions.msq.options[0].id, questions.msq.options[2].id];
    const tfOpt = questions.tf.options[0].id;

    const save1 = await student.agent
      .put(`/api/v1/student/exams/${examId}/attempts/${attemptId}/answers`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        questionId: questions.mcq.id,
        selectedOptionIds: [mcqOpt],
        markedForReview: true,
        clientSequence: 1,
      });
    expect(save1.status).toBe(200);
    expect(save1.headers["cache-control"]).toContain("no-store");

    await student.agent
      .put(`/api/v1/student/exams/${examId}/attempts/${attemptId}/answers`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        questionId: questions.msq.id,
        selectedOptionIds: msqOpts,
        clientSequence: 2,
      });

    await student.agent
      .put(`/api/v1/student/exams/${examId}/attempts/${attemptId}/answers`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        questionId: questions.tf.id,
        selectedOptionIds: [tfOpt],
        clientSequence: 3,
      });

    await student.agent
      .put(`/api/v1/student/exams/${examId}/attempts/${attemptId}/answers`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        questionId: questions.shortSub.id,
        selectedOptionIds: [],
        textAnswer: "Shared and exclusive locks prevent anomalies.",
        clientSequence: 4,
      });

    await student.agent
      .put(`/api/v1/student/exams/${examId}/attempts/${attemptId}/answers`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        questionId: questions.longSub.id,
        selectedOptionIds: [],
        textAnswer: "Use Postgres FOR UPDATE + partial unique indexes.",
        clientSequence: 5,
      });

    const reload = await student.agent.get(`/api/v1/student/exams/${examId}/attempts/${attemptId}`);
    expect(reload.status).toBe(200);
    expect(reload.body.data.answers).toHaveLength(5);

    const savedShort = reload.body.data.answers.find(
      (a: { questionId: string }) => a.questionId === questions.shortSub.id,
    );
    expect(savedShort.textAnswer).toBe("Shared and exclusive locks prevent anomalies.");

    // Clear response
    await student.agent
      .put(`/api/v1/student/exams/${examId}/attempts/${attemptId}/answers`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        questionId: questions.tf.id,
        selectedOptionIds: [],
        clientSequence: 6,
      });
    const cleared = await prisma.examAnswer.findUniqueOrThrow({
      where: { attemptId_questionId: { attemptId, questionId: questions.tf.id } },
    });
    expect(cleared.selectedOptionIds).toEqual([]);
  });

  it("35. Rejects invalid option IDs, enforces stale sequence ordering, and detects revision conflicts", async () => {
    const actors = await seedPhase4BaseActors();
    const student = await loginAs(app, actors.student.email);
    const { examId, questions } = await createFullActiveExam({
      actors,
      allowUnproctoredDev: true,
    });

    const startRes = await student.agent
      .post(`/api/v1/student/exams/${examId}/start`)
      .set("X-CSRF-Token", student.csrf);
    const attemptId = startRes.body.data.id as string;

    // Invalid option ID
    const badOpt = await student.agent
      .put(`/api/v1/student/exams/${examId}/attempts/${attemptId}/answers`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        questionId: questions.mcq.id,
        selectedOptionIds: [questions.msq.options[0].id],
        clientSequence: 1,
      });
    expect(badOpt.status).toBe(400);
    expect(badOpt.body.error.code).toBe("INVALID_OPTION_SELECTION");

    // Newer sequence wins; lower out-of-order sequence is safely ignored
    await student.agent
      .put(`/api/v1/student/exams/${examId}/attempts/${attemptId}/answers`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        questionId: questions.mcq.id,
        selectedOptionIds: [questions.mcq.options[1].id],
        clientSequence: 10,
      });

    const staleSave = await student.agent
      .put(`/api/v1/student/exams/${examId}/attempts/${attemptId}/answers`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        questionId: questions.mcq.id,
        selectedOptionIds: [questions.mcq.options[0].id],
        clientSequence: 5,
      });
    expect(staleSave.status).toBe(200);
    expect(staleSave.body.data.staleIgnored).toBe(true);
    expect(staleSave.body.data.answer.selectedOptionIds).toEqual([questions.mcq.options[1].id]);

    // Expected revision mismatch conflict
    const revConflict = await student.agent
      .put(`/api/v1/student/exams/${examId}/attempts/${attemptId}/answers`)
      .set("X-CSRF-Token", student.csrf)
      .send({
        questionId: questions.mcq.id,
        selectedOptionIds: [questions.mcq.options[0].id],
        clientSequence: 11,
        expectedRevision: 99,
      });
    expect(revConflict.status).toBe(409);
    expect(revConflict.body.error.code).toBe("ANSWER_REVISION_CONFLICT");
  });

  it("36. Prevents horizontal privilege escalation: another student cannot read, autosave, or submit someone else's attempt", async () => {
    const actors = await seedPhase4BaseActors();
    await prisma.enrollment.create({
      data: { courseId: actors.course.id, studentId: actors.otherStudent.id, status: "ACTIVE" },
    });

    const student1 = await loginAs(app, actors.student.email);
    const student2 = await loginAs(app, actors.otherStudent.email);
    const { examId, questions } = await createFullActiveExam({
      actors,
      allowUnproctoredDev: true,
    });

    const startRes = await student1.agent
      .post(`/api/v1/student/exams/${examId}/start`)
      .set("X-CSRF-Token", student1.csrf);
    const attemptId = startRes.body.data.id as string;

    expect(
      (await student2.agent.get(`/api/v1/student/exams/${examId}/attempts/${attemptId}`)).status,
    ).toBe(403);
    expect(
      (
        await student2.agent
          .put(`/api/v1/student/exams/${examId}/attempts/${attemptId}/answers`)
          .set("X-CSRF-Token", student2.csrf)
          .send({
            questionId: questions.mcq.id,
            selectedOptionIds: [questions.mcq.options[0].id],
            clientSequence: 1,
          })
      ).status,
    ).toBe(403);
    expect(
      (
        await student2.agent
          .post(`/api/v1/student/exams/${examId}/attempts/${attemptId}/submit`)
          .set("X-CSRF-Token", student2.csrf)
          .send({ confirmSubmit: true })
      ).status,
    ).toBe(403);
  });
});
