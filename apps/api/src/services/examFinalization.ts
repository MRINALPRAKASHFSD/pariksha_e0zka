import crypto from "node:crypto";
import type { Prisma, UserRole } from "@prisma/client";
import {
  AttemptStatus,
  AuditAction,
  SubmissionReason,
  type ExamSubmissionReceiptDto,
} from "@pariksha/shared";
import { writeAuditLog } from "../lib/audit.js";
import { notFound } from "../lib/errors.js";
import { getPrismaClient } from "../lib/prisma.js";
import { getRealtimeServer } from "../lib/realtime.js";
import { toSubmissionReceiptDto } from "./examSerialization.js";

export const TERMINAL_ATTEMPT_STATUSES: readonly AttemptStatus[] = [
  AttemptStatus.SUBMITTED,
  AttemptStatus.AUTO_SUBMITTED,
  AttemptStatus.EXPIRED,
  AttemptStatus.TERMINATED,
];

export function isTerminalAttemptStatus(status: string): boolean {
  return (TERMINAL_ATTEMPT_STATUSES as readonly string[]).includes(status);
}

export function mapReasonToTerminalStatus(reason: SubmissionReason): AttemptStatus {
  switch (reason) {
    case SubmissionReason.MANUAL:
      return AttemptStatus.SUBMITTED;
    case SubmissionReason.TIMER_EXPIRED:
      return AttemptStatus.EXPIRED;
    case SubmissionReason.VIOLATION_THRESHOLD:
      return AttemptStatus.AUTO_SUBMITTED;
    case SubmissionReason.ADMIN_FORCE:
    case SubmissionReason.EXAM_CANCELLED:
      return AttemptStatus.TERMINATED;
    default:
      return AttemptStatus.AUTO_SUBMITTED;
  }
}

export function mapReasonToAuditAction(reason: SubmissionReason): string {
  switch (reason) {
    case SubmissionReason.MANUAL:
      return AuditAction.EXAM_SUBMITTED;
    case SubmissionReason.TIMER_EXPIRED:
      return AuditAction.EXAM_EXPIRED;
    case SubmissionReason.VIOLATION_THRESHOLD:
      return AuditAction.EXAM_AUTO_SUBMITTED;
    case SubmissionReason.ADMIN_FORCE:
    case SubmissionReason.EXAM_CANCELLED:
      return AuditAction.EXAM_ATTEMPT_TERMINATED;
    default:
      return AuditAction.EXAM_AUTO_SUBMITTED;
  }
}

export function generateReceiptCode(): string {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const randomPart = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `PRK-${datePart}-${randomPart}`;
}

export interface FinalizeAttemptInput {
  attemptId: string;
  reason: SubmissionReason;
  actorId?: string | null;
  actorRole?: UserRole | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  auditAction?: string;
  auditMetadata?: Record<string, unknown>;
}

export interface FinalizeAttemptResult {
  receipt: ExamSubmissionReceiptDto;
  alreadyFinalized: boolean;
  studentId: string;
  examId: string;
}

interface LockedAttemptRow {
  id: string;
  examId: string;
  studentId: string;
  examVersion: number;
  attemptNumber: number;
  status: string;
  startedAt: Date;
  expiresAt: Date;
  submittedAt: Date | null;
  violationCount: number;
  questionSnapshotJson: unknown;
}

