import { getEnv } from "../src/config/env.js";
import { getPrismaClient } from "../src/lib/prisma.js";

/**
 * Explicit safety guard preventing destructive test cleanup from ever running
 * against the development or production database.
 */
export function assertTestDatabaseSafety(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(`Refusing destructive test operation outside NODE_ENV=test (got ${process.env.NODE_ENV})`);
  }
  const env = getEnv();
  const parsed = new URL(env.DATABASE_URL);
  const dbName = parsed.pathname.replace(/^\//, "");
  if (dbName !== "pariksha_test") {
    throw new Error(
      `Refusing destructive test operation on database "${dbName}". Expected isolated "pariksha_test".`,
    );
  }
}

export async function resetTestDatabase(): Promise<void> {
  assertTestDatabaseSafety();
  const prisma = getPrismaClient();
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "AuditLog", "IntegrityEvent", "PreflightHandshake", "Grade", "Result", "ExamSubmission", "ExamAnswer", "ExamAttempt", "QuestionOption", "Question", "ProctoringPolicy", "AssignmentSubmission", "Assignment", "Exam", "Enrollment", "Course", "Session", "User" RESTART IDENTITY CASCADE`,
  );
}
