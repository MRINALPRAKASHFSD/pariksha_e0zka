import crypto from "node:crypto";
import type {
  Exam,
  ExamAnswer,
  ExamAttempt,
  ExamSubmission,
  IntegrityEvent,
  Prisma,
  ProctoringPolicy,
  Question,
  QuestionOption,
} from "@prisma/client";
import {
  DEFAULT_PROCTORING_POLICY,
  UNPROCTORED_DEV_POLICY,
  requiresMandatoryProctoring,
  type AttemptStatus,
  type ExamAttemptSummaryDto,
  type ExamDetailDto,
  type ExamStatus,
  type ExamSubmissionReceiptDto,
  type ExamSummaryDto,
  type ExtensionStrikeMode,
  type IntegrityEventDto,
  type IntegrityEventType,
  type IntegritySeverity,
  type ProctoringPolicyConfig,
  type ProctoringPolicyRecordDto,
  type ProctoringPreflightStatus,
  type QuestionDto,
  type QuestionOptionDto,
  type QuestionType,
  type ScreenSurfacePolicy,
  type StudentExamAnswerDto,
  type StudentExamAttemptDto,
  type StudentQuestionDto,
  type SubmissionReason,
  type UserStatus,
} from "@pariksha/shared";
import { getEnv } from "../config/env.js";

export interface QuestionSnapshotItem {
  id: string;
  type: QuestionType;
  prompt: string;
  marks: number;
  negativeMarks: number;
  orderIndex: number;
  isRequired: boolean;
  options: Array<{
    id: string;
    label: string;
    text: string;
    orderIndex: number;
  }>;
}

export interface AnswerKeySnapshotItem {
  questionId: string;
  type: QuestionType;
  marks: number;
  negativeMarks: number;
  isRequired: boolean;
  correctOptionIds: string[];
}

export function isValidUuid(id: string | undefined): id is string {
  return (
    typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  );
}

export function displayLetterForOrder(orderIndex: number): string {
  if (orderIndex >= 1 && orderIndex <= 26) {
    return String.fromCharCode(64 + orderIndex);
  }
  return String(orderIndex);
}

export function policyModelToConfig(source: ProctoringPolicy): ProctoringPolicyConfig {
  return {
    requireWebcam: source.requireWebcam,
    requireScreenShare: source.requireScreenShare,
    requireFullscreen: source.requireFullscreen,
    allowedScreenSurface: source.allowedScreenSurface as ScreenSurfacePolicy,
    detectTabSwitch: source.detectTabSwitch,
    detectWindowBlur: source.detectWindowBlur,
    detectFullscreenExit: source.detectFullscreenExit,
    detectCameraInterruption: source.detectCameraInterruption,
    detectScreenShareInterruption: source.detectScreenShareInterruption,
    restrictCopyPasteCut: source.restrictCopyPasteCut,
    restrictSelectAll: source.restrictSelectAll,
    restrictRightClick: source.restrictRightClick,
    restrictTextSelection: source.restrictTextSelection,
    detectClipboard: source.detectClipboard,
    detectExtensionsHeuristic: source.detectExtensionsHeuristic,
    extensionStrikeMode: source.extensionStrikeMode as ExtensionStrikeMode,
    monitorConnectionHeartbeat: source.monitorConnectionHeartbeat,
    monitorMediaHeartbeat: source.monitorMediaHeartbeat,
    heartbeatIntervalSeconds: source.heartbeatIntervalSeconds,
    heartbeatTimeoutSeconds: source.heartbeatTimeoutSeconds,
    heartbeatGraceSeconds: source.heartbeatGraceSeconds,
    mediaGraceSeconds: source.mediaGraceSeconds,
    dedupWindowSeconds: source.dedupWindowSeconds,
    violationThreshold: source.violationThreshold,
    pauseOnMediaLoss: source.pauseOnMediaLoss,
  };
}

