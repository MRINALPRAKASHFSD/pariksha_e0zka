import type {
  AssignmentStatus,
  AssignmentSubmissionStatus,
  AttemptStatus,
  EnrollmentStatus,
  ExamStatus,
  IntegrityEventConfidence,
  IntegrityEventSource,
  IntegrityEventType,
  IntegritySeverity,
  QuestionType,
  SubmissionReason,
  UserRole,
  UserStatus,
} from "./enums.js";
import type { ProctoringPolicyConfig, ProctoringPreflightStatus } from "./proctoring.js";

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  requestId?: string;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface HealthCheckStatus {
  status: "ok" | "degraded";
  service: "pariksha-api";
  timestamp: string;
  uptimeSeconds: number;
  database: {
    connected: boolean;
    latencyMs: number | null;
  };
}

export interface AuthenticatedUserDto {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  status: UserStatus;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AuthSessionPayload {
  user: AuthenticatedUserDto;
  csrfToken: string;
}

export interface AdminUserListItemDto extends AuthenticatedUserDto {
  updatedAt: string;
  activeSessionCount: number;
}

export interface AdminUserSummaryCounts {
  total: number;
  active: number;
  inactive: number;
  suspended: number;
  byRole: {
    ADMIN: number;
    TEACHER: number;
    STUDENT: number;
  };
}

export interface AdminUsersListResponse extends PaginatedResult<AdminUserListItemDto> {
  summary: AdminUserSummaryCounts;
}

export interface AuditLogDto {
  id: string;
  actorId: string | null;
  actorRole: UserRole | null;
  action: string;
  entityType: string;
  entityId: string | null;
  ipAddress: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface AttachmentDto {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  downloadUrl: string;
}

export interface CourseTeacherSummaryDto {
  id: string;
  fullName: string;
  email: string;
  status: UserStatus;
}

export interface CourseSummaryDto {
  id: string;
  code: string;
  title: string;
  description: string | null;
  department: string | null;
  semester: string | null;
  capacity: number | null;
  isActive: boolean;
  archivedAt: string | null;
  teacher: CourseTeacherSummaryDto;
  activeEnrollmentCount: number;
  assignmentCount: number;
  examCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface EnrollmentItemDto {
  id: string;
  courseId: string;
  studentId: string;
  status: EnrollmentStatus;
  enrolledAt: string;
  updatedAt: string;
  student: {
    id: string;
    fullName: string;
    email: string;
    status: UserStatus;
  };
  submissionCount?: number;
}

export interface CourseExamPreviewDto {
  id: string;
  title: string;
  status: ExamStatus;
  durationMinutes: number;
  totalMarks: number;
  windowStart: string;
  windowEnd: string;
}

export interface CourseDetailDto extends CourseSummaryDto {
  enrollments: EnrollmentItemDto[];
  assignments: AssignmentSummaryDto[];
  exams: CourseExamPreviewDto[];
}

export interface BulkEnrollmentImportResultDto {
  enrolledCount: number;
  reactivatedCount: number;
  skippedCount: number;
  errors: Array<{
    row: number;
    email: string;
    reason: string;
  }>;
}

export interface AssignmentSummaryDto {
  id: string;
  courseId: string;
  courseCode: string;
  courseTitle: string;
  title: string;
  description: string | null;
  instructions: string | null;
  maxMarks: number;
  dueAt: string;
  allowLateSubmissions: boolean;
  lateDueAt: string | null;
  allowResubmission: boolean;
  status: AssignmentStatus;
  isPublished: boolean;
  publishedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  attachments: AttachmentDto[];
  submissionStats?: {
    totalSubmissions: number;
    gradedSubmissions: number;
    publishedGrades: number;
    pendingGrading: number;
  };
  mySubmission?: StudentSubmissionSummaryDto | null;
}

export interface StudentSubmissionSummaryDto {
  id: string;
  assignmentId: string;
  status: AssignmentSubmissionStatus;
  notes: string | null;
  submissionCount: number;
  submittedAt: string;
  updatedAt: string;
  attachments: AttachmentDto[];
  isGradePublished: boolean;
  gradePublishedAt: string | null;
  score: number | null;
  feedback: string | null;
  gradedAt: string | null;
}

export interface TeacherSubmissionItemDto {
  id: string;
  assignmentId: string;
  student: {
    id: string;
    fullName: string;
    email: string;
    status: UserStatus;
  };
  status: AssignmentSubmissionStatus;
  notes: string | null;
  submissionCount: number;
  submittedAt: string;
  updatedAt: string;
  attachments: AttachmentDto[];
  score: number | null;
  feedback: string | null;
  gradedAt: string | null;
  isGradePublished: boolean;
  gradePublishedAt: string | null;
}

export interface AdminDashboardStatsDto {
  courses: {
    total: number;
    active: number;
    archived: number;
  };
  users: AdminUserSummaryCounts;
  enrollments: {
    active: number;
    dropped: number;
    completed: number;
  };
  assignments: {
    total: number;
    published: number;
    draft: number;
    submissions: number;
  };
  recentActivity: AuditLogDto[];
}

export interface TeacherDashboardStatsDto {
  profile: AuthenticatedUserDto;
  counts: {
    assignedCourses: number;
    totalEnrolledStudents: number;
    publishedAssignments: number;
    pendingSubmissions: number;
    awaitingGrading: number;
    exams: number;
  };
  upcomingDeadlines: Array<{
    id: string;
    title: string;
    courseCode: string;
    dueAt: string;
    submissionCount: number;
  }>;
  recentSubmissions: Array<{
    id: string;
    assignmentId: string;
    assignmentTitle: string;
    courseCode: string;
    studentName: string;
    status: AssignmentSubmissionStatus;
    submittedAt: string;
  }>;
}

export interface StudentDashboardStatsDto {
  profile: AuthenticatedUserDto;
  counts: {
    activeEnrollments: number;
    pendingAssignments: number;
    submittedAssignments: number;
    publishedGrades: number;
    completedAttempts: number;
    publishedExamResults: number;
  };
  upcomingDeadlines: Array<{
    id: string;
    title: string;
    courseId: string;
    courseCode: string;
    dueAt: string;
    allowLateSubmissions: boolean;
    submitted: boolean;
  }>;
  recentActivity: Array<{
    id: string;
    assignmentId: string;
    assignmentTitle: string;
    courseCode: string;
    status: AssignmentSubmissionStatus;
    submittedAt: string;
    isGradePublished: boolean;
    score: number | null;
    maxMarks: number;
  }>;
}

// Phase 4 — Examination Engine DTOs
export interface QuestionOptionDto {
  id: string;
  label: string;
  text: string;
  isCorrect: boolean;
  orderIndex: number;
}

export interface QuestionDto {
  id: string;
  examId: string;
  type: QuestionType;
  prompt: string;
  explanation: string | null;
  marks: number;
  negativeMarks: number;
  orderIndex: number;
  isRequired: boolean;
  options: QuestionOptionDto[];
}

export interface ExamSummaryDto {
  id: string;
  courseId: string;
  courseCode: string;
  courseTitle: string;
  teacherId: string;
  teacherName: string;
  parentExamId: string | null;
  version: number;
  title: string;
  status: ExamStatus;
  durationMinutes: number;
  totalMarks: number;
  passingMarks: number;
  maxAttempts: number;
  isEnabled: boolean;
  allowUnproctoredDev: boolean;
  windowStart: string;
  windowEnd: string;
  questionCount: number;
  attemptCount: number;
  activeAttemptCount: number;
  submissionCount: number;
  rejectionReason: string | null;
  cancellationReason: string | null;
  submittedForApprovalAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  activatedAt: string | null;
  pausedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExamDetailDto extends ExamSummaryDto {
  description: string | null;
  instructions: string | null;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  questions: QuestionDto[];
  proctoringPolicy: ProctoringPolicyConfig;
  preflight: ProctoringPreflightStatus;
}

export interface QuestionImportRowPreviewDto {
  row: number;
  valid: boolean;
  error: string | null;
  question: {
    type: QuestionType;
    prompt: string;
    explanation: string | null;
    marks: number;
    negativeMarks: number;
    isRequired: boolean;
    options: Array<{ label: string; text: string; isCorrect: boolean }>;
  } | null;
}

export interface QuestionImportResultDto {
  mode: "preview" | "import";
  totalRows: number;
  validCount: number;
  invalidCount: number;
  importedCount: number;
  rows: QuestionImportRowPreviewDto[];
  examTotalMarks: number;
}

export interface ExamAttemptSummaryDto {
  id: string;
  examId: string;
  examVersion: number;
  attemptNumber: number;
  status: AttemptStatus;
  finalizationReason: SubmissionReason | null;
  startedAt: string;
  expiresAt: string;
  submittedAt: string | null;
  lastHeartbeatAt: string | null;
  violationCount: number;
  answeredCount: number;
  questionCount: number;
  receiptCode: string | null;
  student: {
    id: string;
    fullName: string;
    email: string;
    status: UserStatus;
  };
}

// Student-facing strictly sanitized DTOs (NEVER expose answer keys or explanations)
export interface StudentQuestionOptionDto {
  id: string;
  label: string;
  text: string;
  orderIndex: number;
}

export interface StudentQuestionDto {
  id: string;
  type: QuestionType;
  prompt: string;
  marks: number;
  negativeMarks: number;
  orderIndex: number;
  isRequired: boolean;
  options: StudentQuestionOptionDto[];
}

export type StudentExamEligibilityStatus =
  | "AVAILABLE"
  | "PREFLIGHT_REQUIRED"
  | "IN_PROGRESS"
  | "UPCOMING"
  | "PAUSED"
  | "PROCTORING_UNAVAILABLE"
  | "DISABLED"
  | "WINDOW_CLOSED"
  | "ATTEMPTS_EXHAUSTED"
  | "COMPLETED"
  | "CANCELLED";

export interface StudentExamListItemDto {
  id: string;
  courseId: string;
  courseCode: string;
  courseTitle: string;
  title: string;
  description: string | null;
  instructions: string | null;
  version: number;
  status: ExamStatus;
  durationMinutes: number;
  totalMarks: number;
  passingMarks: number;
  maxAttempts: number;
  attemptsUsed: number;
  questionCount: number;
  windowStart: string;
  windowEnd: string;
  serverNow: string;
  allowUnproctoredDev: boolean;
  eligibilityStatus: StudentExamEligibilityStatus;
  eligibilityReason: string | null;
  canStart: boolean;
  canResume: boolean;
  activeAttemptId: string | null;
  activeAttemptExpiresAt: string | null;
  latestSubmission: ExamSubmissionReceiptDto | null;
  preflight: ProctoringPreflightStatus;
}

export interface StudentExamAnswerDto {
  questionId: string;
  selectedOptionIds: string[];
  textAnswer: string | null;
  markedForReview: boolean;
  revision: number;
  lastClientSequence: number;
  lastSavedAt: string | null;
  isFinalized: boolean;
}

export interface StudentExamAttemptDto {
  id: string;
  examId: string;
  examTitle: string;
  courseCode: string;
  courseTitle: string;
  examVersion: number;
  instructions: string | null;
  status: AttemptStatus;
  finalizationReason: SubmissionReason | null;
  attemptNumber: number;
  startedAt: string;
  expiresAt: string;
  serverNow: string;
  submittedAt: string | null;
  durationMinutes: number;
  remainingSeconds: number;
  totalMarks: number;
  passingMarks: number;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  revision: number;
  isLocked: boolean;
  allowUnproctoredDev: boolean;
  policyVersion: number;
  policy: ProctoringPolicyConfig;
  violationCount: number;
  warningCount: number;
  strikeThreshold: number;
  pauseReason: string | null;
  cameraActive: boolean;
  screenShareActive: boolean;
  fullscreenActive: boolean;
  lastHeartbeatAt: string | null;
  recentIntegrityEvents: IntegrityEventDto[];
  preflight: ProctoringPreflightStatus;
  questions: StudentQuestionDto[];
  answers: StudentExamAnswerDto[];
  receipt: ExamSubmissionReceiptDto | null;
}

// Phase 5 — Proctoring, Preflight, Lockout & Two-Strike Engine DTOs
export interface ProctoringPolicyRecordDto extends ProctoringPolicyConfig {
  id: string;
  examId: string | null;
  isInstitutionalDefault: boolean;
  isActive: boolean;
  version: number;
  updatedById: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExamProctoringPolicyStateDto {
  examId: string;
  examTitle: string;
  courseCode: string;
  inheritedFromDefault: boolean;
  defaultPolicy: ProctoringPolicyRecordDto;
  examOverride: ProctoringPolicyRecordDto | null;
  effectivePolicy: ProctoringPolicyConfig;
  effectivePolicyVersion: number;
}

export interface StudentExamPreflightContextDto {
  examId: string;
  examTitle: string;
  courseCode: string;
  courseTitle: string;
  instructions: string | null;
  durationMinutes: number;
  totalMarks: number;
  allowUnproctoredDev: boolean;
  policyVersion: number;
  policy: ProctoringPolicyConfig;
  preflight: ProctoringPreflightStatus;
  privacyNotice: string;
  browserLimitations: readonly string[];
}

export interface PreflightHandshakeReceiptDto {
  handshakeId: string;
  preflightToken: string;
  examId: string;
  policyVersion: number;
  expiresAt: string;
  verifiedAt: string;
}

export interface IntegrityEventDto {
  id: string;
  attemptId: string;
  examId: string;
  examTitle?: string;
  courseCode?: string;
  studentId: string;
  studentName?: string;
  studentEmail?: string;
  clientEventId: string;
  eventType: IntegrityEventType;
  severity: IntegritySeverity;
  source: IntegrityEventSource | string;
  confidence: IntegrityEventConfidence | string;
  ruleEnabled: boolean;
  countedAsStrike: boolean;
  violationNumberAfter: number | null;
  dedupGroupKey: string | null;
  incidentKey: string | null;
  deduplicatedIntoId: string | null;
  description: string;
  metadata: unknown;
  occurredAt: string;
  createdAt: string;
}

export interface RecordIntegrityEventResultDto {
  event: IntegrityEventDto;
  duplicate: boolean;
  deduplicated: boolean;
  attemptStatus: AttemptStatus;
  violationCount: number;
  warningCount: number;
  strikeThreshold: number;
  remainingStrikes: number;
  warningIssued: boolean;
  autoSubmitted: boolean;
  paused: boolean;
  pauseReason: string | null;
  receipt: ExamSubmissionReceiptDto | null;
}

export interface ExamHeartbeatResultDto {
  attemptId: string;
  status: AttemptStatus;
  sequence: number;
  serverNow: string;
  expiresAt: string;
  remainingSeconds: number;
  paused: boolean;
  pauseReason: string | null;
  violationCount: number;
  strikeThreshold: number;
  policyVersion: number;
}

export interface ResumeAttemptResultDto {
  attempt: StudentExamAttemptDto;
  serverNow: string;
}

export interface AdminProctoringAttemptItemDto {
  id: string;
  examId: string;
  examTitle: string;
  courseCode: string;
  examVersion: number;
  policyVersion: number;
  attemptNumber: number;
  status: AttemptStatus;
  finalizationReason: SubmissionReason | null;
  pauseReason: string | null;
  violationCount: number;
  warningCount: number;
  strikeThreshold: number;
  cameraActive: boolean;
  screenShareActive: boolean;
  fullscreenActive: boolean;
  allowUnproctoredDev: boolean;
  lastHeartbeatAt: string;
  lastMediaHeartbeatAt: string | null;
  startedAt: string;
  expiresAt: string;
  submittedAt: string | null;
  mediaStatusDisclaimer: string;
  student: {
    id: string;
    fullName: string;
    email: string;
    status: UserStatus;
  };
}

export interface SaveExamAnswerResultDto {
  answer: StudentExamAnswerDto;
  serverNow: string;
  expiresAt: string;
  remainingSeconds: number;
  attemptStatus: AttemptStatus;
  staleIgnored: boolean;
}

export interface ExamSubmissionReceiptDto {
  submissionId: string;
  attemptId: string;
  examId: string;
  examTitle: string;
  courseCode: string;
  courseTitle: string;
  examVersion: number;
  attemptNumber: number;
  receiptCode: string;
  status: AttemptStatus;
  reason: SubmissionReason;
  startedAt: string;
  submittedAt: string;
  answeredCount: number;
  totalQuestions: number;
  totalMarks: number;
  allowUnproctoredDev: boolean;
}
