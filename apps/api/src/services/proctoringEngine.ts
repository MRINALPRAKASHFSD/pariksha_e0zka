import crypto from "node:crypto";
import type { Prisma, UserRole } from "@prisma/client";
import {
  AttemptStatus,
  AuditAction,
  DEFAULT_PROCTORING_POLICY,
  EVENT_DEDUP_GROUPS,
  ExtensionStrikeMode,
  IntegrityEventConfidence,
  IntegrityEventSource,
  IntegrityEventType,
  IntegritySeverity,
  ScreenSurfacePolicy,
  SubmissionReason,
  type ExamHeartbeatInput,
  type ExamHeartbeatResultDto,
  type ProctoringPolicyConfig,
  type RecordIntegrityEventResultDto,
  type ResumeAttemptInput,
  type ResumeAttemptResultDto,
  type SubmitPreflightHandshakeInput,
} from "@pariksha/shared";
import { getEnv } from "../config/env.js";
import { writeAuditLog } from "../lib/audit.js";
import { hashToken } from "../lib/crypto.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { getPrismaClient } from "../lib/prisma.js";
import { getRealtimeServer } from "../lib/realtime.js";
import {
  emitAttemptFinalizedRealtime,
  finalizeExamAttempt,
  isTerminalAttemptStatus,
  type FinalizeAttemptResult,
} from "./examFinalization.js";
import {
  resolveEffectivePolicyWithMeta,
  toIntegrityEventDto,
  toStudentAttemptDto,
} from "./examSerialization.js";

const PREFLIGHT_TTL_SECONDS = 5 * 60;

export async function ensureInstitutionalDefaultPolicy(
  actorId: string,
  tx?: Prisma.TransactionClient,
) {
  const client = tx ?? getPrismaClient();
  const existing = await client.proctoringPolicy.findFirst({
    where: { isInstitutionalDefault: true, examId: null },
  });
  if (existing) return existing;

  return client.proctoringPolicy.create({
    data: {
      isInstitutionalDefault: true,
      isActive: true,
      version: 1,
      updatedById: actorId,
      ...DEFAULT_PROCTORING_POLICY,
    },
  });
}

export function hashPreflightToken(rawToken: string): string {
  const env = getEnv();
  return hashToken(rawToken, env.CSRF_SECRET);
}

export function validatePreflightSubmissionAgainstPolicy(params: {
  input: SubmitPreflightHandshakeInput;
  policy: ProctoringPolicyConfig;
  allowUnproctoredDev: boolean;
}): void {
  const { input, policy, allowUnproctoredDev } = params;
  const isProd = getEnv().NODE_ENV === "production";

  if (allowUnproctoredDev && isProd) {
    throw forbidden(
      "Development-only unproctored bypass is strictly forbidden in production.",
      "UNPROCTORED_FORBIDDEN_IN_PRODUCTION",
    );
  }

  if (!input.connectivityOk) {
    throw badRequest(
      "Live server connectivity check failed before preflight verification.",
      "PREFLIGHT_CONNECTIVITY_FAILED",
    );
  }

  if (policy.requireWebcam && input.cameraStatus !== "GRANTED") {
    throw conflict(
      "Camera permission and live video stream are required by this examination policy.",
      "PREFLIGHT_CAMERA_REQUIRED",
    );
  }

  if (policy.requireScreenShare && input.screenShareStatus !== "GRANTED") {
    throw conflict(
      "Screen sharing permission and active display video stream are required by this examination policy.",
      "PREFLIGHT_SCREEN_SHARE_REQUIRED",
    );
  }

  if (
    policy.requireScreenShare &&
    policy.allowedScreenSurface !== ScreenSurfacePolicy.ANY &&
    input.displaySurface &&
    input.displaySurface.toUpperCase() !== policy.allowedScreenSurface
  ) {
    throw conflict(
      `Examination requires "${policy.allowedScreenSurface.toLowerCase()}" screen sharing surface (reported: ${input.displaySurface}).`,
      "PREFLIGHT_SURFACE_DISALLOWED",
    );
  }

  if (policy.requireFullscreen && input.fullscreenStatus !== "GRANTED") {
    throw conflict(
      "Fullscreen mode must be active before entering this examination.",
      "PREFLIGHT_FULLSCREEN_REQUIRED",
    );
  }
}

