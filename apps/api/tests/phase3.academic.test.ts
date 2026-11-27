import fs from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { getEnv, resetEnvCacheForTest } from "../src/config/env.js";
import { hashPassword } from "../src/lib/crypto.js";
import { disconnectPrisma, getPrismaClient } from "../src/lib/prisma.js";
import { LocalDiskStorageProvider } from "../src/lib/storage.js";
import { resetTestDatabase } from "./testDbGuard.js";

/**
 * Build a minimal valid uncompressed ZIP buffer for OOXML (.docx) signature tests.
 */
function buildMinimalZipBuffer(entries: Array<{ name: string; content: string }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const dataBuf = Buffer.from(entry.content, "utf8");

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(dataBuf.length, 18);
    localHeader.writeUInt32LE(dataBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);

    localParts.push(localHeader, nameBuf, dataBuf);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(dataBuf.length, 20);
    centralHeader.writeUInt32LE(dataBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + dataBuf.length;
  }

  const centralSize = centralParts.reduce((acc, b) => acc + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function validPdfBuffer(label = "Pariksha Academic Handout"): Buffer {
  return Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n`, "utf8");
}

function validDocxBuffer(): Buffer {
  return buildMinimalZipBuffer([
    { name: "[Content_Types].xml", content: "<Types></Types>" },
    { name: "word/document.xml", content: "<w:document/>" },
  ]);
}

describe("Phase 3 Academic Management, Secure Uploads & Portals", () => {
  const prisma = getPrismaClient();
  const app = createApp();

  async function cleanTestUploadsDir() {
    const env = getEnv();
    const resolved = path.resolve(env.UPLOAD_DIR);
    if (!resolved.includes("pariksha-test-uploads")) {
      throw new Error(`Refusing to delete non-test upload dir: ${resolved}`);
    }
    await fs.rm(resolved, { recursive: true, force: true });
  }

  async function seedUsers() {
    const pass = await hashPassword("Phase3Pass!2026");
    const [admin, teacher1, teacher2, student1, student2, inactiveStudent] = await Promise.all([
      prisma.user.create({
        data: { email: "admin@pariksha.test", fullName: "Admin", passwordHash: pass, role: "ADMIN" },
      }),
      prisma.user.create({
        data: {
          email: "teacher1@pariksha.test",
          fullName: "Dr. Rao",
          passwordHash: pass,
          role: "TEACHER",
        },
      }),
      prisma.user.create({
        data: {
          email: "teacher2@pariksha.test",
          fullName: "Prof. Sen",
          passwordHash: pass,
          role: "TEACHER",
        },
      }),
      prisma.user.create({
        data: {
          email: "student1@pariksha.test",
          fullName: "Aarav Student",
          passwordHash: pass,
          role: "STUDENT",
        },
      }),
      prisma.user.create({
        data: {
          email: "student2@pariksha.test",
          fullName: "Meera Student",
          passwordHash: pass,
          role: "STUDENT",
        },
      }),
      prisma.user.create({
        data: {
          email: "inactive.stu@pariksha.test",
          fullName: "Inactive Student",
          passwordHash: pass,
          role: "STUDENT",
          status: "INACTIVE",
        },
      }),
    ]);
    return { admin, teacher1, teacher2, student1, student2, inactiveStudent };
  }

  async function loginAs(email: string, targetApp = app) {
    const agent = request.agent(targetApp);
    const csrfRes = await agent.get("/api/v1/auth/csrf");
    const preCsrf = csrfRes.body.data.csrfToken as string;
    const loginRes = await agent
      .post("/api/v1/auth/login")
      .set("X-CSRF-Token", preCsrf)
      .send({ email, password: "Phase3Pass!2026" });
    expect(loginRes.status).toBe(200);
    return { agent, csrf: loginRes.body.data.csrfToken as string };
  }

  beforeEach(async () => {
    await resetTestDatabase();
    await cleanTestUploadsDir();
  });

  afterAll(async () => {
    await resetTestDatabase();
    await cleanTestUploadsDir();
    await disconnectPrisma();
  });

  it("1-6, 27, 28, 29. Admin course & enrollment lifecycle, CSV bulk import, archival preservation, and audit logs", async () => {
    const { teacher1, teacher2, student1, student2, inactiveStudent } = await seedUsers();
    const { agent: adminAgent, csrf } = await loginAs("admin@pariksha.test");

    // 29. Unauthenticated & missing CSRF rejected
    expect((await request(app).get("/api/v1/admin/courses")).status).toBe(401);
    expect(
      (
        await adminAgent.post("/api/v1/admin/courses").send({
          code: "CS101",
          title: "Algorithms",
          semester: "Fall 2026",
          teacherId: teacher1.id,
        })
      ).status,
    ).toBe(403);

    // 2. Assigning non-teacher fails
    const badTeacher = await adminAgent
      .post("/api/v1/admin/courses")
      .set("X-CSRF-Token", csrf)
      .send({
        code: "CS101",
        title: "Algorithms",
        semester: "Fall 2026",
        teacherId: student1.id,
      });
    expect(badTeacher.status).toBe(400);

    // 1. Admin creates and edits course
    const createCourse = await adminAgent
      .post("/api/v1/admin/courses")
      .set("X-CSRF-Token", csrf)
      .send({
        code: "cs301",
        title: "Operating Systems",
        description: "Kernel & concurrency",
        department: "CS",
        semester: "Fall 2026",
        capacity: 2,
        teacherId: teacher1.id,
      });
    expect(createCourse.status).toBe(201);
    expect(createCourse.body.data.code).toBe("CS301");
    const courseId = createCourse.body.data.id as string;

    const editCourse = await adminAgent
      .patch(`/api/v1/admin/courses/${courseId}`)
      .set("X-CSRF-Token", csrf)
      .send({ title: "Operating Systems & Concurrency", teacherId: teacher2.id });
    expect(editCourse.status).toBe(200);
    expect(editCourse.body.data.title).toBe("Operating Systems & Concurrency");

    // Reassign back to teacher1
    await adminAgent
      .patch(`/api/v1/admin/courses/${courseId}`)
      .set("X-CSRF-Token", csrf)
      .send({ teacherId: teacher1.id });

    // 3, 4, 5. Enroll student, reject duplicate, reject wrong role
    const enroll1 = await adminAgent
      .post(`/api/v1/admin/courses/${courseId}/enrollments`)
      .set("X-CSRF-Token", csrf)
      .send({ studentId: student1.id });
    expect(enroll1.status).toBe(201);

    const dupEnroll = await adminAgent
      .post(`/api/v1/admin/courses/${courseId}/enrollments`)
      .set("X-CSRF-Token", csrf)
      .send({ studentId: student1.id });
    expect(dupEnroll.status).toBe(409);

    const wrongRoleEnroll = await adminAgent
      .post(`/api/v1/admin/courses/${courseId}/enrollments`)
      .set("X-CSRF-Token", csrf)
      .send({ studentId: teacher1.id });
    expect(wrongRoleEnroll.status).toBe(400);

    // 6. Bulk CSV import
    const csvRes = await adminAgent
      .post(`/api/v1/admin/courses/${courseId}/enrollments/import`)
      .set("X-CSRF-Token", csrf)
      .send({
        csvContent: [
          "email",
          student1.email, // already active -> skip
          student2.email, // valid -> enroll
          inactiveStudent.email, // inactive -> error
          teacher1.email, // invalid role -> error
          "missing@pariksha.test", // missing -> error
        ].join("\n"),
      });
    expect(csvRes.status).toBe(200);
    expect(csvRes.body.data.enrolledCount).toBe(1);
    expect(csvRes.body.data.skippedCount).toBe(1);
    expect(csvRes.body.data.errors).toHaveLength(3);

    // 27. Archival preserves historical academic records
    const archiveRes = await adminAgent
      .post(`/api/v1/admin/courses/${courseId}/archive`)
      .set("X-CSRF-Token", csrf);
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.data.isActive).toBe(false);

    const detailAfterArchive = await adminAgent.get(`/api/v1/admin/courses/${courseId}`);
    expect(detailAfterArchive.status).toBe(200);
    expect(detailAfterArchive.body.data.enrollments).toHaveLength(2);

    // 28. Audit logs recorded
    const logsRes = await adminAgent.get("/api/v1/admin/audit-logs?pageSize=20");
    expect(logsRes.status).toBe(200);
    const actions = (logsRes.body.data.items as Array<{ action: string }>).map((l) => l.action);
    expect(actions).toContain("COURSE_CREATED");
    expect(actions).toContain("ENROLLMENT_CREATED");
    expect(actions).toContain("ENROLLMENT_BULK_IMPORTED");
    expect(actions).toContain("COURSE_ARCHIVED");
  });

  it("7-26. Teacher & student course isolation, assignment lifecycle, secure uploads/downloads, deadlines, resubmissions, grading, publication & dashboards", async () => {
    const { teacher1, student1 } = await seedUsers();
    const { agent: adminAgent, csrf: adminCsrf } = await loginAs("admin@pariksha.test");

    const cRes = await adminAgent
      .post("/api/v1/admin/courses")
      .set("X-CSRF-Token", adminCsrf)
      .send({
        code: "CS401",
        title: "Distributed Systems",
        semester: "Fall 2026",
        teacherId: teacher1.id,
      });
    const courseId = cRes.body.data.id as string;

    await adminAgent
      .post(`/api/v1/admin/courses/${courseId}/enrollments`)
      .set("X-CSRF-Token", adminCsrf)
      .send({ studentId: student1.id });

    // 7 & 8. Teacher1 accesses assigned course; Teacher2 is blocked
    const { agent: t1Agent, csrf: t1Csrf } = await loginAs("teacher1@pariksha.test");
    const { agent: t2Agent, csrf: t2Csrf } = await loginAs("teacher2@pariksha.test");

    expect((await t1Agent.get(`/api/v1/teacher/courses/${courseId}`)).status).toBe(200);
    expect((await t2Agent.get(`/api/v1/teacher/courses/${courseId}`)).status).toBe(403);
    expect((await t2Agent.get(`/api/v1/teacher/courses/${courseId}/students`)).status).toBe(403);

    // 9 & 10. Student1 accesses enrolled course; Student2 (not enrolled) is blocked
    const { agent: s1Agent, csrf: s1Csrf } = await loginAs("student1@pariksha.test");
    const { agent: s2Agent, csrf: s2Csrf } = await loginAs("student2@pariksha.test");

    expect((await s1Agent.get(`/api/v1/student/courses/${courseId}`)).status).toBe(200);
    expect((await s2Agent.get(`/api/v1/student/courses/${courseId}`)).status).toBe(403);

    // 14 & 15. Dangerous files rejected, valid PDF & DOCX accepted
    const futureDue = new Date(Date.now() + 3_600_000).toISOString();

    const exeReject = await t1Agent
      .post("/api/v1/teacher/assignments")
      .set("X-CSRF-Token", t1Csrf)
      .field("courseId", courseId)
      .field("title", "Lab 1")
      .field("maxMarks", "50")
      .field("dueAt", futureDue)
      .attach("attachments", Buffer.from("MZ\x90\x00"), {
        filename: "malware.exe",
        contentType: "application/octet-stream",
      });
    expect(exeReject.status).toBe(400);

    const macroReject = await t1Agent
      .post("/api/v1/teacher/assignments")
      .set("X-CSRF-Token", t1Csrf)
      .field("courseId", courseId)
      .field("title", "Lab 1")
      .field("maxMarks", "50")
      .field("dueAt", futureDue)
      .attach(
        "attachments",
        buildMinimalZipBuffer([
          { name: "[Content_Types].xml", content: "<Types/>" },
          { name: "word/document.xml", content: "<w:document/>" },
          { name: "word/vbaProject.bin", content: "macro" },
        ]),
        {
          filename: "tricky.docx",
          contentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      );
    expect(macroReject.status).toBe(400);

    // 11. Teacher1 creates DRAFT assignment with valid PDF + DOCX
    const draftRes = await t1Agent
      .post("/api/v1/teacher/assignments")
      .set("X-CSRF-Token", t1Csrf)
      .field("courseId", courseId)
      .field("title", "Raft Consensus Lab")
      .field("description", "Implement leader election")
      .field("maxMarks", "50")
      .field("dueAt", futureDue)
      .field("allowResubmission", "true")
      .attach("attachments", validPdfBuffer(), {
        filename: "../../handout.pdf",
        contentType: "application/pdf",
      })
      .attach("attachments", validDocxBuffer(), {
        filename: "rubric.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
    expect(draftRes.status).toBe(201);
    expect(draftRes.body.data.status).toBe("DRAFT");
    expect(draftRes.body.data.attachments).toHaveLength(2);
    // Original filename sanitized against path traversal
    expect(draftRes.body.data.attachments[0].originalName).toBe("handout.pdf");
    const assignmentId = draftRes.body.data.id as string;
    const attachmentId = draftRes.body.data.attachments[0].id as string;

    // 13 & 18. Student1 cannot view unpublished assignment or download its attachments; Teacher2 cannot download
    expect((await s1Agent.get(`/api/v1/student/assignments/${assignmentId}`)).status).toBe(404);
    expect((await s1Agent.get(`/api/v1/files/assignment-attachments/${attachmentId}`)).status).toBe(403);
    expect((await t2Agent.get(`/api/v1/files/assignment-attachments/${attachmentId}`)).status).toBe(403);

    // 12. Teacher1 publishes assignment
    const pubRes = await t1Agent
      .post(`/api/v1/teacher/assignments/${assignmentId}/publish`)
      .set("X-CSRF-Token", t1Csrf);
    expect(pubRes.status).toBe(200);
    expect(pubRes.body.data.status).toBe("PUBLISHED");

    // 18b. Student1 downloads authorized attachment with security headers; Student2 still blocked
    const dl1 = await s1Agent.get(`/api/v1/files/assignment-attachments/${attachmentId}`);
    expect(dl1.status).toBe(200);
    expect(dl1.headers["x-content-type-options"]).toBe("nosniff");
    expect(dl1.headers["content-disposition"]).toContain("attachment");
    expect((await s2Agent.get(`/api/v1/files/assignment-attachments/${attachmentId}`)).status).toBe(403);

    // 17. Storage path traversal rejected directly
    const storage = new LocalDiskStorageProvider(getEnv().UPLOAD_DIR);
    await expect(storage.openReadStream("../../etc/passwd")).rejects.toThrow(/Invalid storage key/i);

    // 16. Oversized upload rejected
    const prevMaxBytes = process.env.MAX_UPLOAD_SIZE_BYTES;
    process.env.MAX_UPLOAD_SIZE_BYTES = "1024";
    resetEnvCacheForTest();
    const smallLimitApp = createApp();
    try {
      const { agent: smallS1, csrf: smallCsrf } = await loginAs("student1@pariksha.test", smallLimitApp);
      const bigUpload = await smallS1
        .post(`/api/v1/student/assignments/${assignmentId}/submit`)
        .set("X-CSRF-Token", smallCsrf)
        .attach("files", Buffer.alloc(2048, "A"), {
          filename: "large.txt",
          contentType: "text/plain",
        });
      expect(bigUpload.status).toBe(413);
      expect(bigUpload.body.error.code).toBe("FILE_TOO_LARGE");
    } finally {
      if (prevMaxBytes === undefined) delete process.env.MAX_UPLOAD_SIZE_BYTES;
      else process.env.MAX_UPLOAD_SIZE_BYTES = prevMaxBytes;
      resetEnvCacheForTest();
    }

    // 19 & 21. Student1 submits assignment and resubmits before grading
    const submit1 = await s1Agent
      .post(`/api/v1/student/assignments/${assignmentId}/submit`)
      .set("X-CSRF-Token", s1Csrf)
      .field("notes", "Initial submission")
      .attach("files", validPdfBuffer("Solution v1"), {
        filename: "raft-v1.pdf",
        contentType: "application/pdf",
      });
    expect(submit1.status).toBe(201);
    const submissionId = submit1.body.data.id as string;
    const subAttachmentId = submit1.body.data.attachments[0].id as string;

    const resubmit = await s1Agent
      .post(`/api/v1/student/assignments/${assignmentId}/submit`)
      .set("X-CSRF-Token", s1Csrf)
      .field("notes", "Updated submission")
      .attach("files", validPdfBuffer("Solution v2"), {
        filename: "raft-v2.pdf",
        contentType: "application/pdf",
      });
    expect(resubmit.status).toBe(200);
    expect(resubmit.body.data.submissionCount).toBe(2);
    const subAttachmentIdV2 = resubmit.body.data.attachments[0].id as string;

    // 22. Student2 cannot access or submit for Student1's submission
    expect((await s2Agent.get(`/api/v1/files/submission-attachments/${subAttachmentIdV2}`)).status).toBe(403);
    expect(
      (
        await s2Agent
          .post(`/api/v1/student/assignments/${assignmentId}/submit`)
          .set("X-CSRF-Token", s2Csrf)
          .attach("files", validPdfBuffer("Unauthorized"), {
            filename: "unauth.pdf",
            contentType: "application/pdf",
          })
      ).status,
    ).toBe(403);
    // Old attachment ID removed after resubmission
    expect((await s1Agent.get(`/api/v1/files/submission-attachments/${subAttachmentId}`)).status).toBe(404);

    // 24. Unauthorized grading rejected
    expect(
      (
        await t2Agent
          .post(`/api/v1/teacher/assignment-submissions/${submissionId}/grade`)
          .set("X-CSRF-Token", t2Csrf)
          .send({ score: 40, feedback: "Good" })
      ).status,
    ).toBe(403);
    expect(
      (
        await s1Agent
          .post(`/api/v1/teacher/assignment-submissions/${submissionId}/grade`)
          .set("X-CSRF-Token", s1Csrf)
          .send({ score: 50 })
      ).status,
    ).toBe(403);

    // 23 & 25. Teacher1 grades without publishing -> hidden from student -> publish -> visible
    const draftGrade = await t1Agent
      .post(`/api/v1/teacher/assignment-submissions/${submissionId}/grade`)
      .set("X-CSRF-Token", t1Csrf)
      .send({ score: 45, feedback: "Well structured Raft state machine", publishGrade: false });
    expect(draftGrade.status).toBe(200);

    const studentBeforePub = await s1Agent.get(`/api/v1/student/assignments/${assignmentId}`);
    expect(studentBeforePub.status).toBe(200);
    expect(studentBeforePub.body.data.mySubmission.isGradePublished).toBe(false);
    expect(studentBeforePub.body.data.mySubmission.score).toBeNull();
    expect(studentBeforePub.body.data.mySubmission.feedback).toBeNull();

    const publishGrade = await t1Agent
      .post(`/api/v1/teacher/assignment-submissions/${submissionId}/publish-grade`)
      .set("X-CSRF-Token", t1Csrf);
    expect(publishGrade.status).toBe(200);
    expect(publishGrade.body.data.isGradePublished).toBe(true);

    const studentAfterPub = await s1Agent.get(`/api/v1/student/assignments/${assignmentId}`);
    expect(studentAfterPub.body.data.mySubmission.isGradePublished).toBe(true);
    expect(studentAfterPub.body.data.mySubmission.score).toBe(45);
    expect(studentAfterPub.body.data.mySubmission.feedback).toBe("Well structured Raft state machine");

    // 20 & 21b. Server enforces deadline & single-submission policy
    const pastAssign = await t1Agent
      .post("/api/v1/teacher/assignments")
      .set("X-CSRF-Token", t1Csrf)
      .field("courseId", courseId)
      .field("title", "Closed Lab")
      .field("maxMarks", "20")
      .field("dueAt", new Date(Date.now() - 60_000).toISOString())
      .field("allowLateSubmissions", "false")
      .field("publishImmediately", "true");
    expect(pastAssign.status).toBe(201);

    const lateRejected = await s1Agent
      .post(`/api/v1/student/assignments/${pastAssign.body.data.id}/submit`)
      .set("X-CSRF-Token", s1Csrf)
      .attach("files", validPdfBuffer(), {
        filename: "late.pdf",
        contentType: "application/pdf",
      });
    expect(lateRejected.status).toBe(400);
    expect(lateRejected.body.error.code).toBe("DEADLINE_PASSED");

    // 26. Dashboard counts match real database records
    const [adminDash, teacherDash, studentDash] = await Promise.all([
      adminAgent.get("/api/v1/admin/dashboard"),
      t1Agent.get("/api/v1/teacher/dashboard"),
      s1Agent.get("/api/v1/student/dashboard"),
    ]);
    expect(adminDash.body.data.courses.active).toBe(1);
    expect(adminDash.body.data.enrollments.active).toBe(1);
    expect(adminDash.body.data.assignments.published).toBe(2);
    expect(teacherDash.body.data.counts.assignedCourses).toBe(1);
    expect(teacherDash.body.data.counts.publishedAssignments).toBe(2);
    expect(studentDash.body.data.counts.activeEnrollments).toBe(1);
    expect(studentDash.body.data.counts.publishedGrades).toBe(1);
  });
});
