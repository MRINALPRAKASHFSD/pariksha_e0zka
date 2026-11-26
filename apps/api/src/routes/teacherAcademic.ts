import { Router } from "express";
import type { Prisma } from "@prisma/client";
import {
  AuditAction,
  createAssignmentSchema,
  gradeAssignmentSubmissionSchema,
  paginationQuerySchema,
  teacherAssignmentsQuerySchema,
  teacherCourseStudentsQuerySchema,
  updateAssignmentSchema,
  type ApiSuccessResponse,
  type AssignmentSummaryDto,
  type CourseDetailDto,
  type CourseSummaryDto,
  type EnrollmentItemDto,
  type PaginatedResult,
  type TeacherDashboardStatsDto,
  type TeacherSubmissionItemDto,
} from "@pariksha/shared";
import { writeAuditLog } from "../lib/audit.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { validateUploadedFile } from "../lib/fileSecurity.js";
import { getPrismaClient } from "../lib/prisma.js";
import {
  toAssignmentSummaryDto,
  toAuthenticatedUserDto,
  toCourseExamPreviewDto,
  toCourseSummaryDto,
  toEnrollmentItemDto,
  toTeacherSubmissionDto,
} from "../lib/serializers.js";
import { createAcademicUploadMiddleware, getStorageProvider } from "../lib/storage.js";
import { requireAuth, requireCsrf, requireRoles } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/errorAndValidation.js";
import { createUploadRateLimiter } from "../middleware/security.js";