export function toProctoringPolicyRecordDto(policy: ProctoringPolicy): ProctoringPolicyRecordDto {
  return {
    ...policyModelToConfig(policy),
    id: policy.id,
    examId: policy.examId,
    isInstitutionalDefault: policy.isInstitutionalDefault,
    isActive: policy.isActive,
    version: policy.version,
    updatedById: policy.updatedById,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
  };
}

export function toIntegrityEventDto(
  event: IntegrityEvent & {
    exam?: { title: string; course: { code: string } };
    student?: { fullName: string; email: string };
  },
): IntegrityEventDto {
  return {
    id: event.id,
    attemptId: event.attemptId,
    examId: event.examId,
    ...(event.exam ? { examTitle: event.exam.title, courseCode: event.exam.course.code } : {}),
    studentId: event.studentId,
    ...(event.student
      ? { studentName: event.student.fullName, studentEmail: event.student.email }
      : {}),
    clientEventId: event.clientEventId,
    eventType: event.eventType as IntegrityEventType,
    severity: event.severity as IntegritySeverity,
    source: event.source,
    confidence: event.confidence,
    ruleEnabled: event.ruleEnabled,
    countedAsStrike: event.countedAsStrike,
    violationNumberAfter: event.violationNumberAfter,
    dedupGroupKey: event.dedupGroupKey,
    incidentKey: event.incidentKey,
    deduplicatedIntoId: event.deduplicatedIntoId,
    description: event.description,
    metadata: event.metadata,
    occurredAt: event.occurredAt.toISOString(),
    createdAt: event.createdAt.toISOString(),
  };
}

export function resolveEffectivePolicyWithMeta(params: {
  examPolicy?: ProctoringPolicy | null;
  defaultPolicy?: ProctoringPolicy | null;
  allowUnproctoredDev: boolean;
}): {
  policy: ProctoringPolicyConfig;
  version: number;
  inheritedFromDefault: boolean;
} {
  const isProd = getEnv().NODE_ENV === "production";
  if (params.allowUnproctoredDev && !isProd) {
    if (
      params.examPolicy &&
      params.examPolicy.isActive &&
      !requiresMandatoryProctoring(policyModelToConfig(params.examPolicy))
    ) {
      return {
        policy: policyModelToConfig(params.examPolicy),
        version: params.examPolicy.version,
        inheritedFromDefault: false,
      };
    }
    return {
      policy: { ...UNPROCTORED_DEV_POLICY },
      version: params.examPolicy?.version ?? 1,
      inheritedFromDefault: false,
    };
  }

  if (params.examPolicy && params.examPolicy.isActive) {
    return {
      policy: policyModelToConfig(params.examPolicy),
      version: params.examPolicy.version,
      inheritedFromDefault: false,
    };
  }

  if (params.defaultPolicy) {
    return {
      policy: policyModelToConfig(params.defaultPolicy),
      version: params.defaultPolicy.version,
      inheritedFromDefault: true,
    };
  }

  return {
    policy: { ...DEFAULT_PROCTORING_POLICY },
    version: 1,
    inheritedFromDefault: true,
  };
}

export function resolveEffectiveProctoringPolicy(params: {
  examPolicy?: ProctoringPolicy | null;
  defaultPolicy?: ProctoringPolicy | null;
  allowUnproctoredDev: boolean;
}): ProctoringPolicyConfig {
  return resolveEffectivePolicyWithMeta(params).policy;
}

