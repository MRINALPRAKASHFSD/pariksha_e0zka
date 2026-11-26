import { Router } from "express";
import type { Prisma } from "@prisma/client";
import {
  AuditAction,
  paginationQuerySchema,
  studentAssignmentsQuerySchema,
  studentSubmitAssignmentSchema,
  type ApiSuccessResponse,
  type AssignmentSummaryDto,
  type CourseDetailDto,
  type CourseSummaryDto,
  type PaginatedResult,
  type StudentDashboardStatsDto,
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
  toStudentSubmissionDto,
} from "../lib/serializers.js";
import { createAcademicUploadMiddleware, getStorageProvider } from "../lib/storage.js";
import { requireAuth, requireCsrf, requireRoles } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/errorAndValidation.js";
import { createUploadRateLimiter } from "../middleware/security.js";

export function createStudentAcademicRouter(): Router {
  const studentAcademicRouter = Router();
  studentAcademicRouter.use(requireAuth, requireRoles("STUDENT"));

  const upload = createAcademicUploadMiddleware();

function isValidUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

studentAcademicRouter.get("/dashboard", async (req, res, next) => {
  try {
    const user = req.auth!.user;
    const prisma = getPrismaClient();
    const now = new Date();

    const [
      activeEnrollments,
      publishedAssignments,
      submissions,
      completedAttemptsCount,
      publishedExamResultsCount,
    ] = await Promise.all([
      prisma.enrollment.count({ where: { studentId: user.id, status: "ACTIVE" } }),
      prisma.assignment.findMany({
        where: {
          status: "PUBLISHED",
          isPublished: true,
          course: {
            isActive: true,
            enrollments: { some: { studentId: user.id, status: "ACTIVE" } },
          },
        },
        orderBy: { dueAt: "asc" },
        include: {
          course: { select: { id: true, code: true } },
          submissions: { where: { studentId: user.id } },
        },
      }),
      prisma.assignmentSubmission.findMany({
        where: { studentId: user.id },
        orderBy: { submittedAt: "desc" },
        take: 10,
        include: {
          assignment: {
            select: {
              id: true,
              title: true,
              maxMarks: true,
              course: { select: { code: true } },
            },
          },
        },
      }),
      prisma.examAttempt.count({
        where: {
          studentId: user.id,
          status: { in: ["SUBMITTED", "AUTO_SUBMITTED", "EXPIRED"] },
        },
      }),
      prisma.result.count({ where: { studentId: user.id, isPublished: true } }),
    ]);

    const submittedAssignmentIds = new Set<string>();
    for (const a of publishedAssignments) {
      if (a.submissions.length > 0) submittedAssignmentIds.add(a.id);
    }
    const pendingAssignments = publishedAssignments.filter(
      (a) => !submittedAssignmentIds.has(a.id),
    ).length;

    const totalSubmittedCount = await prisma.assignmentSubmission.count({
      where: { studentId: user.id },
    });
    const publishedGradesCount = await prisma.assignmentSubmission.count({
      where: { studentId: user.id, isGradePublished: true },
    });

    const upcomingDeadlines = publishedAssignments
      .filter((a) => a.dueAt >= now || (a.allowLateSubmissions && (!a.lateDueAt || a.lateDueAt >= now)))
      .slice(0, 6)
      .map((a) => ({
        id: a.id,
        title: a.title,
        courseId: a.course.id,
        courseCode: a.course.code,
        dueAt: a.dueAt.toISOString(),
        allowLateSubmissions: a.allowLateSubmissions,
        submitted: a.submissions.length > 0,
      }));

    const data: StudentDashboardStatsDto = {
      profile: toAuthenticatedUserDto(user),
      counts: {
        activeEnrollments,
        pendingAssignments,
        submittedAssignments: totalSubmittedCount,
        publishedGrades: publishedGradesCount,
        completedAttempts: completedAttemptsCount,
        publishedExamResults: publishedExamResultsCount,
      },
      upcomingDeadlines,
      recentActivity: submissions.map((s) => ({
        id: s.id,
        assignmentId: s.assignment.id,
        assignmentTitle: s.assignment.title,
        courseCode: s.assignment.course.code,
        status: s.isGradePublished || s.status !== "GRADED" ? s.status : "SUBMITTED",
        submittedAt: s.submittedAt.toISOString(),
        isGradePublished: s.isGradePublished,
        score: s.isGradePublished && s.score !== null ? Number(s.score) : null,
        maxMarks: Number(s.assignment.maxMarks),
      })),
    };

    const response: ApiSuccessResponse<StudentDashboardStatsDto> = {
      success: true,
      data,
      requestId: res.locals.requestId as string | undefined,
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

studentAcademicRouter.get("/courses", validateQuery(paginationQuerySchema), async (req, res, next) => {
  try {
    const user = req.auth!.user;
    const prisma = getPrismaClient();
    const { page, pageSize, search } = res.locals.validatedQuery as {
      page: number;
      pageSize: number;
      search?: string;
    };

    const where: Prisma.CourseWhereInput = {
      enrollments: { some: { studentId: user.id, status: "ACTIVE" } },
    };
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
              assignments: { where: { status: "PUBLISHED", isPublished: true } },
              exams: { where: { status: { in: ["APPROVED", "ACTIVE", "COMPLETED"] } } },
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

studentAcademicRouter.get("/courses/:id", async (req, res, next) => {
  try {
    const courseId = req.params.id ?? "";
    if (!isValidUuid(courseId)) {
      next(badRequest("Invalid course ID", "INVALID_ID"));
      return;
    }
    const user = req.auth!.user;
    const prisma = getPrismaClient();

    const enrollment = await prisma.enrollment.findUnique({
      where: { courseId_studentId: { courseId, studentId: user.id } },
    });
    if (!enrollment || enrollment.status !== "ACTIVE") {
      next(forbidden("You are not actively enrolled in this course", "ENROLLMENT_REQUIRED"));
      return;
    }

    const course = await prisma.course.findUnique({
      where: { id: courseId },
      include: {
        teacher: { select: { id: true, fullName: true, email: true, status: true } },
        _count: { select: { enrollments: { where: { status: "ACTIVE" } } } },
        assignments: {
          where: { status: "PUBLISHED", isPublished: true },
          orderBy: { dueAt: "asc" },
          include: {
            course: { select: { code: true, title: true } },
            attachments: true,
            submissions: {
              where: { studentId: user.id },
              include: { attachments: true },
            },
          },
        },
        exams: {
          where: { status: { in: ["APPROVED", "ACTIVE", "COMPLETED"] } },
          orderBy: { windowStart: "asc" },
        },
      },
    });
    if (!course) {
      next(notFound("Course not found", "COURSE_NOT_FOUND"));
      return;
    }

    const detail: CourseDetailDto = {
      ...toCourseSummaryDto(course, {
        activeEnrollmentCount: course._count.enrollments,
        assignmentCount: course.assignments.length,
        examCount: course.exams.length,
      }),
      enrollments: [],
      assignments: course.assignments.map((a) =>
        toAssignmentSummaryDto(a, {
          mySubmission: a.submissions[0] ? toStudentSubmissionDto(a.submissions[0]) : null,
        }),
      ),
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

studentAcademicRouter.get(
  "/assignments",
  validateQuery(studentAssignmentsQuerySchema),
  async (req, res, next) => {
    try {
      const user = req.auth!.user;
      const prisma = getPrismaClient();
      const { page, pageSize, search, courseId, filter } = res.locals.validatedQuery as {
        page: number;
        pageSize: number;
        search?: string;
        courseId?: string;
        filter: "all" | "pending" | "upcoming" | "completed";
      };

      if (courseId) {
        const enrollment = await prisma.enrollment.findUnique({
          where: { courseId_studentId: { courseId, studentId: user.id } },
        });
        if (!enrollment || enrollment.status !== "ACTIVE") {
          next(forbidden("You are not actively enrolled in this course", "ENROLLMENT_REQUIRED"));
          return;
        }
      }

      const now = new Date();
      const where: Prisma.AssignmentWhereInput = {
        status: "PUBLISHED",
        isPublished: true,
        course: {
          enrollments: { some: { studentId: user.id, status: "ACTIVE" } },
        },
      };
      if (courseId) where.courseId = courseId;
      if (search) {
        where.OR = [
          { title: { contains: search, mode: "insensitive" } },
          { description: { contains: search, mode: "insensitive" } },
        ];
      }
      if (filter === "pending") {
        where.submissions = { none: { studentId: user.id } };
      } else if (filter === "upcoming") {
        where.dueAt = { gte: now };
        where.submissions = { none: { studentId: user.id } };
      } else if (filter === "completed") {
        where.submissions = { some: { studentId: user.id } };
      }

      const [total, assignments] = await Promise.all([
        prisma.assignment.count({ where }),
        prisma.assignment.findMany({
          where,
          orderBy: { dueAt: "asc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            course: { select: { code: true, title: true } },
            attachments: true,
            submissions: {
              where: { studentId: user.id },
              include: { attachments: true },
            },
          },
        }),
      ]);

      const response: ApiSuccessResponse<PaginatedResult<AssignmentSummaryDto>> = {
        success: true,
        data: {
          items: assignments.map((a) =>
            toAssignmentSummaryDto(a, {
              mySubmission: a.submissions[0] ? toStudentSubmissionDto(a.submissions[0]) : null,
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
  },
);

studentAcademicRouter.get("/assignments/:id", async (req, res, next) => {
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
        course: { select: { id: true, code: true, title: true } },
        attachments: true,
        submissions: {
          where: { studentId: user.id },
          include: { attachments: true },
        },
      },
    });
    if (!assignment) {
      next(notFound("Assignment not found", "ASSIGNMENT_NOT_FOUND"));
      return;
    }

    const enrollment = await prisma.enrollment.findUnique({
      where: { courseId_studentId: { courseId: assignment.courseId, studentId: user.id } },
    });
    if (!enrollment || enrollment.status !== "ACTIVE") {
      next(forbidden("You are not actively enrolled in this course", "ENROLLMENT_REQUIRED"));
      return;
    }
    if (assignment.status !== "PUBLISHED" || !assignment.isPublished) {
      next(notFound("Assignment is not published", "ASSIGNMENT_NOT_PUBLISHED"));
      return;
    }

    res.json({
      success: true,
      data: toAssignmentSummaryDto(assignment, {
        mySubmission: assignment.submissions[0]
          ? toStudentSubmissionDto(assignment.submissions[0])
          : null,
      }),
      requestId: res.locals.requestId as string | undefined,
    });
  } catch (err) {
    next(err);
  }
});

studentAcademicRouter.post(
  "/assignments/:id/submit",
  createUploadRateLimiter(),
  requireCsrf,
  upload.array("files"),
  validateBody(studentSubmitAssignmentSchema),
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
      const { notes } = req.body as { notes?: string };

      const rawFiles = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (rawFiles.length === 0) {
        next(badRequest("Please upload at least one submission file", "NO_FILES_UPLOADED"));
        return;
      }

      const assignment = await prisma.assignment.findUnique({
        where: { id: assignmentId },
        include: { course: true },
      });
      if (!assignment) {
        next(notFound("Assignment not found", "ASSIGNMENT_NOT_FOUND"));
        return;
      }

      const enrollment = await prisma.enrollment.findUnique({
        where: { courseId_studentId: { courseId: assignment.courseId, studentId: auth.user.id } },
      });
      if (!enrollment || enrollment.status !== "ACTIVE") {
        next(forbidden("You must be actively enrolled to submit this assignment", "ENROLLMENT_REQUIRED"));
        return;
      }
      if (!assignment.course.isActive) {
        next(badRequest("Course is archived and no longer accepts submissions", "COURSE_ARCHIVED"));
        return;
      }
      if (assignment.status !== "PUBLISHED" || !assignment.isPublished) {
        next(badRequest("Assignment is not open for submission", "ASSIGNMENT_NOT_PUBLISHED"));
        return;
      }

      // Server-side UTC deadline check
      const now = new Date();
      let isLate = false;
      if (now > assignment.dueAt) {
        if (!assignment.allowLateSubmissions) {
          next(
            badRequest(
              "The assignment deadline has passed and late submissions are not permitted",
              "DEADLINE_PASSED",
            ),
          );
          return;
        }
        if (assignment.lateDueAt && now > assignment.lateDueAt) {
          next(badRequest("The late submission cutoff has passed", "LATE_DEADLINE_PASSED"));
          return;
        }
        isLate = true;
      }

      const existingSubmission = await prisma.assignmentSubmission.findUnique({
        where: { assignmentId_studentId: { assignmentId, studentId: auth.user.id } },
        include: { attachments: true },
      });
      if (existingSubmission) {
        if (!assignment.allowResubmission) {
          next(
            conflict(
              "Resubmissions are not permitted for this assignment",
              "RESUBMISSION_NOT_ALLOWED",
            ),
          );
          return;
        }
        if (existingSubmission.status === "GRADED" || existingSubmission.isGradePublished) {
          next(
            conflict(
              "This submission has already been graded and cannot be overwritten",
              "SUBMISSION_ALREADY_GRADED",
            ),
          );
          return;
        }
      }

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
          folder: "submissions",
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

      const primary = savedAttachments[0]!;
      const oldStorageKeys = existingSubmission
        ? existingSubmission.attachments.map((a) => a.storageKey)
        : [];

      const saved = await prisma.$transaction(async (tx) => {
        // Re-check inside transaction for concurrency safety
        const currentExisting = await tx.assignmentSubmission.findUnique({
          where: { assignmentId_studentId: { assignmentId, studentId: auth.user.id } },
        });
        if (currentExisting && !assignment.allowResubmission) {
          throw conflict("Resubmissions are not permitted", "RESUBMISSION_NOT_ALLOWED");
        }
        if (currentExisting && (currentExisting.status === "GRADED" || currentExisting.isGradePublished)) {
          throw conflict("Submission already graded", "SUBMISSION_ALREADY_GRADED");
        }

        const submission = currentExisting
          ? await tx.assignmentSubmission.update({
              where: { id: currentExisting.id },
              data: {
                notes: notes ?? null,
                fileName: primary.originalName,
                filePath: primary.storageKey,
                fileMimeType: primary.mimeType,
                fileSizeBytes: primary.sizeBytes,
                status: isLate ? "LATE" : "SUBMITTED",
                submissionCount: currentExisting.submissionCount + 1,
                submittedAt: now,
                attachments: {
                  deleteMany: {},
                  create: savedAttachments.map((att) => ({
                    uploadedById: auth.user.id,
                    originalName: att.originalName,
                    storageKey: att.storageKey,
                    mimeType: att.mimeType,
                    sizeBytes: att.sizeBytes,
                    sha256: att.sha256,
                  })),
                },
              },
              include: { attachments: true },
            })
          : await tx.assignmentSubmission.create({
              data: {
                assignmentId,
                studentId: auth.user.id,
                notes: notes ?? null,
                fileName: primary.originalName,
                filePath: primary.storageKey,
                fileMimeType: primary.mimeType,
                fileSizeBytes: primary.sizeBytes,
                status: isLate ? "LATE" : "SUBMITTED",
                submittedAt: now,
                attachments: {
                  create: savedAttachments.map((att) => ({
                    uploadedById: auth.user.id,
                    originalName: att.originalName,
                    storageKey: att.storageKey,
                    mimeType: att.mimeType,
                    sizeBytes: att.sizeBytes,
                    sha256: att.sha256,
                  })),
                },
              },
              include: { attachments: true },
            });

        await writeAuditLog(
          {
            actorId: auth.user.id,
            actorRole: auth.user.role,
            action: AuditAction.ASSIGNMENT_SUBMITTED,
            entityType: "AssignmentSubmission",
            entityId: submission.id,
            ipAddress: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
            metadata: {
              assignmentId,
              isLate,
              resubmission: Boolean(currentExisting),
              fileCount: savedAttachments.length,
            },
          },
          tx,
        );
        return submission;
      });

      if (oldStorageKeys.length > 0) {
        await Promise.allSettled(oldStorageKeys.map((k) => storage.deleteFile(k)));
      }

      res.status(existingSubmission ? 200 : 201).json({
        success: true,
        data: toStudentSubmissionDto(saved),
        requestId: res.locals.requestId as string | undefined,
      });
    } catch (err) {
      await Promise.allSettled(savedKeys.map((k) => storage.deleteFile(k)));
      next(err);
    }
  },
);

studentAcademicRouter.get("/assignment-submissions", async (req, res, next) => {
  try {
    const user = req.auth!.user;
    const prisma = getPrismaClient();

    const submissions = await prisma.assignmentSubmission.findMany({
      where: { studentId: user.id },
      orderBy: { submittedAt: "desc" },
      include: {
        attachments: true,
        assignment: {
          select: {
            id: true,
            title: true,
            maxMarks: true,
            dueAt: true,
            course: { select: { id: true, code: true, title: true } },
          },
        },
      },
    });

    res.json({
      success: true,
      data: submissions.map((s) => ({
        ...toStudentSubmissionDto(s),
        assignment: {
          id: s.assignment.id,
          title: s.assignment.title,
          maxMarks: Number(s.assignment.maxMarks),
          dueAt: s.assignment.dueAt.toISOString(),
          course: s.assignment.course,
        },
      })),
      requestId: res.locals.requestId as string | undefined,
    });
  } catch (err) {
    next(err);
  }
});

  return studentAcademicRouter;
}