export function createTeacherAcademicRouter(): Router {
  const teacherAcademicRouter = Router();
  teacherAcademicRouter.use(requireAuth, requireRoles("TEACHER"));

  const upload = createAcademicUploadMiddleware();

function isValidUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

teacherAcademicRouter.get("/dashboard", async (req, res, next) => {
  try {
    const user = req.auth!.user;
    const prisma = getPrismaClient();
    const now = new Date();

    const [
      assignedCoursesCount,
      totalEnrolledStudents,
      publishedAssignmentsCount,
      awaitingGradingCount,
      examsCount,
      publishedAssignments,
      recentSubmissions,
    ] = await Promise.all([
      prisma.course.count({ where: { teacherId: user.id, isActive: true } }),
      prisma.enrollment.count({
        where: { status: "ACTIVE", course: { teacherId: user.id, isActive: true } },
      }),
      prisma.assignment.count({
        where: { course: { teacherId: user.id }, status: "PUBLISHED" },
      }),
      prisma.assignmentSubmission.count({
        where: {
          assignment: { course: { teacherId: user.id } },
          status: { in: ["SUBMITTED", "LATE"] },
        },
      }),
      prisma.exam.count({ where: { course: { teacherId: user.id } } }),
      prisma.assignment.findMany({
        where: { course: { teacherId: user.id }, status: "PUBLISHED" },
        orderBy: { dueAt: "asc" },
        include: {
          course: { select: { code: true } },
          _count: { select: { submissions: true } },
        },
      }),
      prisma.assignmentSubmission.findMany({
        where: { assignment: { course: { teacherId: user.id } } },
        orderBy: { submittedAt: "desc" },
        take: 8,
        include: {
          student: { select: { fullName: true } },
          assignment: {
            select: {
              id: true,
              title: true,
              course: { select: { code: true } },
            },
          },
        },
      }),
    ]);

    // Calculate pending submissions across published active-course assignments
    const activeAssignments = await prisma.assignment.findMany({
      where: { course: { teacherId: user.id, isActive: true }, status: "PUBLISHED" },
      select: {
        courseId: true,
        _count: { select: { submissions: true } },
        course: {
          select: {
            _count: { select: { enrollments: { where: { status: "ACTIVE" } } } },
          },
        },
      },
    });
    let pendingSubmissions = 0;
    for (const a of activeAssignments) {
      pendingSubmissions += Math.max(0, a.course._count.enrollments - a._count.submissions);
    }

    const upcomingDeadlines = publishedAssignments
      .filter((a) => a.dueAt >= now)
      .slice(0, 5)
      .map((a) => ({
        id: a.id,
        title: a.title,
        courseCode: a.course.code,
        dueAt: a.dueAt.toISOString(),
        submissionCount: a._count.submissions,
      }));

    const data: TeacherDashboardStatsDto = {
      profile: toAuthenticatedUserDto(user),
      counts: {
        assignedCourses: assignedCoursesCount,
        totalEnrolledStudents,
        publishedAssignments: publishedAssignmentsCount,
        pendingSubmissions,
        awaitingGrading: awaitingGradingCount,
        exams: examsCount,
      },
      upcomingDeadlines,
      recentSubmissions: recentSubmissions.map((s) => ({
        id: s.id,
        assignmentId: s.assignment.id,
        assignmentTitle: s.assignment.title,
        courseCode: s.assignment.course.code,
        studentName: s.student.fullName,
        status: s.status,
        submittedAt: s.submittedAt.toISOString(),
      })),
    };

    const response: ApiSuccessResponse<TeacherDashboardStatsDto> = {
      success: true,
      data,
      requestId: res.locals.requestId as string | undefined,
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

teacherAcademicRouter.get("/courses", validateQuery(paginationQuerySchema), async (req, res, next) => {
  try {
    const user = req.auth!.user;
    const prisma = getPrismaClient();
    const { page, pageSize, search } = res.locals.validatedQuery as {
      page: number;
      pageSize: number;
      search?: string;
    };

    const where: Prisma.CourseWhereInput = { teacherId: user.id };
    if (search) {
      where.OR = [
        { code: { contains: search, mode: "insensitive" } },
        { title: { contains: search, mode: "insensitive" } },
        { semester: { contains: search, mode: "insensitive" } },
      ];
    }

    const [total, courses] = await Promise.all([
      prisma.course.count({ where }),
      prisma.course.findMany({
        where,
        orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          teacher: { select: { id: true, fullName: true, email: true, status: true } },
          _count: {
            select: {
              enrollments: { where: { status: "ACTIVE" } },
              assignments: true,
              exams: true,
            },
          },
        },
      }),
    ]);

    const response: ApiSuccessResponse<PaginatedResult<CourseSummaryDto>> = {
      success: true,
      data: {
        items: courses.map((c) =>
          toCourseSummaryDto(c, {
            activeEnrollmentCount: c._count.enrollments,
            assignmentCount: c._count.assignments,
            examCount: c._count.exams,
          }),
        ),
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
      requestId: res.locals.requestId as string | undefined,
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

teacherAcademicRouter.get("/courses/:id", async (req, res, next) => {
  try {
    const courseId = req.params.id ?? "";
    if (!isValidUuid(courseId)) {
      next(badRequest("Invalid course ID", "INVALID_ID"));
      return;
    }
    const user = req.auth!.user;
    const prisma = getPrismaClient();
    const course = await prisma.course.findUnique({
      where: { id: courseId },
      include: {
        teacher: { select: { id: true, fullName: true, email: true, status: true } },
        enrollments: {
          orderBy: { enrolledAt: "desc" },
          include: {
            student: { select: { id: true, fullName: true, email: true, status: true } },
          },
        },
        assignments: {
          orderBy: { dueAt: "asc" },
          include: {
            course: { select: { code: true, title: true } },
            attachments: true,
            submissions: {
              select: { status: true, isGradePublished: true },
            },
          },
        },
        exams: { orderBy: { windowStart: "asc" } },
      },
    });

    if (!course) {
      next(notFound("Course not found", "COURSE_NOT_FOUND"));
      return;
    }
    if (course.teacherId !== user.id) {
      next(forbidden("You do not have access to this course", "COURSE_ACCESS_DENIED"));
      return;
    }

    const submissionCounts = await prisma.assignmentSubmission.groupBy({
      by: ["studentId"],
      where: { assignment: { courseId } },
      _count: { _all: true },
    });
    const submissionCountByStudent = new Map<string, number>();
    for (const row of submissionCounts) {
      submissionCountByStudent.set(row.studentId, row._count._all);
    }

    const detail: CourseDetailDto = {
      ...toCourseSummaryDto(course, {
        activeEnrollmentCount: course.enrollments.filter((e) => e.status === "ACTIVE").length,
        assignmentCount: course.assignments.length,
        examCount: course.exams.length,
      }),
      enrollments: course.enrollments.map((e) =>
        toEnrollmentItemDto(e, submissionCountByStudent.get(e.studentId) ?? 0),
      ),
      assignments: course.assignments.map((a) => {
        const totalSubs = a.submissions.length;
        const gradedSubs = a.submissions.filter((s) => s.status === "GRADED").length;
        const publishedGrades = a.submissions.filter((s) => s.isGradePublished).length;
        return toAssignmentSummaryDto(a, {
          submissionStats: {
            totalSubmissions: totalSubs,
            gradedSubmissions: gradedSubs,
            publishedGrades,
            pendingGrading: totalSubs - gradedSubs,
          },
        });
      }),
      exams: course.exams.map(toCourseExamPreviewDto),
    };

    res.json({
      success: true,
      data: detail,
      requestId: res.locals.requestId as string | undefined,
    });
  } catch (err) {
    next(err);
  }
});

teacherAcademicRouter.get(
  "/courses/:id/students",
  validateQuery(teacherCourseStudentsQuerySchema),
  async (req, res, next) => {
    try {
      const courseId = req.params.id ?? "";
      if (!isValidUuid(courseId)) {
        next(badRequest("Invalid course ID", "INVALID_ID"));
        return;
      }
      const user = req.auth!.user;
      const prisma = getPrismaClient();
      const course = await prisma.course.findUnique({ where: { id: courseId } });
      if (!course) {
        next(notFound("Course not found", "COURSE_NOT_FOUND"));
        return;
      }
      if (course.teacherId !== user.id) {
        next(forbidden("You do not have access to this course", "COURSE_ACCESS_DENIED"));
        return;
      }

      const { page, pageSize, search, status } = res.locals.validatedQuery as {
        page: number;
        pageSize: number;
        search?: string;
        status?: "ACTIVE" | "DROPPED" | "COMPLETED";
      };

      const where: Prisma.EnrollmentWhereInput = { courseId };
      if (status) where.status = status;
      if (search) {
        where.student = {
          OR: [
            { fullName: { contains: search, mode: "insensitive" } },
            { email: { contains: search, mode: "insensitive" } },
          ],
        };
      }

      const [total, enrollments] = await Promise.all([
        prisma.enrollment.count({ where }),
        prisma.enrollment.findMany({
          where,
          orderBy: { enrolledAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            student: { select: { id: true, fullName: true, email: true, status: true } },
          },
        }),
      ]);

      const response: ApiSuccessResponse<PaginatedResult<EnrollmentItemDto>> = {
        success: true,
        data: {
          items: enrollments.map((e) => toEnrollmentItemDto(e)),
          total,
          page,
          pageSize,
          totalPages: Math.max(1, Math.ceil(total / pageSize)),
        },
        requestId: res.locals.requestId as string | undefined,
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

teacherAcademicRouter.get(
  "/assignments",
  validateQuery(teacherAssignmentsQuerySchema),
  async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const prisma = getPrismaClient();
      const { page, pageSize, search, courseId, status } = res.locals.validatedQuery as {
        page: number;
        pageSize: number;
        search?: string;
        courseId?: string;
        status?: "DRAFT" | "PUBLISHED" | "ARCHIVED";
      };

      if (courseId) {
        const course = await prisma.course.findUnique({ where: { id: courseId } });
        if (!course) {
          next(notFound("Course not found", "COURSE_NOT_FOUND"));
          return;
        }
        if (course.teacherId !== user.id) {
          next(forbidden("You do not have access to this course", "COURSE_ACCESS_DENIED"));
          return;
        }
      }

      const where: Prisma.AssignmentWhereInput = {
        course: { teacherId: user.id },
      };
      if (courseId) where.courseId = courseId;
      if (status) where.status = status;
      if (search) {
        where.OR = [
          { title: { contains: search, mode: "insensitive" } },
          { description: { contains: search, mode: "insensitive" } },
        ];
      }

      const [total, assignments] = await Promise.all([
        prisma.assignment.count({ where }),
        prisma.assignment.findMany({
          where,
          orderBy: [{ createdAt: "desc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            course: { select: { code: true, title: true } },
            attachments: true,
            submissions: { select: { status: true, isGradePublished: true } },
          },
        }),
      ]);

      const response: ApiSuccessResponse<PaginatedResult<AssignmentSummaryDto>> = {
        success: true,
        data: {
          items: assignments.map((a) => {
            const totalSubs = a.submissions.length;
            const gradedSubs = a.submissions.filter((s) => s.status === "GRADED").length;
            const publishedGrades = a.submissions.filter((s) => s.isGradePublished).length;
            return toAssignmentSummaryDto(a, {
              submissionStats: {
                totalSubmissions: totalSubs,
                gradedSubmissions: gradedSubs,
                publishedGrades,
                pendingGrading: totalSubs - gradedSubs,
              },
            });
          }),
          total,
          page,
          pageSize,
          totalPages: Math.max(1, Math.ceil(total / pageSize)),
        },
        requestId: res.locals.requestId as string | undefined,
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

teacherAcademicRouter.post(
  "/assignments",
  createUploadRateLimiter(),
  requireCsrf,
  upload.array("attachments"),
  validateBody(createAssignmentSchema),
  async (req, res, next) => {
    const storage = getStorageProvider();
    const savedKeys: string[] = [];

    try {
      const auth = req.auth!;
      const prisma = getPrismaClient();
      const body = req.body as {
        courseId: string;
        title: string;
        description?: string;
        instructions?: string;
        maxMarks: number;
        dueAt: string;
        allowLateSubmissions: boolean;
        lateDueAt?: string | null;
        allowResubmission: boolean;
        publishImmediately: boolean;
      };

      const course = await prisma.course.findUnique({ where: { id: body.courseId } });
      if (!course) {
        next(notFound("Course not found", "COURSE_NOT_FOUND"));
        return;
      }
      if (course.teacherId !== auth.user.id) {
        next(forbidden("You can only create assignments for your own courses", "COURSE_ACCESS_DENIED"));
        return;
      }
      if (!course.isActive) {
        next(badRequest("Cannot create assignments in an archived course", "COURSE_ARCHIVED"));
        return;
      }

      const rawFiles = (req.files as Express.Multer.File[] | undefined) ?? [];
      const validatedFiles = rawFiles.map((f) => validateUploadedFile(f));

      const savedAttachments: Array<{
        originalName: string;
        storageKey: string;
        mimeType: string;
        sizeBytes: number;
        sha256: string;
      }> = [];

      for (const vf of validatedFiles) {
        const stored = await storage.saveFile(vf.buffer, {
          folder: "assignments",
          extension: vf.extension,
        });
        savedKeys.push(stored.storageKey);
        savedAttachments.push({
          originalName: vf.originalName,
          storageKey: stored.storageKey,
          mimeType: vf.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
        });
      }

      const now = new Date();
      const primary = savedAttachments[0];
      const status = body.publishImmediately ? "PUBLISHED" : "DRAFT";

      const created = await prisma.$transaction(async (tx) => {
        const assignment = await tx.assignment.create({
          data: {
            courseId: body.courseId,
            createdById: auth.user.id,
            title: body.title,
            description: body.description ?? null,
            instructions: body.instructions ?? null,
            maxMarks: body.maxMarks,
            dueAt: new Date(body.dueAt),
            allowLateSubmissions: body.allowLateSubmissions,
            lateDueAt: body.lateDueAt ? new Date(body.lateDueAt) : null,
            allowResubmission: body.allowResubmission,
            status,
            isPublished: body.publishImmediately,
            publishedAt: body.publishImmediately ? now : null,
            attachmentName: primary?.originalName ?? null,
            attachmentPath: primary?.storageKey ?? null,
            attachmentMimeType: primary?.mimeType ?? null,
            attachmentSizeBytes: primary?.sizeBytes ?? null,
            attachments: savedAttachments.length
              ? {
                  create: savedAttachments.map((att) => ({
                    uploadedById: auth.user.id,
                    originalName: att.originalName,
                    storageKey: att.storageKey,
                    mimeType: att.mimeType,
                    sizeBytes: att.sizeBytes,
                    sha256: att.sha256,
                  })),
                }
              : undefined,
          },
          include: {
            course: { select: { code: true, title: true } },
            attachments: true,
          },
        });

        await writeAuditLog(
          {
            actorId: auth.user.id,
            actorRole: auth.user.role,
            action: AuditAction.ASSIGNMENT_CREATED,
            entityType: "Assignment",
            entityId: assignment.id,
            ipAddress: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
            metadata: {
              courseId: assignment.courseId,
              status: assignment.status,
              attachmentCount: savedAttachments.length,
            },
          },
          tx,
        );
        return assignment;
      });

      res.status(201).json({
        success: true,
        data: toAssignmentSummaryDto(created, {
          submissionStats: {
            totalSubmissions: 0,
            gradedSubmissions: 0,
            publishedGrades: 0,
            pendingGrading: 0,
          },
        }),
        requestId: res.locals.requestId as string | undefined,
      });
    } catch (err) {
      await Promise.allSettled(savedKeys.map((key) => storage.deleteFile(key)));
      next(err);
    }
  },
);

teacherAcademicRouter.get("/assignments/:id", async (req, res, next) => {
  try {
    const assignmentId = req.params.id ?? "";
    if (!isValidUuid(assignmentId)) {
      next(badRequest("Invalid assignment ID", "INVALID_ID"));
      return;
    }
    const user = req.auth!.user;
    const prisma = getPrismaClient();

    const assignment = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: {
        course: { select: { code: true, title: true, teacherId: true } },
        attachments: true,
        submissions: { select: { status: true, isGradePublished: true } },
      },
    });
    if (!assignment) {
      next(notFound("Assignment not found", "ASSIGNMENT_NOT_FOUND"));
      return;
    }
    if (assignment.course.teacherId !== user.id) {
      next(forbidden("You do not have access to this assignment", "ASSIGNMENT_ACCESS_DENIED"));
      return;
    }

    const totalSubs = assignment.submissions.length;
    const gradedSubs = assignment.submissions.filter((s) => s.status === "GRADED").length;
    const publishedGrades = assignment.submissions.filter((s) => s.isGradePublished).length;

    res.json({
      success: true,
      data: toAssignmentSummaryDto(assignment, {
        submissionStats: {
          totalSubmissions: totalSubs,
          gradedSubmissions: gradedSubs,
          publishedGrades,
          pendingGrading: totalSubs - gradedSubs,
        },
      }),
      requestId: res.locals.requestId as string | undefined,
    });
  } catch (err) {
    next(err);
  }
});

teacherAcademicRouter.patch(
  "/assignments/:id",
  requireCsrf,
  validateBody(updateAssignmentSchema),
  async (req, res, next) => {
    try {
      const assignmentId = req.params.id ?? "";
      if (!isValidUuid(assignmentId)) {
        next(badRequest("Invalid assignment ID", "INVALID_ID"));
        return;
      }
      const auth = req.auth!;
      const prisma = getPrismaClient();
      const body = req.body as {
        title?: string;
        description?: string | null;
        instructions?: string | null;
        maxMarks?: number;
        dueAt?: string;
        allowLateSubmissions?: boolean;
        lateDueAt?: string | null;
        allowResubmission?: boolean;
      };

      const existing = await prisma.assignment.findUnique({
        where: { id: assignmentId },
        include: { course: true },
      });
      if (!existing) {
        next(notFound("Assignment not found", "ASSIGNMENT_NOT_FOUND"));
        return;
      }
      if (existing.course.teacherId !== auth.user.id) {
        next(forbidden("You do not have permission to edit this assignment", "ASSIGNMENT_ACCESS_DENIED"));
        return;
      }
      if (existing.status === "ARCHIVED") {
        next(badRequest("Archived assignments cannot be modified", "ASSIGNMENT_ARCHIVED"));
        return;
      }

      const effectiveDue = body.dueAt ? new Date(body.dueAt) : existing.dueAt;
      const effectiveAllowLate = body.allowLateSubmissions ?? existing.allowLateSubmissions;
      const effectiveLateDue =
        body.lateDueAt !== undefined
          ? body.lateDueAt
            ? new Date(body.lateDueAt)
            : null
          : existing.lateDueAt;

      if (effectiveAllowLate && effectiveLateDue && effectiveLateDue <= effectiveDue) {
        next(badRequest("Late deadline must be after the primary due date", "INVALID_DEADLINE"));
        return;
      }

      if (body.maxMarks !== undefined) {
        const highestScore = await prisma.assignmentSubmission.aggregate({
          where: { assignmentId, score: { not: null } },
          _max: { score: true },
        });
        if (highestScore._max.score !== null && body.maxMarks < Number(highestScore._max.score)) {
          next(
            conflict(
              `Cannot lower maxMarks (${body.maxMarks}) below an existing awarded score (${Number(highestScore._max.score)})`,
              "MAX_MARKS_BELOW_GRADED",
            ),
          );
          return;
        }
      }

      const updated = await prisma.$transaction(async (tx) => {
        const assignment = await tx.assignment.update({
          where: { id: assignmentId },
          data: {
            title: body.title,
            description: body.description,
            instructions: body.instructions,
            maxMarks: body.maxMarks,
            dueAt: body.dueAt ? new Date(body.dueAt) : undefined,
            allowLateSubmissions: body.allowLateSubmissions,
            lateDueAt:
              body.lateDueAt === undefined
                ? undefined
                : body.lateDueAt
                  ? new Date(body.lateDueAt)
                  : null,
            allowResubmission: body.allowResubmission,
          },
          include: {
            course: { select: { code: true, title: true } },
            attachments: true,
            submissions: { select: { status: true, isGradePublished: true } },
          },
        });
        await writeAuditLog(
          {
            actorId: auth.user.id,
            actorRole: auth.user.role,
            action: AuditAction.ASSIGNMENT_UPDATED,
            entityType: "Assignment",
            entityId: assignment.id,
            ipAddress: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
            metadata: { changedFields: Object.keys(body) },
          },
          tx,
        );
        return assignment;
      });

      const totalSubs = updated.submissions.length;
      const gradedSubs = updated.submissions.filter((s) => s.status === "GRADED").length;
      const publishedGrades = updated.submissions.filter((s) => s.isGradePublished).length;

      res.json({
        success: true,
        data: toAssignmentSummaryDto(updated, {
          submissionStats: {
            totalSubmissions: totalSubs,
            gradedSubmissions: gradedSubs,
            publishedGrades,
            pendingGrading: totalSubs - gradedSubs,
          },
        }),
        requestId: res.locals.requestId as string | undefined,
      });
    } catch (err) {
      next(err);
    }
  },
);

teacherAcademicRouter.post(
  "/assignments/:id/attachments",
  createUploadRateLimiter(),
  requireCsrf,
  upload.array("attachments"),
  async (req, res, next) => {
    const storage = getStorageProvider();
    const savedKeys: string[] = [];
    try {
      const assignmentId = req.params.id ?? "";
      if (!isValidUuid(assignmentId)) {
        next(badRequest("Invalid assignment ID", "INVALID_ID"));
        return;
      }
      const auth = req.auth!;
      const prisma = getPrismaClient();

      const assignment = await prisma.assignment.findUnique({
        where: { id: assignmentId },
        include: { course: true, attachments: true },
      });
      if (!assignment) {
        next(notFound("Assignment not found", "ASSIGNMENT_NOT_FOUND"));
        return;
      }
      if (assignment.course.teacherId !== auth.user.id) {
        next(forbidden("You do not have permission to upload attachments here", "ASSIGNMENT_ACCESS_DENIED"));
        return;
      }
      if (assignment.status === "ARCHIVED") {
        next(badRequest("Cannot attach files to an archived assignment", "ASSIGNMENT_ARCHIVED"));
        return;
      }

      const rawFiles = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (rawFiles.length === 0) {
        next(badRequest("At least one file is required", "NO_FILES_UPLOADED"));
        return;
      }
      if (assignment.attachments.length + rawFiles.length > 10) {
        next(badRequest("Maximum of 10 attachments per assignment exceeded", "TOO_MANY_FILES"));
        return;
      }

      const validatedFiles = rawFiles.map((f) => validateUploadedFile(f));
      const toCreate: Array<{
        originalName: string;
        storageKey: string;
        mimeType: string;
        sizeBytes: number;
        sha256: string;
      }> = [];

      for (const vf of validatedFiles) {
        const stored = await storage.saveFile(vf.buffer, {
          folder: "assignments",
          extension: vf.extension,
        });
        savedKeys.push(stored.storageKey);
        toCreate.push({
          originalName: vf.originalName,
          storageKey: stored.storageKey,
          mimeType: vf.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
        });
      }

      const updated = await prisma.$transaction(async (tx) => {
        await tx.assignmentAttachment.createMany({
          data: toCreate.map((att) => ({
            assignmentId,
            uploadedById: auth.user.id,
            originalName: att.originalName,
            storageKey: att.storageKey,
            mimeType: att.mimeType,
            sizeBytes: att.sizeBytes,
            sha256: att.sha256,
          })),
        });
        return tx.assignment.findUniqueOrThrow({
          where: { id: assignmentId },
          include: {
            course: { select: { code: true, title: true } },
            attachments: true,
          },
        });
      });

      res.status(201).json({
        success: true,
        data: toAssignmentSummaryDto(updated),
        requestId: res.locals.requestId as string | undefined,
      });
    } catch (err) {
      await Promise.allSettled(savedKeys.map((k) => storage.deleteFile(k)));
      next(err);
    }
  },
);

teacherAcademicRouter.post("/assignments/:id/publish", requireCsrf, async (req, res, next) => {
  try {
    const assignmentId = req.params.id ?? "";
    if (!isValidUuid(assignmentId)) {
      next(badRequest("Invalid assignment ID", "INVALID_ID"));
      return;
    }
    const auth = req.auth!;
    const prisma = getPrismaClient();

    const existing = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { course: true },
    });
    if (!existing) {
      next(notFound("Assignment not found", "ASSIGNMENT_NOT_FOUND"));
      return;
    }
    if (existing.course.teacherId !== auth.user.id) {
      next(forbidden("You do not have permission to publish this assignment", "ASSIGNMENT_ACCESS_DENIED"));
      return;
    }
    if (existing.status === "ARCHIVED") {
      next(badRequest("Archived assignments cannot be published", "ASSIGNMENT_ARCHIVED"));
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const assignment = await tx.assignment.update({
        where: { id: assignmentId },
        data: {
          status: "PUBLISHED",
          isPublished: true,
          publishedAt: existing.publishedAt ?? new Date(),
        },
        include: {
          course: { select: { code: true, title: true } },
          attachments: true,
        },
      });
      await writeAuditLog(
        {
          actorId: auth.user.id,
          actorRole: auth.user.role,
          action: AuditAction.ASSIGNMENT_PUBLISHED,
          entityType: "Assignment",
          entityId: assignment.id,
          ipAddress: req.ip ?? null,
          userAgent: req.get("user-agent") ?? null,
          metadata: { courseId: assignment.courseId },
        },
        tx,
      );
      return assignment;
    });

    res.json({
      success: true,
      data: toAssignmentSummaryDto(updated),
      requestId: res.locals.requestId as string | undefined,
    });
  } catch (err) {
    next(err);
  }
});

teacherAcademicRouter.post("/assignments/:id/archive", requireCsrf, async (req, res, next) => {
  try {
    const assignmentId = req.params.id ?? "";
    if (!isValidUuid(assignmentId)) {
      next(badRequest("Invalid assignment ID", "INVALID_ID"));
      return;
    }
    const auth = req.auth!;
    const prisma = getPrismaClient();

    const existing = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { course: true },
    });
    if (!existing) {
      next(notFound("Assignment not found", "ASSIGNMENT_NOT_FOUND"));
      return;
    }
    if (existing.course.teacherId !== auth.user.id) {
      next(forbidden("You do not have permission to archive this assignment", "ASSIGNMENT_ACCESS_DENIED"));
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const assignment = await tx.assignment.update({
        where: { id: assignmentId },
        data: {
          status: "ARCHIVED",
          isPublished: false,
          archivedAt: new Date(),
        },
        include: {
          course: { select: { code: true, title: true } },
          attachments: true,
        },
      });
      await writeAuditLog(
        {
          actorId: auth.user.id,
          actorRole: auth.user.role,
          action: AuditAction.ASSIGNMENT_ARCHIVED,
          entityType: "Assignment",
          entityId: assignment.id,
          ipAddress: req.ip ?? null,
          userAgent: req.get("user-agent") ?? null,
          metadata: { courseId: assignment.courseId },
        },
        tx,
      );
      return assignment;
    });

    res.json({
      success: true,
      data: toAssignmentSummaryDto(updated),
      requestId: res.locals.requestId as string | undefined,
    });
  } catch (err) {
    next(err);
  }
});

teacherAcademicRouter.get("/assignments/:id/submissions", async (req, res, next) => {
  try {
    const assignmentId = req.params.id ?? "";
    if (!isValidUuid(assignmentId)) {
      next(badRequest("Invalid assignment ID", "INVALID_ID"));
      return;
    }
    const user = req.auth!.user;
    const prisma = getPrismaClient();

    const assignment = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { course: true },
    });
    if (!assignment) {
      next(notFound("Assignment not found", "ASSIGNMENT_NOT_FOUND"));
      return;
    }
    if (assignment.course.teacherId !== user.id) {
      next(forbidden("You do not have access to this assignment's submissions", "ASSIGNMENT_ACCESS_DENIED"));
      return;
    }

    const submissions = await prisma.assignmentSubmission.findMany({
      where: { assignmentId },
      orderBy: { submittedAt: "desc" },
      include: {
        student: { select: { id: true, fullName: true, email: true, status: true } },
        attachments: true,
      },
    });

    const response: ApiSuccessResponse<TeacherSubmissionItemDto[]> = {
      success: true,
      data: submissions.map(toTeacherSubmissionDto),
      requestId: res.locals.requestId as string | undefined,
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

teacherAcademicRouter.post(
  "/assignment-submissions/:submissionId/grade",
  requireCsrf,
  validateBody(gradeAssignmentSubmissionSchema),
  async (req, res, next) => {
    try {
      const submissionId = req.params.submissionId ?? "";
      if (!isValidUuid(submissionId)) {
        next(badRequest("Invalid submission ID", "INVALID_ID"));
        return;
      }
      const auth = req.auth!;
      const prisma = getPrismaClient();
      const { score, feedback, publishGrade } = req.body as {
        score: number;
        feedback?: string;
        publishGrade: boolean;
      };

      const submission = await prisma.assignmentSubmission.findUnique({
        where: { id: submissionId },
        include: {
          assignment: {
            include: { course: true },
          },
        },
      });
      if (!submission) {
        next(notFound("Submission not found", "SUBMISSION_NOT_FOUND"));
        return;
      }
      if (submission.assignment.course.teacherId !== auth.user.id) {
        next(forbidden("You are not authorized to grade this submission", "GRADING_FORBIDDEN"));
        return;
      }

      const maxMarks = Number(submission.assignment.maxMarks);
      if (score > maxMarks) {
        next(
          badRequest(`Score (${score}) cannot exceed maximum marks (${maxMarks})`, "SCORE_EXCEEDS_MAX"),
        );
        return;
      }

      const now = new Date();
      const updated = await prisma.$transaction(async (tx) => {
        const nextPublish = publishGrade ? true : submission.isGradePublished;
        const record = await tx.assignmentSubmission.update({
          where: { id: submissionId },
          data: {
            status: "GRADED",
            score,
            feedback: feedback ?? null,
            gradedById: auth.user.id,
            gradedAt: now,
            isGradePublished: nextPublish,
            gradePublishedAt: nextPublish ? submission.gradePublishedAt ?? now : null,
            gradePublishedById: nextPublish ? auth.user.id : submission.gradePublishedById,
          },
          include: {
            student: { select: { id: true, fullName: true, email: true, status: true } },
            attachments: true,
          },
        });

        await writeAuditLog(
          {
            actorId: auth.user.id,
            actorRole: auth.user.role,
            action: publishGrade
              ? AuditAction.ASSIGNMENT_GRADE_PUBLISHED
              : AuditAction.ASSIGNMENT_GRADED,
            entityType: "AssignmentSubmission",
            entityId: record.id,
            ipAddress: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
            metadata: {
              assignmentId: submission.assignmentId,
              studentId: submission.studentId,
              score,
              published: nextPublish,
            },
          },
          tx,
        );
        return record;
      });

      res.json({
        success: true,
        data: toTeacherSubmissionDto(updated),
        requestId: res.locals.requestId as string | undefined,
      });
    } catch (err) {
      next(err);
    }
  },
);

teacherAcademicRouter.post(
  "/assignment-submissions/:submissionId/publish-grade",
  requireCsrf,
  async (req, res, next) => {
    try {
      const submissionId = req.params.submissionId ?? "";
      if (!isValidUuid(submissionId)) {
        next(badRequest("Invalid submission ID", "INVALID_ID"));
        return;
      }
      const auth = req.auth!;
      const prisma = getPrismaClient();

      const submission = await prisma.assignmentSubmission.findUnique({
        where: { id: submissionId },
        include: { assignment: { include: { course: true } } },
      });
      if (!submission) {
        next(notFound("Submission not found", "SUBMISSION_NOT_FOUND"));
        return;
      }
      if (submission.assignment.course.teacherId !== auth.user.id) {
        next(forbidden("You are not authorized to publish this grade", "GRADING_FORBIDDEN"));
        return;
      }
      if (submission.status !== "GRADED" || submission.score === null) {
        next(badRequest("Submission must be graded before publishing", "SUBMISSION_NOT_GRADED"));
        return;
      }

      const now = new Date();
      const updated = await prisma.$transaction(async (tx) => {
        const record = await tx.assignmentSubmission.update({
          where: { id: submissionId },
          data: {
            isGradePublished: true,
            gradePublishedAt: submission.gradePublishedAt ?? now,
            gradePublishedById: auth.user.id,
          },
          include: {
            student: { select: { id: true, fullName: true, email: true, status: true } },
            attachments: true,
          },
        });
        await writeAuditLog(
          {
            actorId: auth.user.id,
            actorRole: auth.user.role,
            action: AuditAction.ASSIGNMENT_GRADE_PUBLISHED,
            entityType: "AssignmentSubmission",
            entityId: record.id,
            ipAddress: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
            metadata: {
              assignmentId: submission.assignmentId,
              studentId: submission.studentId,
            },
          },
          tx,
        );
        return record;
      });

      res.json({
        success: true,
        data: toTeacherSubmissionDto(updated),
        requestId: res.locals.requestId as string | undefined,
      });
    } catch (err) {
      next(err);
    }
  },
);

  return teacherAcademicRouter;
}