export async function createPreflightHandshake(params: {
  examId: string;
  studentId: string;
  sessionId: string;
  input: SubmitPreflightHandshakeInput;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const prisma = getPrismaClient();
  const [exam, defaultPolicy] = await Promise.all([
    prisma.exam.findUnique({
      where: { id: params.examId },
      include: {
        course: { select: { isActive: true } },
        proctoringPolicy: true,
      },
    }),
    prisma.proctoringPolicy.findFirst({
      where: { isInstitutionalDefault: true, examId: null },
    }),
  ]);

  if (!exam) {
    throw notFound("Examination not found", "EXAM_NOT_FOUND");
  }

  const enrollment = await prisma.enrollment.findUnique({
    where: { courseId_studentId: { courseId: exam.courseId, studentId: params.studentId } },
  });
  if (!enrollment || enrollment.status !== "ACTIVE" || !exam.course.isActive) {
    throw forbidden("You are not actively enrolled in this course", "ENROLLMENT_REQUIRED");
  }

  const resolved = resolveEffectivePolicyWithMeta({
    examPolicy: exam.proctoringPolicy,
    defaultPolicy,
    allowUnproctoredDev: exam.allowUnproctoredDev,
  });

  validatePreflightSubmissionAgainstPolicy({
    input: params.input,
    policy: resolved.policy,
    allowUnproctoredDev: exam.allowUnproctoredDev,
  });

  const rawToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashPreflightToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PREFLIGHT_TTL_SECONDS * 1000);

  const created = await prisma.$transaction(async (tx) => {
    const handshake = await tx.preflightHandshake.create({
      data: {
        examId: exam.id,
        studentId: params.studentId,
        sessionId: params.sessionId,
        tokenHash,
        policyVersion: resolved.version,
        policySnapshotJson: resolved.policy as unknown as Prisma.InputJsonValue,
        cameraStatus: params.input.cameraStatus,
        screenShareStatus: params.input.screenShareStatus,
        displaySurface: params.input.displaySurface ?? null,
        fullscreenStatus: params.input.fullscreenStatus,
        connectivityOk: params.input.connectivityOk,
        consentAccepted: params.input.consentAccepted,
        expiresAt,
      },
    });

    await writeAuditLog(
      {
        actorId: params.studentId,
        actorRole: "STUDENT",
        action: AuditAction.PREFLIGHT_VERIFIED,
        entityType: "PreflightHandshake",
        entityId: handshake.id,
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
        metadata: {
          examId: exam.id,
          policyVersion: resolved.version,
          cameraStatus: params.input.cameraStatus,
          screenShareStatus: params.input.screenShareStatus,
          displaySurface: params.input.displaySurface ?? null,
          fullscreenStatus: params.input.fullscreenStatus,
        },
      },
      tx,
    );

    return handshake;
  });

  return {
    handshakeId: created.id,
    preflightToken: rawToken,
    examId: exam.id,
    policyVersion: created.policyVersion,
    expiresAt: created.expiresAt.toISOString(),
    verifiedAt: created.createdAt.toISOString(),
  };
}

export interface EvaluatedEventRule {
  enabled: boolean;
  countAsStrike: boolean;
  confidence: IntegrityEventConfidence;
  defaultDescription: string;
}

export function evaluateEventRuleUnderPolicy(
  eventType: IntegrityEventType,
  policy: ProctoringPolicyConfig,
  requestedConfidence?: string,
): EvaluatedEventRule {
  switch (eventType) {
    case IntegrityEventType.TAB_SWITCH:
      return {
        enabled: policy.detectTabSwitch,
        countAsStrike: policy.detectTabSwitch,
        confidence: IntegrityEventConfidence.OBSERVED,
        defaultDescription: "Candidate switched browser tabs or hid the exam page.",
      };
    case IntegrityEventType.WINDOW_BLUR:
      return {
        enabled: policy.detectWindowBlur,
        countAsStrike: policy.detectWindowBlur,
        confidence: IntegrityEventConfidence.OBSERVED,
        defaultDescription: "Examination window lost OS/browser focus.",
      };
    case IntegrityEventType.FULLSCREEN_EXIT:
      return {
        enabled: policy.detectFullscreenExit,
        countAsStrike: policy.detectFullscreenExit,
        confidence: IntegrityEventConfidence.OBSERVED,
        defaultDescription: "Candidate exited fullscreen examination mode.",
      };
    case IntegrityEventType.CAMERA_INTERRUPTED:
      return {
        enabled: policy.detectCameraInterruption,
        countAsStrike: policy.detectCameraInterruption,
        confidence: IntegrityEventConfidence.CLIENT_REPORTED,
        defaultDescription: "Client reported webcam stream interruption or ended track.",
      };
    case IntegrityEventType.SCREEN_SHARE_INTERRUPTED:
      return {
        enabled: policy.detectScreenShareInterruption,
        countAsStrike: policy.detectScreenShareInterruption,
        confidence: IntegrityEventConfidence.CLIENT_REPORTED,
        defaultDescription: "Client reported screen-sharing stream stopped or ended.",
      };
    case IntegrityEventType.COPY_ATTEMPT:
    case IntegrityEventType.PASTE_ATTEMPT:
    case IntegrityEventType.CUT_ATTEMPT:
      return {
        enabled: policy.restrictCopyPasteCut,
        countAsStrike: policy.restrictCopyPasteCut,
        confidence: IntegrityEventConfidence.OBSERVED,
        defaultDescription: `Prohibited clipboard shortcut or action detected (${eventType}).`,
      };
    case IntegrityEventType.CLIPBOARD_EVENT:
      return {
        enabled: policy.detectClipboard,
        countAsStrike: policy.detectClipboard,
        confidence: IntegrityEventConfidence.OBSERVED,
        defaultDescription: "Clipboard interaction detected during proctored attempt.",
      };
    case IntegrityEventType.SELECT_ALL_ATTEMPT:
      return {
        enabled: policy.restrictSelectAll,
        countAsStrike: policy.restrictSelectAll,
        confidence: IntegrityEventConfidence.OBSERVED,
        defaultDescription: "Select-all shortcut was intercepted during exam.",
      };
    case IntegrityEventType.RIGHT_CLICK_ATTEMPT:
      return {
        enabled: policy.restrictRightClick,
        countAsStrike: policy.restrictRightClick,
        confidence: IntegrityEventConfidence.OBSERVED,
        defaultDescription: "Context-menu invocation attempted during exam.",
      };
    case IntegrityEventType.EXTENSION_HEURISTIC:
      return {
        enabled: policy.detectExtensionsHeuristic,
        countAsStrike:
          policy.detectExtensionsHeuristic &&
          policy.extensionStrikeMode === ExtensionStrikeMode.STRIKE,
        confidence: IntegrityEventConfidence.HEURISTIC,
        defaultDescription:
          "Heuristic observation: unexpected extension DOM or script signal detected (not definitive proof).",
      };
    case IntegrityEventType.HEARTBEAT_MISSED:
      return {
        enabled: policy.monitorConnectionHeartbeat,
        countAsStrike: policy.monitorConnectionHeartbeat,
        confidence: IntegrityEventConfidence.SERVER_DETECTED,
        defaultDescription:
          "Server monitoring heartbeat missed past timeout and grace period (connectivity interruption).",
      };
    case IntegrityEventType.PERMISSION_DENIED:
      return {
        enabled: Boolean(policy.requireWebcam || policy.requireScreenShare),
        countAsStrike: Boolean(policy.requireWebcam || policy.requireScreenShare),
        confidence:
          (requestedConfidence as IntegrityEventConfidence) ??
          IntegrityEventConfidence.CLIENT_REPORTED,
        defaultDescription: "Required browser media permission was denied or revoked.",
      };
    default:
      return {
        enabled: false,
        countAsStrike: false,
        confidence: IntegrityEventConfidence.OBSERVED,
        defaultDescription: "Integrity telemetry recorded.",
      };
  }
}

