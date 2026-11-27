import { Router, type NextFunction, type Request, type Response } from "express";
import type { Prisma } from "@prisma/client";
import {
  AuditAction,
  DEFAULT_PROCTORING_POLICY,
  adminProctoringAttemptsQuerySchema,
  adminProctoringEventsQuerySchema,
  adminUpdateProctoringPolicySchema,
  type AdminProctoringAttemptItemDto,
  type ApiSuccessResponse,
  type ExamProctoringPolicyStateDto,
  type IntegrityEventDto,
  type PaginatedResult,
  type ProctoringPolicyRecordDto,
} from "@pariksha/shared";
import { writeAuditLog } from "../lib/audit.js";
import { badRequest, notFound } from "../lib/errors.js";
import { getPrismaClient } from "../lib/prisma.js";
import { requireAuth, requireCsrf, requireRoles } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/errorAndValidation.js";
import {
  isValidUuid,
  resolveEffectivePolicyWithMeta,
  toIntegrityEventDto,
  toProctoringPolicyRecordDto,
} from "../services/examSerialization.js";
import { ensureInstitutionalDefaultPolicy } from "../services/proctoringEngine.js";
import { neutralizeCsvFormula } from "../services/questionImportExport.js";

function sendSuccess<T>(res: Response, data: T, status = 200): void {
  res.setHeader("Cache-Control", "no-store, private");
  const payload: ApiSuccessResponse<T> = {
    success: true,
    data,
    requestId: res.locals.requestId as string | undefined,
  };
  res.status(status).json(payload);
}

function escapeCsvCell(value: string): string {
  const safe = neutralizeCsvFormula(value);
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export const MEDIA_STATUS_DISCLAIMER =
  "Media indicators reflect browser client-reported track telemetry only; ordinary web applications cannot independently guarantee physical camera/screen integrity.";

export async function getExamProctoringPolicyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = req.auth!.user;
    const examId = req.params.examId ?? "";
    if (!isValidUuid(examId)) {
      throw badRequest("Invalid exam identifier", "INVALID_ID");
    }

    const prisma = getPrismaClient();
    const [exam, defaultPolicy] = await Promise.all([
      prisma.exam.findUnique({
        where: { id: examId },
        include: {
          course: { select: { code: true } },
          proctoringPolicy: true,
        },
      }),
      ensureInstitutionalDefaultPolicy(user.id),
    ]);
    if (!exam) {
      throw notFound("Examination not found", "EXAM_NOT_FOUND");
    }

    const resolved = resolveEffectivePolicyWithMeta({
      examPolicy: exam.proctoringPolicy,
      defaultPolicy,
      allowUnproctoredDev: exam.allowUnproctoredDev,
    });

    const dto: ExamProctoringPolicyStateDto = {
      examId: exam.id,
      examTitle: exam.title,
      courseCode: exam.course.code,
      inheritedFromDefault: resolved.inheritedFromDefault,
      defaultPolicy: toProctoringPolicyRecordDto(defaultPolicy),
      examOverride: exam.proctoringPolicy
        ? toProctoringPolicyRecordDto(exam.proctoringPolicy)
        : null,
      effectivePolicy: resolved.policy,
      effectivePolicyVersion: resolved.version,
    };
    sendSuccess(res, dto);
  } catch (error) {
    next(error);
  }
}

