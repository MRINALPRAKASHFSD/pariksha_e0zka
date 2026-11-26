import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Force isolated test environment before loading env/config
process.env.NODE_ENV = "test";
process.env.PORT = "4001";
process.env.CLIENT_ORIGIN = "http://localhost:5174";
process.env.UPLOAD_DIR = "/tmp/pariksha-test-uploads";
process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = "200";
process.env.RATE_LIMIT_MAX_REQUESTS = "2000";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiDistRoot = path.resolve(__dirname, "../dist");

const { getEnv } = await import(path.join(apiDistRoot, "config/env.js"));
const { createApp } = await import(path.join(apiDistRoot, "app.js"));
const { configureSocketServer } = await import(path.join(apiDistRoot, "server.js"));
const { getPrismaClient, disconnectPrisma } = await import(path.join(apiDistRoot, "lib/prisma.js"));
const { hashPassword } = await import(path.join(apiDistRoot, "lib/crypto.js"));
const { startExamExpirationWorker, stopExamExpirationWorker } = await import(
  path.join(apiDistRoot, "services/examExpirationWorker.js")
);

function assertIsolatedTestEnvironment() {
  const env = getEnv();
  if (env.NODE_ENV !== "test") {
    throw new Error(`E2E server requires NODE_ENV=test, got ${env.NODE_ENV}`);
  }
  const dbName = new URL(env.DATABASE_URL).pathname.replace(/^\//, "");
  if (dbName !== "pariksha_test") {
    throw new Error(`Refusing to start E2E server against non-test database "${dbName}"`);
  }
  if (!path.resolve(env.UPLOAD_DIR).includes("pariksha-test-uploads")) {
    throw new Error(`Refusing to use non-test upload dir "${env.UPLOAD_DIR}"`);
  }
}

async function resetAndSeedE2EDatabase() {
  assertIsolatedTestEnvironment();
  const env = getEnv();
  await fs.rm(path.resolve(env.UPLOAD_DIR), { recursive: true, force: true });

  const prisma = getPrismaClient();
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "AuditLog", "IntegrityEvent", "PreflightHandshake", "Grade", "Result", "ExamSubmission", "ExamAnswer", "ExamAttempt", "QuestionOption", "Question", "ProctoringPolicy", "AssignmentSubmission", "Assignment", "Exam", "Enrollment", "Course", "Session", "User" RESTART IDENTITY CASCADE`,
  );

  const pass = await hashPassword("E2ETestPass!2026");
  await prisma.user.createMany({
    data: [
      {
        email: "admin@pariksha.test",
        fullName: "E2E Admin",
        passwordHash: pass,
        role: "ADMIN",
        status: "ACTIVE",
      },
      {
        email: "teacher@pariksha.test",
        fullName: "Dr. Rao Teacher",
        passwordHash: pass,
        role: "TEACHER",
        status: "ACTIVE",
      },
      {
        email: "student@pariksha.test",
        fullName: "Rohan Student",
        passwordHash: pass,
        role: "STUDENT",
        status: "ACTIVE",
      },
      {
        email: "outsider@pariksha.test",
        fullName: "Outsider Student",
        passwordHash: pass,
        role: "STUDENT",
        status: "ACTIVE",
      },
    ],
  });
}

await resetAndSeedE2EDatabase();

const env = getEnv();
const app = createApp();
const server = http.createServer(app);
const io = configureSocketServer(server, env.CLIENT_ORIGIN);
startExamExpirationWorker(1500);

server.listen(env.PORT, "127.0.0.1", () => {
  console.log(`[pariksha-e2e-api] Isolated test server listening on http://127.0.0.1:${env.PORT}`);
});

const shutdown = async () => {
  stopExamExpirationWorker();
  io.close();
  server.close(async () => {
    await disconnectPrisma();
    process.exit(0);
  });
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
