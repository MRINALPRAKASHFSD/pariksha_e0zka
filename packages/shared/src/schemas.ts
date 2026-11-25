import { z } from "zod";
import {
  AssignmentStatus,
  EnrollmentStatus,
  ExamStatus,
  ExtensionStrikeMode,
  IntegrityEventType,
  QuestionType,
  ScreenSurfacePolicy,
  UserRole,
  UserStatus,
} from "./enums.js";

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().email().max(255).transform((v) => v.toLowerCase()),
  password: z.string().min(1, "Password is required").max(128),
});

export const strongPasswordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128, "Password must be at most 128 characters")
  .refine((val) => /[A-Z]/.test(val) && /[a-z]/.test(val) && /[0-9]/.test(val), {
    message: "Password must include uppercase, lowercase, and numeric characters",
  });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required").max(128),
    newPassword: strongPasswordSchema,
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: "New password must differ from your current password",
    path: ["newPassword"],
  });

export const adminCreateUserSchema = z.object({
  email: z.string().trim().email().max(255).transform((v) => v.toLowerCase()),
  fullName: z.string().trim().min(2).max(120),
  password: strongPasswordSchema,
  role: z.enum([UserRole.TEACHER, UserRole.STUDENT]),
  status: z.enum([UserStatus.ACTIVE, UserStatus.INACTIVE]).optional().default(UserStatus.ACTIVE),
});

export const adminUpdateUserSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(255)
    .transform((v) => v.toLowerCase())
    .optional(),
  fullName: z.string().trim().min(2).max(120).optional(),
  role: z.enum([UserRole.TEACHER, UserRole.STUDENT]).optional(),
});

export const adminUpdateUserStatusSchema = z.object({
  status: z.enum([UserStatus.ACTIVE, UserStatus.INACTIVE, UserStatus.SUSPENDED]),
});

export const adminResetPasswordSchema = z.object({
  newPassword: strongPasswordSchema.optional(),
  expiresInHours: z.coerce.number().int().min(1).max(168).optional(),
});

export const adminUsersQuerySchema = paginationQuerySchema.extend({
  role: z.enum([UserRole.ADMIN, UserRole.TEACHER, UserRole.STUDENT]).optional(),
  status: z.enum([UserStatus.ACTIVE, UserStatus.INACTIVE, UserStatus.SUSPENDED]).optional(),
});

// Phase 3 — Courses & Enrollments
export const adminCoursesQuerySchema = paginationQuerySchema.extend({
  isActive: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  semester: z.string().trim().max(40).optional(),
  teacherId: z.string().uuid().optional(),
});

export const adminCreateCourseSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/, "Course code may contain letters, numbers, hyphens, and underscores")
    .transform((v) => v.toUpperCase()),
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().max(4000).optional(),
  department: z.string().trim().max(80).optional(),
  semester: z.string().trim().min(2).max(40),
  capacity: z.coerce.number().int().min(1).max(5000).nullable().optional(),
  teacherId: z.string().uuid("Select a valid teacher"),
});

export const adminUpdateCourseSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/)
    .transform((v) => v.toUpperCase())
    .optional(),
  title: z.string().trim().min(3).max(160).optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  department: z.string().trim().max(80).nullable().optional(),
  semester: z.string().trim().min(2).max(40).optional(),
  capacity: z.coerce.number().int().min(1).max(5000).nullable().optional(),
  teacherId: z.string().uuid().optional(),
});

export const adminEnrollStudentSchema = z.object({
  studentId: z.string().uuid("Valid student ID required"),
});

export const adminUpdateEnrollmentSchema = z.object({
  status: z.enum([EnrollmentStatus.ACTIVE, EnrollmentStatus.DROPPED, EnrollmentStatus.COMPLETED]),
});

export const adminBulkEnrollmentCsvSchema = z.object({
  csvContent: z.string().trim().min(3, "CSV content is required").max(500_000),
});