export interface ProcessIntegrityEventInput {
  attemptId: string;
  studentId?: string;
  clientEventId: string;
  eventType: IntegrityEventType;
  description?: string;
  source?: IntegrityEventSource | string;
  confidence?: IntegrityEventConfidence | string;
  metadata?: Record<string, unknown>;
  actorId?: string | null;
  actorRole?: UserRole | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface ProcessIntegrityEventOutcome {
  dto: RecordIntegrityEventResultDto;
  examId: string;
  studentId: string;
  finalizationResult: FinalizeAttemptResult | null;
}

interface LockedAttemptForIntegrity {
  id: string;
  examId: string;
  studentId: string;
  examVersion: number;
  policyVersion: number;
  attemptNumber: number;
  status: string;
  isLocked: boolean;
  expiresAt: Date;
  startedAt: Date;
  violationCount: number;
  warningCount: number;
  strikeThreshold: number;
  pauseReason: string | null;
  mediaLossActive: boolean;
  heartbeatOutageActive: boolean;
  cameraActive: boolean;
  screenShareActive: boolean;
  fullscreenActive: boolean;
  policySnapshotJson: unknown;
}

function parseSnapshotPolicy(raw: unknown): ProctoringPolicyConfig {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_PROCTORING_POLICY };
  }
  return {
    ...DEFAULT_PROCTORING_POLICY,
    ...(raw as Partial<ProctoringPolicyConfig>),
  };
}

