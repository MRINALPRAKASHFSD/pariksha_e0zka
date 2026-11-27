import type { Express } from "express";
import request from "supertest";
import { hashPassword } from "../src/lib/crypto.js";
import { getPrismaClient } from "../src/lib/prisma.js";

export interface SeededPhase4Actors {
  admin: { id: string; email: string };
  teacher: { id: string; email: string };
  otherTeacher: { id: string; email: string };
  student: { id: string; email: string };
  otherStudent: { id: string; email: string };
  course: { id: string; code: string };
  otherCourse: { id: string; code: string };
}

export async function seedPhase4BaseActors(): Promise<SeededPhase4Actors> {
  const prisma = getPrismaClient();
  const pwHash = await hashPassword("Phase4Pass!2026");

  const [admin, teacher, otherTeacher, student, otherStudent] = await Promise.all([
    prisma.user.create({
      data: {
        email: "admin.p4@pariksha.test",
        fullName: "Admin P4",
        passwordHash: pwHash,
        role: "ADMIN",
        status: "ACTIVE",
      },
    }),
    prisma.user.create({
      data: {
        email: "teacher.p4@pariksha.test",
        fullName: "Teacher P4",
        passwordHash: pwHash,
        role: "TEACHER",
        status: "ACTIVE",
      },
    }),
    prisma.user.create({
      data: {
        email: "otherteacher.p4@pariksha.test",
        fullName: "Other Teacher P4",
        passwordHash: pwHash,
        role: "TEACHER",
        status: "ACTIVE",
      },
    }),
    prisma.user.create({
      data: {
        email: "student.p4@pariksha.test",
        fullName: "Student P4",
        passwordHash: pwHash,
        role: "STUDENT",
        status: "ACTIVE",
      },
    }),
    prisma.user.create({
      data: {
        email: "otherstudent.p4@pariksha.test",
        fullName: "Other Student P4",
        passwordHash: pwHash,
        role: "STUDENT",
        status: "ACTIVE",
      },
    }),
  ]);

  const [course, otherCourse] = await Promise.all([
    prisma.course.create({
      data: {
        code: "CS401",
        title: "Compilers & Examination Systems",
        semester: "Fall 2026",
        teacherId: teacher.id,
        isActive: true,
      },
    }),
    prisma.course.create({
      data: {
        code: "CS499",
        title: "Unassigned Course",
        semester: "Fall 2026",
        teacherId: otherTeacher.id,
        isActive: true,
      },
    }),
  ]);

  await prisma.enrollment.create({
    data: {
      courseId: course.id,
      studentId: student.id,
      status: "ACTIVE",
    },
  });

  return {
    admin: { id: admin.id, email: admin.email },
    teacher: { id: teacher.id, email: teacher.email },
    otherTeacher: { id: otherTeacher.id, email: otherTeacher.email },
    student: { id: student.id, email: student.email },
    otherStudent: { id: otherStudent.id, email: otherStudent.email },
    course: { id: course.id, code: course.code },
    otherCourse: { id: otherCourse.id, code: otherCourse.code },
  };
}

export async function loginAs(
  app: Express,
  email: string,
  password = "Phase4Pass!2026",
): Promise<{ agent: ReturnType<typeof request.agent>; csrf: string }> {
  const agent = request.agent(app);
  const csrfRes = await agent.get("/api/v1/auth/csrf");
  const preAuthCsrf = csrfRes.body.data.csrfToken as string;
  const loginRes = await agent
    .post("/api/v1/auth/login")
    .set("X-CSRF-Token", preAuthCsrf)
    .send({ email, password });

  if (loginRes.status !== 200) {
    throw new Error(`Login failed for ${email}: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }

  return {
    agent,
    csrf: loginRes.body.data.csrfToken as string,
  };
}

export function futureWindowIso(offsetStartMs = -60_000, offsetEndMs = 3_600_000) {
  const now = Date.now();
  return {
    windowStart: new Date(now + offsetStartMs).toISOString(),
    windowEnd: new Date(now + offsetEndMs).toISOString(),
  };
}