export const teacherCourseStudentsQuerySchema = paginationQuerySchema.extend({
  status: z.enum([EnrollmentStatus.ACTIVE, EnrollmentStatus.DROPPED, EnrollmentStatus.COMPLETED]).optional(),
});

// Phase 3 — Assignments & Grading
export const teacherAssignmentsQuerySchema = paginationQuerySchema.extend({
  courseId: z.string().uuid().optional(),
  status: z.enum([AssignmentStatus.DRAFT, AssignmentStatus.PUBLISHED, AssignmentStatus.ARCHIVED]).optional(),
});

export const createAssignmentSchema = z
  .object({
    courseId: z.string().uuid("Select a valid course"),
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().max(4000).optional(),
    instructions: z.string().trim().max(8000).optional(),
    maxMarks: z.coerce.number().positive().max(10000),
    dueAt: z.string().datetime({ offset: true }),
    allowLateSubmissions: z
      .union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")])
      .optional()
      .default(false),
    lateDueAt: z.string().datetime({ offset: true }).nullable().optional(),
    allowResubmission: z
      .union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")])
      .optional()
      .default(false),
    publishImmediately: z
      .union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")])
      .optional()
      .default(false),
  })
  .refine(
    (data) => {
      if (!data.allowLateSubmissions || !data.lateDueAt) return true;
      return new Date(data.lateDueAt) > new Date(data.dueAt);
    },
    { message: "Late submission cutoff must be after the primary due date", path: ["lateDueAt"] },
  );

export const updateAssignmentSchema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    instructions: z.string().trim().max(8000).nullable().optional(),
    maxMarks: z.coerce.number().positive().max(10000).optional(),
    dueAt: z.string().datetime({ offset: true }).optional(),
    allowLateSubmissions: z.boolean().optional(),
    lateDueAt: z.string().datetime({ offset: true }).nullable().optional(),
    allowResubmission: z.boolean().optional(),
  });

export const gradeAssignmentSubmissionSchema = z.object({
  score: z.coerce.number().min(0).max(10000),
  feedback: z.string().trim().max(4000).optional(),
  publishGrade: z.boolean().optional().default(false),
});

export const studentAssignmentsQuerySchema = paginationQuerySchema.extend({
  courseId: z.string().uuid().optional(),
  filter: z.enum(["all", "pending", "upcoming", "completed"]).optional().default("all"),
});

export const studentSubmitAssignmentSchema = z.object({
  notes: z.string().trim().max(4000).optional(),
});

export const proctoringPolicySchema = z.object({
  requireWebcam: z.boolean(),
  requireScreenShare: z.boolean(),
  requireFullscreen: z.boolean(),
  allowedScreenSurface: z
    .enum([
      ScreenSurfacePolicy.ANY,
      ScreenSurfacePolicy.MONITOR,
      ScreenSurfacePolicy.WINDOW,
      ScreenSurfacePolicy.BROWSER,
    ])
    .default(ScreenSurfacePolicy.ANY),
  detectTabSwitch: z.boolean(),
  detectWindowBlur: z.boolean(),
  detectFullscreenExit: z.boolean().default(true),
  detectCameraInterruption: z.boolean(),
  detectScreenShareInterruption: z.boolean(),
  restrictCopyPasteCut: z.boolean(),
  restrictSelectAll: z.boolean(),
  restrictRightClick: z.boolean(),
  restrictTextSelection: z.boolean(),
  detectClipboard: z.boolean(),
  detectExtensionsHeuristic: z.boolean(),
  extensionStrikeMode: z
    .enum([ExtensionStrikeMode.STRIKE, ExtensionStrikeMode.AUDIT_ONLY])
    .default(ExtensionStrikeMode.STRIKE),
  monitorConnectionHeartbeat: z.boolean().default(true),
  monitorMediaHeartbeat: z.boolean().default(true),
  heartbeatIntervalSeconds: z.coerce.number().int().min(5).max(120),
  heartbeatTimeoutSeconds: z.coerce.number().int().min(10).max(300),
  heartbeatGraceSeconds: z.coerce.number().int().min(0).max(120).default(15),
  mediaGraceSeconds: z.coerce.number().int().min(0).max(60).default(8),
  dedupWindowSeconds: z.coerce.number().int().min(1).max(30),
  violationThreshold: z.coerce.number().int().min(1).max(20),
  pauseOnMediaLoss: z.boolean(),
});

