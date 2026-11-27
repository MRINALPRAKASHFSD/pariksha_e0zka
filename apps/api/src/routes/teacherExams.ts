import { Router, type Response } from "express";
import type { Prisma } from "@prisma/client";
import {
  AuditAction,
  ExamStatus,
  createExamSchema,
  createQuestionSchema,
  importQuestionsSchema,
  isSubjectiveQuestionType,
  reorderQuestionsSchema,
  teacherExamsQuerySchema,
  updateExamSchema,
  updateQuestionSchema,
  validateQuestionIntegrity,
  type ApiSuccessResponse,
  type ExamAttemptSummaryDto,
  type ExamDetailDto,
  type ExamSummaryDto,
  type PaginatedResult,
  type QuestionDto,
  type QuestionImportResultDto,
  type QuestionType,
} from "@pariksha/shared";
import { writeAuditLog } from "../lib/audit.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { getPrismaClient } from "../lib/prisma.js";
import { requireAuth, requireCsrf, requireRoles } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/errorAndValidation.js";
import {
  isValidUuid,
  recalculateExamTotalMarks,
  toExamAttemptSummaryDto,
  toExamDetailDto,
  toExamSummaryDto,
  toIntegrityEventDto,
  toQuestionDto,
} from "../services/examSerialization.js";
import {
  QUESTION_CSV_TEMPLATE,
  QUESTION_JSON_TEMPLATE,
  exportQuestionsToCsv,
  exportQuestionsToJson,
  parseAndValidateQuestionsImport,
} from "../services/questionImportExport.js";

function sendSuccess<T>(res: Response, data: T, status = 200): void {
  const payload: ApiSuccessResponse<T> = {
    success: true,
    data,
    requestId: res.locals.requestId as string | undefined,
  };
  res.status(status).json(payload);
}

const EDITABLE_EXAM_STATUSES = new Set<string>([ExamStatus.DRAFT, ExamStatus.REJECTED]);