export function evaluateProctoringPreflight(
  allowUnproctoredDev: boolean,
  policy: ProctoringPolicyConfig,
): ProctoringPreflightStatus {
  const isProd = getEnv().NODE_ENV === "production";
  const mandatoryProctoring = requiresMandatoryProctoring(policy);

  if (allowUnproctoredDev && isProd) {
    return {
      mode: "PROCTORED_REQUIRED",
      proctoringEngineImplemented: true,
      canStartAttempt: false,
      requiresPreflightHandshake: true,
      blockingCode: "UNPROCTORED_FORBIDDEN_IN_PRODUCTION",
      blockingMessage:
        "Development-only unproctored examination mode is strictly disabled in production environments.",
      bannerLabel: "Unproctored bypass disabled in production",
      requirements: {
        requireWebcam: policy.requireWebcam,
        requireScreenShare: policy.requireScreenShare,
        requireFullscreen: policy.requireFullscreen,
        allowedScreenSurface: policy.allowedScreenSurface,
        violationThreshold: policy.violationThreshold,
        heartbeatIntervalSeconds: policy.heartbeatIntervalSeconds,
        heartbeatTimeoutSeconds: policy.heartbeatTimeoutSeconds,
        heartbeatGraceSeconds: policy.heartbeatGraceSeconds,
        mediaGraceSeconds: policy.mediaGraceSeconds,
        pauseOnMediaLoss: policy.pauseOnMediaLoss,
      },
    };
  }

  if (allowUnproctoredDev && !mandatoryProctoring && !isProd) {
    return {
      mode: "UNPROCTORED_DEV",
      proctoringEngineImplemented: true,
      canStartAttempt: true,
      requiresPreflightHandshake: false,
      blockingCode: null,
      blockingMessage: null,
      bannerLabel:
        "Development-only unproctored examination mode (disabled automatically in production)",
      requirements: {
        requireWebcam: false,
        requireScreenShare: false,
        requireFullscreen: false,
        allowedScreenSurface: policy.allowedScreenSurface,
        violationThreshold: policy.violationThreshold,
        heartbeatIntervalSeconds: policy.heartbeatIntervalSeconds,
        heartbeatTimeoutSeconds: policy.heartbeatTimeoutSeconds,
        heartbeatGraceSeconds: policy.heartbeatGraceSeconds,
        mediaGraceSeconds: policy.mediaGraceSeconds,
        pauseOnMediaLoss: policy.pauseOnMediaLoss,
      },
    };
  }

  return {
    mode: "PROCTORED_REQUIRED",
    proctoringEngineImplemented: true,
    canStartAttempt: true,
    requiresPreflightHandshake: true,
    blockingCode: null,
    blockingMessage: null,
    bannerLabel: `Monitored examination (${policy.violationThreshold}-strike policy; mandatory preflight verification required)`,
    requirements: {
      requireWebcam: policy.requireWebcam,
      requireScreenShare: policy.requireScreenShare,
      requireFullscreen: policy.requireFullscreen,
      allowedScreenSurface: policy.allowedScreenSurface,
      violationThreshold: policy.violationThreshold,
      heartbeatIntervalSeconds: policy.heartbeatIntervalSeconds,
      heartbeatTimeoutSeconds: policy.heartbeatTimeoutSeconds,
      heartbeatGraceSeconds: policy.heartbeatGraceSeconds,
      mediaGraceSeconds: policy.mediaGraceSeconds,
      pauseOnMediaLoss: policy.pauseOnMediaLoss,
    },
  };
}

export function toQuestionOptionDto(option: QuestionOption): QuestionOptionDto {
  return {
    id: option.id,
    label: displayLetterForOrder(option.orderIndex),
    text: option.label,
    isCorrect: option.isCorrect,
    orderIndex: option.orderIndex,
  };
}

export function toQuestionDto(
  question: Question & { options: QuestionOption[] },
): QuestionDto {
  return {
    id: question.id,
    examId: question.examId,
    type: question.type as QuestionType,
    prompt: question.prompt,
    explanation: question.explanation,
    marks: Number(question.marks),
    negativeMarks: Number(question.negativeMarks),
    orderIndex: question.orderIndex,
    isRequired: question.isRequired,
    options: [...question.options]
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .map(toQuestionOptionDto),
  };
}