export const adminUpdateProctoringPolicySchema = proctoringPolicySchema
  .extend({
    isActive: z.boolean().optional(),
  })
  .partial()
  .refine(
    (d) =>
      d.heartbeatIntervalSeconds === undefined ||
      d.heartbeatTimeoutSeconds === undefined ||
      d.heartbeatTimeoutSeconds >= d.heartbeatIntervalSeconds,
    {
      message: "Heartbeat timeout must be greater than or equal to heartbeat interval",
      path: ["heartbeatTimeoutSeconds"],
    },
  );

export const submitPreflightHandshakeSchema = z.object({
  cameraStatus: z.enum(["GRANTED", "DENIED", "UNAVAILABLE", "NOT_REQUIRED"]),
  screenShareStatus: z.enum(["GRANTED", "DENIED", "UNAVAILABLE", "NOT_REQUIRED"]),
  displaySurface: z
    .enum(["monitor", "window", "browser", "application", "unknown"])
    .nullable()
    .optional(),
  fullscreenStatus: z.enum(["GRANTED", "DENIED", "UNAVAILABLE", "NOT_REQUIRED"]),
  connectivityOk: z.boolean(),
  consentAccepted: z.boolean().refine((v) => v === true, {
    message: "You must acknowledge the proctoring & privacy notice to proceed",
  }),
});

export const startExamAttemptSchema = z.object({
  preflightToken: z.string().trim().min(16).max(256).optional(),
});

export const integrityEventTypeValues = [
  IntegrityEventType.TAB_SWITCH,
  IntegrityEventType.WINDOW_BLUR,
  IntegrityEventType.FULLSCREEN_EXIT,
  IntegrityEventType.CAMERA_INTERRUPTED,
  IntegrityEventType.SCREEN_SHARE_INTERRUPTED,
  IntegrityEventType.COPY_ATTEMPT,
  IntegrityEventType.PASTE_ATTEMPT,
  IntegrityEventType.CUT_ATTEMPT,
  IntegrityEventType.SELECT_ALL_ATTEMPT,
  IntegrityEventType.RIGHT_CLICK_ATTEMPT,
  IntegrityEventType.CLIPBOARD_EVENT,
  IntegrityEventType.EXTENSION_HEURISTIC,
  IntegrityEventType.HEARTBEAT_MISSED,
  IntegrityEventType.PERMISSION_DENIED,
] as const;

export const recordIntegrityEventSchema = z.object({
  clientEventId: z.string().trim().min(4).max(128),
  eventType: z.enum(integrityEventTypeValues),
  description: z.string().trim().min(1).max(500).optional(),
  confidence: z.enum(["OBSERVED", "HEURISTIC", "CLIENT_REPORTED"]).optional(),
  metadata: z
    .record(z.string().max(64), z.union([z.string().max(256), z.number(), z.boolean(), z.null()]))
    .optional(),
});

export const examHeartbeatSchema = z.object({
  sequence: z.coerce.number().int().min(1).max(1_000_000_000),
  cameraActive: z.boolean(),
  screenShareActive: z.boolean(),
  fullscreenActive: z.boolean(),
  connectionOnline: z.boolean().optional().default(true),
  clientTimestamp: z.string().datetime({ offset: true }).optional(),
});

export const resumeAttemptSchema = z.object({
  preflightToken: z.string().trim().min(16).max(256).optional(),
  cameraActive: z.boolean(),
  screenShareActive: z.boolean(),
  fullscreenActive: z.boolean(),
  displaySurface: z
    .enum(["monitor", "window", "browser", "application", "unknown"])
    .nullable()
    .optional(),
});

