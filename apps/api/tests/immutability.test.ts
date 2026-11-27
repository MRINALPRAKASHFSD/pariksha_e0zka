import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrismaClient } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/crypto.js";
import { resetTestDatabase } from "./testDbGuard.js";

describe("PostgreSQL Immutability Triggers & Regression Guards (pariksha_test)", () => {
  const prisma = getPrismaClient();

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await resetTestDatabase();
    await disconnectPrisma();
  });

  async function seedAttemptFixture() {
    const passwordHash = await hashPassword("TestPass1234!");
    const teacher = await prisma.user.create({
      data: {
        email: "teacher.trigger@pariksha.test",
        fullName: "Trigger Teacher",
        passwordHash,
        role: "TEACHER",
      },
    });
    const student = await prisma.user.create({
      data: {
        email: "student.trigger@pariksha.test",
        fullName: "Trigger Student",
        passwordHash,
        role: "STUDENT",
      },
    });
    const course = await prisma.course.create({
      data: {
        code: "CS101-TRIG",
        title: "Trigger Verification",
        teacherId: teacher.id,
      },
    });
    const exam = await prisma.exam.create({
      data: {
        courseId: course.id,
        createdById: teacher.id,
        title: "Trigger Exam",
        status: "ACTIVE",
        durationMinutes: 30,
        totalMarks: 10,
        passingMarks: 4,
        windowStart: new Date(Date.now() - 60_000),
        windowEnd: new Date(Date.now() + 3_600_000),
      },
    });
    const question = await prisma.question.create({
      data: {
        examId: exam.id,
        orderIndex: 1,
        type: "SUBJECTIVE",
        prompt: "Explain ACID properties.",
        marks: 10,
      },
    });
    const question2 = await prisma.question.create({
      data: {
        examId: exam.id,
        orderIndex: 2,
        type: "SUBJECTIVE",
        prompt: "Explain isolation levels.",
        marks: 10,
      },
    });
    const attempt = await prisma.examAttempt.create({
      data: {
        examId: exam.id,
        studentId: student.id,
        status: "IN_PROGRESS",
        expiresAt: new Date(Date.now() + 1_800_000),
      },
    });
    return { exam, question, question2, attempt, student };
  }

  it("blocks UPDATE, DELETE, INSERT, and status downgrade after submission", async () => {
    const { exam, question, question2, attempt, student } = await seedAttemptFixture();

    const answer = await prisma.examAnswer.create({
      data: {
        attemptId: attempt.id,
        questionId: question.id,
        subjectiveText: "Atomicity, Consistency, Isolation, Durability.",
        isFinalized: false,
      },
    });

    await prisma.$transaction(async (tx) => {
      await tx.examAttempt.update({
        where: { id: attempt.id },
        data: { status: "SUBMITTED", isLocked: true, submittedAt: new Date() },
      });
      await tx.examAnswer.update({
        where: { id: answer.id },
        data: { isFinalized: true },
      });
      await tx.examSubmission.create({
        data: {
          attemptId: attempt.id,
          examId: exam.id,
          studentId: student.id,
          reason: "MANUAL",
          receiptCode: "RCPT-TRIG-001",
          finalViolationCount: 0,
          snapshotAnswersJson: [{ questionId: question.id, subjectiveText: answer.subjectiveText }],
        },
      });
    });

    // 1. UPDATE finalized answer rejected
    await expect(
      prisma.examAnswer.update({
        where: { id: answer.id },
        data: { subjectiveText: "Tampered answer" },
      }),
    ).rejects.toThrow(/immutable/i);

    // 2. DELETE finalized answer rejected
    await expect(
      prisma.examAnswer.delete({ where: { id: answer.id } }),
    ).rejects.toThrow(/cannot be deleted/i);

    // 3. INSERT new answer into submitted attempt rejected
    await expect(
      prisma.examAnswer.create({
        data: {
          attemptId: attempt.id,
          questionId: question2.id,
          subjectiveText: "Late bypassed insert",
        },
      }),
    ).rejects.toThrow(/finalized or locked attempt/i);

    // 4. Downgrading terminal ExamAttempt back to IN_PROGRESS rejected
    await expect(
      prisma.examAttempt.update({
        where: { id: attempt.id },
        data: { status: "IN_PROGRESS", isLocked: false },
      }),
    ).rejects.toThrow(/immutable/i);

    // 5. UPDATE ExamSubmission rejected
    await expect(
      prisma.examSubmission.update({
        where: { attemptId: attempt.id },
        data: { receiptCode: "RCPT-TAMPERED" },
      }),
    ).rejects.toThrow(/immutable/i);
  });

  it("serializes concurrent answer writes against submission FOR UPDATE lock", async () => {
    const { question, attempt } = await seedAttemptFixture();
    const answer = await prisma.examAnswer.create({
      data: {
        attemptId: attempt.id,
        questionId: question.id,
        subjectiveText: "Initial answer",
        isFinalized: false,
      },
    });

    // Tx1 locks ExamAttempt FOR UPDATE and transitions to SUBMITTED before committing
    let releaseTx1!: () => void;
    const tx1Locked = new Promise<void>((resolve) => {
      releaseTx1 = resolve;
    });
    let markTx1Ready!: () => void;
    const tx1Ready = new Promise<void>((resolve) => {
      markTx1Ready = resolve;
    });

    const tx1Promise = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ExamAttempt" WHERE id = ${attempt.id}::uuid FOR UPDATE`;
      await tx.examAttempt.update({
        where: { id: attempt.id },
        data: { status: "SUBMITTED", isLocked: true, submittedAt: new Date() },
      });
      await tx.examAnswer.update({
        where: { id: answer.id },
        data: { isFinalized: true },
      });
      markTx1Ready();
      await tx1Locked;
    });

    await tx1Ready;

    // Concurrent answer update starts while Tx1 holds FOR UPDATE; must wait and then fail
    const concurrentUpdate = prisma.examAnswer.update({
      where: { id: answer.id },
      data: { subjectiveText: "Race-condition overwrite" },
    });

    // Let concurrentUpdate hit the row lock, then commit Tx1
    await new Promise((r) => setTimeout(r, 80));
    releaseTx1();

    await tx1Promise;
    await expect(concurrentUpdate).rejects.toThrow(/immutable|submission/i);

    const persisted = await prisma.examAnswer.findUniqueOrThrow({ where: { id: answer.id } });
    expect(persisted.subjectiveText).toBe("Initial answer");
    expect(persisted.isFinalized).toBe(true);
  });
});