export function toStudentQuestionDto(
  question: Question & { options: QuestionOption[] },
): StudentQuestionDto {
  return {
    id: question.id,
    type: question.type as QuestionType,
    prompt: question.prompt,
    marks: Number(question.marks),
    negativeMarks: Number(question.negativeMarks),
    orderIndex: question.orderIndex,
    isRequired: question.isRequired,
    options: [...question.options]
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .map((opt) => ({
        id: opt.id,
        label: displayLetterForOrder(opt.orderIndex),
        text: opt.label,
        orderIndex: opt.orderIndex,
      })),
  };
}

function shuffleWithCrypto<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

export function buildAttemptSnapshots(
  exam: Pick<Exam, "shuffleQuestions" | "shuffleOptions">,
  questions: Array<Question & { options: QuestionOption[] }>,
  policy: ProctoringPolicyConfig,
): {
  questionSnapshot: QuestionSnapshotItem[];
  answerKeySnapshot: AnswerKeySnapshotItem[];
  policySnapshot: ProctoringPolicyConfig;
} {
  const sortedQuestions = [...questions].sort((a, b) => a.orderIndex - b.orderIndex);
  const orderedQuestions = exam.shuffleQuestions
    ? shuffleWithCrypto(sortedQuestions)
    : sortedQuestions;

  const questionSnapshot: QuestionSnapshotItem[] = orderedQuestions.map((q, qIdx) => {
    const sortedOptions = [...q.options].sort((a, b) => a.orderIndex - b.orderIndex);
    const orderedOptions = exam.shuffleOptions
      ? shuffleWithCrypto(sortedOptions)
      : sortedOptions;

    return {
      id: q.id,
      type: q.type as QuestionType,
      prompt: q.prompt,
      marks: Number(q.marks),
      negativeMarks: Number(q.negativeMarks),
      orderIndex: qIdx + 1,
      isRequired: q.isRequired,
      options: orderedOptions.map((opt, optIdx) => ({
        id: opt.id,
        label: displayLetterForOrder(optIdx + 1),
        text: opt.label,
        orderIndex: optIdx + 1,
      })),
    };
  });

  const answerKeySnapshot: AnswerKeySnapshotItem[] = sortedQuestions.map((q) => ({
    questionId: q.id,
    type: q.type as QuestionType,
    marks: Number(q.marks),
    negativeMarks: Number(q.negativeMarks),
    isRequired: q.isRequired,
    correctOptionIds: q.options.filter((o) => o.isCorrect).map((o) => o.id),
  }));

  return {
    questionSnapshot,
    answerKeySnapshot,
    policySnapshot: policy,
  };
}

export function toExamSummaryDto(
  exam: Exam & {
    course: {
      id: string;
      code: string;
      title: string;
      teacher: { id: string; fullName: string };
    };
  },
  counts: {
    questionCount: number;
    attemptCount: number;
    activeAttemptCount: number;
    submissionCount: number;
  },
): ExamSummaryDto {
  return {
    id: exam.id,
    courseId: exam.courseId,
    courseCode: exam.course.code,
    courseTitle: exam.course.title,
    teacherId: exam.course.teacher.id,
    teacherName: exam.course.teacher.fullName,
    parentExamId: exam.parentExamId,
    version: exam.version,
    title: exam.title,
    status: exam.status as ExamStatus,
    durationMinutes: exam.durationMinutes,
    totalMarks: Number(exam.totalMarks),
    passingMarks: Number(exam.passingMarks),
    maxAttempts: exam.maxAttempts,
    isEnabled: exam.isEnabled,
    allowUnproctoredDev: exam.allowUnproctoredDev,
    windowStart: exam.windowStart.toISOString(),
    windowEnd: exam.windowEnd.toISOString(),
    questionCount: counts.questionCount,
    attemptCount: counts.attemptCount,
    activeAttemptCount: counts.activeAttemptCount,
    submissionCount: counts.submissionCount,
    rejectionReason: exam.rejectionReason,
    cancellationReason: exam.cancellationReason,
    submittedForApprovalAt: exam.submittedForApprovalAt
      ? exam.submittedForApprovalAt.toISOString()
      : null,
    approvedAt: exam.approvedAt ? exam.approvedAt.toISOString() : null,
    rejectedAt: exam.rejectedAt ? exam.rejectedAt.toISOString() : null,
    activatedAt: exam.activatedAt ? exam.activatedAt.toISOString() : null,
    pausedAt: exam.pausedAt ? exam.pausedAt.toISOString() : null,
    cancelledAt: exam.cancelledAt ? exam.cancelledAt.toISOString() : null,
    createdAt: exam.createdAt.toISOString(),
    updatedAt: exam.updatedAt.toISOString(),
  };
}