export const adminProctoringAttemptsQuerySchema = paginationQuerySchema.extend({
  examId: z.string().uuid().optional(),
  status: z
    .enum(["IN_PROGRESS", "PAUSED", "SUBMITTED", "AUTO_SUBMITTED", "EXPIRED", "TERMINATED"])
    .optional(),
});

export const adminProctoringEventsQuerySchema = paginationQuerySchema.extend({
  examId: z.string().uuid().optional(),
  attemptId: z.string().uuid().optional(),
  studentId: z.string().uuid().optional(),
  eventType: z.enum(integrityEventTypeValues).optional(),
  severity: z.enum(["INFO", "WARNING", "STRIKE", "CRITICAL"]).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

// Phase 4 — Examination Engine
export const examStatusValues = [
  ExamStatus.DRAFT,
  ExamStatus.PENDING_APPROVAL,
  ExamStatus.APPROVED,
  ExamStatus.REJECTED,
  ExamStatus.ACTIVE,
  ExamStatus.PAUSED,
  ExamStatus.COMPLETED,
  ExamStatus.CANCELLED,
  ExamStatus.ARCHIVED,
] as const;

export const questionTypeValues = [
  QuestionType.MULTIPLE_CHOICE,
  QuestionType.MULTIPLE_SELECT,
  QuestionType.TRUE_FALSE,
  QuestionType.SUBJECTIVE,
  QuestionType.SUBJECTIVE_SHORT,
  QuestionType.SUBJECTIVE_LONG,
] as const;

export function isObjectiveQuestionType(type: QuestionType): boolean {
  return (
    type === QuestionType.MULTIPLE_CHOICE ||
    type === QuestionType.MULTIPLE_SELECT ||
    type === QuestionType.TRUE_FALSE
  );
}

export function isSubjectiveQuestionType(type: QuestionType): boolean {
  return (
    type === QuestionType.SUBJECTIVE ||
    type === QuestionType.SUBJECTIVE_SHORT ||
    type === QuestionType.SUBJECTIVE_LONG
  );
}

export const teacherExamsQuerySchema = paginationQuerySchema.extend({
  courseId: z.string().uuid().optional(),
  status: z.enum(examStatusValues).optional(),
});

export const adminExamsQuerySchema = paginationQuerySchema.extend({
  courseId: z.string().uuid().optional(),
  teacherId: z.string().uuid().optional(),
  status: z.enum(examStatusValues).optional(),
  isEnabled: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

export const studentExamsQuerySchema = paginationQuerySchema.extend({
  courseId: z.string().uuid().optional(),
  filter: z.enum(["all", "upcoming", "available", "in_progress", "completed"]).optional().default("all"),
});

export const createExamSchema = z
  .object({
    courseId: z.string().uuid("Select a valid course"),
    title: z.string().trim().min(3, "Exam title must be at least 3 characters").max(200),
    description: z.string().trim().max(4000).nullable().optional(),
    instructions: z.string().trim().max(8000).nullable().optional(),
    passingMarks: z.coerce.number().min(0).max(100000).optional().default(0),
    durationMinutes: z.coerce.number().int().min(1, "Duration must be at least 1 minute").max(600),
    windowStart: z.string().datetime({ offset: true }),
    windowEnd: z.string().datetime({ offset: true }),
    maxAttempts: z.coerce.number().int().min(1).max(10).optional().default(1),
    shuffleQuestions: z.boolean().optional().default(false),
    shuffleOptions: z.boolean().optional().default(false),
  })
  .refine((data) => new Date(data.windowEnd) > new Date(data.windowStart), {
    message: "Availability window end must be after window start",
    path: ["windowEnd"],
  });

export const updateExamSchema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    instructions: z.string().trim().max(8000).nullable().optional(),
    passingMarks: z.coerce.number().min(0).max(100000).optional(),
    durationMinutes: z.coerce.number().int().min(1).max(600).optional(),
    windowStart: z.string().datetime({ offset: true }).optional(),
    windowEnd: z.string().datetime({ offset: true }).optional(),
    maxAttempts: z.coerce.number().int().min(1).max(10).optional(),
    shuffleQuestions: z.boolean().optional(),
    shuffleOptions: z.boolean().optional(),
  })
  .refine(
    (data) => {
      if (!data.windowStart || !data.windowEnd) return true;
      return new Date(data.windowEnd) > new Date(data.windowStart);
    },
    { message: "Availability window end must be after window start", path: ["windowEnd"] },
  );

export const questionOptionInputSchema = z.object({
  id: z.string().uuid().optional(),
  label: z.string().trim().min(1).max(20).optional(),
  text: z.string().trim().min(1, "Option text cannot be empty").max(2000),
  isCorrect: z.boolean().default(false),
});

export interface QuestionIntegrityCandidate {
  type: QuestionType;
  prompt: string;
  marks: number;
  negativeMarks: number;
  options?: Array<{ label?: string; text: string; isCorrect: boolean }>;
}

export function validateQuestionIntegrity(
  q: QuestionIntegrityCandidate,
): string | null {
  if (!q.prompt.trim()) {
    return "Question prompt is required";
  }
  if (!Number.isFinite(q.marks) || q.marks <= 0) {
    return "Marks must be greater than zero";
  }
  if (!Number.isFinite(q.negativeMarks) || q.negativeMarks < 0) {
    return "Negative marks cannot be negative";
  }
  if (q.negativeMarks > q.marks) {
    return "Negative marks cannot exceed question marks";
  }

  const options = q.options ?? [];

  if (isSubjectiveQuestionType(q.type)) {
    if (options.length > 0) {
      return "Subjective questions must not define answer options";
    }
    return null;
  }

  if (q.type === QuestionType.TRUE_FALSE) {
    if (options.length !== 2) {
      return "True/False questions must have exactly 2 options";
    }
    const correctCount = options.filter((opt) => opt.isCorrect).length;
    if (correctCount !== 1) {
      return "True/False questions must have exactly 1 correct option";
    }
    return null;
  }

  if (q.type === QuestionType.MULTIPLE_CHOICE) {
    if (options.length < 2 || options.length > 10) {
      return "Multiple-choice questions require between 2 and 10 options";
    }
    const correctCount = options.filter((opt) => opt.isCorrect).length;
    if (correctCount !== 1) {
      return "Multiple-choice questions must have exactly 1 correct option";
    }
    return null;
  }

  if (q.type === QuestionType.MULTIPLE_SELECT) {
    if (options.length < 2 || options.length > 10) {
      return "Multiple-select questions require between 2 and 10 options";
    }
    const correctCount = options.filter((opt) => opt.isCorrect).length;
    if (correctCount < 1) {
      return "Multiple-select questions must have at least 1 correct option";
    }
    return null;
  }

  return "Unsupported question type";
}

export const createQuestionSchema = z
  .object({
    type: z.enum(questionTypeValues),
    prompt: z.string().trim().min(1, "Question prompt is required").max(10000),
    explanation: z.string().trim().max(4000).nullable().optional(),
    marks: z.coerce.number().positive("Marks must be positive").max(1000),
    negativeMarks: z.coerce.number().min(0).max(1000).optional().default(0),
    isRequired: z.boolean().optional().default(false),
    options: z.array(questionOptionInputSchema).max(10).optional().default([]),
  })
  .superRefine((data, ctx) => {
    const issue = validateQuestionIntegrity(data);
    if (issue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: issue,
        path: ["options"],
      });
    }
  });