async function runFinalizeInsideTx(
  tx: Prisma.TransactionClient,
  input: FinalizeAttemptInput,
): Promise<FinalizeAttemptResult> {
  const lockedRows = await tx.$queryRaw<LockedAttemptRow[]>`
    SELECT
      id,
      "examId",
      "studentId",
      "examVersion",
      "attemptNumber",
      status::text AS status,
      "startedAt",
      "expiresAt",
      "submittedAt",
      "violationCount",
      "questionSnapshotJson"
    FROM "ExamAttempt"
    WHERE id = ${input.attemptId}::uuid
    FOR UPDATE
  `;

  const locked = lockedRows[0];
  if (!locked) {
    throw notFound("Exam attempt not found", "ATTEMPT_NOT_FOUND");
  }

  const exam = await tx.exam.findUnique({
    where: { id: locked.examId },
    select: {
      id: true,
      title: true,
      totalMarks: true,
      allowUnproctoredDev: true,
      course: { select: { code: true, title: true } },
      _count: { select: { questions: true } },
    },
  });
  if (!exam) {
    throw notFound("Exam not found", "EXAM_NOT_FOUND");
  }

  const existingSubmission = await tx.examSubmission.findUnique({
    where: { attemptId: locked.id },
  });

  const existingAnswers = await tx.examAnswer.findMany({
    where: { attemptId: locked.id },
    orderBy: { questionId: "asc" },
  });

  const answeredCount = existingAnswers.filter((a) => {
    const selected = Array.isArray(a.selectedOptionIds) ? a.selectedOptionIds : [];
    return selected.length > 0 || Boolean(a.subjectiveText && a.subjectiveText.trim().length > 0);
  }).length;

  if (existingSubmission && isTerminalAttemptStatus(locked.status)) {
    return {
      receipt: toSubmissionReceiptDto({
        submission: existingSubmission,
        attempt: {
          id: locked.id,
          examId: locked.examId,
          examVersion: locked.examVersion,
          attemptNumber: locked.attemptNumber,
          status: locked.status as AttemptStatus,
          startedAt: locked.startedAt,
          questionSnapshotJson: locked.questionSnapshotJson as Prisma.JsonValue,
        },
        exam,
        answeredCount,
        fallbackQuestionCount: exam._count.questions,
      }),
      alreadyFinalized: true,
      studentId: locked.studentId,
      examId: locked.examId,
    };
  }

  const now = new Date();
  const terminalStatus = isTerminalAttemptStatus(locked.status)
    ? (locked.status as AttemptStatus)
    : mapReasonToTerminalStatus(input.reason);

  // Order matters with PostgreSQL immutability triggers:
  // 1) Finalize answers while ExamAttempt is still active.
  await tx.examAnswer.updateMany({
    where: { attemptId: locked.id, isFinalized: false },
    data: { isFinalized: true },
  });

  // 2) Transition ExamAttempt to its terminal locked state if not already terminal.
  const updatedAttempt = isTerminalAttemptStatus(locked.status)
    ? {
        id: locked.id,
        examId: locked.examId,
        examVersion: locked.examVersion,
        attemptNumber: locked.attemptNumber,
        status: locked.status as AttemptStatus,
        startedAt: locked.startedAt,
        submittedAt: locked.submittedAt ?? now,
        questionSnapshotJson: locked.questionSnapshotJson as Prisma.JsonValue,
      }
    : await tx.examAttempt.update({
        where: { id: locked.id },
        data: {
          status: terminalStatus,
          isLocked: true,
          submittedAt: now,
          finalizationReason: input.reason,
          revision: { increment: 1 },
        },
      });

  // 3) Insert immutable ExamSubmission row (trigger validates parent attempt is already terminal).
  const snapshotAnswersJson = existingAnswers.map((a) => ({
    questionId: a.questionId,
    selectedOptionIds: a.selectedOptionIds,
    textAnswer: a.subjectiveText,
    markedForReview: a.markedForReview,
    revision: a.revision,
    lastSavedAt: a.updatedAt.toISOString(),
  })) as Prisma.InputJsonValue;

  const submission =
    existingSubmission ??
    (await tx.examSubmission.create({
      data: {
        attemptId: locked.id,
        examId: locked.examId,
        studentId: locked.studentId,
        receiptCode: generateReceiptCode(),
        submittedAt: updatedAttempt.submittedAt ?? now,
        reason: input.reason,
        finalViolationCount: locked.violationCount,
        snapshotAnswersJson,
      },
    }));

  // 4) Record audit trail inside the same transaction.
  await writeAuditLog(
    {
      actorId: input.actorId ?? null,
      actorRole: input.actorRole ?? null,
      action: input.auditAction ?? mapReasonToAuditAction(input.reason),
      entityType: "ExamAttempt",
      entityId: locked.id,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      metadata: {
        examId: locked.examId,
        studentId: locked.studentId,
        reason: input.reason,
        terminalStatus,
        receiptCode: submission.receiptCode,
        answeredCount,
        ...(input.auditMetadata ?? {}),
      },
    },
    tx,
  );

  return {
    receipt: toSubmissionReceiptDto({
      submission,
      attempt: updatedAttempt,
      exam,
      answeredCount,
      fallbackQuestionCount: exam._count.questions,
    }),
    alreadyFinalized: false,
    studentId: locked.studentId,
    examId: locked.examId,
  };
}

export function emitAttemptFinalizedRealtime(result: FinalizeAttemptResult): void {
  if (result.alreadyFinalized) return;
  const io = getRealtimeServer();
  if (!io) return;

  io.to(`user:${result.studentId}`).emit("exam:attempt-finalized", {
    attemptId: result.receipt.attemptId,
    examId: result.receipt.examId,
    status: result.receipt.status,
    reason: result.receipt.reason,
    receiptCode: result.receipt.receiptCode,
    submittedAt: result.receipt.submittedAt,
  });
}

/**
 * Atomically transitions an exam attempt into a terminal state and writes its immutable submission receipt.
 * Safe for concurrent callers, manual submission, expiration worker, admin cancellation, and Phase 5 auto-submit.
 */
export async function finalizeExamAttempt(
  input: FinalizeAttemptInput,
  externalTx?: Prisma.TransactionClient,
): Promise<FinalizeAttemptResult> {
  if (externalTx) {
    return runFinalizeInsideTx(externalTx, input);
  }

  const prisma = getPrismaClient();
  const result = await prisma.$transaction((tx) => runFinalizeInsideTx(tx, input));
  emitAttemptFinalizedRealtime(result);
  return result;
}