export function createTeacherExamsRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireRoles("TEACHER"));

  async function loadOwnedExamOrThrow(rawExamId: string | undefined, teacherId: string) {
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
            teacherId: true,
            isActive: true,
            teacher: { select: { id: true, fullName: true } },
          },
        },
        questions: {
          orderBy: { orderIndex: "asc" },
          include: { options: { orderBy: { orderIndex: "asc" } } },
        },
        proctoringPolicy: true,
        _count: { select: { attempts: true } },
      },
    });
    if (!exam) {
      throw notFound("Examination not found", "EXAM_NOT_FOUND");
    }
    if (exam.course.teacherId !== teacherId) {
      throw forbidden("You are not assigned to this course", "EXAM_ACCESS_DENIED");
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

  function assertExamEditable(exam: { status: string; _count: { attempts: number } }) {
    if (!EDITABLE_EXAM_STATUSES.has(exam.status)) {
      throw conflict(
        `Examination cannot be edited while in ${exam.status} status`,
        "EXAM_NOT_EDITABLE",
      );
    }
    if (exam._count.attempts > 0) {
      throw conflict(
        "Examination structure cannot be modified after student attempts exist",
        "EXAM_HAS_ATTEMPTS",
      );
    }
  }

  router.get("/templates/:format", (req, res, next) => {
    try {
      const format = String(req.params.format ?? "").toLowerCase();
      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", 'attachment; filename="questions-template.csv"');
        res.setHeader("Cache-Control", "no-store");
        res.status(200).send(QUESTION_CSV_TEMPLATE);
        return;
      }
      if (format === "json") {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Disposition", 'attachment; filename="questions-template.json"');
        res.setHeader("Cache-Control", "no-store");
        res.status(200).send(QUESTION_JSON_TEMPLATE);
        return;
      }
      throw badRequest("Template format must be csv or json", "INVALID_FORMAT");
    } catch (error) {
      next(error);
    }
  });

  router.get("/", validateQuery(teacherExamsQuerySchema), async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const query = res.locals.validatedQuery as {
        page: number;
        pageSize: number;
        search?: string;
        courseId?: string;
        status?: ExamStatus;
      };
      const prisma = getPrismaClient();

      const where: Prisma.ExamWhereInput = {
        course: { teacherId: user.id },
        ...(query.courseId ? { courseId: query.courseId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.search
          ? {
              OR: [
                { title: { contains: query.search, mode: "insensitive" } },
                { course: { code: { contains: query.search, mode: "insensitive" } } },
                { course: { title: { contains: query.search, mode: "insensitive" } } },
              ],
            }
          : {}),
      };

      const [total, exams] = await Promise.all([
        prisma.exam.count({ where }),
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

      const examIds = exams.map((e) => e.id);
      const [activeGroups, submissionCounts] = examIds.length
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

      const activeMap = new Map<string, number>();
      for (const row of activeGroups) activeMap.set(row.examId, row._count._all);
      const submissionMap = new Map<string, number>();
      for (const row of submissionCounts) submissionMap.set(row.examId, row._count._all);

      const items: ExamSummaryDto[] = exams.map((exam) =>
        toExamSummaryDto(exam, {
          questionCount: exam._count.questions,
          attemptCount: exam._count.attempts,
          activeAttemptCount: activeMap.get(exam.id) ?? 0,
          submissionCount: submissionMap.get(exam.id) ?? 0,
        }),
      );

      const result: PaginatedResult<ExamSummaryDto> = {
        items,
        total,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      };
      sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/", requireCsrf, validateBody(createExamSchema), async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const body = req.body as {
        courseId: string;
        title: string;
        description?: string | null;
        instructions?: string | null;
        passingMarks: number;
        durationMinutes: number;
        windowStart: string;
        windowEnd: string;
        maxAttempts: number;
        shuffleQuestions: boolean;
        shuffleOptions: boolean;
      };
      const prisma = getPrismaClient();

      const course = await prisma.course.findUnique({ where: { id: body.courseId } });
      if (!course) {
        throw notFound("Course not found", "COURSE_NOT_FOUND");
      }
      if (course.teacherId !== user.id) {
        throw forbidden("You may only create exams for courses assigned to you", "COURSE_FORBIDDEN");
      }
      if (!course.isActive) {
        throw conflict("Cannot create an exam in an archived course", "COURSE_ARCHIVED");
      }

      const defaultPolicy = await prisma.proctoringPolicy.findFirst({
        where: { isInstitutionalDefault: true, examId: null },
      });

      const created = await prisma.$transaction(async (tx) => {
        const exam = await tx.exam.create({
          data: {
            courseId: body.courseId,
            createdById: user.id,
            title: body.title,
            description: body.description ?? null,
            instructions: body.instructions ?? null,
            status: ExamStatus.DRAFT,
            totalMarks: 0,
            passingMarks: body.passingMarks,
            durationMinutes: body.durationMinutes,
            windowStart: new Date(body.windowStart),
            windowEnd: new Date(body.windowEnd),
            maxAttempts: body.maxAttempts,
            shuffleQuestions: body.shuffleQuestions,
            shuffleOptions: body.shuffleOptions,
            isEnabled: true,
            allowUnproctoredDev: false,
            version: 1,
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
            action: AuditAction.EXAM_CREATED,
            entityType: "Exam",
            entityId: exam.id,
            ipAddress: req.ip,
            userAgent: req.get("user-agent") ?? null,
            metadata: { courseId: exam.courseId, title: exam.title },
          },
          tx,
        );

        return exam;
      });

      sendSuccess<ExamDetailDto>(
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
  });

  router.get("/:examId", async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const prisma = getPrismaClient();
      const exam = await loadOwnedExamOrThrow(req.params.examId, user.id);
      const [counts, defaultPolicy] = await Promise.all([
        loadExamCounts(exam.id),
        prisma.proctoringPolicy.findFirst({
          where: { isInstitutionalDefault: true, examId: null },
        }),
      ]);
      sendSuccess(res, toExamDetailDto(exam, defaultPolicy, counts));
    } catch (error) {
      next(error);
    }
  });

  router.get("/:examId/preview", async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const prisma = getPrismaClient();
      const exam = await loadOwnedExamOrThrow(req.params.examId, user.id);
      const [counts, defaultPolicy] = await Promise.all([
        loadExamCounts(exam.id),
        prisma.proctoringPolicy.findFirst({
          where: { isInstitutionalDefault: true, examId: null },
        }),
      ]);
      sendSuccess(res, toExamDetailDto(exam, defaultPolicy, counts));
    } catch (error) {
      next(error);
    }
  });

  router.patch("/:examId", requireCsrf, validateBody(updateExamSchema), async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const exam = await loadOwnedExamOrThrow(req.params.examId, user.id);
      assertExamEditable(exam);

      const body = req.body as {
        title?: string;
        description?: string | null;
        instructions?: string | null;
        passingMarks?: number;
        durationMinutes?: number;
        windowStart?: string;
        windowEnd?: string;
        maxAttempts?: number;
        shuffleQuestions?: boolean;
        shuffleOptions?: boolean;
      };

      const nextWindowStart = body.windowStart ? new Date(body.windowStart) : exam.windowStart;
      const nextWindowEnd = body.windowEnd ? new Date(body.windowEnd) : exam.windowEnd;
      if (nextWindowEnd <= nextWindowStart) {
        throw badRequest("Availability window end must be after window start", "INVALID_WINDOW");
      }

      const prisma = getPrismaClient();
      const [updated, counts, defaultPolicy] = await Promise.all([
        prisma.$transaction(async (tx) => {
          const saved = await tx.exam.update({
            where: { id: exam.id },
            data: {
              ...(body.title !== undefined ? { title: body.title } : {}),
              ...(body.description !== undefined ? { description: body.description } : {}),
              ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
              ...(body.passingMarks !== undefined ? { passingMarks: body.passingMarks } : {}),
              ...(body.durationMinutes !== undefined
                ? { durationMinutes: body.durationMinutes }
                : {}),
              ...(body.windowStart !== undefined ? { windowStart: nextWindowStart } : {}),
              ...(body.windowEnd !== undefined ? { windowEnd: nextWindowEnd } : {}),
              ...(body.maxAttempts !== undefined ? { maxAttempts: body.maxAttempts } : {}),
              ...(body.shuffleQuestions !== undefined
                ? { shuffleQuestions: body.shuffleQuestions }
                : {}),
              ...(body.shuffleOptions !== undefined ? { shuffleOptions: body.shuffleOptions } : {}),
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
              action: AuditAction.EXAM_UPDATED,
              entityType: "Exam",
              entityId: exam.id,
              ipAddress: req.ip,
              userAgent: req.get("user-agent") ?? null,
              metadata: { updatedFields: Object.keys(body) },
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

  router.post("/:examId/duplicate", requireCsrf, async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const source = await loadOwnedExamOrThrow(req.params.examId, user.id);
      const prisma = getPrismaClient();
      const defaultPolicy = await prisma.proctoringPolicy.findFirst({
        where: { isInstitutionalDefault: true, examId: null },
      });

      const duplicated = await prisma.$transaction(async (tx) => {
        const created = await tx.exam.create({
          data: {
            courseId: source.courseId,
            createdById: user.id,
            title: `${source.title} (Copy)`.slice(0, 200),
            description: source.description,
            instructions: source.instructions,
            status: ExamStatus.DRAFT,
            totalMarks: source.totalMarks,
            passingMarks: source.passingMarks,
            durationMinutes: source.durationMinutes,
            windowStart: source.windowStart,
            windowEnd: source.windowEnd,
            maxAttempts: source.maxAttempts,
            shuffleQuestions: source.shuffleQuestions,
            shuffleOptions: source.shuffleOptions,
            isEnabled: true,
            allowUnproctoredDev: false,
            version: 1,
          },
        });

        for (const q of source.questions) {
          await tx.question.create({
            data: {
              examId: created.id,
              type: q.type,
              prompt: q.prompt,
              explanation: q.explanation,
              marks: q.marks,
              negativeMarks: q.negativeMarks,
              orderIndex: q.orderIndex,
              isRequired: q.isRequired,
              options: {
                create: q.options.map((o) => ({
                  label: o.label,
                  isCorrect: o.isCorrect,
                  orderIndex: o.orderIndex,
                })),
              },
            },
          });
        }

        await recalculateExamTotalMarks(tx, created.id);

        await writeAuditLog(
          {
            actorId: user.id,
            actorRole: user.role,
            action: AuditAction.EXAM_DUPLICATED,
            entityType: "Exam",
            entityId: created.id,
            ipAddress: req.ip,
            userAgent: req.get("user-agent") ?? null,
            metadata: { sourceExamId: source.id },
          },
          tx,
        );

        return tx.exam.findUniqueOrThrow({
          where: { id: created.id },
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
        toExamDetailDto(duplicated, defaultPolicy, {
          attemptCount: 0,
          activeAttemptCount: 0,
          submissionCount: 0,
        }),
        201,
      );
    } catch (error) {
      next(error);
    }
  });

  router.post("/:examId/submit-for-approval", requireCsrf, async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const exam = await loadOwnedExamOrThrow(req.params.examId, user.id);
      assertExamEditable(exam);

      const totalMarks = Number(exam.totalMarks);
      const passingMarks = Number(exam.passingMarks);

      if (exam.questions.length === 0) {
        throw badRequest(
          "Add at least one question before submitting the exam for approval",
          "EXAM_EMPTY",
        );
      }
      if (totalMarks <= 0) {
        throw badRequest("Total marks must be greater than zero", "INVALID_MARKS");
      }
      if (passingMarks > totalMarks) {
        throw badRequest(
          "Passing marks cannot exceed total exam marks",
          "PASSING_MARKS_EXCEED_TOTAL",
        );
      }
      if (exam.windowEnd <= exam.windowStart) {
        throw badRequest("Exam window end must be after window start", "INVALID_WINDOW");
      }

      const prisma = getPrismaClient();
      const [updated, counts, defaultPolicy] = await Promise.all([
        prisma.$transaction(async (tx) => {
          const saved = await tx.exam.update({
            where: { id: exam.id },
            data: {
              status: ExamStatus.PENDING_APPROVAL,
              submittedForApprovalAt: new Date(),
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
              action: AuditAction.EXAM_SUBMITTED_FOR_APPROVAL,
              entityType: "Exam",
              entityId: exam.id,
              ipAddress: req.ip,
              userAgent: req.get("user-agent") ?? null,
              metadata: { questionCount: exam.questions.length, totalMarks },
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

  router.get("/:examId/attempts", async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const exam = await loadOwnedExamOrThrow(req.params.examId, user.id);
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
    "/:examId/questions",
    requireCsrf,
    validateBody(createQuestionSchema),
    async (req, res, next) => {
      try {
        const user = req.auth!.user;
        const exam = await loadOwnedExamOrThrow(req.params.examId, user.id);
        assertExamEditable(exam);

        const body = req.body as {
          type: QuestionType;
          prompt: string;
          explanation?: string | null;
          marks: number;
          negativeMarks: number;
          isRequired: boolean;
          options: Array<{ label?: string; text: string; isCorrect: boolean }>;
        };

        const prisma = getPrismaClient();
        const result = await prisma.$transaction(async (tx) => {
          const maxOrder = exam.questions.reduce(
            (max, q) => (q.orderIndex > max ? q.orderIndex : max),
            0,
          );

          const question = await tx.question.create({
            data: {
              examId: exam.id,
              type: body.type,
              prompt: body.prompt,
              explanation: body.explanation ?? null,
              marks: body.marks,
              negativeMarks: body.negativeMarks,
              orderIndex: maxOrder + 1,
              isRequired: body.isRequired,
              options: isSubjectiveQuestionType(body.type)
                ? undefined
                : {
                    create: body.options.map((opt, idx) => ({
                      label: opt.text.trim(),
                      isCorrect: opt.isCorrect,
                      orderIndex: idx + 1,
                    })),
                  },
            },
            include: { options: { orderBy: { orderIndex: "asc" } } },
          });

          const examTotalMarks = await recalculateExamTotalMarks(tx, exam.id);

          await writeAuditLog(
            {
              actorId: user.id,
              actorRole: user.role,
              action: AuditAction.QUESTION_CREATED,
              entityType: "Question",
              entityId: question.id,
              ipAddress: req.ip,
              userAgent: req.get("user-agent") ?? null,
              metadata: {
                examId: exam.id,
                type: question.type,
                marks: Number(question.marks),
              },
            },
            tx,
          );

          return { question: toQuestionDto(question), examTotalMarks };
        });

        sendSuccess<{ question: QuestionDto; examTotalMarks: number }>(res, result, 201);
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    "/:examId/questions/reorder",
    requireCsrf,
    validateBody(reorderQuestionsSchema),
    async (req, res, next) => {
      try {
        const user = req.auth!.user;
        const exam = await loadOwnedExamOrThrow(req.params.examId, user.id);
        assertExamEditable(exam);

        const { questionIds } = req.body as { questionIds: string[] };
        const existingIds = new Set(exam.questions.map((q) => q.id));
        const uniqueInput = new Set(questionIds);

        if (
          uniqueInput.size !== existingIds.size ||
          questionIds.length !== existingIds.size ||
          questionIds.some((id) => !existingIds.has(id))
        ) {
          throw badRequest(
            "questionIds must contain every question in the exam exactly once",
            "INVALID_REORDER_LIST",
          );
        }

        const prisma = getPrismaClient();
        const reordered = await prisma.$transaction(async (tx) => {
          // Use temporary high offset first to satisfy @@unique([examId, orderIndex])
          for (let i = 0; i < questionIds.length; i += 1) {
            await tx.question.update({
              where: { id: questionIds[i]! },
              data: { orderIndex: 10000 + i + 1 },
            });
          }
          for (let i = 0; i < questionIds.length; i += 1) {
            await tx.question.update({
              where: { id: questionIds[i]! },
              data: { orderIndex: i + 1 },
            });
          }

          await writeAuditLog(
            {
              actorId: user.id,
              actorRole: user.role,
              action: AuditAction.QUESTIONS_REORDERED,
              entityType: "Exam",
              entityId: exam.id,
              ipAddress: req.ip,
              userAgent: req.get("user-agent") ?? null,
              metadata: { orderCount: questionIds.length },
            },
            tx,
          );

          return tx.question.findMany({
            where: { examId: exam.id },
            orderBy: { orderIndex: "asc" },
            include: { options: { orderBy: { orderIndex: "asc" } } },
          });
        });

        sendSuccess(res, reordered.map(toQuestionDto));
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    "/:examId/questions/:questionId",
    requireCsrf,
    validateBody(updateQuestionSchema),
    async (req, res, next) => {
      try {
        const user = req.auth!.user;
        const exam = await loadOwnedExamOrThrow(req.params.examId, user.id);
        assertExamEditable(exam);

        const questionId = req.params.questionId;
        if (!isValidUuid(questionId)) {
          throw badRequest("Invalid question identifier", "INVALID_ID");
        }

        const existing = exam.questions.find((q) => q.id === questionId);
        if (!existing) {
          throw notFound("Question not found in this exam", "QUESTION_NOT_FOUND");
        }

        const body = req.body as {
          type?: QuestionType;
          prompt?: string;
          explanation?: string | null;
          marks?: number;
          negativeMarks?: number;
          isRequired?: boolean;
          options?: Array<{ label?: string; text: string; isCorrect: boolean }>;
        };

        const nextType = (body.type ?? existing.type) as QuestionType;
        const nextPrompt = body.prompt ?? existing.prompt;
        const nextMarks = body.marks ?? Number(existing.marks);
        const nextNegativeMarks = body.negativeMarks ?? Number(existing.negativeMarks);
        const nextOptions =
          body.options !== undefined
            ? body.options
            : isSubjectiveQuestionType(nextType)
              ? []
              : existing.options.map((o) => ({
                  text: o.label,
                  isCorrect: o.isCorrect,
                }));

        const integrityError = validateQuestionIntegrity({
          type: nextType,
          prompt: nextPrompt,
          marks: nextMarks,
          negativeMarks: nextNegativeMarks,
          options: nextOptions,
        });
        if (integrityError) {
          throw badRequest(integrityError, "INVALID_QUESTION_DEFINITION");
        }

        const prisma = getPrismaClient();
        const result = await prisma.$transaction(async (tx) => {
          if (body.options !== undefined || isSubjectiveQuestionType(nextType)) {
            await tx.questionOption.deleteMany({ where: { questionId: existing.id } });
          }

          const updated = await tx.question.update({
            where: { id: existing.id },
            data: {
              type: nextType,
              prompt: nextPrompt,
              ...(body.explanation !== undefined ? { explanation: body.explanation } : {}),
              marks: nextMarks,
              negativeMarks: nextNegativeMarks,
              ...(body.isRequired !== undefined ? { isRequired: body.isRequired } : {}),
              ...(body.options !== undefined && !isSubjectiveQuestionType(nextType)
                ? {
                    options: {
                      create: nextOptions.map((opt, idx) => ({
                        label: opt.text.trim(),
                        isCorrect: opt.isCorrect,
                        orderIndex: idx + 1,
                      })),
                    },
                  }
                : {}),
            },
            include: { options: { orderBy: { orderIndex: "asc" } } },
          });

          const examTotalMarks = await recalculateExamTotalMarks(tx, exam.id);

          await writeAuditLog(
            {
              actorId: user.id,
              actorRole: user.role,
              action: AuditAction.QUESTION_UPDATED,
              entityType: "Question",
              entityId: existing.id,
              ipAddress: req.ip,
              userAgent: req.get("user-agent") ?? null,
              metadata: { examId: exam.id },
            },
            tx,
          );

          return { question: toQuestionDto(updated), examTotalMarks };
        });

        sendSuccess(res, result);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post("/:examId/questions/:questionId/duplicate", requireCsrf, async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const exam = await loadOwnedExamOrThrow(req.params.examId, user.id);
      assertExamEditable(exam);

      const questionId = req.params.questionId;
      if (!isValidUuid(questionId)) {
        throw badRequest("Invalid question identifier", "INVALID_ID");
      }
      const source = exam.questions.find((q) => q.id === questionId);
      if (!source) {
        throw notFound("Question not found", "QUESTION_NOT_FOUND");
      }

      const maxOrder = exam.questions.reduce(
        (max, q) => (q.orderIndex > max ? q.orderIndex : max),
        0,
      );

      const prisma = getPrismaClient();
      const result = await prisma.$transaction(async (tx) => {
        const clone = await tx.question.create({
          data: {
            examId: exam.id,
            type: source.type,
            prompt: `${source.prompt} (Copy)`,
            explanation: source.explanation,
            marks: source.marks,
            negativeMarks: source.negativeMarks,
            orderIndex: maxOrder + 1,
            isRequired: source.isRequired,
            options: {
              create: source.options.map((opt) => ({
                label: opt.label,
                isCorrect: opt.isCorrect,
                orderIndex: opt.orderIndex,
              })),
            },
          },
          include: { options: { orderBy: { orderIndex: "asc" } } },
        });

        const examTotalMarks = await recalculateExamTotalMarks(tx, exam.id);

        await writeAuditLog(
          {
            actorId: user.id,
            actorRole: user.role,
            action: AuditAction.QUESTION_CREATED,
            entityType: "Question",
            entityId: clone.id,
            ipAddress: req.ip,
            userAgent: req.get("user-agent") ?? null,
            metadata: { examId: exam.id, duplicatedFrom: source.id },
          },
          tx,
        );

        return { question: toQuestionDto(clone), examTotalMarks };
      });

      sendSuccess(res, result, 201);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:examId/questions/:questionId", requireCsrf, async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const exam = await loadOwnedExamOrThrow(req.params.examId, user.id);
      assertExamEditable(exam);

      const questionId = req.params.questionId;
      if (!isValidUuid(questionId)) {
        throw badRequest("Invalid question identifier", "INVALID_ID");
      }
      const existing = exam.questions.find((q) => q.id === questionId);
      if (!existing) {
        throw notFound("Question not found", "QUESTION_NOT_FOUND");
      }

      const prisma = getPrismaClient();
      const examTotalMarks = await prisma.$transaction(async (tx) => {
        await tx.question.delete({ where: { id: questionId } });

        const remaining = await tx.question.findMany({
          where: { examId: exam.id },
          orderBy: { orderIndex: "asc" },
          select: { id: true },
        });
        for (let i = 0; i < remaining.length; i += 1) {
          await tx.question.update({
            where: { id: remaining[i]!.id },
            data: { orderIndex: 10000 + i + 1 },
          });
        }
        for (let i = 0; i < remaining.length; i += 1) {
          await tx.question.update({
            where: { id: remaining[i]!.id },
            data: { orderIndex: i + 1 },
          });
        }

        const total = await recalculateExamTotalMarks(tx, exam.id);

        await writeAuditLog(
          {
            actorId: user.id,
            actorRole: user.role,
            action: AuditAction.QUESTION_DELETED,
            entityType: "Question",
            entityId: questionId,
            ipAddress: req.ip,
            userAgent: req.get("user-agent") ?? null,
            metadata: { examId: exam.id },
          },
          tx,
        );

        return total;
      });

      sendSuccess(res, { deletedQuestionId: questionId, examTotalMarks });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/:examId/questions/import",
    requireCsrf,
    validateBody(importQuestionsSchema),
    async (req, res, next) => {
      try {
        const user = req.auth!.user;
        const exam = await loadOwnedExamOrThrow(req.params.examId, user.id);
        const body = req.body as {
          format: "csv" | "json";
          content: string;
          mode: "preview" | "import";
        };

        const { rows, parseError } = parseAndValidateQuestionsImport(body.format, body.content);
        if (parseError) {
          throw badRequest(parseError, "QUESTION_IMPORT_PARSE_ERROR");
        }

        const validCount = rows.filter((r) => r.valid).length;
        const invalidCount = rows.length - validCount;

        if (body.mode === "preview") {
          const previewResult: QuestionImportResultDto = {
            mode: "preview",
            totalRows: rows.length,
            validCount,
            invalidCount,
            importedCount: 0,
            rows,
            examTotalMarks: Number(exam.totalMarks),
          };
          sendSuccess(res, previewResult);
          return;
        }

        assertExamEditable(exam);

        if (invalidCount > 0) {
          throw badRequest(
            `${invalidCount} question row(s) failed validation. Fix all errors before importing.`,
            "QUESTION_IMPORT_VALIDATION_FAILED",
            { rows },
          );
        }

        const prisma = getPrismaClient();
        const examTotalMarks = await prisma.$transaction(async (tx) => {
          let nextOrder = exam.questions.reduce(
            (max, q) => (q.orderIndex > max ? q.orderIndex : max),
            0,
          );

          for (const row of rows) {
            if (!row.question) continue;
            nextOrder += 1;
            const q = row.question;
            await tx.question.create({
              data: {
                examId: exam.id,
                type: q.type,
                prompt: q.prompt,
                explanation: q.explanation,
                marks: q.marks,
                negativeMarks: q.negativeMarks,
                orderIndex: nextOrder,
                isRequired: q.isRequired,
                options:
                  q.options.length > 0
                    ? {
                        create: q.options.map((opt, idx) => ({
                          label: opt.text,
                          isCorrect: opt.isCorrect,
                          orderIndex: idx + 1,
                        })),
                      }
                    : undefined,
              },
            });
          }

          const total = await recalculateExamTotalMarks(tx, exam.id);

          await writeAuditLog(
            {
              actorId: user.id,
              actorRole: user.role,
              action: AuditAction.QUESTIONS_IMPORTED,
              entityType: "Exam",
              entityId: exam.id,
              ipAddress: req.ip,
              userAgent: req.get("user-agent") ?? null,
              metadata: { format: body.format, importedCount: validCount },
            },
            tx,
          );

          return total;
        });

        const result: QuestionImportResultDto = {
          mode: "import",
          totalRows: rows.length,
          validCount,
          invalidCount: 0,
          importedCount: validCount,
          rows,
          examTotalMarks,
        };
        sendSuccess(res, result, 201);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get("/:examId/questions/export", async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const exam = await loadOwnedExamOrThrow(req.params.examId, user.id);
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

  // Phase 5 — Read-only course-scoped integrity timeline for human review
  router.get("/:examId/integrity-events", async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const exam = await loadOwnedExamOrThrow(req.params.examId, user.id);
      const prisma = getPrismaClient();

      const events = await prisma.integrityEvent.findMany({
        where: { examId: exam.id },
        orderBy: { occurredAt: "desc" },
        take: 250,
        include: {
          exam: { select: { title: true, course: { select: { code: true } } } },
          student: { select: { fullName: true, email: true } },
        },
      });
      sendSuccess(res, events.map(toIntegrityEventDto));
    } catch (error) {
      next(error);
    }
  });

  router.get("/:examId/attempts/:attemptId/events", async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const exam = await loadOwnedExamOrThrow(req.params.examId, user.id);
      const attemptId = req.params.attemptId;
      if (!isValidUuid(attemptId)) {
        throw badRequest("Invalid attempt identifier", "INVALID_ID");
      }

      const prisma = getPrismaClient();
      const attempt = await prisma.examAttempt.findUnique({
        where: { id: attemptId },
        select: { id: true, examId: true },
      });
      if (!attempt || attempt.examId !== exam.id) {
        throw notFound("Exam attempt not found", "ATTEMPT_NOT_FOUND");
      }

      const events = await prisma.integrityEvent.findMany({
        where: { attemptId },
        orderBy: { occurredAt: "asc" },
        include: {
          exam: { select: { title: true, course: { select: { code: true } } } },
          student: { select: { fullName: true, email: true } },
        },
      });
      sendSuccess(res, events.map(toIntegrityEventDto));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