export const updateQuestionSchema = z.object({
  type: z.enum(questionTypeValues).optional(),
  prompt: z.string().trim().min(1).max(10000).optional(),
  explanation: z.string().trim().max(4000).nullable().optional(),
  marks: z.coerce.number().positive().max(1000).optional(),
  negativeMarks: z.coerce.number().min(0).max(1000).optional(),
  isRequired: z.boolean().optional(),
  options: z.array(questionOptionInputSchema).max(10).optional(),
});

export const reorderQuestionsSchema = z.object({
  questionIds: z.array(z.string().uuid()).min(1).max(500),
});

export const importQuestionsSchema = z.object({
  format: z.enum(["csv", "json"]),
  content: z.string().min(1, "Import file content is required").max(1_000_000),
  mode: z.enum(["preview", "import"]).optional().default("preview"),
});

export const adminApproveExamSchema = z
  .object({
    windowStart: z.string().datetime({ offset: true }).optional(),
    windowEnd: z.string().datetime({ offset: true }).optional(),
    durationMinutes: z.coerce.number().int().min(1).max(600).optional(),
    maxAttempts: z.coerce.number().int().min(1).max(10).optional(),
    passingMarks: z.coerce.number().min(0).max(100000).optional(),
    allowUnproctoredDev: z.boolean().optional(),
    activateImmediately: z.boolean().optional().default(false),
  })
  .refine(
    (data) => {
      if (!data.windowStart || !data.windowEnd) return true;
      return new Date(data.windowEnd) > new Date(data.windowStart);
    },
    { message: "Availability window end must be after window start", path: ["windowEnd"] },
  );