export async function updateExamProctoringPolicyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = req.auth!.user;
    const examId = req.params.examId ?? "";
    if (!isValidUuid(examId)) {
      throw badRequest("Invalid exam identifier", "INVALID_ID");
    }

    const prisma = getPrismaClient();
    const updates = req.body as Record<string, unknown>;

    const result = await prisma.$transaction(async (tx) => {
      const exam = await tx.exam.findUnique({
        where: { id: examId },
        include: {
          course: { select: { code: true } },
          proctoringPolicy: true,
        },
      });
      if (!exam) {
        throw notFound("Examination not found", "EXAM_NOT_FOUND");
      }
      const defaultPolicy = await ensureInstitutionalDefaultPolicy(user.id, tx);

      const baseConfig = exam.proctoringPolicy ?? defaultPolicy;
      const nextTimeout =
        (updates.heartbeatTimeoutSeconds as number | undefined) ?? baseConfig.heartbeatTimeoutSeconds;
      const nextInterval =
        (updates.heartbeatIntervalSeconds as number | undefined) ??
        baseConfig.heartbeatIntervalSeconds;
      if (nextTimeout < nextInterval) {
        throw badRequest(
          "Heartbeat timeout must be >= heartbeat interval",
          "INVALID_POLICY_CONFIG",
        );
      }

      const savedOverride = exam.proctoringPolicy
        ? await tx.proctoringPolicy.update({
            where: { id: exam.proctoringPolicy.id },
            data: {
              ...(updates as Prisma.ProctoringPolicyUncheckedUpdateInput),
              updatedById: user.id,
              version: { increment: 1 },
            },
          })
        : await tx.proctoringPolicy.create({
            data: {
              examId: exam.id,
              isInstitutionalDefault: false,
              updatedById: user.id,
              version: 1,
              requireWebcam: defaultPolicy.requireWebcam,
              requireScreenShare: defaultPolicy.requireScreenShare,
              requireFullscreen: defaultPolicy.requireFullscreen,
              allowedScreenSurface: defaultPolicy.allowedScreenSurface,
              detectTabSwitch: defaultPolicy.detectTabSwitch,
              detectWindowBlur: defaultPolicy.detectWindowBlur,
              detectFullscreenExit: defaultPolicy.detectFullscreenExit,
              detectCameraInterruption: defaultPolicy.detectCameraInterruption,
              detectScreenShareInterruption: defaultPolicy.detectScreenShareInterruption,
              restrictCopyPasteCut: defaultPolicy.restrictCopyPasteCut,
              restrictSelectAll: defaultPolicy.restrictSelectAll,
              restrictRightClick: defaultPolicy.restrictRightClick,
              restrictTextSelection: defaultPolicy.restrictTextSelection,
              detectClipboard: defaultPolicy.detectClipboard,
              detectExtensionsHeuristic: defaultPolicy.detectExtensionsHeuristic,
              extensionStrikeMode: defaultPolicy.extensionStrikeMode,
              monitorConnectionHeartbeat: defaultPolicy.monitorConnectionHeartbeat,
              monitorMediaHeartbeat: defaultPolicy.monitorMediaHeartbeat,
              heartbeatIntervalSeconds: defaultPolicy.heartbeatIntervalSeconds,
              heartbeatTimeoutSeconds: defaultPolicy.heartbeatTimeoutSeconds,
              heartbeatGraceSeconds: defaultPolicy.heartbeatGraceSeconds,
              mediaGraceSeconds: defaultPolicy.mediaGraceSeconds,
              dedupWindowSeconds: defaultPolicy.dedupWindowSeconds,
              violationThreshold: defaultPolicy.violationThreshold,
              pauseOnMediaLoss: defaultPolicy.pauseOnMediaLoss,
              ...(updates as Record<string, unknown>),
            },
          });

      await writeAuditLog(
        {
          actorId: user.id,
          actorRole: user.role,
          action: AuditAction.PROCTORING_EXAM_POLICY_UPDATED,
          entityType: "ProctoringPolicy",
          entityId: savedOverride.id,
          ipAddress: req.ip,
          userAgent: req.get("user-agent") ?? null,
          metadata: {
            examId: exam.id,
            version: savedOverride.version,
            updatedFields: Object.keys(updates),
          },
        },
        tx,
      );

      const resolved = resolveEffectivePolicyWithMeta({
        examPolicy: savedOverride,
        defaultPolicy,
        allowUnproctoredDev: exam.allowUnproctoredDev,
      });

      return {
        examId: exam.id,
        examTitle: exam.title,
        courseCode: exam.course.code,
        inheritedFromDefault: resolved.inheritedFromDefault,
        defaultPolicy: toProctoringPolicyRecordDto(defaultPolicy),
        examOverride: toProctoringPolicyRecordDto(savedOverride),
        effectivePolicy: resolved.policy,
        effectivePolicyVersion: resolved.version,
      } satisfies ExamProctoringPolicyStateDto;
    });

    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function resetExamProctoringPolicyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = req.auth!.user;
    const examId = req.params.examId ?? "";
    if (!isValidUuid(examId)) {
      throw badRequest("Invalid exam identifier", "INVALID_ID");
    }

    const prisma = getPrismaClient();
    const result = await prisma.$transaction(async (tx) => {
      const exam = await tx.exam.findUnique({
        where: { id: examId },
        include: {
          course: { select: { code: true } },
          proctoringPolicy: true,
        },
      });
      if (!exam) {
        throw notFound("Examination not found", "EXAM_NOT_FOUND");
      }
      const defaultPolicy = await ensureInstitutionalDefaultPolicy(user.id, tx);

      if (exam.proctoringPolicy) {
        await tx.proctoringPolicy.delete({ where: { id: exam.proctoringPolicy.id } });
      }

      await writeAuditLog(
        {
          actorId: user.id,
          actorRole: user.role,
          action: AuditAction.PROCTORING_EXAM_POLICY_RESET,
          entityType: "Exam",
          entityId: exam.id,
          ipAddress: req.ip,
          userAgent: req.get("user-agent") ?? null,
        },
        tx,
      );

      const resolved = resolveEffectivePolicyWithMeta({
        examPolicy: null,
        defaultPolicy,
        allowUnproctoredDev: exam.allowUnproctoredDev,
      });

      return {
        examId: exam.id,
        examTitle: exam.title,
        courseCode: exam.course.code,
        inheritedFromDefault: resolved.inheritedFromDefault,
        defaultPolicy: toProctoringPolicyRecordDto(defaultPolicy),
        examOverride: null,
        effectivePolicy: resolved.policy,
        effectivePolicyVersion: resolved.version,
      } satisfies ExamProctoringPolicyStateDto;
    });

    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export function createAdminProctoringRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireRoles("ADMIN"));

  router.get("/policies", async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const prisma = getPrismaClient();
      const defaultPolicy = await ensureInstitutionalDefaultPolicy(user.id);
      const examOverrides = await prisma.proctoringPolicy.findMany({
        where: { isInstitutionalDefault: false, examId: { not: null } },
        orderBy: { updatedAt: "desc" },
        include: {
          exam: {
            select: {
              id: true,
              title: true,
              status: true,
              allowUnproctoredDev: true,
              course: { select: { code: true, title: true } },
            },
          },
        },
      });

      sendSuccess(res, {
        defaultPolicy: toProctoringPolicyRecordDto(defaultPolicy),
        examPolicies: examOverrides.map((p) => ({
          ...toProctoringPolicyRecordDto(p),
          exam: p.exam,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/default-policy", async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const policy = await ensureInstitutionalDefaultPolicy(user.id);
      sendSuccess<ProctoringPolicyRecordDto>(res, toProctoringPolicyRecordDto(policy));
    } catch (error) {
      next(error);
    }
  });

  router.patch(
    "/default-policy",
    requireCsrf,
    validateBody(adminUpdateProctoringPolicySchema),
    async (req, res, next) => {
      try {
        const user = req.auth!.user;
        const prisma = getPrismaClient();
        const updates = req.body as Record<string, unknown>;

        const updated = await prisma.$transaction(async (tx) => {
          const existing = await ensureInstitutionalDefaultPolicy(user.id, tx);
          const nextTimeout =
            (updates.heartbeatTimeoutSeconds as number | undefined) ?? existing.heartbeatTimeoutSeconds;
          const nextInterval =
            (updates.heartbeatIntervalSeconds as number | undefined) ??
            existing.heartbeatIntervalSeconds;
          if (nextTimeout < nextInterval) {
            throw badRequest(
              "Heartbeat timeout must be >= heartbeat interval",
              "INVALID_POLICY_CONFIG",
            );
          }

          const ruleUpdates = { ...updates };
          delete ruleUpdates.isActive;
          const saved = await tx.proctoringPolicy.update({
            where: { id: existing.id },
            data: {
              ...(ruleUpdates as Prisma.ProctoringPolicyUncheckedUpdateInput),
              updatedById: user.id,
              version: { increment: 1 },
            },
          });

          await writeAuditLog(
            {
              actorId: user.id,
              actorRole: user.role,
              action: AuditAction.PROCTORING_DEFAULT_POLICY_UPDATED,
              entityType: "ProctoringPolicy",
              entityId: saved.id,
              ipAddress: req.ip,
              userAgent: req.get("user-agent") ?? null,
              metadata: {
                version: saved.version,
                updatedFields: Object.keys(updates),
                violationThreshold: saved.violationThreshold,
              },
            },
            tx,
          );

          return saved;
        });

        sendSuccess<ProctoringPolicyRecordDto>(res, toProctoringPolicyRecordDto(updated));
      } catch (error) {
        next(error);
      }
    },
  );

  router.post("/default-policy/restore", requireCsrf, async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const prisma = getPrismaClient();

      const restored = await prisma.$transaction(async (tx) => {
        const existing = await ensureInstitutionalDefaultPolicy(user.id, tx);
        const saved = await tx.proctoringPolicy.update({
          where: { id: existing.id },
          data: {
            ...DEFAULT_PROCTORING_POLICY,
            isActive: true,
            updatedById: user.id,
            version: { increment: 1 },
          },
        });

        await writeAuditLog(
          {
            actorId: user.id,
            actorRole: user.role,
            action: AuditAction.PROCTORING_DEFAULT_POLICY_UPDATED,
            entityType: "ProctoringPolicy",
            entityId: saved.id,
            ipAddress: req.ip,
            userAgent: req.get("user-agent") ?? null,
            metadata: { restoredDefaults: true, version: saved.version },
          },
          tx,
        );

        return saved;
      });

      sendSuccess<ProctoringPolicyRecordDto>(res, toProctoringPolicyRecordDto(restored));
    } catch (error) {
      next(error);
    }
  });

  router.get("/exams/:examId/policy", getExamProctoringPolicyHandler);

  router.patch(
    "/exams/:examId/policy",
    requireCsrf,
    validateBody(adminUpdateProctoringPolicySchema),
    updateExamProctoringPolicyHandler,
  );

  router.post("/exams/:examId/policy/reset", requireCsrf, resetExamProctoringPolicyHandler);

  router.get("/attempts", validateQuery(adminProctoringAttemptsQuerySchema), async (_req, res, next) => {
    try {
      const query = res.locals.validatedQuery as {
        page: number;
        pageSize: number;
        search?: string;
        examId?: string;
        status?: "IN_PROGRESS" | "PAUSED" | "SUBMITTED" | "AUTO_SUBMITTED" | "EXPIRED" | "TERMINATED";
      };
      const prisma = getPrismaClient();

      const where: Prisma.ExamAttemptWhereInput = {
        ...(query.examId ? { examId: query.examId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.search
          ? {
              OR: [
                { student: { fullName: { contains: query.search, mode: "insensitive" } } },
                { student: { email: { contains: query.search, mode: "insensitive" } } },
                { exam: { title: { contains: query.search, mode: "insensitive" } } },
                { exam: { course: { code: { contains: query.search, mode: "insensitive" } } } },
              ],
            }
          : {}),
      };

      const [total, attempts] = await Promise.all([
        prisma.examAttempt.count({ where }),
        prisma.examAttempt.findMany({
          where,
          orderBy: [{ updatedAt: "desc" }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          include: {
            student: { select: { id: true, fullName: true, email: true, status: true } },
            exam: {
              select: {
                id: true,
                title: true,
                allowUnproctoredDev: true,
                course: { select: { code: true } },
              },
            },
          },
        }),
      ]);

      const items: AdminProctoringAttemptItemDto[] = attempts.map((a) => ({
        id: a.id,
        examId: a.examId,
        examTitle: a.exam.title,
        courseCode: a.exam.course.code,
        examVersion: a.examVersion,
        policyVersion: a.policyVersion,
        attemptNumber: a.attemptNumber,
        status: a.status,
        finalizationReason: a.finalizationReason,
        pauseReason: a.pauseReason,
        violationCount: a.violationCount,
        warningCount: a.warningCount,
        strikeThreshold: a.strikeThreshold,
        cameraActive: a.cameraActive,
        screenShareActive: a.screenShareActive,
        fullscreenActive: a.fullscreenActive,
        allowUnproctoredDev: a.exam.allowUnproctoredDev,
        lastHeartbeatAt: a.lastHeartbeatAt.toISOString(),
        lastMediaHeartbeatAt: a.lastMediaHeartbeatAt ? a.lastMediaHeartbeatAt.toISOString() : null,
        startedAt: a.startedAt.toISOString(),
        expiresAt: a.expiresAt.toISOString(),
        submittedAt: a.submittedAt ? a.submittedAt.toISOString() : null,
        mediaStatusDisclaimer: MEDIA_STATUS_DISCLAIMER,
        student: {
          id: a.student.id,
          fullName: a.student.fullName,
          email: a.student.email,
          status: a.student.status,
        },
      }));

      const result = {
        items,
        total,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        mediaStatusDisclaimer: MEDIA_STATUS_DISCLAIMER,
      };
      sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/attempts/:attemptId/events", async (req, res, next) => {
    try {
      const attemptId = req.params.attemptId;
      if (!isValidUuid(attemptId)) {
        throw badRequest("Invalid attempt identifier", "INVALID_ID");
      }
      const prisma = getPrismaClient();
      const attempt = await prisma.examAttempt.findUnique({ where: { id: attemptId } });
      if (!attempt) {
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
      sendSuccess<IntegrityEventDto[]>(res, events.map(toIntegrityEventDto));
    } catch (error) {
      next(error);
    }
  });

  function buildEventsWhere(query: {
    search?: string;
    examId?: string;
    attemptId?: string;
    studentId?: string;
    eventType?: string;
    severity?: string;
    from?: string;
    to?: string;
  }): Prisma.IntegrityEventWhereInput {
    return {
      ...(query.examId ? { examId: query.examId } : {}),
      ...(query.attemptId ? { attemptId: query.attemptId } : {}),
      ...(query.studentId ? { studentId: query.studentId } : {}),
      ...(query.eventType ? { eventType: query.eventType as Prisma.EnumIntegrityEventTypeFilter } : {}),
      ...(query.severity ? { severity: query.severity as Prisma.EnumIntegritySeverityFilter } : {}),
      ...(query.from || query.to
        ? {
            occurredAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { description: { contains: query.search, mode: "insensitive" } },
              { student: { fullName: { contains: query.search, mode: "insensitive" } } },
              { student: { email: { contains: query.search, mode: "insensitive" } } },
              { exam: { title: { contains: query.search, mode: "insensitive" } } },
            ],
          }
        : {}),
    };
  }

  router.get("/events", validateQuery(adminProctoringEventsQuerySchema), async (_req, res, next) => {
    try {
      const query = res.locals.validatedQuery as {
        page: number;
        pageSize: number;
        search?: string;
        examId?: string;
        attemptId?: string;
        studentId?: string;
        eventType?: string;
        severity?: string;
        from?: string;
        to?: string;
      };
      const prisma = getPrismaClient();
      const where = buildEventsWhere(query);

      const [total, events] = await Promise.all([
        prisma.integrityEvent.count({ where }),
        prisma.integrityEvent.findMany({
          where,
          orderBy: { occurredAt: "desc" },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          include: {
            exam: { select: { title: true, course: { select: { code: true } } } },
            student: { select: { fullName: true, email: true } },
          },
        }),
      ]);

      sendSuccess<PaginatedResult<IntegrityEventDto>>(res, {
        items: events.map(toIntegrityEventDto),
        total,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get(
    "/events/export",
    validateQuery(adminProctoringEventsQuerySchema),
    async (req, res, next) => {
      try {
        const user = req.auth!.user;
        const query = res.locals.validatedQuery as {
          search?: string;
          examId?: string;
          attemptId?: string;
          studentId?: string;
          eventType?: string;
          severity?: string;
          from?: string;
          to?: string;
        };
        const prisma = getPrismaClient();
        const where = buildEventsWhere(query);

        const events = await prisma.integrityEvent.findMany({
          where,
          orderBy: { occurredAt: "desc" },
          take: 5000,
          include: {
            exam: { select: { title: true, course: { select: { code: true } } } },
            student: { select: { fullName: true, email: true } },
          },
        });

        await writeAuditLog({
          actorId: user.id,
          actorRole: user.role,
          action: AuditAction.PROCTORING_EVENTS_EXPORTED,
          entityType: "IntegrityEvent",
          ipAddress: req.ip,
          userAgent: req.get("user-agent") ?? null,
          metadata: { exportedCount: events.length, filters: query },
        });

        const header =
          "occurredAt,courseCode,examTitle,studentName,studentEmail,attemptId,eventType,severity,source,confidence,countedAsStrike,violationNumberAfter,deduplicatedIntoId,description";
        const rows = events.map((ev) =>
          [
            escapeCsvCell(ev.occurredAt.toISOString()),
            escapeCsvCell(ev.exam.course.code),
            escapeCsvCell(ev.exam.title),
            escapeCsvCell(ev.student.fullName),
            escapeCsvCell(ev.student.email),
            escapeCsvCell(ev.attemptId),
            escapeCsvCell(ev.eventType),
            escapeCsvCell(ev.severity),
            escapeCsvCell(ev.source),
            escapeCsvCell(ev.confidence),
            String(ev.countedAsStrike),
            ev.violationNumberAfter !== null ? String(ev.violationNumberAfter) : "",
            escapeCsvCell(ev.deduplicatedIntoId ?? ""),
            escapeCsvCell(ev.description),
          ].join(","),
        );

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="pariksha-integrity-events.csv"',
        );
        res.setHeader("Cache-Control", "no-store");
        res.status(200).send([header, ...rows].join("\n"));
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