export function toExamDetailDto(
  exam: Exam & {
    course: {
      id: string;
      code: string;
      title: string;
      teacher: { id: string; fullName: string };
    };
    questions: Array<Question & { options: QuestionOption[] }>;
    proctoringPolicy: ProctoringPolicy | null;
  },
  defaultPolicy: ProctoringPolicy | null,
  counts: {
    attemptCount: number;
    activeAttemptCount: number;
    submissionCount: number;
  },
): ExamDetailDto {
  const effectivePolicy = resolveEffectiveProctoringPolicy({
    examPolicy: exam.proctoringPolicy,
    defaultPolicy,
    allowUnproctoredDev: exam.allowUnproctoredDev,
  });

  return {
    ...toExamSummaryDto(exam, {
      questionCount: exam.questions.length,
      attemptCount: counts.attemptCount,
      activeAttemptCount: counts.activeAttemptCount,
      submissionCount: counts.submissionCount,
    }),
    description: exam.description,
    instructions: exam.instructions,
    shuffleQuestions: exam.shuffleQuestions,
    shuffleOptions: exam.shuffleOptions,
    questions: [...exam.questions]
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .map(toQuestionDto),
    proctoringPolicy: effectivePolicy,
    preflight: evaluateProctoringPreflight(exam.allowUnproctoredDev, effectivePolicy),
  };
}

export function toExamAttemptSummaryDto(
  attempt: ExamAttempt & {
    student: { id: string; fullName: string; email: string; status: UserStatus | string };
    submission: { receiptCode: string } | null;
    answers: Array<{ selectedOptionIds: unknown; subjectiveText: string | null }>;
  },
  liveQuestionCount: number,
): ExamAttemptSummaryDto {
  const snapshotQuestions = Array.isArray(attempt.questionSnapshotJson)
    ? attempt.questionSnapshotJson
    : null;
  const questionCount = snapshotQuestions ? snapshotQuestions.length : liveQuestionCount;
  const answeredCount = attempt.answers.filter((a) => {
    const selected = Array.isArray(a.selectedOptionIds) ? a.selectedOptionIds : [];
    return selected.length > 0 || Boolean(a.subjectiveText && a.subjectiveText.trim().length > 0);
  }).length;

  return {
    id: attempt.id,
    examId: attempt.examId,
    examVersion: attempt.examVersion,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status as AttemptStatus,
    finalizationReason: (attempt.finalizationReason as SubmissionReason | null) ?? null,
    startedAt: attempt.startedAt.toISOString(),
    expiresAt: attempt.expiresAt.toISOString(),
    submittedAt: attempt.submittedAt ? attempt.submittedAt.toISOString() : null,
    lastHeartbeatAt: attempt.lastHeartbeatAt ? attempt.lastHeartbeatAt.toISOString() : null,
    violationCount: attempt.violationCount,
    answeredCount,
    questionCount,
    receiptCode: attempt.submission?.receiptCode ?? null,
    student: {
      id: attempt.student.id,
      fullName: attempt.student.fullName,
      email: attempt.student.email,
      status: attempt.student.status as UserStatus,
    },
  };
}

