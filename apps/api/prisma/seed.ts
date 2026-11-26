import "../src/config/env.js";
import { DEFAULT_PROCTORING_POLICY } from "@pariksha/shared";
import { hashPassword } from "../src/lib/crypto.js";
import { disconnectPrisma, getPrismaClient } from "../src/lib/prisma.js";

async function ensureUser(params: {
  email: string;
  fullName: string;
  password: string;
  role: "ADMIN" | "TEACHER" | "STUDENT";
}) {
  const prisma = getPrismaClient();
  const normalizedEmail = params.email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    return { user: existing, created: false };
  }

  const passwordHash = await hashPassword(params.password);
  const created = await prisma.user.create({
    data: {
      email: normalizedEmail,
      fullName: params.fullName,
      passwordHash,
      role: params.role,
      status: "ACTIVE",
    },
  });
  return { user: created, created: true };
}

async function main() {
  const prisma = getPrismaClient();
  const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const adminName = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || "Pariksha System Administrator";

  if (!adminEmail || !adminPassword) {
    throw new Error(
      "BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD environment variables are required to bootstrap the administrator account.",
    );
  }
  if (adminPassword.length < 10) {
    throw new Error("BOOTSTRAP_ADMIN_PASSWORD must be at least 10 characters.");
  }

  const adminResult = await ensureUser({
    email: adminEmail,
    fullName: adminName,
    password: adminPassword,
    role: "ADMIN",
  });

  console.log(
    `[seed] Administrator ${adminResult.created ? "created" : "already exists"}: ${adminResult.user.email}`,
  );

  // Ensure institutional default proctoring policy exists idempotently
  const existingPolicy = await prisma.proctoringPolicy.findFirst({
    where: { isInstitutionalDefault: true, examId: null },
  });
  if (!existingPolicy) {
    await prisma.proctoringPolicy.create({
      data: {
        isInstitutionalDefault: true,
        updatedById: adminResult.user.id,
        ...DEFAULT_PROCTORING_POLICY,
      },
    });
    console.log("[seed] Default institutional proctoring policy initialized.");
  } else {
    console.log("[seed] Default institutional proctoring policy already present.");
  }

  // Optional development-only sample accounts (never enabled in production)
  if (process.env.SEED_DEV_ACCOUNTS === "true" && process.env.NODE_ENV !== "production") {
    const teacherPassword = process.env.SEED_DEV_TEACHER_PASSWORD;
    const studentPassword = process.env.SEED_DEV_STUDENT_PASSWORD;

    if (!teacherPassword || teacherPassword.length < 10) {
      throw new Error("SEED_DEV_TEACHER_PASSWORD (>=10 chars) is required when SEED_DEV_ACCOUNTS=true");
    }
    if (!studentPassword || studentPassword.length < 10) {
      throw new Error("SEED_DEV_STUDENT_PASSWORD (>=10 chars) is required when SEED_DEV_ACCOUNTS=true");
    }

    const teacherRes = await ensureUser({
      email: "teacher@pariksha.local",
      fullName: "Dr. Ananya Rao",
      password: teacherPassword,
      role: "TEACHER",
    });
    const studentRes = await ensureUser({
      email: "student@pariksha.local",
      fullName: "Rohan Mehta",
      password: studentPassword,
      role: "STUDENT",
    });

    console.log(
      `[seed] Dev teacher ${teacherRes.created ? "created" : "already exists"}: ${teacherRes.user.email}`,
    );
    console.log(
      `[seed] Dev student ${studentRes.created ? "created" : "already exists"}: ${studentRes.user.email}`,
    );
  }
}

main()
  .catch((err) => {
    console.error("[seed] Failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma();
  });