export const adminRejectExamSchema = z.object({
  reason: z.string().trim().min(5, "Rejection reason must be at least 5 characters").max(2000),
});

export const adminUpdateExamConfigSchema = z
  .object({
    windowStart: z.string().datetime({ offset: true }).optional(),
    windowEnd: z.string().datetime({ offset: true }).optional(),
    durationMinutes: z.coerce.number().int().min(1).max(600).optional(),
    maxAttempts: z.coerce.number().int().min(1).max(10).optional(),
    passingMarks: z.coerce.number().min(0).max(100000).optional(),
    isEnabled: z.boolean().optional(),
    allowUnproctoredDev: z.boolean().optional(),
  })
  .refine(
    (data) => {
      if (!data.windowStart || !data.windowEnd) return true;
      return new Date(data.windowEnd) > new Date(data.windowStart);
    },
    { message: "Availability window end must be after window start", path: ["windowEnd"] },
  );

export const adminCancelExamSchema = z.object({
  reason: z.string().trim().min(5, "Cancellation reason must be at least 5 characters").max(2000),
});

export const adminCreateExamVersionSchema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    durationMinutes: z.coerce.number().int().min(1).max(600).optional(),
    windowStart: z.string().datetime({ offset: true }).optional(),
    windowEnd: z.string().datetime({ offset: true }).optional(),
    maxAttempts: z.coerce.number().int().min(1).max(10).optional(),
  })
  .refine(
    (data) => {
      if (!data.windowStart || !data.windowEnd) return true;
      return new Date(data.windowEnd) > new Date(data.windowStart);
    },
    { message: "Availability window end must be after window start", path: ["windowEnd"] },
  );

export const adminForceTerminateAttemptSchema = z.object({
  reason: z.string().trim().min(3).max(500).optional(),
});

export const saveExamAnswerSchema = z.object({
  questionId: z.string().uuid(),
  selectedOptionIds: z.array(z.string().uuid()).max(20).optional().default([]),
  textAnswer: z.string().max(25000).nullable().optional().default(null),
  markedForReview: z.boolean().optional(),
  clientSequence: z.coerce.number().int().min(1).max(1_000_000_000),
  expectedRevision: z.coerce.number().int().min(1).optional(),
});

export const bulkSaveExamAnswersSchema = z.object({
  answers: z.array(saveExamAnswerSchema).min(1).max(200),
});

export const submitExamAttemptSchema = z.object({
  confirmSubmit: z.literal(true).optional().default(true),
});

