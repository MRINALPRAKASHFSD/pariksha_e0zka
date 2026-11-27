import { Router, type Response } from "express";
import type { Prisma } from "@prisma/client";
import {
  AuditAction,
  ExamStatus,
  SubmissionReason,
  UNPROCTORED_DEV_POLICY,
  adminApproveExamSchema,
  adminCancelExamSchema,
  adminCreateExamVersionSchema,
  adminExamsQuerySchema,
  adminForceTerminateAttemptSchema,
  adminRejectExamSchema,
  adminUpdateExamConfigSchema,
  adminUpdateProctoringPolicySchema,
  type ApiSuccessResponse,
  type ExamAttemptSummaryDto,
  type ExamDetailDto,
  type ExamSubmissionReceiptDto,
  type ExamSummaryDto,
  type PaginatedResult,
} from "@pariksha/shared";
import { writeAuditLog } from "../lib/audit.js";
import { getEnv } from "../config/env.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { getPrismaClient } from "../lib/prisma.js";
import { requireAuth, requireCsrf, requireRoles } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/errorAndValidation.js";
import {
  emitAttemptFinalizedRealtime,
  finalizeExamAttempt,
} from "../services/examFinalization.js";
import {
  getExamProctoringPolicyHandler,
  resetExamProctoringPolicyHandler,
  updateExamProctoringPolicyHandler,
} from "./adminProctoring.js";
import {
  isValidUuid,
  recalculateExamTotalMarks,
  toExamAttemptSummaryDto,
  toExamDetailDto,
  toExamSummaryDto,
  toQuestionDto,
} from "../services/examSerialization.js";
import { exportQuestionsToCsv, exportQuestionsToJson } from "../services/questionImportExport.js";

function sendSuccess<T>(res: Response, data: T, status = 200): void {
  const payload: ApiSuccessResponse<T> = {
    success: true,
    data,
    requestId: res.locals.requestId as string | undefined,
  };
  res.status(status).json(payload);
}

export interface AdminExamsListResponse extends PaginatedResult<ExamSummaryDto> {
  summary: {
    total: number;
    draft: number;
    pendingApproval: number;
    approved: number;
    rejected: number;
    active: number;
    paused: number;
    completed: number;
    cancelled: number;
  };
}

