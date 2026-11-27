import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { parse as parseCsv } from "csv-parse/sync";
import {
  AuditAction,
  adminBulkEnrollmentCsvSchema,
  adminCoursesQuerySchema,
  adminCreateCourseSchema,
  adminEnrollStudentSchema,
  adminUpdateCourseSchema,
  adminUpdateEnrollmentSchema,
  paginationQuerySchema,
  type AdminDashboardStatsDto,
  type ApiSuccessResponse,
  type BulkEnrollmentImportResultDto,
  type CourseDetailDto,
  type CourseSummaryDto,
  type EnrollmentItemDto,
  type PaginatedResult,
} from "@pariksha/shared";
import { writeAuditLog } from "../lib/audit.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { getPrismaClient } from "../lib/prisma.js";
import {
  toAssignmentSummaryDto,
  toAuditLogDto,
  toCourseExamPreviewDto,
  toCourseSummaryDto,
  toEnrollmentItemDto,
} from "../lib/serializers.js";
import { requireAuth, requireCsrf, requireRoles } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/errorAndValidation.js";

export const adminAcademicRouter = Router();
adminAcademicRouter.use(requireAuth, requireRoles("ADMIN"));

function isValidUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

adminAcademicRouter.get("/dashboard", async (_req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const [
      totalCourses,
      activeCourses,
      roleGroups,
      statusGroups,
      enrollmentGroups,
      assignmentGroups,
      submissionsCount,
      recentLogs,
    ] = await Promise.all([
      prisma.course.count(),
      prisma.course.count({ where: { isActive: true } }),
      prisma.user.groupBy({ by: ["role"], _count: { _all: true } }),
      prisma.user.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.enrollment.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.assignment.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.assignmentSubmission.count(),
      prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 8 }),
    ]);

    const byRole = { ADMIN: 0, TEACHER: 0, STUDENT: 0 };
    for (const g of roleGroups) byRole[g.role] = g._count._all;

    let activeUsers = 0;
    let inactiveUsers = 0;
    let suspendedUsers = 0;
    for (const g of statusGroups) {
      if (g.status === "ACTIVE") activeUsers = g._count._all;
      if (g.status === "INACTIVE") inactiveUsers = g._count._all;
      if (g.status === "SUSPENDED") suspendedUsers = g._count._all;
    }

    const enrollments = { active: 0, dropped: 0, completed: 0 };
    for (const g of enrollmentGroups) {
      if (g.status === "ACTIVE") enrollments.active = g._count._all;
      if (g.status === "DROPPED") enrollments.dropped = g._count._all;
      if (g.status === "COMPLETED") enrollments.completed = g._count._all;
    }

    let publishedAssignments = 0;
    let draftAssignments = 0;
    let totalAssignments = 0;
    for (const g of assignmentGroups) {
      totalAssignments += g._count._all;
      if (g.status === "PUBLISHED") publishedAssignments = g._count._all;
      if (g.status === "DRAFT") draftAssignments = g._count._all;
    }

    const data: AdminDashboardStatsDto = {
      courses: {
        total: totalCourses,
        active: activeCourses,
        archived: totalCourses - activeCourses,
      },
      users: {
        total: activeUsers + inactiveUsers + suspendedUsers,
        active: activeUsers,
        inactive: inactiveUsers,
        suspended: suspendedUsers,
        byRole,
      },
      enrollments,
      assignments: {
        total: totalAssignments,
        published: publishedAssignments,
        draft: draftAssignments,
        submissions: submissionsCount,
      },
      recentActivity: recentLogs.map(toAuditLogDto),
    };

    const response: ApiSuccessResponse<AdminDashboardStatsDto> = {
      success: true,
      data,
      requestId: res.locals.requestId as string | undefined,
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

adminAcademicRouter.get("/courses", validateQuery(adminCoursesQuerySchema), async (_req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const { page, pageSize, search, isActive, semester, teacherId } = res.locals.validatedQuery as {
      page: number;
      pageSize: number;
      search?: string;
      isActive?: boolean;
      semester?: string;
      teacherId?: string;
    };

    const where: Prisma.CourseWhereInput = {};
    if (isActive !== undefined) where.isActive = isActive;
    if (semester) where.semester = { contains: semester, mode: "insensitive" };
    if (teacherId) where.teacherId = teacherId;
    if (search) {
      where.OR = [
        { code: { contains: search, mode: "insensitive" } },
        { title: { contains: search, mode: "insensitive" } },
        { department: { contains: search, mode: "insensitive" } },
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

adminAcademicRouter.post(
  "/courses",
  requireCsrf,
  validateBody(adminCreateCourseSchema),
  async (req, res, next) => {
    try {
      const auth = req.auth!;
      const prisma = getPrismaClient();
      const body = req.body as {
        code: string;
        title: string;
        description?: string;
        department?: string;
        semester: string;
        capacity?: number | null;
        teacherId: string;
      };

      const [existingCode, teacher] = await Promise.all([
        prisma.course.findUnique({ where: { code: body.code } }),
        prisma.user.findUnique({ where: { id: body.teacherId } }),
      ]);

      if (existingCode) {
        next(conflict(`Course code "${body.code}" already exists`, "COURSE_CODE_EXISTS"));
        return;
      }
      if (!teacher) {
        next(notFound("Assigned teacher account not found", "TEACHER_NOT_FOUND"));
        return;
      }
      if (teacher.role !== "TEACHER") {
        next(badRequest("Assigned instructor must have the TEACHER role", "INVALID_TEACHER_ROLE"));
        return;
      }
      if (teacher.status !== "ACTIVE") {
        next(badRequest("Assigned teacher account is not active", "TEACHER_INACTIVE"));
        return;
      }

      const created = await prisma.$transaction(async (tx) => {
        const course = await tx.course.create({
          data: {
            code: body.code,
            title: body.title,
            description: body.description ?? null,
            department: body.department ?? null,
            semester: body.semester,
            capacity: body.capacity ?? null,
            teacherId: body.teacherId,
            isActive: true,
          },
          include: {
            teacher: { select: { id: true, fullName: true, email: true, status: true } },
          },
        });
        await writeAuditLog(
          {
            actorId: auth.user.id,
            actorRole: auth.user.role,
            action: AuditAction.COURSE_CREATED,
            entityType: "Course",
            entityId: course.id,
            ipAddress: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
            metadata: { code: course.code, title: course.title, teacherId: course.teacherId },
          },
          tx,
        );
        return course;
      });

      const response: ApiSuccessResponse<CourseSummaryDto> = {
        success: true,
        data: toCourseSummaryDto(created, {
          activeEnrollmentCount: 0,
          assignmentCount: 0,
          examCount: 0,
        }),
        requestId: res.locals.requestId as string | undefined,
      };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  },
);

adminAcademicRouter.get("/courses/:id", async (req, res, next) => {
  try {
    const courseId = req.params.id ?? "";
    if (!isValidUuid(courseId)) {
      next(badRequest("Invalid course ID", "INVALID_ID"));
      return;
    }
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
            _count: { select: { submissions: true } },
          },
        },
        exams: {
          orderBy: { windowStart: "asc" },
        },
      },
    });
    if (!course) {
      next(notFound("Course not found", "COURSE_NOT_FOUND"));
      return;
    }

    const activeEnrollmentCount = course.enrollments.filter((e) => e.status === "ACTIVE").length;
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
        activeEnrollmentCount,
        assignmentCount: course.assignments.length,
        examCount: course.exams.length,
      }),
      enrollments: course.enrollments.map((e) =>
        toEnrollmentItemDto(e, submissionCountByStudent.get(e.studentId) ?? 0),
      ),
      assignments: course.assignments.map((a) =>
        toAssignmentSummaryDto(a, {
          submissionStats: {
            totalSubmissions: a._count.submissions,
            gradedSubmissions: 0,
            publishedGrades: 0,
            pendingGrading: 0,
          },
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

adminAcademicRouter.patch(
  "/courses/:id",
  requireCsrf,
  validateBody(adminUpdateCourseSchema),
  async (req, res, next) => {
    try {
      const courseId = req.params.id ?? "";
      if (!isValidUuid(courseId)) {
        next(badRequest("Invalid course ID", "INVALID_ID"));
        return;
      }
      const auth = req.auth!;
      const prisma = getPrismaClient();
      const body = req.body as {
        code?: string;
        title?: string;
        description?: string | null;
        department?: string | null;
        semester?: string;
        capacity?: number | null;
        teacherId?: string;
      };

      const existing = await prisma.course.findUnique({ where: { id: courseId } });
      if (!existing) {
        next(notFound("Course not found", "COURSE_NOT_FOUND"));
        return;
      }

      if (body.code && body.code !== existing.code) {
        const dup = await prisma.course.findUnique({ where: { code: body.code } });
        if (dup) {
          next(conflict(`Course code "${body.code}" is already in use`, "COURSE_CODE_EXISTS"));
          return;
        }
      }

      if (body.teacherId) {
        const teacher = await prisma.user.findUnique({ where: { id: body.teacherId } });
        if (!teacher) {
          next(notFound("Teacher account not found", "TEACHER_NOT_FOUND"));
          return;
        }
        if (teacher.role !== "TEACHER" || teacher.status !== "ACTIVE") {
          next(
            badRequest(
              "Course teacher must be an ACTIVE account with TEACHER role",
              "INVALID_TEACHER",
            ),
          );
          return;
        }
      }

      if (body.capacity !== undefined && body.capacity !== null) {
        const activeCount = await prisma.enrollment.count({
          where: { courseId, status: "ACTIVE" },
        });
        if (body.capacity < activeCount) {
          next(
            conflict(
              `Capacity (${body.capacity}) cannot be lower than current active enrollments (${activeCount})`,
              "CAPACITY_BELOW_ENROLLED",
            ),
          );
          return;
        }
      }

      const updated = await prisma.$transaction(async (tx) => {
        const course = await tx.course.update({
          where: { id: courseId },
          data: body,
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
        });
        await writeAuditLog(
          {
            actorId: auth.user.id,
            actorRole: auth.user.role,
            action: AuditAction.COURSE_UPDATED,
            entityType: "Course",
            entityId: course.id,
            ipAddress: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
            metadata: { changedFields: Object.keys(body) },
          },
          tx,
        );
        return course;
      });

      res.json({
        success: true,
        data: toCourseSummaryDto(updated, {
          activeEnrollmentCount: updated._count.enrollments,
          assignmentCount: updated._count.assignments,
          examCount: updated._count.exams,
        }),
        requestId: res.locals.requestId as string | undefined,
      });
    } catch (err) {
      next(err);
    }
  },
);

adminAcademicRouter.post("/courses/:id/archive", requireCsrf, async (req, res, next) => {
  try {
    const courseId = req.params.id ?? "";
    if (!isValidUuid(courseId)) {
      next(badRequest("Invalid course ID", "INVALID_ID"));
      return;
    }
    const auth = req.auth!;
    const prisma = getPrismaClient();
    const existing = await prisma.course.findUnique({ where: { id: courseId } });
    if (!existing) {
      next(notFound("Course not found", "COURSE_NOT_FOUND"));
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const course = await tx.course.update({
        where: { id: courseId },
        data: { isActive: false, archivedAt: new Date() },
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
      });
      await writeAuditLog(
        {
          actorId: auth.user.id,
          actorRole: auth.user.role,
          action: AuditAction.COURSE_ARCHIVED,
          entityType: "Course",
          entityId: course.id,
          ipAddress: req.ip ?? null,
          userAgent: req.get("user-agent") ?? null,
          metadata: { code: course.code },
        },
        tx,
      );
      return course;
    });

    res.json({
      success: true,
      data: toCourseSummaryDto(updated, {
        activeEnrollmentCount: updated._count.enrollments,
        assignmentCount: updated._count.assignments,
        examCount: updated._count.exams,
      }),
      requestId: res.locals.requestId as string | undefined,
    });
  } catch (err) {
    next(err);
  }
});

adminAcademicRouter.post("/courses/:id/activate", requireCsrf, async (req, res, next) => {
  try {
    const courseId = req.params.id ?? "";
    if (!isValidUuid(courseId)) {
      next(badRequest("Invalid course ID", "INVALID_ID"));
      return;
    }
    const auth = req.auth!;
    const prisma = getPrismaClient();
    const existing = await prisma.course.findUnique({ where: { id: courseId } });
    if (!existing) {
      next(notFound("Course not found", "COURSE_NOT_FOUND"));
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const course = await tx.course.update({
        where: { id: courseId },
        data: { isActive: true, archivedAt: null },
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
      });
      await writeAuditLog(
        {
          actorId: auth.user.id,
          actorRole: auth.user.role,
          action: AuditAction.COURSE_ACTIVATED,
          entityType: "Course",
          entityId: course.id,
          ipAddress: req.ip ?? null,
          userAgent: req.get("user-agent") ?? null,
          metadata: { code: course.code },
        },
        tx,
      );
      return course;
    });

    res.json({
      success: true,
      data: toCourseSummaryDto(updated, {
        activeEnrollmentCount: updated._count.enrollments,
        assignmentCount: updated._count.assignments,
        examCount: updated._count.exams,
      }),
      requestId: res.locals.requestId as string | undefined,
    });
  } catch (err) {
    next(err);
  }
});

adminAcademicRouter.get(
  "/courses/:id/enrollments",
  validateQuery(paginationQuerySchema),
  async (req, res, next) => {
    try {
      const courseId = req.params.id ?? "";
      if (!isValidUuid(courseId)) {
        next(badRequest("Invalid course ID", "INVALID_ID"));
        return;
      }
      const prisma = getPrismaClient();
      const { page, pageSize, search } = res.locals.validatedQuery as {
        page: number;
        pageSize: number;
        search?: string;
      };

      const where: Prisma.EnrollmentWhereInput = { courseId };
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

adminAcademicRouter.post(
  "/courses/:id/enrollments",
  requireCsrf,
  validateBody(adminEnrollStudentSchema),
  async (req, res, next) => {
    try {
      const courseId = req.params.id ?? "";
      if (!isValidUuid(courseId)) {
        next(badRequest("Invalid course ID", "INVALID_ID"));
        return;
      }
      const auth = req.auth!;
      const prisma = getPrismaClient();
      const { studentId } = req.body as { studentId: string };

      const enrollment = await prisma.$transaction(async (tx) => {
        const course = await tx.course.findUnique({ where: { id: courseId } });
        if (!course) {
          throw notFound("Course not found", "COURSE_NOT_FOUND");
        }
        if (!course.isActive) {
          throw badRequest("Cannot enroll students into an archived course", "COURSE_ARCHIVED");
        }

        const student = await tx.user.findUnique({ where: { id: studentId } });
        if (!student) {
          throw notFound("Student account not found", "STUDENT_NOT_FOUND");
        }
        if (student.role !== "STUDENT") {
          throw badRequest("Only STUDENT accounts can be enrolled in courses", "INVALID_ENROLLMENT_ROLE");
        }
        if (student.status !== "ACTIVE") {
          throw badRequest("Cannot enroll an inactive or suspended student", "STUDENT_INACTIVE");
        }

        const existing = await tx.enrollment.findUnique({
          where: { courseId_studentId: { courseId, studentId } },
        });
        if (existing && existing.status === "ACTIVE") {
          throw conflict("Student is already actively enrolled in this course", "DUPLICATE_ENROLLMENT");
        }

        if (course.capacity !== null) {
          const activeCount = await tx.enrollment.count({
            where: { courseId, status: "ACTIVE" },
          });
          if (activeCount >= course.capacity) {
            throw conflict("Course has reached maximum enrollment capacity", "COURSE_CAPACITY_REACHED");
          }
        }

        const record = existing
          ? await tx.enrollment.update({
              where: { id: existing.id },
              data: { status: "ACTIVE" },
              include: {
                student: { select: { id: true, fullName: true, email: true, status: true } },
              },
            })
          : await tx.enrollment.create({
              data: { courseId, studentId, status: "ACTIVE" },
              include: {
                student: { select: { id: true, fullName: true, email: true, status: true } },
              },
            });

        await writeAuditLog(
          {
            actorId: auth.user.id,
            actorRole: auth.user.role,
            action: AuditAction.ENROLLMENT_CREATED,
            entityType: "Enrollment",
            entityId: record.id,
            ipAddress: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
            metadata: { courseId, studentId, reactivated: Boolean(existing) },
          },
          tx,
        );
        return record;
      });

      res.status(201).json({
        success: true,
        data: toEnrollmentItemDto(enrollment),
        requestId: res.locals.requestId as string | undefined,
      });
    } catch (err) {
      next(err);
    }
  },
);

adminAcademicRouter.patch(
  "/enrollments/:enrollmentId",
  requireCsrf,
  validateBody(adminUpdateEnrollmentSchema),
  async (req, res, next) => {
    try {
      const enrollmentId = req.params.enrollmentId ?? "";
      if (!isValidUuid(enrollmentId)) {
        next(badRequest("Invalid enrollment ID", "INVALID_ID"));
        return;
      }
      const auth = req.auth!;
      const prisma = getPrismaClient();
      const { status } = req.body as { status: "ACTIVE" | "DROPPED" | "COMPLETED" };

      const existing = await prisma.enrollment.findUnique({
        where: { id: enrollmentId },
        include: {
          course: true,
          student: { select: { id: true, fullName: true, email: true, status: true } },
        },
      });
      if (!existing) {
        next(notFound("Enrollment not found", "ENROLLMENT_NOT_FOUND"));
        return;
      }

      if (status === "ACTIVE" && existing.status !== "ACTIVE") {
        if (existing.student.status !== "ACTIVE") {
          next(badRequest("Cannot activate enrollment for inactive student", "STUDENT_INACTIVE"));
          return;
        }
        if (existing.course.capacity !== null) {
          const activeCount = await prisma.enrollment.count({
            where: { courseId: existing.courseId, status: "ACTIVE" },
          });
          if (activeCount >= existing.course.capacity) {
            next(conflict("Course capacity reached", "COURSE_CAPACITY_REACHED"));
            return;
          }
        }
      }

      const updated = await prisma.$transaction(async (tx) => {
        const record = await tx.enrollment.update({
          where: { id: enrollmentId },
          data: { status },
          include: {
            student: { select: { id: true, fullName: true, email: true, status: true } },
          },
        });
        await writeAuditLog(
          {
            actorId: auth.user.id,
            actorRole: auth.user.role,
            action:
              status === "DROPPED" ? AuditAction.ENROLLMENT_REMOVED : AuditAction.ENROLLMENT_UPDATED,
            entityType: "Enrollment",
            entityId: record.id,
            ipAddress: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
            metadata: {
              courseId: record.courseId,
              studentId: record.studentId,
              previousStatus: existing.status,
              newStatus: status,
            },
          },
          tx,
        );
        return record;
      });

      res.json({
        success: true,
        data: toEnrollmentItemDto(updated),
        requestId: res.locals.requestId as string | undefined,
      });
    } catch (err) {
      next(err);
    }
  },
);

adminAcademicRouter.post(
  "/courses/:id/enrollments/import",
  requireCsrf,
  validateBody(adminBulkEnrollmentCsvSchema),
  async (req, res, next) => {
    try {
      const courseId = req.params.id ?? "";
      if (!isValidUuid(courseId)) {
        next(badRequest("Invalid course ID", "INVALID_ID"));
        return;
      }
      const auth = req.auth!;
      const prisma = getPrismaClient();
      const { csvContent } = req.body as { csvContent: string };

      let records: Array<Record<string, string>>;
      try {
        records = parseCsv(csvContent, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
        }) as Array<Record<string, string>>;
      } catch {
        next(badRequest("Malformed CSV format", "INVALID_CSV"));
        return;
      }

      if (records.length === 0) {
        next(badRequest("CSV contains no student rows", "EMPTY_CSV"));
        return;
      }
      if (records.length > 500) {
        next(badRequest("Bulk import supports up to 500 rows per batch", "CSV_ROW_LIMIT"));
        return;
      }

      const result = await prisma.$transaction(async (tx) => {
        const course = await tx.course.findUnique({ where: { id: courseId } });
        if (!course) {
          throw notFound("Course not found", "COURSE_NOT_FOUND");
        }
        if (!course.isActive) {
          throw badRequest("Cannot import enrollments into an archived course", "COURSE_ARCHIVED");
        }

        let currentActiveCount = await tx.enrollment.count({
          where: { courseId, status: "ACTIVE" },
        });

        let enrolledCount = 0;
        let reactivatedCount = 0;
        let skippedCount = 0;
        const errors: BulkEnrollmentImportResultDto["errors"] = [];
        const seenEmails = new Set<string>();

        for (let idx = 0; idx < records.length; idx++) {
          const row = records[idx]!;
          const emailKey = Object.keys(row).find((k) => k.trim().toLowerCase() === "email");
          const rawEmail = emailKey ? row[emailKey]?.trim().toLowerCase() ?? "" : "";
          const rowNum = idx + 2; // 1-indexed including header

          if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
            errors.push({ row: rowNum, email: rawEmail, reason: "Invalid or missing email" });
            continue;
          }
          if (seenEmails.has(rawEmail)) {
            skippedCount++;
            continue;
          }
          seenEmails.add(rawEmail);

          const user = await tx.user.findUnique({ where: { email: rawEmail } });
          if (!user) {
            errors.push({ row: rowNum, email: rawEmail, reason: "User account not found" });
            continue;
          }
          if (user.role !== "STUDENT") {
            errors.push({
              row: rowNum,
              email: rawEmail,
              reason: `Account role is ${user.role}, expected STUDENT`,
            });
            continue;
          }
          if (user.status !== "ACTIVE") {
            errors.push({ row: rowNum, email: rawEmail, reason: "Student account is inactive" });
            continue;
          }

          const existing = await tx.enrollment.findUnique({
            where: { courseId_studentId: { courseId, studentId: user.id } },
          });
          if (existing && existing.status === "ACTIVE") {
            skippedCount++;
            continue;
          }

          if (course.capacity !== null && currentActiveCount >= course.capacity) {
            errors.push({ row: rowNum, email: rawEmail, reason: "Course capacity reached" });
            continue;
          }

          if (existing) {
            await tx.enrollment.update({
              where: { id: existing.id },
              data: { status: "ACTIVE" },
            });
            reactivatedCount++;
          } else {
            await tx.enrollment.create({
              data: { courseId, studentId: user.id, status: "ACTIVE" },
            });
            enrolledCount++;
          }
          currentActiveCount++;
        }

        await writeAuditLog(
          {
            actorId: auth.user.id,
            actorRole: auth.user.role,
            action: AuditAction.ENROLLMENT_BULK_IMPORTED,
            entityType: "Course",
            entityId: courseId,
            ipAddress: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
            metadata: { enrolledCount, reactivatedCount, skippedCount, errorCount: errors.length },
          },
          tx,
        );

        return { enrolledCount, reactivatedCount, skippedCount, errors };
      });

      res.json({
        success: true,
        data: result,
        requestId: res.locals.requestId as string | undefined,
      });
    } catch (err) {
      next(err);
    }
  },
);