export type PaginationQueryInput = z.infer<typeof paginationQuerySchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type AdminCreateUserInput = z.infer<typeof adminCreateUserSchema>;
export type AdminUpdateUserInput = z.infer<typeof adminUpdateUserSchema>;
export type AdminUpdateUserStatusInput = z.infer<typeof adminUpdateUserStatusSchema>;
export type AdminResetPasswordInput = z.infer<typeof adminResetPasswordSchema>;
export type AdminUsersQueryInput = z.infer<typeof adminUsersQuerySchema>;
export type AdminCoursesQueryInput = z.infer<typeof adminCoursesQuerySchema>;
export type AdminCreateCourseInput = z.infer<typeof adminCreateCourseSchema>;
export type AdminUpdateCourseInput = z.infer<typeof adminUpdateCourseSchema>;
export type AdminEnrollStudentInput = z.infer<typeof adminEnrollStudentSchema>;
export type AdminUpdateEnrollmentInput = z.infer<typeof adminUpdateEnrollmentSchema>;
export type AdminBulkEnrollmentCsvInput = z.infer<typeof adminBulkEnrollmentCsvSchema>;
export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;
export type UpdateAssignmentInput = z.infer<typeof updateAssignmentSchema>;
export type GradeAssignmentSubmissionInput = z.infer<typeof gradeAssignmentSubmissionSchema>;
export type StudentSubmitAssignmentInput = z.infer<typeof studentSubmitAssignmentSchema>;
export type ProctoringPolicyInput = z.infer<typeof proctoringPolicySchema>;
export type TeacherExamsQueryInput = z.infer<typeof teacherExamsQuerySchema>;
export type AdminExamsQueryInput = z.infer<typeof adminExamsQuerySchema>;
export type StudentExamsQueryInput = z.infer<typeof studentExamsQuerySchema>;
export type CreateExamInput = z.infer<typeof createExamSchema>;
export type UpdateExamInput = z.infer<typeof updateExamSchema>;
export type CreateQuestionInput = z.infer<typeof createQuestionSchema>;
export type UpdateQuestionInput = z.infer<typeof updateQuestionSchema>;
export type ReorderQuestionsInput = z.infer<typeof reorderQuestionsSchema>;
export type ImportQuestionsInput = z.infer<typeof importQuestionsSchema>;
export type AdminApproveExamInput = z.infer<typeof adminApproveExamSchema>;
export type AdminRejectExamInput = z.infer<typeof adminRejectExamSchema>;
export type AdminUpdateExamConfigInput = z.infer<typeof adminUpdateExamConfigSchema>;
export type AdminCancelExamInput = z.infer<typeof adminCancelExamSchema>;
export type AdminCreateExamVersionInput = z.infer<typeof adminCreateExamVersionSchema>;
export type SaveExamAnswerInput = z.infer<typeof saveExamAnswerSchema>;
export type BulkSaveExamAnswersInput = z.infer<typeof bulkSaveExamAnswersSchema>;
export type SubmitExamAttemptInput = z.infer<typeof submitExamAttemptSchema>;
export type AdminUpdateProctoringPolicyInput = z.infer<typeof adminUpdateProctoringPolicySchema>;
export type SubmitPreflightHandshakeInput = z.infer<typeof submitPreflightHandshakeSchema>;
export type StartExamAttemptInput = z.infer<typeof startExamAttemptSchema>;
export type RecordIntegrityEventInput = z.infer<typeof recordIntegrityEventSchema>;
export type ExamHeartbeatInput = z.infer<typeof examHeartbeatSchema>;
export type ResumeAttemptInput = z.infer<typeof resumeAttemptSchema>;
export type AdminProctoringAttemptsQueryInput = z.infer<typeof adminProctoringAttemptsQuerySchema>;
export type AdminProctoringEventsQueryInput = z.infer<typeof adminProctoringEventsQuerySchema>;