async function runProcessIntegrityEventTx(
  tx: Prisma.TransactionClient,
  input: ProcessIntegrityEventInput,
): Promise<ProcessIntegrityEventOutcome> {
  const lockedRows = await tx.$queryRaw<LockedAttemptForIntegrity[]>`
    SELECT
      id,
      "examId",
      "studentId",
      "examVersion",
      "policyVersion",
      "attemptNumber",
      status::text AS status,
      "isLocked",
      "expiresAt",
      "startedAt",
      "violationCount",
      "warningCount",
      "strikeThreshold",
      "pauseReason",
      "mediaLossActive",
      "heartbeatOutageActive",
      "cameraActive",
      "screenShareActive",
      "fullscreenActive",
      "policySnapshotJson"
    FROM "ExamAttempt"
    WHERE id = ${input.attemptId}::uuid
    FOR UPDATE
  `;

  const attempt = lockedRows[0];
  if (!attempt) {
    throw notFound("Exam attempt not found", "ATTEMPT_NOT_FOUND");
  }

  if (input.studentId && attempt.studentId !== input.studentId) {
    throw forbidden("You cannot submit integrity events for another student's attempt", "ATTEMPT_FORBIDDEN");
  }

  // 1) Idempotent duplicate clientEventId handling
  const existingByClientId = await tx.integrityEvent.findUnique({
    where: {
      attemptId_clientEventId: {
        attemptId: attempt.id,
        clientEventId: input.clientEventId,
      },
    },
  });

  if (existingByClientId) {
    const existingSub = await tx.examSubmission.findUnique({
      where: { attemptId: attempt.id },
      include: {
        exam: { select: { title: true, totalMarks: true, allowUnproctoredDev: true, course: { select: { code: true, title: true } }, _count: { select: { questions: true } } } },
      },
    });
    const receipt = existingSub
      ? {
          submissionId: existingSub.id,
          attemptId: attempt.id,
          examId: attempt.examId,
          examTitle: existingSub.exam.title,
          courseCode: existingSub.exam.course.code,
          courseTitle: existingSub.exam.course.title,
          examVersion: attempt.examVersion,
          attemptNumber: attempt.attemptNumber,
          receiptCode: existingSub.receiptCode,
          status: attempt.status as AttemptStatus,
          reason: existingSub.reason as SubmissionReason,
          startedAt: attempt.startedAt.toISOString(),
          submittedAt: existingSub.submittedAt.toISOString(),
          answeredCount: 0,
          totalQuestions: existingSub.exam._count.questions,
          totalMarks: Number(existingSub.exam.totalMarks),
          allowUnproctoredDev: existingSub.exam.allowUnproctoredDev,
        }
      : null;

    return {
      dto: {
        event: toIntegrityEventDto(existingByClientId),
        duplicate: true,
        deduplicated: Boolean(existingByClientId.deduplicatedIntoId),
        attemptStatus: attempt.status as AttemptStatus,
        violationCount: attempt.violationCount,
        warningCount: attempt.warningCount,
        strikeThreshold: attempt.strikeThreshold,
        remainingStrikes: Math.max(0, attempt.strikeThreshold - attempt.violationCount),
        warningIssued: false,
        autoSubmitted: isTerminalAttemptStatus(attempt.status),
        paused: attempt.status === AttemptStatus.PAUSED,
        pauseReason: attempt.pauseReason,
        receipt,
      },
      examId: attempt.examId,
      studentId: attempt.studentId,
      finalizationResult: null,
    };
  }

  // 2) Reject events on already terminal attempts
  if (attempt.isLocked || isTerminalAttemptStatus(attempt.status)) {
    throw conflict(
      "Attempt is already finalized; subsequent integrity events cannot alter submission state.",
      "ATTEMPT_LOCKED",
    );
  }

  // 3) Authoritative server expiration check before counting new strikes
  const now = new Date();
  if (now >= attempt.expiresAt) {
    const expiredFinalization = await finalizeExamAttempt(
      {
        attemptId: attempt.id,
        reason: SubmissionReason.TIMER_EXPIRED,
        actorId: input.actorId ?? attempt.studentId,
        actorRole: input.actorRole ?? "STUDENT",
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
      tx,
    );
    return {
      dto: {
        event: {
          id: existingEventPlaceholderId(),
          attemptId: attempt.id,
          examId: attempt.examId,
          studentId: attempt.studentId,
          clientEventId: input.clientEventId,
          eventType: input.eventType,
          severity: IntegritySeverity.INFO,
          source: input.source ?? IntegrityEventSource.CLIENT,
          confidence: IntegrityEventConfidence.SERVER_DETECTED,
          ruleEnabled: false,
          countedAsStrike: false,
          violationNumberAfter: attempt.violationCount,
          dedupGroupKey: EVENT_DEDUP_GROUPS[input.eventType] ?? null,
          incidentKey: null,
          deduplicatedIntoId: null,
          description: "Attempt deadline reached prior to event processing.",
          metadata: null,
          occurredAt: now.toISOString(),
          createdAt: now.toISOString(),
        },
        duplicate: false,
        deduplicated: false,
        attemptStatus: AttemptStatus.EXPIRED,
        violationCount: attempt.violationCount,
        warningCount: attempt.warningCount,
        strikeThreshold: attempt.strikeThreshold,
        remainingStrikes: Math.max(0, attempt.strikeThreshold - attempt.violationCount),
        warningIssued: false,
        autoSubmitted: true,
        paused: false,
        pauseReason: null,
        receipt: expiredFinalization.receipt,
      },
      examId: attempt.examId,
      studentId: attempt.studentId,
      finalizationResult: expiredFinalization,
    };
  }

  // 4) Evaluate rule under pinned attempt policy snapshot
  const policy = parseSnapshotPolicy(attempt.policySnapshotJson);
  const strikeThreshold = Math.max(1, attempt.strikeThreshold || policy.violationThreshold || 2);
  const rule = evaluateEventRuleUnderPolicy(input.eventType, policy, input.confidence);
  const dedupGroupKey = EVENT_DEDUP_GROUPS[input.eventType] ?? input.eventType;
  const source = input.source ?? IntegrityEventSource.CLIENT;
  const confidence = (input.confidence as IntegrityEventConfidence) ?? rule.confidence;
  const description = (input.description ?? rule.defaultDescription).slice(0, 500);

  // 5) Check deduplication within policy.dedupWindowSeconds AND active incident flags
  let deduplicatedIntoId: string | null = null;
  let isDeduplicated = false;
  let incidentKey = `${dedupGroupKey}:${now.getTime()}`;

  if (rule.countAsStrike) {
    // Same continuous media loss or same continuous heartbeat outage is one incident until recovered
    if (
      (input.eventType === IntegrityEventType.CAMERA_INTERRUPTED ||
        input.eventType === IntegrityEventType.SCREEN_SHARE_INTERRUPTED) &&
      attempt.mediaLossActive
    ) {
      const priorMediaStrike = await tx.integrityEvent.findFirst({
        where: {
          attemptId: attempt.id,
          dedupGroupKey: { in: ["CAMERA_LOSS", "SCREEN_SHARE_LOSS"] },
          countedAsStrike: true,
        },
        orderBy: { occurredAt: "desc" },
      });
      if (priorMediaStrike) {
        isDeduplicated = true;
        deduplicatedIntoId = priorMediaStrike.id;
        incidentKey = priorMediaStrike.incidentKey ?? incidentKey;
      }
    }

    if (!isDeduplicated) {
      const dedupCutoff = new Date(now.getTime() - policy.dedupWindowSeconds * 1000);
      const relatedGroups =
        dedupGroupKey === "FULLSCREEN_LOSS"
          ? ["FULLSCREEN_LOSS", "FOCUS_LOSS"]
          : dedupGroupKey === "FOCUS_LOSS"
            ? ["FOCUS_LOSS", "FULLSCREEN_LOSS"]
            : [dedupGroupKey];

      const recentRoot = await tx.integrityEvent.findFirst({
        where: {
          attemptId: attempt.id,
          countedAsStrike: true,
          dedupGroupKey: { in: relatedGroups },
          occurredAt: { gte: dedupCutoff },
        },
        orderBy: { occurredAt: "desc" },
      });

      if (recentRoot) {
        isDeduplicated = true;
        deduplicatedIntoId = recentRoot.id;
        incidentKey = recentRoot.incidentKey ?? incidentKey;
      }
    }
  }

  const countedAsStrike = rule.countAsStrike && !isDeduplicated;
  const nextViolationCount = countedAsStrike ? attempt.violationCount + 1 : attempt.violationCount;
  const reachedThreshold = countedAsStrike && nextViolationCount >= strikeThreshold;
  const warningIssued = countedAsStrike && !reachedThreshold;
  const nextWarningCount = warningIssued ? attempt.warningCount + 1 : attempt.warningCount;

  const isMediaLossEvent =
    input.eventType === IntegrityEventType.CAMERA_INTERRUPTED ||
    input.eventType === IntegrityEventType.SCREEN_SHARE_INTERRUPTED;

  const shouldPause =
    !reachedThreshold &&
    policy.pauseOnMediaLoss &&
    ((input.eventType === IntegrityEventType.CAMERA_INTERRUPTED && policy.requireWebcam) ||
      (input.eventType === IntegrityEventType.SCREEN_SHARE_INTERRUPTED &&
        policy.requireScreenShare));

  const nextStatus: AttemptStatus = reachedThreshold
    ? AttemptStatus.AUTO_SUBMITTED
    : shouldPause
      ? AttemptStatus.PAUSED
      : (attempt.status as AttemptStatus);

  const nextPauseReason = shouldPause
    ? input.eventType
    : reachedThreshold
      ? null
      : attempt.pauseReason;

  const severity: IntegritySeverity = !rule.enabled
    ? IntegritySeverity.INFO
    : !rule.countAsStrike
      ? IntegritySeverity.WARNING
      : isDeduplicated
        ? IntegritySeverity.INFO
        : reachedThreshold
          ? IntegritySeverity.CRITICAL
          : IntegritySeverity.STRIKE;

  const createdEvent = await tx.integrityEvent.create({
    data: {
      attemptId: attempt.id,
      examId: attempt.examId,
      studentId: attempt.studentId,
      clientEventId: input.clientEventId,
      eventType: input.eventType,
      severity,
      source: String(source),
      confidence: String(confidence),
      ruleEnabled: rule.enabled,
      countedAsStrike,
      violationNumberAfter: nextViolationCount,
      dedupGroupKey,
      incidentKey,
      deduplicatedIntoId,
      description,
      metadata: (input.metadata ?? null) as Prisma.InputJsonValue,
      occurredAt: now,
    },
  });

  await tx.examAttempt.update({
    where: { id: attempt.id },
    data: {
      violationCount: nextViolationCount,
      warningCount: nextWarningCount,
      ...(input.eventType === IntegrityEventType.CAMERA_INTERRUPTED
        ? { cameraActive: false, mediaLossActive: true }
        : {}),
      ...(input.eventType === IntegrityEventType.SCREEN_SHARE_INTERRUPTED
        ? { screenShareActive: false, mediaLossActive: true }
        : {}),
      ...(input.eventType === IntegrityEventType.FULLSCREEN_EXIT
        ? { fullscreenActive: false }
        : {}),
      ...(isMediaLossEvent && shouldPause
        ? {
            status: AttemptStatus.PAUSED,
            pausedAt: now,
            pauseReason: input.eventType,
          }
        : {}),
      ...(input.eventType === IntegrityEventType.HEARTBEAT_MISSED
        ? { heartbeatOutageActive: true }
        : {}),
    },
  });

  await writeAuditLog(
    {
      actorId: input.actorId ?? attempt.studentId,
      actorRole: input.actorRole ?? "STUDENT",
      action: warningIssued
        ? AuditAction.INTEGRITY_WARNING_ISSUED
        : input.eventType === IntegrityEventType.HEARTBEAT_MISSED
          ? AuditAction.HEARTBEAT_TIMEOUT_DETECTED
          : AuditAction.INTEGRITY_EVENT_RECORDED,
      entityType: "IntegrityEvent",
      entityId: createdEvent.id,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      metadata: {
        attemptId: attempt.id,
        examId: attempt.examId,
        eventType: input.eventType,
        countedAsStrike,
        isDeduplicated,
        ruleEnabled: rule.enabled,
        violationCountAfter: nextViolationCount,
        strikeThreshold,
        paused: shouldPause,
        autoSubmitted: reachedThreshold,
      },
    },
    tx,
  );

  if (input.eventType === IntegrityEventType.HEARTBEAT_MISSED && !isDeduplicated && warningIssued) {
    await writeAuditLog(
      {
        actorId: input.actorId ?? null,
        actorRole: input.actorRole ?? null,
        action: AuditAction.HEARTBEAT_TIMEOUT_DETECTED,
        entityType: "IntegrityEvent",
        entityId: createdEvent.id,
        metadata: {
          attemptId: attempt.id,
          examId: attempt.examId,
          violationCountAfter: nextViolationCount,
        },
      },
      tx,
    );
  }

  if (shouldPause && !reachedThreshold && attempt.status !== AttemptStatus.PAUSED) {
    await writeAuditLog(
      {
        actorId: input.actorId ?? attempt.studentId,
        actorRole: input.actorRole ?? "STUDENT",
        action: AuditAction.EXAM_ATTEMPT_PAUSED,
        entityType: "ExamAttempt",
        entityId: attempt.id,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        metadata: {
          examId: attempt.examId,
          pauseReason: input.eventType,
          triggeringEventId: createdEvent.id,
          violationCount: nextViolationCount,
        },
      },
      tx,
    );
  }

  let finalizationResult: FinalizeAttemptResult | null = null;
  if (reachedThreshold) {
    finalizationResult = await finalizeExamAttempt(
      {
        attemptId: attempt.id,
        reason: SubmissionReason.VIOLATION_THRESHOLD,
        actorId: input.actorId ?? attempt.studentId,
        actorRole: input.actorRole ?? "STUDENT",
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        auditMetadata: {
          triggeringEventId: createdEvent.id,
          triggeringEventType: input.eventType,
          violationCount: nextViolationCount,
          strikeThreshold,
        },
      },
      tx,
    );
  }

  return {
    dto: {
      event: toIntegrityEventDto(createdEvent),
      duplicate: false,
      deduplicated: isDeduplicated,
      attemptStatus: finalizationResult
        ? finalizationResult.receipt.status
        : nextStatus,
      violationCount: nextViolationCount,
      warningCount: nextWarningCount,
      strikeThreshold,
      remainingStrikes: Math.max(0, strikeThreshold - nextViolationCount),
      warningIssued,
      autoSubmitted: Boolean(finalizationResult),
      paused: shouldPause && !finalizationResult,
      pauseReason: nextPauseReason,
      receipt: finalizationResult ? finalizationResult.receipt : null,
    },
    examId: attempt.examId,
    studentId: attempt.studentId,
    finalizationResult,
  };
}

function existingEventPlaceholderId(): string {
  return "00000000-0000-4000-8000-000000000000";
}

export function emitProctoringOutcomeRealtime(outcome: ProcessIntegrityEventOutcome): void {
  const io = getRealtimeServer();
  if (!io) return;

  if (!outcome.dto.duplicate) {
    io.to(`attempt:${outcome.dto.event.attemptId}`)
      .to("admin:proctoring")
      .emit("proctoring:event", {
        attemptId: outcome.dto.event.attemptId,
        examId: outcome.examId,
        event: outcome.dto.event,
        violationCount: outcome.dto.violationCount,
        strikeThreshold: outcome.dto.strikeThreshold,
        attemptStatus: outcome.dto.attemptStatus,
        paused: outcome.dto.paused,
        autoSubmitted: outcome.dto.autoSubmitted,
      });

    if (outcome.dto.warningIssued) {
      io.to(`user:${outcome.studentId}`)
        .to(`attempt:${outcome.dto.event.attemptId}`)
        .emit("proctoring:warning", {
          attemptId: outcome.dto.event.attemptId,
          violationCount: outcome.dto.violationCount,
          strikeThreshold: outcome.dto.strikeThreshold,
          remainingStrikes: outcome.dto.remainingStrikes,
          eventType: outcome.dto.event.eventType,
          description: outcome.dto.event.description,
        });
    }

    if (outcome.dto.paused) {
      io.to(`user:${outcome.studentId}`)
        .to(`attempt:${outcome.dto.event.attemptId}`)
        .emit("proctoring:attempt-paused", {
          attemptId: outcome.dto.event.attemptId,
          pauseReason: outcome.dto.pauseReason,
        });
    }
  }

  if (outcome.finalizationResult) {
    emitAttemptFinalizedRealtime(outcome.finalizationResult);
  }
}

export async function processIntegrityEvent(
  input: ProcessIntegrityEventInput,
  externalTx?: Prisma.TransactionClient,
): Promise<ProcessIntegrityEventOutcome> {
  if (externalTx) {
    return runProcessIntegrityEventTx(externalTx, input);
  }

  const prisma = getPrismaClient();
  const outcome = await prisma.$transaction((tx) => runProcessIntegrityEventTx(tx, input));
  emitProctoringOutcomeRealtime(outcome);
  return outcome;
}

export async function processAttemptHeartbeat(params: {
  attemptId: string;
  studentId: string;
  input: ExamHeartbeatInput;
}): Promise<ExamHeartbeatResultDto> {
  const prisma = getPrismaClient();
  let finalizedExpired: FinalizeAttemptResult | null = null;

  const result = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<LockedAttemptForIntegrity[]>`
      SELECT
        id,
        "examId",
        "studentId",
        "examVersion",
        "policyVersion",
        "attemptNumber",
        status::text AS status,
        "isLocked",
        "expiresAt",
        "startedAt",
        "violationCount",
        "warningCount",
        "strikeThreshold",
        "pauseReason",
        "mediaLossActive",
        "heartbeatOutageActive",
        "cameraActive",
        "screenShareActive",
        "fullscreenActive",
        "policySnapshotJson"
      FROM "ExamAttempt"
      WHERE id = ${params.attemptId}::uuid
      FOR UPDATE
    `;

    const attempt = locked[0];
    if (!attempt) {
      throw notFound("Exam attempt not found", "ATTEMPT_NOT_FOUND");
    }
    if (attempt.studentId !== params.studentId) {
      throw forbidden("You cannot send heartbeat for another student's attempt", "ATTEMPT_FORBIDDEN");
    }
    if (attempt.isLocked || isTerminalAttemptStatus(attempt.status)) {
      throw conflict("Attempt is locked and finalized", "ATTEMPT_LOCKED");
    }

    const now = new Date();
    if (now >= attempt.expiresAt) {
      finalizedExpired = await finalizeExamAttempt(
        {
          attemptId: attempt.id,
          reason: SubmissionReason.TIMER_EXPIRED,
          actorId: params.studentId,
          actorRole: "STUDENT",
        },
        tx,
      );
      return {
        expired: true as const,
        dto: {
          attemptId: attempt.id,
          status: AttemptStatus.EXPIRED,
          sequence: params.input.sequence,
          serverNow: now.toISOString(),
          expiresAt: attempt.expiresAt.toISOString(),
          remainingSeconds: 0,
          paused: false,
          pauseReason: null,
          violationCount: attempt.violationCount,
          strikeThreshold: attempt.strikeThreshold,
          policyVersion: attempt.policyVersion,
        } satisfies ExamHeartbeatResultDto,
      };
    }

    const fullAttempt = await tx.examAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
      select: { lastHeartbeatSeq: true },
    });

    const policy = parseSnapshotPolicy(attempt.policySnapshotJson);
    const mediaHealthy =
      (!policy.requireWebcam || params.input.cameraActive) &&
      (!policy.requireScreenShare || params.input.screenShareActive);

    if (params.input.sequence > fullAttempt.lastHeartbeatSeq) {
      await tx.examAttempt.update({
        where: { id: attempt.id },
        data: {
          lastHeartbeatAt: now,
          lastHeartbeatSeq: params.input.sequence,
          heartbeatOutageActive: false,
          cameraActive: params.input.cameraActive,
          screenShareActive: params.input.screenShareActive,
          fullscreenActive: params.input.fullscreenActive,
          ...(mediaHealthy ? { lastMediaHeartbeatAt: now, mediaLossActive: false } : {}),
        },
      });
    } else {
      await tx.examAttempt.update({
        where: { id: attempt.id },
        data: {
          lastHeartbeatAt: now,
          heartbeatOutageActive: false,
        },
      });
    }

    const remainingSeconds = Math.max(
      0,
      Math.floor((attempt.expiresAt.getTime() - now.getTime()) / 1000),
    );

    return {
      expired: false as const,
      dto: {
        attemptId: attempt.id,
        status: attempt.status as AttemptStatus,
        sequence: Math.max(params.input.sequence, fullAttempt.lastHeartbeatSeq),
        serverNow: now.toISOString(),
        expiresAt: attempt.expiresAt.toISOString(),
        remainingSeconds,
        paused: attempt.status === AttemptStatus.PAUSED,
        pauseReason: attempt.pauseReason,
        violationCount: attempt.violationCount,
        strikeThreshold: attempt.strikeThreshold,
        policyVersion: attempt.policyVersion,
      } satisfies ExamHeartbeatResultDto,
    };
  });

  if (finalizedExpired) {
    emitAttemptFinalizedRealtime(finalizedExpired);
    throw conflict("Attempt expired prior to heartbeat", "ATTEMPT_EXPIRED", {
      receipt: (finalizedExpired as FinalizeAttemptResult).receipt,
    });
  }

  return result.dto;
}