export function createAdminExamsRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireRoles("ADMIN"));

  async function loadExamOrThrow(rawExamId: string | undefined) {
    if (!isValidUuid(rawExamId)) {
      throw badRequest("Invalid exam identifier", "INVALID_ID");
    }
    const prisma = getPrismaClient();
    const exam = await prisma.exam.findUnique({
      where: { id: rawExamId },
      include: {
        course: {
          select: {
            id: true,
            code: true,
            title: true,
            teacher: { select: { id: true, fullName: true } },
          },
        },
        questions: {
          orderBy: { orderIndex: "asc" },
          include: { options: { orderBy: { orderIndex: "asc" } } },
        },
        proctoringPolicy: true,
      },
    });
    if (!exam) {
      throw notFound("Examination not found", "EXAM_NOT_FOUND");
    }
    return exam;
  }

  async function loadExamCounts(examId: string) {
    const prisma = getPrismaClient();
    const [attemptCount, activeAttemptCount, submissionCount] = await Promise.all([
      prisma.examAttempt.count({ where: { examId } }),
      prisma.examAttempt.count({
        where: { examId, status: { in: ["IN_PROGRESS", "PAUSED"] } },
      }),
      prisma.examSubmission.count({ where: { examId } }),
    ]);
    return { attemptCount, activeAttemptCount, submissionCount };
  }

  async function syncExamUnproctoredPolicy(
    tx: Prisma.TransactionClient,
    examId: string,
    updatedById: string,
    allowUnproctoredDev: boolean,
  ): Promise<void> {
    if (allowUnproctoredDev) {
      await tx.proctoringPolicy.upsert({
        where: { examId },
        create: {
          examId,
          updatedById,
          isInstitutionalDefault: false,
          ...UNPROCTORED_DEV_POLICY,
        },
        update: {
          updatedById,
          ...UNPROCTORED_DEV_POLICY,
        },
      });
    } else {
      // Only remove an unproctored dev stub if present so proctored exams inherit institutional defaults
      const existing = await tx.proctoringPolicy.findUnique({ where: { examId } });
      if (
        existing &&
        !existing.requireWebcam &&
        !existing.requireScreenShare &&
        !existing.requireFullscreen
      ) {
        await tx.proctoringPolicy.delete({ where: { examId } });
      }
    }
  }

  router.get("/", validateQuery(adminExamsQuerySchema), async (_req, res, next) => {
    try {
      const query = res.locals.validatedQuery as {
        page: number;
        pageSize: number;
        search?: string;
        courseId?: string;
        teacherId?: string;
        status?: ExamStatus;
        isEnabled?: boolean;
      };
      const prisma = getPrismaClient();

      const where: Prisma.ExamWhereInput = {
        ...(query.courseId ? { courseId: query.courseId } : {}),
        ...(query.teacherId ? { course: { teacherId: query.teacherId } } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.isEnabled !== undefined ? { isEnabled: query.isEnabled } : {}),
        ...(query.search
          ? {
              OR: [
                { title: { contains: query.search, mode: "insensitive" } },
                { course: { code: { contains: query.search, mode: "insensitive" } } },
                { course: { title: { contains: query.search, mode: "insensitive" } } },
                { course: { teacher: { fullName: { contains: query.search, mode: "insensitive" } } } },
              ],
            }
          : {}),
      };

      const [total, statusGroups, exams] = await Promise.all([
        prisma.exam.count({ where }),
        prisma.exam.groupBy({ by: ["status"], _count: { _all: true } }),
        prisma.exam.findMany({
          where,
          orderBy: [{ updatedAt: "desc" }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          include: {
            course: {
              select: {
                id: true,
                code: true,
                title: true,
                teacher: { select: { id: true, fullName: true } },
              },
            },
            _count: { select: { questions: true, attempts: true } },
          },
        }),
      ]);

      const summary = {
        total: 0,
        draft: 0,
        pendingApproval: 0,
        approved: 0,
        rejected: 0,
        active: 0,
        paused: 0,
        completed: 0,
        cancelled: 0,
      };
      for (const row of statusGroups) {
        summary.total += row._count._all;
        if (row.status === ExamStatus.DRAFT) summary.draft = row._count._all;
        if (row.status === ExamStatus.PENDING_APPROVAL) summary.pendingApproval = row._count._all;
        if (row.status === ExamStatus.APPROVED) summary.approved = row._count._all;
        if (row.status === ExamStatus.REJECTED) summary.rejected = row._count._all;
        if (row.status === ExamStatus.ACTIVE) summary.active = row._count._all;
        if (row.status === ExamStatus.PAUSED) summary.paused = row._count._all;
        if (row.status === ExamStatus.COMPLETED) summary.completed = row._count._all;
        if (row.status === ExamStatus.CANCELLED) summary.cancelled = row._count._all;
      }

      const examIds = exams.map((e) => e.id);
      const [activeGroups, submissionGroups] = examIds.length
        ? await Promise.all([
            prisma.examAttempt.groupBy({
              by: ["examId"],
              where: { examId: { in: examIds }, status: { in: ["IN_PROGRESS", "PAUSED"] } },
              _count: { _all: true },
            }),
            prisma.examSubmission.groupBy({
              by: ["examId"],
              where: { examId: { in: examIds } },
              _count: { _all: true },
            }),
          ])
        : [[], []];

      const activeMap = new Map(activeGroups.map((g) => [g.examId, g._count._all]));
      const submissionMap = new Map(submissionGroups.map((g) => [g.examId, g._count._all]));

      const items: ExamSummaryDto[] = exams.map((exam) =>
        toExamSummaryDto(exam, {
          questionCount: exam._count.questions,
          attemptCount: exam._count.attempts,
          activeAttemptCount: activeMap.get(exam.id) ?? 0,
          submissionCount: submissionMap.get(exam.id) ?? 0,
        }),
      );

      const response: AdminExamsListResponse = {
        items,
        total,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        summary,
      };
      sendSuccess(res, response);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:examId", async (req, res, next) => {
    try {
      const prisma = getPrismaClient();
      const exam = await loadExamOrThrow(req.params.examId);
      const [counts, defaultPolicy] = await Promise.all([
        loadExamCounts(exam.id),
        prisma.proctoringPolicy.findFirst({
          where: { isInstitutionalDefault: true, examId: null },
        }),
      ]);
      sendSuccess<ExamDetailDto>(res, toExamDetailDto(exam, defaultPolicy, counts));
    } catch (error) {
      next(error);
    }
  });

  router.get("/:examId/questions/export", async (req, res, next) => {
    try {
      const exam = await loadExamOrThrow(req.params.examId);
      const format = String(req.query.format ?? "csv").toLowerCase();
      const questionDtos = exam.questions.map(toQuestionDto);

      res.setHeader("Cache-Control", "no-store");
      if (format === "json") {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="exam-${exam.id}-questions.json"`,
        );
        res.status(200).send(exportQuestionsToJson(questionDtos));
        return;
      }
      if (format !== "csv") {
        throw badRequest("Export format must be csv or json", "INVALID_FORMAT");
      }

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="exam-${exam.id}-questions.csv"`,
      );
      res.status(200).send(exportQuestionsToCsv(questionDtos));
    } catch (error) {
      next(error);
    }
  });

  router.get("/:examId/attempts", async (req, res, next) => {
    try {
      const exam = await loadExamOrThrow(req.params.examId);
      const prisma = getPrismaClient();
      const attempts = await prisma.examAttempt.findMany({
        where: { examId: exam.id },
        orderBy: [{ startedAt: "desc" }],
        include: {
          student: { select: { id: true, fullName: true, email: true, status: true } },
          submission: { select: { receiptCode: true } },
          answers: { select: { selectedOptionIds: true, subjectiveText: true } },
        },
      });
      const items: ExamAttemptSummaryDto[] = attempts.map((a) =>
        toExamAttemptSummaryDto(a, exam.questions.length),
      );
      sendSuccess(res, items);
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/:examId/approve",
    requireCsrf,
    validateBody(adminApproveExamSchema),
    async (req, res, next) => {
      try {
        const user = req.auth!.user;
        const exam = await loadExamOrThrow(req.params.examId);
        if (exam.status !== ExamStatus.PENDING_APPROVAL) {
          throw conflict(
            `Only examinations in PENDING_APPROVAL status can be approved (current: ${exam.status})`,
            "INVALID_EXAM_TRANSITION",
          );
        }
        const totalMarks = Number(exam.totalMarks);
        if (exam.questions.length === 0 || totalMarks <= 0) {
          throw badRequest("Cannot approve an examination without valid questions", "EXAM_EMPTY");
        }

        const body = req.body as {
          windowStart?: string;
          windowEnd?: string;
          durationMinutes?: number;
          maxAttempts?: number;
          passingMarks?: number;
          allowUnproctoredDev?: boolean;
          activateImmediately: boolean;
        };

        const nextWindowStart = body.windowStart ? new Date(body.windowStart) : exam.windowStart;
        const nextWindowEnd = body.windowEnd ? new Date(body.windowEnd) : exam.windowEnd;
        if (nextWindowEnd <= nextWindowStart) {
          throw badRequest("Availability window end must be after window start", "INVALID_WINDOW");
        }
        const nextPassingMarks = body.passingMarks ?? Number(exam.passingMarks);
        if (nextPassingMarks > totalMarks) {
          throw badRequest(
            "Passing marks cannot exceed total exam marks",
            "PASSING_MARKS_EXCEED_TOTAL",
          );
        }

        const now = new Date();
        const nextAllowUnproctoredDev = body.allowUnproctoredDev ?? exam.allowUnproctoredDev;
        if (nextAllowUnproctoredDev && getEnv().NODE_ENV === "production") {
          throw forbidden(
            "Development-only unproctored delivery cannot be enabled in production",
            "UNPROCTORED_DEV_FORBIDDEN_IN_PRODUCTION",
          );
        }
        const nextStatus = body.activateImmediately ? ExamStatus.ACTIVE : ExamStatus.APPROVED;

        const prisma = getPrismaClient();
        const [updated, counts, defaultPolicy] = await Promise.all([
          prisma.$transaction(async (tx) => {
            if (body.allowUnproctoredDev !== undefined) {
              await syncExamUnproctoredPolicy(tx, exam.id, user.id, body.allowUnproctoredDev);
            }

            const saved = await tx.exam.update({
              where: { id: exam.id },
              data: {
                status: nextStatus,
                approvedById: user.id,
                approvedAt: now,
                ...(body.activateImmediately ? { activatedAt: now, isEnabled: true } : {}),
                windowStart: nextWindowStart,
                windowEnd: nextWindowEnd,
                ...(body.durationMinutes !== undefined
                  ? { durationMinutes: body.durationMinutes }
                  : {}),
                ...(body.maxAttempts !== undefined ? { maxAttempts: body.maxAttempts } : {}),
                ...(body.passingMarks !== undefined ? { passingMarks: body.passingMarks } : {}),
                allowUnproctoredDev: nextAllowUnproctoredDev,
                rejectionReason: null,
                rejectedAt: null,
              },
              include: {
                course: {
                  select: {
                    id: true,
                    code: true,
                    title: true,
                    teacher: { select: { id: true, fullName: true } },
                  },
                },
                questions: {
                  orderBy: { orderIndex: "asc" },
                  include: { options: { orderBy: { orderIndex: "asc" } } },
                },
                proctoringPolicy: true,
              },
            });

            await writeAuditLog(
              {
                actorId: user.id,
                actorRole: user.role,
                action: AuditAction.EXAM_APPROVED,
                entityType: "Exam",
                entityId: exam.id,
                ipAddress: req.ip,
                userAgent: req.get("user-agent") ?? null,
                metadata: {
                  activateImmediately: body.activateImmediately,
                  allowUnproctoredDev: nextAllowUnproctoredDev,
                },
              },
              tx,
            );

            if (body.activateImmediately) {
              await writeAuditLog(
                {
                  actorId: user.id,
                  actorRole: user.role,
                  action: AuditAction.EXAM_ACTIVATED,
                  entityType: "Exam",
                  entityId: exam.id,
                  ipAddress: req.ip,
                  userAgent: req.get("user-agent") ?? null,
                },
                tx,
              );
            }

            return saved;
          }),
          loadExamCounts(exam.id),
          prisma.proctoringPolicy.findFirst({
            where: { isInstitutionalDefault: true, examId: null },
          }),
        ]);

        sendSuccess(res, toExamDetailDto(updated, defaultPolicy, counts));
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:examId/reject",
    requireCsrf,
    validateBody(adminRejectExamSchema),
    async (req, res, next) => {
      try {
        const user = req.auth!.user;
        const exam = await loadExamOrThrow(req.params.examId);
        if (exam.status !== ExamStatus.PENDING_APPROVAL) {
          throw conflict(
            `Only PENDING_APPROVAL examinations can be rejected (current: ${exam.status})`,
            "INVALID_EXAM_TRANSITION",
          );
        }

        const { reason } = req.body as { reason: string };
        const prisma = getPrismaClient();
        const [updated, counts, defaultPolicy] = await Promise.all([
          prisma.$transaction(async (tx) => {
            const saved = await tx.exam.update({
              where: { id: exam.id },
              data: {
                status: ExamStatus.REJECTED,
                rejectionReason: reason,
                rejectedAt: new Date(),
              },
              include: {
                course: {
                  select: {
                    id: true,
                    code: true,
                    title: true,
                    teacher: { select: { id: true, fullName: true } },
                  },
                },
                questions: {
                  orderBy: { orderIndex: "asc" },
                  include: { options: { orderBy: { orderIndex: "asc" } } },
                },
                proctoringPolicy: true,
              },
            });

            await writeAuditLog(
              {
                actorId: user.id,
                actorRole: user.role,
                action: AuditAction.EXAM_REJECTED,
                entityType: "Exam",
                entityId: exam.id,
                ipAddress: req.ip,
                userAgent: req.get("user-agent") ?? null,
                metadata: { reason },
              },
              tx,
            );

            return saved;
          }),
          loadExamCounts(exam.id),
          prisma.proctoringPolicy.findFirst({
            where: { isInstitutionalDefault: true, examId: null },
          }),
        ]);

        sendSuccess(res, toExamDetailDto(updated, defaultPolicy, counts));
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    "/:examId/config",
    requireCsrf,
    validateBody(adminUpdateExamConfigSchema),
    async (req, res, next) => {
      try {
        const user = req.auth!.user;
        const exam = await loadExamOrThrow(req.params.examId);
        if (exam.status === ExamStatus.CANCELLED || exam.status === ExamStatus.ARCHIVED) {
          throw conflict(
            `Cannot modify configuration of a ${exam.status} exam`,
            "EXAM_NOT_CONFIGURABLE",
          );
        }

        const body = req.body as {
          windowStart?: string;
          windowEnd?: string;
          durationMinutes?: number;
          maxAttempts?: number;
          passingMarks?: number;
          isEnabled?: boolean;
          allowUnproctoredDev?: boolean;
        };

        const nextWindowStart = body.windowStart ? new Date(body.windowStart) : exam.windowStart;
        const nextWindowEnd = body.windowEnd ? new Date(body.windowEnd) : exam.windowEnd;
        if (nextWindowEnd <= nextWindowStart) {
          throw badRequest("Availability window end must be after window start", "INVALID_WINDOW");
        }
        const totalMarks = Number(exam.totalMarks);
        if (body.passingMarks !== undefined && totalMarks > 0 && body.passingMarks > totalMarks) {
          throw badRequest(
            "Passing marks cannot exceed total exam marks",
            "PASSING_MARKS_EXCEED_TOTAL",
          );
        }
        if (body.allowUnproctoredDev === true && getEnv().NODE_ENV === "production") {
          throw forbidden(
            "Development-only unproctored delivery cannot be enabled in production",
            "UNPROCTORED_DEV_FORBIDDEN_IN_PRODUCTION",
          );
        }

        const prisma = getPrismaClient();
        const [updated, counts, defaultPolicy] = await Promise.all([
          prisma.$transaction(async (tx) => {
            if (body.allowUnproctoredDev !== undefined) {
              await syncExamUnproctoredPolicy(tx, exam.id, user.id, body.allowUnproctoredDev);
            }

            const saved = await tx.exam.update({
              where: { id: exam.id },
              data: {
                ...(body.windowStart !== undefined ? { windowStart: nextWindowStart } : {}),
                ...(body.windowEnd !== undefined ? { windowEnd: nextWindowEnd } : {}),
                ...(body.durationMinutes !== undefined
                  ? { durationMinutes: body.durationMinutes }
                  : {}),
                ...(body.maxAttempts !== undefined ? { maxAttempts: body.maxAttempts } : {}),
                ...(body.passingMarks !== undefined ? { passingMarks: body.passingMarks } : {}),
                ...(body.isEnabled !== undefined ? { isEnabled: body.isEnabled } : {}),
                ...(body.allowUnproctoredDev !== undefined
                  ? { allowUnproctoredDev: body.allowUnproctoredDev }
                  : {}),
              },
              include: {
                course: {
                  select: {
                    id: true,
                    code: true,
                    title: true,
                    teacher: { select: { id: true, fullName: true } },
                  },
                },
                questions: {
                  orderBy: { orderIndex: "asc" },
                  include: { options: { orderBy: { orderIndex: "asc" } } },
                },
                proctoringPolicy: true,
              },
            });

            await writeAuditLog(
              {
                actorId: user.id,
                actorRole: user.role,
                action: AuditAction.EXAM_SCHEDULE_UPDATED,
                entityType: "Exam",
                entityId: exam.id,
                ipAddress: req.ip,
                userAgent: req.get("user-agent") ?? null,
                metadata: { updatedFields: Object.keys(body) },
              },
              tx,
            );

            if (body.isEnabled !== undefined && body.isEnabled !== exam.isEnabled) {
              await writeAuditLog(
                {
                  actorId: user.id,
                  actorRole: user.role,
                  action: AuditAction.EXAM_ENABLED_CHANGED,
                  entityType: "Exam",
                  entityId: exam.id,
                  ipAddress: req.ip,
                  userAgent: req.get("user-agent") ?? null,
                  metadata: { isEnabled: body.isEnabled },
                },
                tx,
              );
            }

            if (
              body.allowUnproctoredDev !== undefined &&
              body.allowUnproctoredDev !== exam.allowUnproctoredDev
            ) {
              await writeAuditLog(
                {
                  actorId: user.id,
                  actorRole: user.role,
                  action: AuditAction.EXAM_UNPROCTORED_DEV_CHANGED,
                  entityType: "Exam",
                  entityId: exam.id,
                  ipAddress: req.ip,
                  userAgent: req.get("user-agent") ?? null,
                  metadata: { allowUnproctoredDev: body.allowUnproctoredDev },
                },
                tx,
              );
            }

            return saved;
          }),
          loadExamCounts(exam.id),
          prisma.proctoringPolicy.findFirst({
            where: { isInstitutionalDefault: true, examId: null },
          }),
        ]);

        sendSuccess(res, toExamDetailDto(updated, defaultPolicy, counts));
      } catch (error) {
        next(error);
      }
    },
  );

  router.post("/:examId/activate", requireCsrf, async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const exam = await loadExamOrThrow(req.params.examId);
      if (exam.status !== ExamStatus.APPROVED && exam.status !== ExamStatus.PAUSED) {
        throw conflict(
          `Only APPROVED or PAUSED exams can be activated (current: ${exam.status})`,
          "INVALID_EXAM_TRANSITION",
        );
      }
      if (exam.questions.length === 0 || Number(exam.totalMarks) <= 0) {
        throw badRequest("Cannot activate an exam with no questions", "EXAM_EMPTY");
      }

      const prisma = getPrismaClient();
      const [updated, counts, defaultPolicy] = await Promise.all([
        prisma.$transaction(async (tx) => {
          const saved = await tx.exam.update({
            where: { id: exam.id },
            data: {
              status: ExamStatus.ACTIVE,
              isEnabled: true,
              activatedAt: new Date(),
            },
            include: {
              course: {
                select: {
                  id: true,
                  code: true,
                  title: true,
                  teacher: { select: { id: true, fullName: true } },
                },
              },
              questions: {
                orderBy: { orderIndex: "asc" },
                include: { options: { orderBy: { orderIndex: "asc" } } },
              },
              proctoringPolicy: true,
            },
          });

          await writeAuditLog(
            {
              actorId: user.id,
              actorRole: user.role,
              action: AuditAction.EXAM_ACTIVATED,
              entityType: "Exam",
              entityId: exam.id,
              ipAddress: req.ip,
              userAgent: req.get("user-agent") ?? null,
            },
            tx,
          );

          return saved;
        }),
        loadExamCounts(exam.id),
        prisma.proctoringPolicy.findFirst({
          where: { isInstitutionalDefault: true, examId: null },
        }),
      ]);

      sendSuccess(res, toExamDetailDto(updated, defaultPolicy, counts));
    } catch (error) {
      next(error);
    }
  });

  router.post("/:examId/pause", requireCsrf, async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const exam = await loadExamOrThrow(req.params.examId);
      if (exam.status !== ExamStatus.ACTIVE) {
        throw conflict(
          `Only ACTIVE exams can be paused (current: ${exam.status})`,
          "INVALID_EXAM_TRANSITION",
        );
      }

      const prisma = getPrismaClient();
      const [updated, counts, defaultPolicy] = await Promise.all([
        prisma.$transaction(async (tx) => {
          const saved = await tx.exam.update({
            where: { id: exam.id },
            data: {
              status: ExamStatus.PAUSED,
              pausedAt: new Date(),
            },
            include: {
              course: {
                select: {
                  id: true,
                  code: true,
                  title: true,
                  teacher: { select: { id: true, fullName: true } },
                },
              },
              questions: {
                orderBy: { orderIndex: "asc" },
                include: { options: { orderBy: { orderIndex: "asc" } } },
              },
              proctoringPolicy: true,
            },
          });

          await writeAuditLog(
            {
              actorId: user.id,
              actorRole: user.role,
              action: AuditAction.EXAM_PAUSED,
              entityType: "Exam",
              entityId: exam.id,
              ipAddress: req.ip,
              userAgent: req.get("user-agent") ?? null,
            },
            tx,
          );

          return saved;
        }),
        loadExamCounts(exam.id),
        prisma.proctoringPolicy.findFirst({
          where: { isInstitutionalDefault: true, examId: null },
        }),
      ]);

      sendSuccess(res, toExamDetailDto(updated, defaultPolicy, counts));
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/:examId/cancel",
    requireCsrf,
    validateBody(adminCancelExamSchema),
    async (req, res, next) => {
      try {
        const user = req.auth!.user;
        const exam = await loadExamOrThrow(req.params.examId);
        if (exam.status === ExamStatus.CANCELLED || exam.status === ExamStatus.ARCHIVED) {
          throw conflict(`Exam is already ${exam.status}`, "INVALID_EXAM_TRANSITION");
        }

        const { reason } = req.body as { reason: string };
        const prisma = getPrismaClient();
        const finalizedResults: Awaited<ReturnType<typeof finalizeExamAttempt>>[] = [];

        const updated = await prisma.$transaction(async (tx) => {
          const activeAttempts = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id
            FROM "ExamAttempt"
            WHERE "examId" = ${exam.id}::uuid
              AND status IN ('IN_PROGRESS', 'PAUSED')
            FOR UPDATE
          `;

          for (const row of activeAttempts) {
            const finalized = await finalizeExamAttempt(
              {
                attemptId: row.id,
                reason: SubmissionReason.EXAM_CANCELLED,
                actorId: user.id,
                actorRole: user.role,
                ipAddress: req.ip,
                userAgent: req.get("user-agent") ?? null,
                auditMetadata: { cancellationReason: reason },
              },
              tx,
            );
            finalizedResults.push(finalized);
          }

          const saved = await tx.exam.update({
            where: { id: exam.id },
            data: {
              status: ExamStatus.CANCELLED,
              isEnabled: false,
              cancellationReason: reason,
              cancelledAt: new Date(),
            },
            include: {
              course: {
                select: {
                  id: true,
                  code: true,
                  title: true,
                  teacher: { select: { id: true, fullName: true } },
                },
              },
              questions: {
                orderBy: { orderIndex: "asc" },
                include: { options: { orderBy: { orderIndex: "asc" } } },
              },
              proctoringPolicy: true,
            },
          });

          await writeAuditLog(
            {
              actorId: user.id,
              actorRole: user.role,
              action: AuditAction.EXAM_CANCELLED,
              entityType: "Exam",
              entityId: exam.id,
              ipAddress: req.ip,
              userAgent: req.get("user-agent") ?? null,
              metadata: { reason, terminatedAttempts: finalizedResults.length },
            },
            tx,
          );

          return saved;
        });

        for (const result of finalizedResults) {
          emitAttemptFinalizedRealtime(result);
        }

        const [counts, defaultPolicy] = await Promise.all([
          loadExamCounts(exam.id),
          prisma.proctoringPolicy.findFirst({
            where: { isInstitutionalDefault: true, examId: null },
          }),
        ]);

        sendSuccess(res, toExamDetailDto(updated, defaultPolicy, counts));
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:examId/create-version",
    requireCsrf,
    validateBody(adminCreateExamVersionSchema),
    async (req, res, next) => {
      try {
        const user = req.auth!.user;
        const source = await loadExamOrThrow(req.params.examId);
        const body = req.body as {
          title?: string;
          durationMinutes?: number;
          windowStart?: string;
          windowEnd?: string;
          maxAttempts?: number;
        };

        const rootId = source.parentExamId ?? source.id;
        const prisma = getPrismaClient();
        const defaultPolicy = await prisma.proctoringPolicy.findFirst({
          where: { isInstitutionalDefault: true, examId: null },
        });

        const nextWindowStart = body.windowStart ? new Date(body.windowStart) : source.windowStart;
        const nextWindowEnd = body.windowEnd ? new Date(body.windowEnd) : source.windowEnd;
        if (nextWindowEnd <= nextWindowStart) {
          throw badRequest("Availability window end must be after window start", "INVALID_WINDOW");
        }

        const created = await prisma.$transaction(async (tx) => {
          const siblingMax = await tx.exam.aggregate({
            where: { OR: [{ id: rootId }, { parentExamId: rootId }] },
            _max: { version: true },
          });
          const nextVersion = (siblingMax._max.version ?? source.version) + 1;

          const versioned = await tx.exam.create({
            data: {
              courseId: source.courseId,
              createdById: source.createdById,
              parentExamId: rootId,
              version: nextVersion,
              title: body.title ?? source.title,
              description: source.description,
              instructions: source.instructions,
              status: ExamStatus.DRAFT,
              totalMarks: source.totalMarks,
              passingMarks: source.passingMarks,
              durationMinutes: body.durationMinutes ?? source.durationMinutes,
              windowStart: nextWindowStart,
              windowEnd: nextWindowEnd,
              maxAttempts: body.maxAttempts ?? source.maxAttempts,
              shuffleQuestions: source.shuffleQuestions,
              shuffleOptions: source.shuffleOptions,
              isEnabled: true,
              allowUnproctoredDev: source.allowUnproctoredDev,
            },
          });

          for (const q of source.questions) {
            await tx.question.create({
              data: {
                examId: versioned.id,
                type: q.type,
                prompt: q.prompt,
                explanation: q.explanation,
                marks: q.marks,
                negativeMarks: q.negativeMarks,
                orderIndex: q.orderIndex,
                isRequired: q.isRequired,
                options: {
                  create: q.options.map((opt) => ({
                    label: opt.label,
                    isCorrect: opt.isCorrect,
                    orderIndex: opt.orderIndex,
                  })),
                },
              },
            });
          }

          if (source.allowUnproctoredDev) {
            await syncExamUnproctoredPolicy(tx, versioned.id, user.id, true);
          }

          await recalculateExamTotalMarks(tx, versioned.id);

          await writeAuditLog(
            {
              actorId: user.id,
              actorRole: user.role,
              action: AuditAction.EXAM_VERSION_CREATED,
              entityType: "Exam",
              entityId: versioned.id,
              ipAddress: req.ip,
              userAgent: req.get("user-agent") ?? null,
              metadata: { sourceExamId: source.id, rootExamId: rootId, version: nextVersion },
            },
            tx,
          );

          return tx.exam.findUniqueOrThrow({
            where: { id: versioned.id },
            include: {
              course: {
                select: {
                  id: true,
                  code: true,
                  title: true,
                  teacher: { select: { id: true, fullName: true } },
                },
              },
              questions: {
                orderBy: { orderIndex: "asc" },
                include: { options: { orderBy: { orderIndex: "asc" } } },
              },
              proctoringPolicy: true,
            },
          });
        });

        sendSuccess(
          res,
          toExamDetailDto(created, defaultPolicy, {
            attemptCount: 0,
            activeAttemptCount: 0,
            submissionCount: 0,
          }),
          201,
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:examId/attempts/:attemptId/terminate",
    requireCsrf,
    validateBody(adminForceTerminateAttemptSchema),
    async (req, res, next) => {
      try {
        const user = req.auth!.user;
        const examId = req.params.examId;
        const attemptId = req.params.attemptId;
        if (!isValidUuid(examId) || !isValidUuid(attemptId)) {
          throw badRequest("Invalid identifier", "INVALID_ID");
        }

        const prisma = getPrismaClient();
        const attempt = await prisma.examAttempt.findUnique({
          where: { id: attemptId },
          select: { id: true, examId: true },
        });
        if (!attempt || attempt.examId !== examId) {
          throw notFound("Exam attempt not found", "ATTEMPT_NOT_FOUND");
        }

        const { reason } = req.body as { reason?: string };
        const result = await finalizeExamAttempt({
          attemptId,
          reason: SubmissionReason.ADMIN_FORCE,
          actorId: user.id,
          actorRole: user.role,
          ipAddress: req.ip,
          userAgent: req.get("user-agent") ?? null,
          auditMetadata: reason ? { adminReason: reason } : undefined,
        });

        sendSuccess<{ receipt: ExamSubmissionReceiptDto; alreadyFinalized: boolean }>(res, {
          receipt: result.receipt,
          alreadyFinalized: result.alreadyFinalized,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get("/:examId/proctoring-policy", getExamProctoringPolicyHandler);

  router.patch(
    "/:examId/proctoring-policy",
    requireCsrf,
    validateBody(adminUpdateProctoringPolicySchema),
    updateExamProctoringPolicyHandler,
  );

  router.post("/:examId/proctoring-policy/reset", requireCsrf, resetExamProctoringPolicyHandler);

  return router;
}