export function toStudentExamAnswerDto(answer: ExamAnswer): StudentExamAnswerDto {
  const selected = Array.isArray(answer.selectedOptionIds)
    ? answer.selectedOptionIds.filter((v): v is string => typeof v === "string")
    : [];

  return {
    questionId: answer.questionId,
    selectedOptionIds: selected,
    textAnswer: answer.subjectiveText,
    markedForReview: answer.markedForReview,
    revision: answer.revision,
    lastClientSequence: answer.lastClientSequence,
    lastSavedAt: answer.updatedAt.toISOString(),
    isFinalized: answer.isFinalized,
  };
}

export function toSubmissionReceiptDto(params: {
  submission: ExamSubmission;
  attempt: Pick<
    ExamAttempt,
    "id" | "examId" | "examVersion" | "attemptNumber" | "status" | "startedAt" | "questionSnapshotJson"
  >;
  exam: {
    title: string;
    totalMarks: Prisma.Decimal | number;
    allowUnproctoredDev: boolean;
    course: { code: string; title: string };
  };
  answeredCount: number;
  fallbackQuestionCount: number;
}): ExamSubmissionReceiptDto {
  const snapshotQuestions = Array.isArray(params.attempt.questionSnapshotJson)
    ? params.attempt.questionSnapshotJson
    : null;
  const totalQuestions = snapshotQuestions
    ? snapshotQuestions.length
    : params.fallbackQuestionCount;

  return {
    submissionId: params.submission.id,
    attemptId: params.attempt.id,
    examId: params.attempt.examId,
    examTitle: params.exam.title,
    courseCode: params.exam.course.code,
    courseTitle: params.exam.course.title,
    examVersion: params.attempt.examVersion,
    attemptNumber: params.attempt.attemptNumber,
    receiptCode: params.submission.receiptCode,
    status: params.attempt.status as AttemptStatus,
    reason: params.submission.reason as SubmissionReason,
    startedAt: params.attempt.startedAt.toISOString(),
    submittedAt: params.submission.submittedAt.toISOString(),
    answeredCount: params.answeredCount,
    totalQuestions,
    totalMarks: Number(params.exam.totalMarks),
    allowUnproctoredDev: params.exam.allowUnproctoredDev,
  };
}

export function extractStudentQuestionsFromAttempt(
  attempt: Pick<ExamAttempt, "questionSnapshotJson">,
  liveQuestions: Array<Question & { options: QuestionOption[] }>,
): StudentQuestionDto[] {
  if (Array.isArray(attempt.questionSnapshotJson) && attempt.questionSnapshotJson.length > 0) {
    return attempt.questionSnapshotJson.map((raw) => {
      const item = raw as unknown as QuestionSnapshotItem;
      return {
        id: String(item.id),
        type: item.type,
        prompt: String(item.prompt),
        marks: Number(item.marks),
        negativeMarks: Number(item.negativeMarks ?? 0),
        orderIndex: Number(item.orderIndex),
        isRequired: Boolean(item.isRequired),
        options: Array.isArray(item.options)
          ? item.options.map((opt) => ({
              id: String(opt.id),
              label: String(opt.label),
              text: String(opt.text),
              orderIndex: Number(opt.orderIndex),
            }))
          : [],
      };
    });
  }

  return [...liveQuestions]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map(toStudentQuestionDto);
}

