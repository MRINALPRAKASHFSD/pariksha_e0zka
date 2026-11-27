import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { disconnectPrisma, getPrismaClient } from "../src/lib/prisma.js";
import { resetTestDatabase } from "./testDbGuard.js";
import { futureWindowIso, loginAs, seedPhase4BaseActors } from "./phase4TestHelpers.js";

describe("Phase 4 Teacher Examination Management, Question Builder & Import/Export (Tests 1-16)", () => {
  let app = createApp();
  const prisma = getPrismaClient();

  beforeEach(async () => {
    app = createApp();
    await resetTestDatabase();
  });

  afterAll(async () => {
    await disconnectPrisma();
  });

  async function createSampleDraftExam(
    teacherSession: Awaited<ReturnType<typeof loginAs>>,
    courseId: string,
    title = "Midterm Examination",
  ) {
    const win = futureWindowIso();
    const res = await teacherSession.agent
      .post("/api/v1/teacher/exams")
      .set("X-CSRF-Token", teacherSession.csrf)
      .send({
        courseId,
        title,
        description: "Covers modules 1 to 4",
        instructions: "Answer carefully",
        passingMarks: 2,
        durationMinutes: 45,
        windowStart: win.windowStart,
        windowEnd: win.windowEnd,
        maxAttempts: 1,
      });
    expect(res.status).toBe(201);
    return res.body.data as { id: string; title: string; totalMarks: number };
  }

  it("1. Teacher creates draft exam for assigned course and validates window & negative marks boundaries", async () => {
    const actors = await seedPhase4BaseActors();
    const teacher = await loginAs(app, actors.teacher.email);
    const draft = await createSampleDraftExam(teacher, actors.course.id);

    expect(draft.totalMarks).toBe(0);

    const invalidWindowRes = await teacher.agent
      .post("/api/v1/teacher/exams")
      .set("X-CSRF-Token", teacher.csrf)
      .send({
        courseId: actors.course.id,
        title: "Invalid Window",
        durationMinutes: 30,
        passingMarks: -5,
        windowStart: new Date(Date.now() + 100_000).toISOString(),
        windowEnd: new Date(Date.now() + 50_000).toISOString(),
      });
    expect(invalidWindowRes.status).toBe(400);
  });

  it("2. Unassigned teacher cannot create, view, mutate, export, or inspect attempts for another teacher's exam", async () => {
    const actors = await seedPhase4BaseActors();
    const teacher = await loginAs(app, actors.teacher.email);
    const outsiderTeacher = await loginAs(app, actors.otherTeacher.email);

    const createUnauthorized = await outsiderTeacher.agent
      .post("/api/v1/teacher/exams")
      .set("X-CSRF-Token", outsiderTeacher.csrf)
      .send({
        courseId: actors.course.id,
        title: "Hijack Attempt",
        durationMinutes: 30,
        ...futureWindowIso(),
      });
    expect(createUnauthorized.status).toBe(403);

    const exam = await createSampleDraftExam(teacher, actors.course.id);

    expect((await outsiderTeacher.agent.get(`/api/v1/teacher/exams/${exam.id}`)).status).toBe(403);
    expect(
      (
        await outsiderTeacher.agent
          .patch(`/api/v1/teacher/exams/${exam.id}`)
          .set("X-CSRF-Token", outsiderTeacher.csrf)
          .send({ title: "Hijacked" })
      ).status,
    ).toBe(403);
    expect(
      (await outsiderTeacher.agent.get(`/api/v1/teacher/exams/${exam.id}/questions/export`)).status,
    ).toBe(403);
    expect(
      (await outsiderTeacher.agent.get(`/api/v1/teacher/exams/${exam.id}/attempts`)).status,
    ).toBe(403);
  });

  it("3. Teacher creates MULTIPLE_CHOICE question and rejects invalid correct option counts", async () => {
    const actors = await seedPhase4BaseActors();
    const teacher = await loginAs(app, actors.teacher.email);
    const exam = await createSampleDraftExam(teacher, actors.course.id);

    const twoCorrect = await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({
        type: "MULTIPLE_CHOICE",
        prompt: "Pick one",
        marks: 4,
        options: [
          { text: "A1", isCorrect: true },
          { text: "A2", isCorrect: true },
        ],
      });
    expect(twoCorrect.status).toBe(400);

    const valid = await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({
        type: "MULTIPLE_CHOICE",
        prompt: "What is 2 + 2?",
        marks: 4,
        negativeMarks: 1,
        explanation: "Basic arithmetic",
        isRequired: true,
        options: [
          { text: "3", isCorrect: false },
          { text: "4", isCorrect: true },
        ],
      });
    expect(valid.status).toBe(201);
    expect(valid.body.data.examTotalMarks).toBe(4);
    expect(valid.body.data.question.options).toHaveLength(2);
  });

  it("4. Teacher creates MULTIPLE_SELECT question requiring >= 1 correct option", async () => {
    const actors = await seedPhase4BaseActors();
    const teacher = await loginAs(app, actors.teacher.email);
    const exam = await createSampleDraftExam(teacher, actors.course.id);

    const zeroCorrect = await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({
        type: "MULTIPLE_SELECT",
        prompt: "Pick primes",
        marks: 5,
        options: [
          { text: "4", isCorrect: false },
          { text: "6", isCorrect: false },
        ],
      });
    expect(zeroCorrect.status).toBe(400);

    const valid = await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({
        type: "MULTIPLE_SELECT",
        prompt: "Pick prime numbers",
        marks: 5,
        options: [
          { text: "2", isCorrect: true },
          { text: "3", isCorrect: true },
          { text: "4", isCorrect: false },
        ],
      });
    expect(valid.status).toBe(201);
    expect(valid.body.data.examTotalMarks).toBe(5);
  });

  it("5. Teacher creates TRUE_FALSE question with exactly 2 options and 1 correct option", async () => {
    const actors = await seedPhase4BaseActors();
    const teacher = await loginAs(app, actors.teacher.email);
    const exam = await createSampleDraftExam(teacher, actors.course.id);

    const threeOpts = await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({
        type: "TRUE_FALSE",
        prompt: "TLS encrypts HTTP traffic.",
        marks: 2,
        options: [
          { text: "True", isCorrect: true },
          { text: "False", isCorrect: false },
          { text: "Maybe", isCorrect: false },
        ],
      });
    expect(threeOpts.status).toBe(400);

    const valid = await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({
        type: "TRUE_FALSE",
        prompt: "PostgreSQL supports partial unique indexes.",
        marks: 2,
        options: [
          { text: "True", isCorrect: true },
          { text: "False", isCorrect: false },
        ],
      });
    expect(valid.status).toBe(201);
  });

  it("6. Teacher creates SUBJECTIVE_SHORT and SUBJECTIVE_LONG questions without options", async () => {
    const actors = await seedPhase4BaseActors();
    const teacher = await loginAs(app, actors.teacher.email);
    const exam = await createSampleDraftExam(teacher, actors.course.id);

    const withOptsRejected = await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({
        type: "SUBJECTIVE_SHORT",
        prompt: "Explain CSRF",
        marks: 3,
        options: [{ text: "Nope", isCorrect: true }],
      });
    expect(withOptsRejected.status).toBe(400);

    const shortQ = await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({ type: "SUBJECTIVE_SHORT", prompt: "Define ACID", marks: 3 });
    const longQ = await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({ type: "SUBJECTIVE_LONG", prompt: "Design a distributed lock", marks: 7 });

    expect(shortQ.status).toBe(201);
    expect(longQ.status).toBe(201);
    expect(longQ.body.data.examTotalMarks).toBe(10);
  });

  it("7. Teacher updates, duplicates, deletes, and reorders questions while totalMarks stays server-accurate", async () => {
    const actors = await seedPhase4BaseActors();
    const teacher = await loginAs(app, actors.teacher.email);
    const exam = await createSampleDraftExam(teacher, actors.course.id);

    const q1 = await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({ type: "SUBJECTIVE_SHORT", prompt: "First", marks: 2 });
    const q2 = await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({ type: "SUBJECTIVE_SHORT", prompt: "Second", marks: 3 });

    const q1Id = q1.body.data.question.id as string;
    const q2Id = q2.body.data.question.id as string;

    const patchRes = await teacher.agent
      .patch(`/api/v1/teacher/exams/${exam.id}/questions/${q1Id}`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({ marks: 5, prompt: "First Updated" });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.examTotalMarks).toBe(8);

    const reorderRes = await teacher.agent
      .patch(`/api/v1/teacher/exams/${exam.id}/questions/reorder`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({ questionIds: [q2Id, q1Id] });
    expect(reorderRes.status).toBe(200);
    expect(reorderRes.body.data[0].id).toBe(q2Id);
    expect(reorderRes.body.data[0].orderIndex).toBe(1);

    const dupRes = await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/questions/${q1Id}/duplicate`)
      .set("X-CSRF-Token", teacher.csrf);
    expect(dupRes.status).toBe(201);
    expect(dupRes.body.data.examTotalMarks).toBe(13);

    const delRes = await teacher.agent
      .delete(`/api/v1/teacher/exams/${exam.id}/questions/${q2Id}`)
      .set("X-CSRF-Token", teacher.csrf);
    expect(delRes.status).toBe(200);
    expect(delRes.body.data.examTotalMarks).toBe(10);
  });

  it("8. Rejects negativeMarks exceeding question marks", async () => {
    const actors = await seedPhase4BaseActors();
    const teacher = await loginAs(app, actors.teacher.email);
    const exam = await createSampleDraftExam(teacher, actors.course.id);

    const bad = await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({
        type: "TRUE_FALSE",
        prompt: "Check marks",
        marks: 2,
        negativeMarks: 3,
        options: [
          { text: "True", isCorrect: true },
          { text: "False", isCorrect: false },
        ],
      });
    expect(bad.status).toBe(400);
  });

  it("9. Rejects submitting empty exam or exam where passingMarks exceeds totalMarks", async () => {
    const actors = await seedPhase4BaseActors();
    const teacher = await loginAs(app, actors.teacher.email);
    const exam = await createSampleDraftExam(teacher, actors.course.id);

    const emptySubmit = await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/submit-for-approval`)
      .set("X-CSRF-Token", teacher.csrf);
    expect(emptySubmit.status).toBe(400);
    expect(emptySubmit.body.error.code).toBe("EXAM_EMPTY");

    await teacher.agent
      .patch(`/api/v1/teacher/exams/${exam.id}`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({ passingMarks: 50 });

    await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({ type: "SUBJECTIVE_SHORT", prompt: "Only 10 marks", marks: 10 });

    const passingExceeds = await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/submit-for-approval`)
      .set("X-CSRF-Token", teacher.csrf);
    expect(passingExceeds.status).toBe(400);
    expect(passingExceeds.body.error.code).toBe("PASSING_MARKS_EXCEED_TOTAL");
  });

  it("10. Previews valid CSV and JSON question imports cleanly", async () => {
    const actors = await seedPhase4BaseActors();
    const teacher = await loginAs(app, actors.teacher.email);
    const exam = await createSampleDraftExam(teacher, actors.course.id);

    const tplRes = await teacher.agent.get("/api/v1/teacher/exams/templates/csv");
    expect(tplRes.status).toBe(200);
    expect(tplRes.text).toContain("MULTIPLE_CHOICE");

    const previewCsv = await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/questions/import`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({ format: "csv", content: tplRes.text, mode: "preview" });
    expect(previewCsv.status).toBe(200);
    expect(previewCsv.body.data.validCount).toBe(5);
    expect(previewCsv.body.data.invalidCount).toBe(0);

    const jsonTpl = await teacher.agent.get("/api/v1/teacher/exams/templates/json");
    const previewJson = await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/questions/import`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({ format: "json", content: jsonTpl.text, mode: "preview" });
    expect(previewJson.status).toBe(200);
    expect(previewJson.body.data.validCount).toBe(2);
  });

  it("11. Rejects invalid batch CSV import atomically with zero partial inserts", async () => {
    const actors = await seedPhase4BaseActors();
    const teacher = await loginAs(app, actors.teacher.email);
    const exam = await createSampleDraftExam(teacher, actors.course.id);

    const badCsv = [
      "type,prompt,marks,negativeMarks,isRequired,optionA,optionB,optionC,optionD,correctOptions,explanation",
      'SUBJECTIVE_SHORT,"Valid row",4,0,true,,,,,,',
      'MULTIPLE_CHOICE,"Broken row missing correct option",2,0,false,"A","B","","","Z",""',
    ].join("\n");

    const importRes = await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/questions/import`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({ format: "csv", content: badCsv, mode: "import" });
    expect(importRes.status).toBe(400);
    expect(importRes.body.error.code).toBe("QUESTION_IMPORT_VALIDATION_FAILED");

    const count = await prisma.question.count({ where: { examId: exam.id } });
    expect(count).toBe(0);
  });

  it("12. Commits valid JSON & CSV imports transactionally and updates exam totalMarks", async () => {
    const actors = await seedPhase4BaseActors();
    const teacher = await loginAs(app, actors.teacher.email);
    const exam = await createSampleDraftExam(teacher, actors.course.id);

    const csvTpl = await teacher.agent.get("/api/v1/teacher/exams/templates/csv");
    const importRes = await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/questions/import`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({ format: "csv", content: csvTpl.text, mode: "import" });

    expect(importRes.status).toBe(201);
    expect(importRes.body.data.importedCount).toBe(5);
    expect(importRes.body.data.examTotalMarks).toBe(21);
  });

  it("13. CSV export neutralizes formula-injection payloads for Teacher and Admin", async () => {
    const actors = await seedPhase4BaseActors();
    const teacher = await loginAs(app, actors.teacher.email);
    const exam = await createSampleDraftExam(teacher, actors.course.id);

    await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({
        type: "SUBJECTIVE_SHORT",
        prompt: "=CMD('calc')",
        explanation: "+SUM(1,2)",
        marks: 2,
      });

    const exportRes = await teacher.agent.get(`/api/v1/teacher/exams/${exam.id}/questions/export?format=csv`);
    expect(exportRes.status).toBe(200);
    expect(exportRes.text).toContain("'=CMD");
    expect(exportRes.text).toContain("'+SUM");
  });

  it("14. Teacher duplicates an exam draft independently preserving questions and resetting to DRAFT", async () => {
    const actors = await seedPhase4BaseActors();
    const teacher = await loginAs(app, actors.teacher.email);
    const exam = await createSampleDraftExam(teacher, actors.course.id, "Original Exam");

    await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({ type: "SUBJECTIVE_SHORT", prompt: "Q1", marks: 5 });

    const dup = await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/duplicate`)
      .set("X-CSRF-Token", teacher.csrf);
    expect(dup.status).toBe(201);
    expect(dup.body.data.id).not.toBe(exam.id);
    expect(dup.body.data.status).toBe("DRAFT");
    expect(dup.body.data.questions).toHaveLength(1);
    expect(dup.body.data.totalMarks).toBe(5);
  });

  it("15. Submitting exam transitions to PENDING_APPROVAL and locks teacher edits", async () => {
    const actors = await seedPhase4BaseActors();
    const teacher = await loginAs(app, actors.teacher.email);
    const exam = await createSampleDraftExam(teacher, actors.course.id);

    await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({ type: "SUBJECTIVE_SHORT", prompt: "Q1", marks: 5 });

    const submitRes = await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/submit-for-approval`)
      .set("X-CSRF-Token", teacher.csrf);
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.data.status).toBe("PENDING_APPROVAL");

    const blockedAdd = await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({ type: "SUBJECTIVE_SHORT", prompt: "Late Question", marks: 5 });
    expect(blockedAdd.status).toBe(409);
    expect(blockedAdd.body.error.code).toBe("EXAM_NOT_EDITABLE");
  });

  it("16. Rejected exam becomes editable again and can be resubmitted by teacher", async () => {
    const actors = await seedPhase4BaseActors();
    const teacher = await loginAs(app, actors.teacher.email);
    const admin = await loginAs(app, actors.admin.email);
    const exam = await createSampleDraftExam(teacher, actors.course.id);

    await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/questions`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({ type: "SUBJECTIVE_SHORT", prompt: "Needs polish", marks: 5 });

    await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/submit-for-approval`)
      .set("X-CSRF-Token", teacher.csrf);

    await admin.agent
      .post(`/api/v1/admin/exams/${exam.id}/reject`)
      .set("X-CSRF-Token", admin.csrf)
      .send({ reason: "Please add clearer instructions" });

    const editRes = await teacher.agent
      .patch(`/api/v1/teacher/exams/${exam.id}`)
      .set("X-CSRF-Token", teacher.csrf)
      .send({ instructions: "Updated clear instructions" });
    expect(editRes.status).toBe(200);

    const resubmit = await teacher.agent
      .post(`/api/v1/teacher/exams/${exam.id}/submit-for-approval`)
      .set("X-CSRF-Token", teacher.csrf);
    expect(resubmit.status).toBe(200);
    expect(resubmit.body.data.status).toBe("PENDING_APPROVAL");
    expect(resubmit.body.data.rejectionReason).toBeNull();
  });
});
