import { Router, type Request, type Response } from "express";
import type { Prisma } from "@prisma/client";
import rateLimit from "express-rate-limit";
import {
  AuditAction,
  BROWSER_SECURITY_LIMITATIONS,
  ExamStatus,
  IntegrityEventSource,
  QuestionType,
  SubmissionReason,
  examHeartbeatSchema,
  isSubjectiveQuestionType,
  recordIntegrityEventSchema,
  resumeAttemptSchema,
  saveExamAnswerSchema,
  startExamAttemptSchema,
  studentExamsQuerySchema,
  submitExamAttemptSchema,
  submitPreflightHandshakeSchema,
  type ApiSuccessResponse,
  type ExamHeartbeatInput,
  type ExamSubmissionReceiptDto,
  type PaginatedResult,
  type PreflightHandshakeReceiptDto,
  type RecordIntegrityEventInput,
  type ResumeAttemptInput,
  type SaveExamAnswerResultDto,
  type StudentExamAttemptDto,
  type StudentExamEligibilityStatus,
  type StudentExamListItemDto,
  type StudentExamPreflightContextDto,
} from "@pariksha/shared";
import { getEnv } from "../config/env.js";
import { writeAuditLog } from "../lib/audit.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { getPrismaClient } from "../lib/prisma.js";
import { requireAuth, requireCsrf, requireRoles } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/errorAndValidation.js";
import { expireAttemptIfDue } from "../services/examExpirationWorker.js";
import {
  emitAttemptFinalizedRealtime,
  finalizeExamAttempt,
  isTerminalAttemptStatus,
} from "../services/examFinalization.js";
import {
  buildAttemptSnapshots,
  displayLetterForOrder,
  evaluateProctoringPreflight,
  isValidUuid,
  resolveEffectivePolicyWithMeta,
  resolveEffectiveProctoringPolicy,
  toStudentAttemptDto,
  toStudentExamAnswerDto,
  toSubmissionReceiptDto,
  type QuestionSnapshotItem,
} from "../services/examSerialization.js";
import {
  createPreflightHandshake,
  hashPreflightToken,
  processAttemptHeartbeat,
  processIntegrityEvent,
  resumeProctoredAttempt,
  validatePreflightSubmissionAgainstPolicy,
} from "../services/proctoringEngine.js";

function setNoStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store, private, must-revalidate");
  res.setHeader("Pragma", "no-cache");
}

function sendSuccess<T>(res: Response, data: T, status = 200): void {
  setNoStore(res);
  const payload: ApiSuccessResponse<T> = {
    success: true,
    data,
    requestId: res.locals.requestId as string | undefined,
  };
  res.status(status).json(payload);
}

const examActionLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.auth?.user.id ?? req.ip ?? "anon",
  message: {
    success: false,
    error: {
      code: "EXAM_RATE_LIMIT_EXCEEDED",
      message: "Too many exam lifecycle requests. Please wait a moment.",
    },
  },
});

const examAutosaveLimiter = rateLimit({
  windowMs: 60_000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.auth?.user.id ?? req.ip ?? "anon",
  message: {
    success: false,
    error: {
      code: "AUTOSAVE_RATE_LIMIT_EXCEEDED",
      message: "Answer autosave rate limit exceeded briefly. Retrying shortly.",
    },
  },
});

const proctoringTelemetryLimiter = rateLimit({
  windowMs: 60_000,
  max: 360,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.auth?.user.id ?? req.ip ?? "anon",
  message: {
    success: false,
    error: {
      code: "PROCTORING_RATE_LIMIT_EXCEEDED",
      message: "Too many proctoring telemetry requests. Please slow down briefly.",
    },
  },
});

const STUDENT_VISIBLE_EXAM_STATUSES = [
  ExamStatus.APPROVED,
  ExamStatus.ACTIVE,
  ExamStatus.PAUSED,
  ExamStatus.COMPLETED,
  ExamStatus.CANCELLED,
] as const;