export function toStudentAttemptDto(params: {
  attempt: ExamAttempt & {
    answers: ExamAnswer[];
    submission: ExamSubmission | null;
    integrityEvents?: IntegrityEvent[];
  };
  exam: Exam & {
    course: { code: string; title: string };
    questions: Array<Question & { options: QuestionOption[] }>;
    proctoringPolicy: ProctoringPolicy | null;
  };
  defaultPolicy: ProctoringPolicy | null;
  now?: Date;
}): StudentExamAttemptDto {
  const now = params.now ?? new Date();
  const remainingSeconds = Math.max(
    0,
    Math.floor((params.attempt.expiresAt.getTime() - now.getTime()) / 1000),
  );
  const rawSnapshotPolicy =
    params.attempt.policySnapshotJson && typeof params.attempt.policySnapshotJson === "object"
      ? (params.attempt.policySnapshotJson as Record<string, unknown>)
      : null;

  const baseFallback = resolveEffectiveProctoringPolicy({
    examPolicy: params.exam.proctoringPolicy,
    defaultPolicy: params.defaultPolicy,
    allowUnproctoredDev: params.exam.allowUnproctoredDev,
  });

  const policyFromSnapshot: ProctoringPolicyConfig = rawSnapshotPolicy
    ? {
        ...baseFallback,
        ...(rawSnapshotPolicy as Partial<ProctoringPolicyConfig>),
      }
    : baseFallback;
  const questions = extractStudentQuestionsFromAttempt(params.attempt, params.exam.questions);
  const answers = params.attempt.answers.map(toStudentExamAnswerDto);
  const answeredCount = answers.filter(
    (a) => a.selectedOptionIds.length > 0 || Boolean(a.textAnswer && a.textAnswer.trim()),
  ).length;

  return {
    id: params.attempt.id,
    examId: params.attempt.examId,
    examTitle: params.exam.title,
    courseCode: params.exam.course.code,
    courseTitle: params.exam.course.title,
    examVersion: params.attempt.examVersion,
    instructions: params.exam.instructions,
    status: params.attempt.status as AttemptStatus,
    finalizationReason: (params.attempt.finalizationReason as SubmissionReason | null) ?? null,
    attemptNumber: params.attempt.attemptNumber,
    startedAt: params.attempt.startedAt.toISOString(),
    expiresAt: params.attempt.expiresAt.toISOString(),
    serverNow: now.toISOString(),
    submittedAt: params.attempt.submittedAt ? params.attempt.submittedAt.toISOString() : null,
    durationMinutes: params.exam.durationMinutes,
    remainingSeconds:
      params.attempt.status === "IN_PROGRESS" || params.attempt.status === "PAUSED"
        ? remainingSeconds
        : 0,
    totalMarks: Number(params.exam.totalMarks),
    passingMarks: Number(params.exam.passingMarks),
    shuffleQuestions: params.exam.shuffleQuestions,
    shuffleOptions: params.exam.shuffleOptions,
    revision: params.attempt.revision,
    isLocked: params.attempt.isLocked,
    allowUnproctoredDev: params.exam.allowUnproctoredDev,
    policyVersion: params.attempt.policyVersion,
    policy: policyFromSnapshot,
    violationCount: params.attempt.violationCount,
    warningCount: params.attempt.warningCount,
    strikeThreshold: params.attempt.strikeThreshold,
    pauseReason: params.attempt.pauseReason,
    cameraActive: params.attempt.cameraActive,
    screenShareActive: params.attempt.screenShareActive,
    fullscreenActive: params.attempt.fullscreenActive,
    lastHeartbeatAt: params.attempt.lastHeartbeatAt.toISOString(),
    recentIntegrityEvents: (params.attempt.integrityEvents ?? []).map((ev) =>
      toIntegrityEventDto(ev),
    ),
    preflight: evaluateProctoringPreflight(params.exam.allowUnproctoredDev, policyFromSnapshot),
    questions,
    answers,
    receipt: params.attempt.submission
      ? toSubmissionReceiptDto({
          submission: params.attempt.submission,
          attempt: params.attempt,
          exam: params.exam,
          answeredCount,
          fallbackQuestionCount: questions.length,
        })
      : null,
  };
}

export async function recalculateExamTotalMarks(
  tx: Prisma.TransactionClient,
  examId: string,
): Promise<number> {
  const aggregate = await tx.question.aggregate({
    where: { examId },
    _sum: { marks: true },
  });
  const totalMarks = Number(Number(aggregate._sum.marks ?? 0).toFixed(2));
  await tx.exam.update({
    where: { id: examId },
    data: { totalMarks },
  });
  return totalMarks;
}