export async function resumeProctoredAttempt(params: {
  attemptId: string;
  studentId: string;
  sessionId: string;
  input: ResumeAttemptInput;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<ResumeAttemptResultDto> {
  const prisma = getPrismaClient();
  let finalizedExpired: FinalizeAttemptResult | null = null;

  const outcome = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<LockedAttemptForIntegrity[]>`
      SELECT
        id,
        "examId",
        "studentId",
        "examVersion",
        "policyVersion",
        "attemptNumber",
        status::text AS status,
        "isLocked",
        "expiresAt",
        "startedAt",
        "violationCount",
        "warningCount",
        "strikeThreshold",
        "pauseReason",
        "mediaLossActive",
        "heartbeatOutageActive",
        "cameraActive",
        "screenShareActive",
        "fullscreenActive",
        "policySnapshotJson"
      FROM "ExamAttempt"
      WHERE id = ${params.attemptId}::uuid
      FOR UPDATE
    `;

    const attempt = locked[0];
    if (!attempt) {
      throw notFound("Exam attempt not found", "ATTEMPT_NOT_FOUND");
    }
    if (attempt.studentId !== params.studentId) {
      throw forbidden("You cannot resume another student's attempt", "ATTEMPT_FORBIDDEN");
    }
    if (attempt.isLocked || isTerminalAttemptStatus(attempt.status)) {
      throw conflict("Finalized attempts cannot be resumed", "ATTEMPT_LOCKED");
    }

    const now = new Date();
    if (now >= attempt.expiresAt) {
      finalizedExpired = await finalizeExamAttempt(
        {
          attemptId: attempt.id,
          reason: SubmissionReason.TIMER_EXPIRED,
          actorId: params.studentId,
          actorRole: "STUDENT",
          ipAddress: params.ipAddress ?? null,
          userAgent: params.userAgent ?? null,
        },
        tx,
      );
      return { expired: true as const };
    }

    const policy = parseSnapshotPolicy(attempt.policySnapshotJson);

    if (policy.requireWebcam && !params.input.cameraActive) {
      throw conflict(
        "Live camera stream must be restored before resuming the examination.",
        "CAMERA_RECOVERY_REQUIRED",
      );
    }
    if (policy.requireScreenShare && !params.input.screenShareActive) {
      throw conflict(
        "Active screen sharing must be restored before resuming the examination.",
        "SCREEN_SHARE_RECOVERY_REQUIRED",
      );
    }
    if (
      policy.requireScreenShare &&
      policy.allowedScreenSurface !== ScreenSurfacePolicy.ANY &&
      params.input.displaySurface &&
      params.input.displaySurface.toUpperCase() !== policy.allowedScreenSurface
    ) {
      throw conflict(
        `Screen share surface must match "${policy.allowedScreenSurface.toLowerCase()}".`,
        "PREFLIGHT_SURFACE_DISALLOWED",
      );
    }
    if (policy.requireFullscreen && !params.input.fullscreenActive) {
      throw conflict(
        "Fullscreen mode must be re-entered before resuming the examination.",
        "FULLSCREEN_RECOVERY_REQUIRED",
      );
    }

    await tx.examAttempt.update({
      where: { id: attempt.id },
      data: {
        status: AttemptStatus.IN_PROGRESS,
        pausedAt: null,
        pauseReason: null,
        resumedAt: now,
        lastHeartbeatAt: now,
        lastMediaHeartbeatAt: now,
        mediaLossActive: false,
        heartbeatOutageActive: false,
        cameraActive: params.input.cameraActive,
        screenShareActive: params.input.screenShareActive,
        fullscreenActive: params.input.fullscreenActive,
      },
    });

    await writeAuditLog(
      {
        actorId: params.studentId,
        actorRole: "STUDENT",
        action: AuditAction.EXAM_ATTEMPT_RESUMED,
        entityType: "ExamAttempt",
        entityId: attempt.id,
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
        metadata: {
          previousPauseReason: attempt.pauseReason,
          preservedViolationCount: attempt.violationCount,
          expiresAt: attempt.expiresAt.toISOString(),
        },
      },
      tx,
    );

    const [hydrated, defaultPolicy] = await Promise.all([
      tx.examAttempt.findUniqueOrThrow({
        where: { id: attempt.id },
        include: {
          answers: true,
          submission: true,
          integrityEvents: { orderBy: { occurredAt: "desc" }, take: 25 },
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
      tx.proctoringPolicy.findFirst({
        where: { isInstitutionalDefault: true, examId: null },
      }),
    ]);

    return {
      expired: false as const,
      dto: toStudentAttemptDto({
        attempt: hydrated,
        exam: hydrated.exam,
        defaultPolicy,
        now,
      }),
      serverNow: now.toISOString(),
    };
  });

  if (outcome.expired && finalizedExpired) {
    emitAttemptFinalizedRealtime(finalizedExpired);
    throw conflict(
      "Examination deadline expired while paused; attempt has been locked and submitted.",
      "ATTEMPT_EXPIRED",
      { receipt: (finalizedExpired as FinalizeAttemptResult).receipt },
    );
  }

  return {
    attempt: outcome.dto!,
    serverNow: outcome.serverNow!,
  };
}
