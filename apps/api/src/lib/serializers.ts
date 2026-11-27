import type {
  Assignment,
  AssignmentAttachment,
  AssignmentStatus,
  AssignmentSubmission,
  AssignmentSubmissionStatus,
  AuditLog,
  Course,
  Enrollment,
  EnrollmentStatus,
  Exam,
  ExamStatus,
  SubmissionAttachment,
  User,
} from "@prisma/client";
import type {
  AdminUserListItemDto,
  AssignmentSummaryDto,
  AttachmentDto,
  AuditLogDto,
  AuthenticatedUserDto,
  CourseExamPreviewDto,
  CourseSummaryDto,
  EnrollmentItemDto,
  StudentSubmissionSummaryDto,
  TeacherSubmissionItemDto,
  UserRole,
  UserStatus,
} from "@pariksha/shared";

export function toAuthenticatedUserDto(user: User): AuthenticatedUserDto {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role as UserRole,
    status: user.status as UserStatus,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toAdminUserListItemDto(
  user: User,
  activeSessionCount: number,
): AdminUserListItemDto {
  return {
    ...toAuthenticatedUserDto(user),
    updatedAt: user.updatedAt.toISOString(),
    activeSessionCount,
  };
}

export function toAuditLogDto(log: AuditLog): AuditLogDto {
  return {
    id: log.id,
    actorId: log.actorId,
    actorRole: (log.actorRole as UserRole | null) ?? null,
    action: log.action,
    entityType: log.entityType,
    entityId: log.entityId,
    ipAddress: log.ipAddress,
    metadata: log.metadata,
    createdAt: log.createdAt.toISOString(),
  };
}

export function toAssignmentAttachmentDto(att: AssignmentAttachment): AttachmentDto {
  return {
    id: att.id,
    originalName: att.originalName,
    mimeType: att.mimeType,
    sizeBytes: att.sizeBytes,
    createdAt: att.createdAt.toISOString(),
    downloadUrl: `/api/v1/files/assignment-attachments/${att.id}`,
  };
}

export function toSubmissionAttachmentDto(att: SubmissionAttachment): AttachmentDto {
  return {
    id: att.id,
    originalName: att.originalName,
    mimeType: att.mimeType,
    sizeBytes: att.sizeBytes,
    createdAt: att.createdAt.toISOString(),
    downloadUrl: `/api/v1/files/submission-attachments/${att.id}`,
  };
}

export function toCourseSummaryDto(
  course: Course & {
    teacher: Pick<User, "id" | "fullName" | "email" | "status">;
  },
  counts: {
    activeEnrollmentCount: number;
    assignmentCount: number;
    examCount: number;
  },
): CourseSummaryDto {
  return {
    id: course.id,
    code: course.code,
    title: course.title,
    description: course.description,
    department: course.department,
    semester: course.semester,
    capacity: course.capacity,
    isActive: course.isActive,
    archivedAt: course.archivedAt ? course.archivedAt.toISOString() : null,
    teacher: {
      id: course.teacher.id,
      fullName: course.teacher.fullName,
      email: course.teacher.email,
      status: course.teacher.status as UserStatus,
    },
    activeEnrollmentCount: counts.activeEnrollmentCount,
    assignmentCount: counts.assignmentCount,
    examCount: counts.examCount,
    createdAt: course.createdAt.toISOString(),
    updatedAt: course.updatedAt.toISOString(),
  };
}

export function toEnrollmentItemDto(
  enrollment: Enrollment & {
    student: Pick<User, "id" | "fullName" | "email" | "status">;
  },
  submissionCount?: number,
): EnrollmentItemDto {
  return {
    id: enrollment.id,
    courseId: enrollment.courseId,
    studentId: enrollment.studentId,
    status: enrollment.status as EnrollmentStatus,
    enrolledAt: enrollment.enrolledAt.toISOString(),
    updatedAt: enrollment.updatedAt.toISOString(),
    student: {
      id: enrollment.student.id,
      fullName: enrollment.student.fullName,
      email: enrollment.student.email,
      status: enrollment.student.status as UserStatus,
    },
    submissionCount,
  };
}

export function toCourseExamPreviewDto(exam: Exam): CourseExamPreviewDto {
  return {
    id: exam.id,
    title: exam.title,
    status: exam.status as ExamStatus,
    durationMinutes: exam.durationMinutes,
    totalMarks: Number(exam.totalMarks),
    windowStart: exam.windowStart.toISOString(),
    windowEnd: exam.windowEnd.toISOString(),
  };
}

export function toStudentSubmissionDto(
  submission: AssignmentSubmission & { attachments: SubmissionAttachment[] },
): StudentSubmissionSummaryDto {
  // Never expose score, feedback, or gradedAt before authorized grade publication
  const published = submission.isGradePublished;
  return {
    id: submission.id,
    assignmentId: submission.assignmentId,
    status:
      published || submission.status !== "GRADED"
        ? (submission.status as AssignmentSubmissionStatus)
        : "SUBMITTED",
    notes: submission.notes,
    submissionCount: submission.submissionCount,
    submittedAt: submission.submittedAt.toISOString(),
    updatedAt: submission.updatedAt.toISOString(),
    attachments: submission.attachments.map(toSubmissionAttachmentDto),
    isGradePublished: published,
    gradePublishedAt:
      published && submission.gradePublishedAt ? submission.gradePublishedAt.toISOString() : null,
    score: published && submission.score !== null ? Number(submission.score) : null,
    feedback: published ? submission.feedback : null,
    gradedAt: published && submission.gradedAt ? submission.gradedAt.toISOString() : null,
  };
}

export function toTeacherSubmissionDto(
  submission: AssignmentSubmission & {
    student: Pick<User, "id" | "fullName" | "email" | "status">;
    attachments: SubmissionAttachment[];
  },
): TeacherSubmissionItemDto {
  return {
    id: submission.id,
    assignmentId: submission.assignmentId,
    student: {
      id: submission.student.id,
      fullName: submission.student.fullName,
      email: submission.student.email,
      status: submission.student.status as UserStatus,
    },
    status: submission.status as AssignmentSubmissionStatus,
    notes: submission.notes,
    submissionCount: submission.submissionCount,
    submittedAt: submission.submittedAt.toISOString(),
    updatedAt: submission.updatedAt.toISOString(),
    attachments: submission.attachments.map(toSubmissionAttachmentDto),
    score: submission.score !== null ? Number(submission.score) : null,
    feedback: submission.feedback,
    gradedAt: submission.gradedAt ? submission.gradedAt.toISOString() : null,
    isGradePublished: submission.isGradePublished,
    gradePublishedAt: submission.gradePublishedAt
      ? submission.gradePublishedAt.toISOString()
      : null,
  };
}

export function toAssignmentSummaryDto(
  assignment: Assignment & {
    course: Pick<Course, "code" | "title">;
    attachments: AssignmentAttachment[];
  },
  extra?: {
    submissionStats?: AssignmentSummaryDto["submissionStats"];
    mySubmission?: StudentSubmissionSummaryDto | null;
  },
): AssignmentSummaryDto {
  return {
    id: assignment.id,
    courseId: assignment.courseId,
    courseCode: assignment.course.code,
    courseTitle: assignment.course.title,
    title: assignment.title,
    description: assignment.description,
    instructions: assignment.instructions,
    maxMarks: Number(assignment.maxMarks),
    dueAt: assignment.dueAt.toISOString(),
    allowLateSubmissions: assignment.allowLateSubmissions,
    lateDueAt: assignment.lateDueAt ? assignment.lateDueAt.toISOString() : null,
    allowResubmission: assignment.allowResubmission,
    status: assignment.status as AssignmentStatus,
    isPublished: assignment.isPublished,
    publishedAt: assignment.publishedAt ? assignment.publishedAt.toISOString() : null,
    archivedAt: assignment.archivedAt ? assignment.archivedAt.toISOString() : null,
    createdAt: assignment.createdAt.toISOString(),
    updatedAt: assignment.updatedAt.toISOString(),
    attachments: assignment.attachments.map(toAssignmentAttachmentDto),
    submissionStats: extra?.submissionStats,
    mySubmission: extra?.mySubmission,
  };
}