export function createStudentExamsRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireRoles("STUDENT"));

  async function buildStudentExamListItem(params: {
    exam: Prisma.ExamGetPayload<{
      include: {
        course: { select: { id: true; code: true; title: true; isActive: true } };
        proctoringPolicy: true;
        _count: { select: { questions: true } };
      };
    }>;
    attempts: Prisma.ExamAttemptGetPayload<{
      include: {
        submission: true;
        answers: { select: { selectedOptionIds: true; subjectiveText: true } };
      };
    }>[];
    defaultPolicy: Prisma.ProctoringPolicyGetPayload<object> | null;
    now: Date;
  }): Promise<StudentExamListItemDto> {
    const { exam, attempts, defaultPolicy, now } = params;
    const effectivePolicy = resolveEffectiveProctoringPolicy({
      examPolicy: exam.proctoringPolicy,
      defaultPolicy,
      allowUnproctoredDev: exam.allowUnproctoredDev,
    });
    const preflight = evaluateProctoringPreflight(exam.allowUnproctoredDev, effectivePolicy);

    const activeAttempt = attempts.find(
      (a) => a.status === "IN_PROGRESS" || a.status === "PAUSED",
    );
    const submittedAttempts = attempts
      .filter((a) => a.submission !== null)
      .sort((a, b) => b.attemptNumber - a.attemptNumber);
    const latestSubmittedAttempt = submittedAttempts[0] ?? null;

    const latestSubmission: ExamSubmissionReceiptDto | null =
      latestSubmittedAttempt && latestSubmittedAttempt.submission
        ? toSubmissionReceiptDto({
            submission: latestSubmittedAttempt.submission,
            attempt: latestSubmittedAttempt,
            exam,
            answeredCount: latestSubmittedAttempt.answers.filter((a) => {
              const selected = Array.isArray(a.selectedOptionIds) ? a.selectedOptionIds : [];
              return (
                selected.length > 0 ||
                Boolean(a.subjectiveText && a.subjectiveText.trim().length > 0)
              );
            }).length,
            fallbackQuestionCount: exam._count.questions,
          })
        : null;

    let eligibilityStatus: StudentExamEligibilityStatus = "AVAILABLE";
    let eligibilityReason: string | null = null;
    let canStart = false;
    let canResume = false;

    if (activeAttempt) {
      if (exam.status === ExamStatus.CANCELLED) {
        eligibilityStatus = "CANCELLED";
        eligibilityReason = exam.cancellationReason ?? "Examination was cancelled by an administrator";
      } else {
        eligibilityStatus = "IN_PROGRESS";
        canResume = true;
      }
    } else if (exam.status === ExamStatus.CANCELLED) {
      eligibilityStatus = "CANCELLED";
      eligibilityReason = exam.cancellationReason ?? "Examination was cancelled by an administrator";
    } else if (!exam.isEnabled) {
      eligibilityStatus = "DISABLED";
      eligibilityReason = "Examination has been disabled by an administrator";
    } else if (attempts.length >= exam.maxAttempts) {
      eligibilityStatus = submittedAttempts.length > 0 ? "COMPLETED" : "ATTEMPTS_EXHAUSTED";
      eligibilityReason =
        submittedAttempts.length > 0
          ? "Examination attempt completed and submitted"
          : "Maximum allowed attempts reached";
    } else if (exam.status === ExamStatus.COMPLETED) {
      eligibilityStatus = "COMPLETED";
      eligibilityReason = "Examination window has concluded";
    } else if (exam.status === ExamStatus.PAUSED) {
      eligibilityStatus = "PAUSED";
      eligibilityReason = "New exam starts are temporarily paused by an administrator";
    } else if (now < exam.windowStart || exam.status === ExamStatus.APPROVED) {
      eligibilityStatus = "UPCOMING";
      eligibilityReason =
        exam.status === ExamStatus.APPROVED
          ? "Exam is approved and awaiting activation"
          : `Opens at ${exam.windowStart.toISOString()}`;
    } else if (now > exam.windowEnd) {
      eligibilityStatus = "WINDOW_CLOSED";
      eligibilityReason = "Examination availability window has closed";
    } else if (!preflight.canStartAttempt) {
      eligibilityStatus = "PROCTORING_UNAVAILABLE";
      eligibilityReason = preflight.blockingMessage;
    } else if (exam.status === ExamStatus.ACTIVE) {
      eligibilityStatus = preflight.requiresPreflightHandshake ? "PREFLIGHT_REQUIRED" : "AVAILABLE";
      eligibilityReason = preflight.requiresPreflightHandshake ? preflight.bannerLabel : null;
      canStart = true;
    }

    return {
      id: exam.id,
      courseId: exam.courseId,
      courseCode: exam.course.code,
      courseTitle: exam.course.title,
      title: exam.title,
      description: exam.description,
      instructions: exam.instructions,
      version: exam.version,
      status: exam.status as ExamStatus,
      durationMinutes: exam.durationMinutes,
      totalMarks: Number(exam.totalMarks),
      passingMarks: Number(exam.passingMarks),
      maxAttempts: exam.maxAttempts,
      attemptsUsed: attempts.length,
      questionCount: exam._count.questions,
      windowStart: exam.windowStart.toISOString(),
      windowEnd: exam.windowEnd.toISOString(),
      serverNow: now.toISOString(),
      allowUnproctoredDev: exam.allowUnproctoredDev,
      eligibilityStatus,
      eligibilityReason,
      canStart,
      canResume,
      activeAttemptId: activeAttempt?.id ?? null,
      activeAttemptExpiresAt: activeAttempt ? activeAttempt.expiresAt.toISOString() : null,
      latestSubmission,
      preflight,
    };
  }

  async function sweepStudentOverdueAttempts(studentId: string): Promise<void> {
    const prisma = getPrismaClient();
    const overdue = await prisma.examAttempt.findMany({
      where: {
        studentId,
        status: { in: ["IN_PROGRESS", "PAUSED"] },
        expiresAt: { lte: new Date() },
      },
      select: { id: true },
    });
    for (const row of overdue) {
      await expireAttemptIfDue(row.id);
    }
  }

  router.get("/", validateQuery(studentExamsQuerySchema), async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const query = res.locals.validatedQuery as {
        page: number;
        pageSize: number;
        search?: string;
        courseId?: string;
        filter: "all" | "upcoming" | "available" | "in_progress" | "completed";
      };

      await sweepStudentOverdueAttempts(user.id);
      const prisma = getPrismaClient();
      const now = new Date();

      const enrollments = await prisma.enrollment.findMany({
        where: {
          studentId: user.id,
          status: "ACTIVE",
          course: { isActive: true },
        },
        select: { courseId: true },
      });
      const courseIds = enrollments.map((e) => e.courseId);

      if (courseIds.length === 0 || (query.courseId && !courseIds.includes(query.courseId))) {
        const empty: PaginatedResult<StudentExamListItemDto> = {
          items: [],
          total: 0,
          page: query.page,
          pageSize: query.pageSize,
          totalPages: 1,
        };
        sendSuccess(res, empty);
        return;
      }

      const [defaultPolicy, exams] = await Promise.all([
        prisma.proctoringPolicy.findFirst({
          where: { isInstitutionalDefault: true, examId: null },
        }),
        prisma.exam.findMany({
          where: {
            courseId: query.courseId ? query.courseId : { in: courseIds },
            status: { in: [...STUDENT_VISIBLE_EXAM_STATUSES] },
            ...(query.search
              ? {
                  OR: [
                    { title: { contains: query.search, mode: "insensitive" } },
                    { course: { code: { contains: query.search, mode: "insensitive" } } },
                    { course: { title: { contains: query.search, mode: "insensitive" } } },
                  ],
                }
              : {}),
          },
          orderBy: [{ windowStart: "asc" }],
          include: {
            course: { select: { id: true, code: true, title: true, isActive: true } },
            proctoringPolicy: true,
            _count: { select: { questions: true } },
          },
        }),
      ]);

      const examIds = exams.map((e) => e.id);
      const attempts = examIds.length
        ? await prisma.examAttempt.findMany({
            where: { studentId: user.id, examId: { in: examIds } },
            orderBy: { attemptNumber: "asc" },
            include: {
              submission: true,
              answers: { select: { selectedOptionIds: true, subjectiveText: true } },
            },
          })
        : [];

      const attemptsByExam = new Map<string, typeof attempts>();
      for (const a of attempts) {
        const list = attemptsByExam.get(a.examId) ?? [];
        list.push(a);
        attemptsByExam.set(a.examId, list);
      }

      const allItems = await Promise.all(
        exams.map((exam) =>
          buildStudentExamListItem({
            exam,
            attempts: attemptsByExam.get(exam.id) ?? [],
            defaultPolicy,
            now,
          }),
        ),
      );

      const filtered = allItems.filter((item) => {
        if (query.filter === "all") return true;
        if (query.filter === "available") {
          return (
            item.eligibilityStatus === "AVAILABLE" ||
            item.eligibilityStatus === "PREFLIGHT_REQUIRED" ||
            item.eligibilityStatus === "PROCTORING_UNAVAILABLE" ||
            item.eligibilityStatus === "PAUSED"
          );
        }
        if (query.filter === "upcoming") return item.eligibilityStatus === "UPCOMING";
        if (query.filter === "in_progress") return item.eligibilityStatus === "IN_PROGRESS";
        if (query.filter === "completed") {
          return (
            item.eligibilityStatus === "COMPLETED" ||
            item.eligibilityStatus === "ATTEMPTS_EXHAUSTED" ||
            item.eligibilityStatus === "WINDOW_CLOSED" ||
            item.eligibilityStatus === "CANCELLED"
          );
        }
        return true;
      });

      const start = (query.page - 1) * query.pageSize;
      const paged = filtered.slice(start, start + query.pageSize);

      sendSuccess<PaginatedResult<StudentExamListItemDto>>(res, {
        items: paged,
        total: filtered.length,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.max(1, Math.ceil(filtered.length / query.pageSize)),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:examId", async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const examId = req.params.examId;
      if (!isValidUuid(examId)) {
        throw badRequest("Invalid exam identifier", "INVALID_ID");
      }

      await sweepStudentOverdueAttempts(user.id);
      const prisma = getPrismaClient();

      const exam = await prisma.exam.findUnique({
        where: { id: examId },
        include: {
          course: { select: { id: true, code: true, title: true, isActive: true } },
          proctoringPolicy: true,
          _count: { select: { questions: true } },
        },
      });
      if (!exam || !(STUDENT_VISIBLE_EXAM_STATUSES as readonly string[]).includes(exam.status)) {
        throw notFound("Examination not found", "EXAM_NOT_FOUND");
      }

      const enrollment = await prisma.enrollment.findUnique({
        where: { courseId_studentId: { courseId: exam.courseId, studentId: user.id } },
      });
      if (!enrollment || enrollment.status !== "ACTIVE" || !exam.course.isActive) {
        throw forbidden("You are not actively enrolled in this course", "ENROLLMENT_REQUIRED");
      }

      const [defaultPolicy, attempts] = await Promise.all([
        prisma.proctoringPolicy.findFirst({
          where: { isInstitutionalDefault: true, examId: null },
        }),
        prisma.examAttempt.findMany({
          where: { examId: exam.id, studentId: user.id },
          orderBy: { attemptNumber: "asc" },
          include: {
            submission: true,
            answers: { select: { selectedOptionIds: true, subjectiveText: true } },
          },
        }),
      ]);

      const dto = await buildStudentExamListItem({
        exam,
        attempts,
        defaultPolicy,
        now: new Date(),
      });
      sendSuccess(res, dto);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:examId/preflight", async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const examId = req.params.examId;
      if (!isValidUuid(examId)) {
        throw badRequest("Invalid exam identifier", "INVALID_ID");
      }

      const prisma = getPrismaClient();
      const [exam, defaultPolicy] = await Promise.all([
        prisma.exam.findUnique({
          where: { id: examId },
          include: {
            course: { select: { id: true, code: true, title: true, isActive: true } },
            proctoringPolicy: true,
          },
        }),
        prisma.proctoringPolicy.findFirst({
          where: { isInstitutionalDefault: true, examId: null },
        }),
      ]);

      if (!exam || !(STUDENT_VISIBLE_EXAM_STATUSES as readonly string[]).includes(exam.status)) {
        throw notFound("Examination not found", "EXAM_NOT_FOUND");
      }

      const enrollment = await prisma.enrollment.findUnique({
        where: { courseId_studentId: { courseId: exam.courseId, studentId: user.id } },
      });
      if (!enrollment || enrollment.status !== "ACTIVE" || !exam.course.isActive) {
        throw forbidden("You are not actively enrolled in this course", "ENROLLMENT_REQUIRED");
      }

      const resolved = resolveEffectivePolicyWithMeta({
        examPolicy: exam.proctoringPolicy,
        defaultPolicy,
        allowUnproctoredDev: exam.allowUnproctoredDev,
      });
      const preflight = evaluateProctoringPreflight(exam.allowUnproctoredDev, resolved.policy);

      const context: StudentExamPreflightContextDto = {
        examId: exam.id,
        examTitle: exam.title,
        courseCode: exam.course.code,
        courseTitle: exam.course.title,
        instructions: exam.instructions,
        durationMinutes: exam.durationMinutes,
        totalMarks: Number(exam.totalMarks),
        allowUnproctoredDev: exam.allowUnproctoredDev,
        policyVersion: resolved.version,
        policy: resolved.policy,
        preflight,
        privacyNotice:
          "Pariksha monitors local camera/screen-share track states, fullscreen/focus status, and clipboard actions as telemetry during monitored examinations. Raw webcam video or screen-share recordings are NOT recorded or uploaded by default.",
        browserLimitations: BROWSER_SECURITY_LIMITATIONS,
      };
      sendSuccess(res, context);
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/:examId/preflight",
    requireCsrf,
    examActionLimiter,
    validateBody(submitPreflightHandshakeSchema),
    async (req, res, next) => {
      try {
        const user = req.auth!.user;
        const examId = req.params.examId;
        if (!isValidUuid(examId)) {
          throw badRequest("Invalid exam identifier", "INVALID_ID");
        }

        const receipt: PreflightHandshakeReceiptDto = await createPreflightHandshake({
          examId,
          studentId: user.id,
          sessionId: req.auth!.sessionId,
          input: req.body,
          ipAddress: req.ip,
          userAgent: req.get("user-agent") ?? null,
        });
        sendSuccess(res, receipt, 201);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:examId/start",
    requireCsrf,
    examActionLimiter,
    validateBody(startExamAttemptSchema),
    async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const examId = req.params.examId;
      if (!isValidUuid(examId)) {
        throw badRequest("Invalid exam identifier", "INVALID_ID");
      }
      const startBody = (req.body ?? {}) as { preflightToken?: string };

      await sweepStudentOverdueAttempts(user.id);
      const prisma = getPrismaClient();
      const defaultPolicy = await prisma.proctoringPolicy.findFirst({
        where: { isInstitutionalDefault: true, examId: null },
      });

      const result = await prisma.$transaction(async (tx) => {
        // Advisory transaction lock serializes concurrent starts for (examId, studentId) even when 0 attempts exist yet
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${examId}:${user.id}`}))`;

        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM "ExamAttempt"
          WHERE "examId" = ${examId}::uuid
            AND "studentId" = ${user.id}::uuid
          FOR UPDATE
        `;

        const exam = await tx.exam.findUnique({
          where: { id: examId },
          include: {
            course: { select: { id: true, code: true, title: true, isActive: true } },
            questions: {
              orderBy: { orderIndex: "asc" },
              include: { options: { orderBy: { orderIndex: "asc" } } },
            },
            proctoringPolicy: true,
          },
        });
        if (!exam || !(STUDENT_VISIBLE_EXAM_STATUSES as readonly string[]).includes(exam.status)) {
          throw notFound("Examination not found", "EXAM_NOT_FOUND");
        }

        const enrollment = await tx.enrollment.findUnique({
          where: { courseId_studentId: { courseId: exam.courseId, studentId: user.id } },
        });
        if (!enrollment || enrollment.status !== "ACTIVE" || !exam.course.isActive) {
          throw forbidden("You are not actively enrolled in this course", "ENROLLMENT_REQUIRED");
        }

        const existingAttempts = await tx.examAttempt.findMany({
          where: { examId: exam.id, studentId: user.id },
          orderBy: { attemptNumber: "asc" },
          include: {
            answers: true,
            submission: true,
            integrityEvents: { orderBy: { occurredAt: "desc" }, take: 25 },
          },
        });

        const now = new Date();
        const active = existingAttempts.find(
          (a) => a.status === "IN_PROGRESS" || a.status === "PAUSED",
        );

        if (active) {
          if (exam.status === ExamStatus.CANCELLED) {
            throw conflict(
              exam.cancellationReason ?? "Examination has been cancelled by an administrator",
              "EXAM_CANCELLED",
            );
          }
          if (active.expiresAt <= now) {
            await finalizeExamAttempt(
              {
                attemptId: active.id,
                reason: SubmissionReason.TIMER_EXPIRED,
                actorId: user.id,
                actorRole: user.role,
              },
              tx,
            );
          } else {
            return {
              created: false,
              dto: toStudentAttemptDto({
                attempt: active,
                exam,
                defaultPolicy,
                now,
              }),
            };
          }
        }

        if (exam.status === ExamStatus.CANCELLED) {
          throw conflict(
            exam.cancellationReason ?? "Examination has been cancelled",
            "EXAM_CANCELLED",
          );
        }
        if (!exam.isEnabled) {
          throw conflict("Examination is currently disabled by an administrator", "EXAM_DISABLED");
        }
        if (exam.status === ExamStatus.PAUSED) {
          throw conflict("New attempts are temporarily paused by an administrator", "EXAM_PAUSED");
        }
        if (exam.status !== ExamStatus.ACTIVE) {
          throw conflict(`Examination is not active (status: ${exam.status})`, "EXAM_NOT_ACTIVE");
        }
        if (now < exam.windowStart) {
          throw conflict("Examination availability window has not opened yet", "EXAM_WINDOW_NOT_OPEN");
        }
        if (now > exam.windowEnd) {
          throw conflict("Examination availability window has closed", "EXAM_WINDOW_CLOSED");
        }
        if (exam.questions.length === 0) {
          throw conflict("Examination contains no questions", "EXAM_EMPTY");
        }

        const resolvedPolicy = resolveEffectivePolicyWithMeta({
          examPolicy: exam.proctoringPolicy,
          defaultPolicy,
          allowUnproctoredDev: exam.allowUnproctoredDev,
        });
        const effectivePolicy = resolvedPolicy.policy;
        const preflight = evaluateProctoringPreflight(exam.allowUnproctoredDev, effectivePolicy);

        if (!preflight.canStartAttempt) {
          if (preflight.blockingCode === "UNPROCTORED_FORBIDDEN_IN_PRODUCTION") {
            throw forbidden(
              preflight.blockingMessage ??
                "Development-only unproctored bypass cannot be used in production.",
              "UNPROCTORED_FORBIDDEN_IN_PRODUCTION",
            );
          }
          throw conflict(
            preflight.blockingMessage ?? "Proctoring requirements cannot be satisfied.",
            "PROCTORING_UNAVAILABLE",
            { preflight },
          );
        }

        let consumedHandshake: {
          id: string;
          cameraStatus: string;
          screenShareStatus: string;
          fullscreenStatus: string;
        } | null = null;

        if (preflight.requiresPreflightHandshake) {
          if (!startBody.preflightToken) {
            throw conflict(
              "Mandatory proctoring preflight handshake is required before starting this examination.",
              "PREFLIGHT_REQUIRED",
              { preflight },
            );
          }

          const tokenHash = hashPreflightToken(startBody.preflightToken);
          const handshake = await tx.preflightHandshake.findUnique({
            where: { tokenHash },
          });

          if (!handshake) {
            throw conflict("Invalid preflight verification handshake.", "PREFLIGHT_INVALID");
          }
          if (handshake.studentId !== user.id || handshake.examId !== exam.id) {
            throw forbidden(
              "Preflight handshake does not match the authenticated student or examination.",
              "PREFLIGHT_MISMATCHED",
            );
          }
          if (handshake.sessionId !== req.auth!.sessionId) {
            throw conflict(
              "Preflight handshake is bound to a different login session.",
              "PREFLIGHT_SESSION_MISMATCH",
            );
          }
          if (handshake.consumedAt !== null) {
            throw conflict(
              "Preflight handshake has already been consumed and cannot be replayed.",
              "PREFLIGHT_REPLAYED",
            );
          }
          if (handshake.expiresAt <= now) {
            throw conflict(
              "Preflight handshake expired. Re-verify permissions and retry.",
              "PREFLIGHT_EXPIRED",
            );
          }
          if (handshake.policyVersion !== resolvedPolicy.version) {
            throw conflict(
              "Proctoring policy changed since preflight verification. Re-run preflight.",
              "PREFLIGHT_POLICY_MISMATCH",
            );
          }

          validatePreflightSubmissionAgainstPolicy({
            input: {
              cameraStatus: handshake.cameraStatus as "GRANTED" | "DENIED" | "UNAVAILABLE" | "NOT_REQUIRED",
              screenShareStatus: handshake.screenShareStatus as "GRANTED" | "DENIED" | "UNAVAILABLE" | "NOT_REQUIRED",
              displaySurface: (handshake.displaySurface ?? null) as
                | "monitor"
                | "window"
                | "browser"
                | "application"
                | "unknown"
                | null,
              fullscreenStatus: handshake.fullscreenStatus as "GRANTED" | "DENIED" | "UNAVAILABLE" | "NOT_REQUIRED",
              connectivityOk: handshake.connectivityOk,
              consentAccepted: handshake.consentAccepted,
            },
            policy: effectivePolicy,
            allowUnproctoredDev: exam.allowUnproctoredDev,
          });

          consumedHandshake = handshake;
        } else if (getEnv().NODE_ENV === "production") {
          throw forbidden(
            "Development-only unproctored bypass cannot be used in production.",
            "UNPROCTORED_FORBIDDEN_IN_PRODUCTION",
          );
        }

        const refreshedCount = await tx.examAttempt.count({
          where: { examId: exam.id, studentId: user.id },
        });
        if (refreshedCount >= exam.maxAttempts) {
          throw conflict("Maximum attempt limit reached for this examination", "ATTEMPT_LIMIT_REACHED");
        }

        const durationDeadline = new Date(now.getTime() + exam.durationMinutes * 60_000);
        const expiresAt = new Date(Math.min(durationDeadline.getTime(), exam.windowEnd.getTime()));
        if (expiresAt <= now) {
          throw conflict("Insufficient time left in examination window", "EXAM_WINDOW_CLOSED");
        }

        const snapshots = buildAttemptSnapshots(exam, exam.questions, effectivePolicy);

        const createdAttempt = await tx.examAttempt.create({
          data: {
            examId: exam.id,
            studentId: user.id,
            examVersion: exam.version,
            policyVersion: resolvedPolicy.version,
            strikeThreshold: effectivePolicy.violationThreshold,
            attemptNumber: refreshedCount + 1,
            status: "IN_PROGRESS",
            startedAt: now,
            expiresAt,
            lastHeartbeatAt: now,
            cameraActive: consumedHandshake ? consumedHandshake.cameraStatus === "GRANTED" : false,
            screenShareActive: consumedHandshake
              ? consumedHandshake.screenShareStatus === "GRANTED"
              : false,
            fullscreenActive: consumedHandshake
              ? consumedHandshake.fullscreenStatus === "GRANTED"
              : false,
            preflightHandshakeId: consumedHandshake?.id ?? null,
            questionSnapshotJson: snapshots.questionSnapshot as unknown as Prisma.InputJsonValue,
            answerKeySnapshotJson: snapshots.answerKeySnapshot as unknown as Prisma.InputJsonValue,
            policySnapshotJson: snapshots.policySnapshot as unknown as Prisma.InputJsonValue,
          },
          include: {
            answers: true,
            submission: true,
            integrityEvents: { orderBy: { occurredAt: "desc" }, take: 25 },
          },
        });

        if (consumedHandshake) {
          await tx.preflightHandshake.update({
            where: { id: consumedHandshake.id },
            data: {
              consumedAt: now,
              consumedAttemptId: createdAttempt.id,
            },
          });
        }

        await writeAuditLog(
          {
            actorId: user.id,
            actorRole: user.role,
            action: AuditAction.EXAM_ATTEMPT_STARTED,
            entityType: "ExamAttempt",
            entityId: createdAttempt.id,
            ipAddress: req.ip,
            userAgent: req.get("user-agent") ?? null,
            metadata: {
              examId: exam.id,
              attemptNumber: createdAttempt.attemptNumber,
              expiresAt: createdAttempt.expiresAt.toISOString(),
              allowUnproctoredDev: exam.allowUnproctoredDev,
              policyVersion: resolvedPolicy.version,
              preflightHandshakeId: consumedHandshake?.id ?? null,
            },
          },
          tx,
        );

        return {
          created: true,
          dto: toStudentAttemptDto({
            attempt: createdAttempt,
            exam,
            defaultPolicy,
            now,
          }),
        };
      });

      sendSuccess<StudentExamAttemptDto>(res, result.dto, result.created ? 201 : 200);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:examId/attempts/:attemptId", async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const examId = req.params.examId;
      const attemptId = req.params.attemptId;
      if (!isValidUuid(examId) || !isValidUuid(attemptId)) {
        throw badRequest("Invalid identifier", "INVALID_ID");
      }

      await expireAttemptIfDue(attemptId);
      const prisma = getPrismaClient();
      const [attempt, defaultPolicy] = await Promise.all([
        prisma.examAttempt.findUnique({
          where: { id: attemptId },
          include: {
            answers: true,
            submission: true,
            integrityEvents: {
              orderBy: { occurredAt: "desc" },
              take: 25,
            },
            exam: {
              include: {
                course: { select: { code: true, title: true } },
                questions: {
                  orderBy: { orderIndex: "asc" },
                  include: { options: { orderBy: { orderIndex: "asc" } } },
                },
                proctoringPolicy: true,
              },
            },
          },
        }),
        prisma.proctoringPolicy.findFirst({
          where: { isInstitutionalDefault: true, examId: null },
        }),
      ]);

      if (!attempt || attempt.examId !== examId) {
        throw notFound("Exam attempt not found", "ATTEMPT_NOT_FOUND");
      }
      if (attempt.studentId !== user.id) {
        throw forbidden("You cannot access another student's exam attempt", "ATTEMPT_FORBIDDEN");
      }

      sendSuccess(
        res,
        toStudentAttemptDto({
          attempt,
          exam: attempt.exam,
          defaultPolicy,
          now: new Date(),
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.put(
    "/:examId/attempts/:attemptId/answers",
    requireCsrf,
    examAutosaveLimiter,
    validateBody(saveExamAnswerSchema),
    async (req, res, next) => {
      try {
        const user = req.auth!.user;
        const examId = req.params.examId;
        const attemptId = req.params.attemptId;
        if (!isValidUuid(examId) || !isValidUuid(attemptId)) {
          throw badRequest("Invalid identifier", "INVALID_ID");
        }

        const body = req.body as {
          questionId: string;
          selectedOptionIds: string[];
          textAnswer: string | null;
          markedForReview?: boolean;
          clientSequence: number;
          expectedRevision?: number;
        };

        const prisma = getPrismaClient();
        const saveResult = await prisma.$transaction(async (tx) => {
          const lockedRows = await tx.$queryRaw<
            Array<{
              id: string;
              examId: string;
              studentId: string;
              status: string;
              isLocked: boolean;
              expiresAt: Date;
              questionSnapshotJson: unknown;
            }>
          >`
            SELECT
              id,
              "examId",
              "studentId",
              status::text AS status,
              "isLocked",
              "expiresAt",
              "questionSnapshotJson"
            FROM "ExamAttempt"
            WHERE id = ${attemptId}::uuid
            FOR UPDATE
          `;

          const attempt = lockedRows[0];
          if (!attempt || attempt.examId !== examId) {
            throw notFound("Exam attempt not found", "ATTEMPT_NOT_FOUND");
          }
          if (attempt.studentId !== user.id) {
            throw forbidden("You cannot modify another student's attempt", "ATTEMPT_FORBIDDEN");
          }
          if (attempt.isLocked || isTerminalAttemptStatus(attempt.status)) {
            throw conflict("Attempt is locked and can no longer be modified", "ATTEMPT_LOCKED");
          }
          if (attempt.status === "PAUSED") {
            throw conflict(
              "Examination attempt is paused until proctoring media and fullscreen requirements are restored.",
              "ATTEMPT_PAUSED",
            );
          }

          const now = new Date();
          if (now >= attempt.expiresAt) {
            const finalized = await finalizeExamAttempt(
              {
                attemptId: attempt.id,
                reason: SubmissionReason.TIMER_EXPIRED,
                actorId: user.id,
                actorRole: user.role,
                ipAddress: req.ip,
                userAgent: req.get("user-agent") ?? null,
              },
              tx,
            );
            return { kind: "expired" as const, finalized };
          }

          const snapshotList = Array.isArray(attempt.questionSnapshotJson)
            ? (attempt.questionSnapshotJson as QuestionSnapshotItem[])
            : [];
          let targetQuestion = snapshotList.find((q) => q.id === body.questionId) ?? null;

          if (!targetQuestion) {
            const dbQuestion = await tx.question.findFirst({
              where: { id: body.questionId, examId },
              include: { options: true },
            });
            if (dbQuestion) {
              targetQuestion = {
                id: dbQuestion.id,
                type: dbQuestion.type as QuestionType,
                prompt: dbQuestion.prompt,
                marks: Number(dbQuestion.marks),
                negativeMarks: Number(dbQuestion.negativeMarks),
                orderIndex: dbQuestion.orderIndex,
                isRequired: dbQuestion.isRequired,
                options: dbQuestion.options.map((o) => ({
                  id: o.id,
                  label: displayLetterForOrder(o.orderIndex),
                  text: o.label,
                  orderIndex: o.orderIndex,
                })),
              };
            }
          }

          if (!targetQuestion) {
            throw badRequest("Question does not belong to this exam attempt", "INVALID_QUESTION");
          }

          const dedupedSelected = Array.from(new Set(body.selectedOptionIds));
          const validOptionIds = new Set(targetQuestion.options.map((o) => o.id));
          if (dedupedSelected.some((optId) => !validOptionIds.has(optId))) {
            throw badRequest(
              "One or more selected options do not belong to this question",
              "INVALID_OPTION_SELECTION",
            );
          }

          if (isSubjectiveQuestionType(targetQuestion.type)) {
            if (dedupedSelected.length > 0) {
              throw badRequest(
                "Subjective questions cannot accept selected option IDs",
                "INVALID_OPTION_SELECTION",
              );
            }
          } else {
            if (
              (targetQuestion.type === QuestionType.MULTIPLE_CHOICE ||
                targetQuestion.type === QuestionType.TRUE_FALSE) &&
              dedupedSelected.length > 1
            ) {
              throw badRequest(
                `${targetQuestion.type} allows at most one selected option`,
                "INVALID_OPTION_SELECTION",
              );
            }
          }

          const existingAnswer = await tx.examAnswer.findUnique({
            where: {
              attemptId_questionId: {
                attemptId: attempt.id,
                questionId: body.questionId,
              },
            },
          });

          if (existingAnswer && existingAnswer.lastClientSequence >= body.clientSequence) {
            const remainingSeconds = Math.max(
              0,
              Math.floor((attempt.expiresAt.getTime() - now.getTime()) / 1000),
            );
            return {
              kind: "saved" as const,
              payload: {
                answer: toStudentExamAnswerDto(existingAnswer),
                serverNow: now.toISOString(),
                expiresAt: attempt.expiresAt.toISOString(),
                remainingSeconds,
                attemptStatus: attempt.status as SaveExamAnswerResultDto["attemptStatus"],
                staleIgnored: true,
              } satisfies SaveExamAnswerResultDto,
            };
          }

          if (
            body.expectedRevision !== undefined &&
            existingAnswer &&
            existingAnswer.revision !== body.expectedRevision
          ) {
            throw conflict(
              "Answer revision conflict detected; reload latest saved answer state",
              "ANSWER_REVISION_CONFLICT",
              { currentAnswer: toStudentExamAnswerDto(existingAnswer) },
            );
          }

          const normalizedText = isSubjectiveQuestionType(targetQuestion.type)
            ? body.textAnswer
            : null;

          const saved = existingAnswer
            ? await tx.examAnswer.update({
                where: { id: existingAnswer.id },
                data: {
                  selectedOptionIds: dedupedSelected,
                  subjectiveText: normalizedText,
                  ...(body.markedForReview !== undefined
                    ? { markedForReview: body.markedForReview }
                    : {}),
                  revision: { increment: 1 },
                  lastClientSequence: body.clientSequence,
                  answeredAt: now,
                },
              })
            : await tx.examAnswer.create({
                data: {
                  attemptId: attempt.id,
                  questionId: body.questionId,
                  selectedOptionIds: dedupedSelected,
                  subjectiveText: normalizedText,
                  markedForReview: body.markedForReview ?? false,
                  revision: 1,
                  lastClientSequence: body.clientSequence,
                  answeredAt: now,
                },
              });

          const remainingSeconds = Math.max(
            0,
            Math.floor((attempt.expiresAt.getTime() - now.getTime()) / 1000),
          );

          return {
            kind: "saved" as const,
            payload: {
              answer: toStudentExamAnswerDto(saved),
              serverNow: now.toISOString(),
              expiresAt: attempt.expiresAt.toISOString(),
              remainingSeconds,
              attemptStatus: attempt.status as SaveExamAnswerResultDto["attemptStatus"],
              staleIgnored: false,
            } satisfies SaveExamAnswerResultDto,
          };
        });

        if (saveResult.kind === "expired") {
          emitAttemptFinalizedRealtime(saveResult.finalized);
          throw conflict(
            "Examination timer has expired; attempt has been locked and submitted",
            "ATTEMPT_EXPIRED",
            { receipt: saveResult.finalized.receipt },
          );
        }

        sendSuccess(res, saveResult.payload);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:examId/attempts/:attemptId/submit",
    requireCsrf,
    examActionLimiter,
    validateBody(submitExamAttemptSchema),
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
          select: { id: true, examId: true, studentId: true, expiresAt: true, status: true },
        });
        if (!attempt || attempt.examId !== examId) {
          throw notFound("Exam attempt not found", "ATTEMPT_NOT_FOUND");
        }
        if (attempt.studentId !== user.id) {
          throw forbidden("You cannot submit another student's exam attempt", "ATTEMPT_FORBIDDEN");
        }

        const reason =
          new Date() > attempt.expiresAt && !isTerminalAttemptStatus(attempt.status)
            ? SubmissionReason.TIMER_EXPIRED
            : SubmissionReason.MANUAL;

        const result = await finalizeExamAttempt({
          attemptId: attempt.id,
          reason,
          actorId: user.id,
          actorRole: user.role,
          ipAddress: req.ip,
          userAgent: req.get("user-agent") ?? null,
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

  router.get("/:examId/attempts/:attemptId/receipt", async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const examId = req.params.examId;
      const attemptId = req.params.attemptId;
      if (!isValidUuid(examId) || !isValidUuid(attemptId)) {
        throw badRequest("Invalid identifier", "INVALID_ID");
      }

      await expireAttemptIfDue(attemptId);
      const prisma = getPrismaClient();
      const attempt = await prisma.examAttempt.findUnique({
        where: { id: attemptId },
        include: {
          submission: true,
          answers: { select: { selectedOptionIds: true, subjectiveText: true } },
          exam: {
            select: {
              title: true,
              totalMarks: true,
              allowUnproctoredDev: true,
              course: { select: { code: true, title: true } },
              _count: { select: { questions: true } },
            },
          },
        },
      });

      if (!attempt || attempt.examId !== examId) {
        throw notFound("Exam attempt not found", "ATTEMPT_NOT_FOUND");
      }
      if (attempt.studentId !== user.id) {
        throw forbidden("You cannot view another student's submission receipt", "ATTEMPT_FORBIDDEN");
      }
      if (!attempt.submission) {
        throw conflict("Exam attempt has not been submitted yet", "ATTEMPT_NOT_SUBMITTED");
      }

      const answeredCount = attempt.answers.filter((a) => {
        const selected = Array.isArray(a.selectedOptionIds) ? a.selectedOptionIds : [];
        return (
          selected.length > 0 ||
          Boolean(a.subjectiveText && a.subjectiveText.trim().length > 0)
        );
      }).length;

      sendSuccess(
        res,
        toSubmissionReceiptDto({
          submission: attempt.submission,
          attempt,
          exam: attempt.exam,
          answeredCount,
          fallbackQuestionCount: attempt.exam._count.questions,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/:examId/attempts/:attemptId/integrity-events",
    requireCsrf,
    proctoringTelemetryLimiter,
    validateBody(recordIntegrityEventSchema),
    async (req, res, next) => {
      try {
        await handleRecordIntegrityEvent(req, res, req.params.examId);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:examId/attempts/:attemptId/heartbeat",
    requireCsrf,
    proctoringTelemetryLimiter,
    validateBody(examHeartbeatSchema),
    async (req, res, next) => {
      try {
        await handleAttemptHeartbeat(req, res, req.params.examId);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:examId/attempts/:attemptId/resume",
    requireCsrf,
    proctoringTelemetryLimiter,
    validateBody(resumeAttemptSchema),
    async (req, res, next) => {
      try {
        await handleAttemptResume(req, res, req.params.examId);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

async function verifyAttemptMatchesExamIfPresent(
  attemptId: string,
  studentId: string,
  expectedExamId?: string,
): Promise<void> {
  if (!isValidUuid(attemptId) || (expectedExamId !== undefined && !isValidUuid(expectedExamId))) {
    throw badRequest("Invalid identifier", "INVALID_ID");
  }
  if (!expectedExamId) return;

  const prisma = getPrismaClient();
  const attempt = await prisma.examAttempt.findUnique({
    where: { id: attemptId },
    select: { id: true, examId: true, studentId: true },
  });
  if (!attempt || attempt.examId !== expectedExamId) {
    throw notFound("Exam attempt not found", "ATTEMPT_NOT_FOUND");
  }
  if (attempt.studentId !== studentId) {
    throw forbidden("You cannot access another student's exam attempt", "ATTEMPT_FORBIDDEN");
  }
}

async function handleRecordIntegrityEvent(
  req: Request,
  res: Response,
  expectedExamId?: string,
): Promise<void> {
  const user = req.auth!.user;
  const attemptId = req.params.attemptId ?? "";
  await verifyAttemptMatchesExamIfPresent(attemptId, user.id, expectedExamId);

  const body = req.body as RecordIntegrityEventInput;
  const outcome = await processIntegrityEvent({
    attemptId,
    studentId: user.id,
    clientEventId: body.clientEventId,
    eventType: body.eventType,
    description: body.description,
    source: IntegrityEventSource.CLIENT,
    confidence: body.confidence,
    metadata: body.metadata,
    actorId: user.id,
    actorRole: user.role,
    ipAddress: req.ip,
    userAgent: req.get("user-agent") ?? null,
  });

  sendSuccess(res, outcome.dto);
}

async function handleAttemptHeartbeat(
  req: Request,
  res: Response,
  expectedExamId?: string,
): Promise<void> {
  const user = req.auth!.user;
  const attemptId = req.params.attemptId ?? "";
  await verifyAttemptMatchesExamIfPresent(attemptId, user.id, expectedExamId);

  const body = req.body as ExamHeartbeatInput;
  const result = await processAttemptHeartbeat({
    attemptId,
    studentId: user.id,
    input: body,
  });

  sendSuccess(res, result);
}

async function handleAttemptResume(
  req: Request,
  res: Response,
  expectedExamId?: string,
): Promise<void> {
  const user = req.auth!.user;
  const attemptId = req.params.attemptId ?? "";
  await verifyAttemptMatchesExamIfPresent(attemptId, user.id, expectedExamId);

  const body = req.body as ResumeAttemptInput;
  const result = await resumeProctoredAttempt({
    attemptId,
    studentId: user.id,
    sessionId: req.auth!.sessionId,
    input: body,
    ipAddress: req.ip,
    userAgent: req.get("user-agent") ?? null,
  });

  sendSuccess(res, result);
}

export function createStudentAttemptsRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireRoles("STUDENT"));

  router.post(
    "/:attemptId/integrity-events",
    requireCsrf,
    proctoringTelemetryLimiter,
    validateBody(recordIntegrityEventSchema),
    async (req, res, next) => {
      try {
        await handleRecordIntegrityEvent(req, res);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:attemptId/heartbeat",
    requireCsrf,
    proctoringTelemetryLimiter,
    validateBody(examHeartbeatSchema),
    async (req, res, next) => {
      try {
        await handleAttemptHeartbeat(req, res);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:attemptId/resume",
    requireCsrf,
    proctoringTelemetryLimiter,
    validateBody(resumeAttemptSchema),
    async (req, res, next) => {
      try {
        await handleAttemptResume(req, res);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
