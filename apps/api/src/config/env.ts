import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootEnvPath = path.resolve(__dirname, "../../../../.env");
const rootTestEnvPath = path.resolve(__dirname, "../../../../.env.test");
const apiEnvPath = path.resolve(__dirname, "../../.env");
const externalConfigDir = path.join(os.homedir(), ".config", "pariksha");

function loadEnvironmentFiles(): void {
  const isTest = process.env.NODE_ENV === "test";

  // 1. Explicit external env file (recommended outside iCloud Drive)
  const explicitFile = isTest ? process.env.PARIKSHA_TEST_ENV_FILE : process.env.PARIKSHA_ENV_FILE;
  if (explicitFile && fs.existsSync(explicitFile)) {
    dotenv.config({ path: explicitFile, override: false });
  }

  // 2. User-home external config outside iCloud Drive (~/.config/pariksha/.env)
  const externalDefault = path.join(externalConfigDir, isTest ? ".env.test" : ".env");
  if (fs.existsSync(externalDefault)) {
    dotenv.config({ path: externalDefault, override: false });
  }

  // 3. Local workspace fallback for development/testing
  if (isTest && fs.existsSync(rootTestEnvPath)) {
    dotenv.config({ path: rootTestEnvPath, override: false });
  }
  if (fs.existsSync(rootEnvPath)) {
    dotenv.config({ path: rootEnvPath, override: false });
  }
  if (fs.existsSync(apiEnvPath)) {
    dotenv.config({ path: apiEnvPath, override: false });
  }
}

loadEnvironmentFiles();

const defaultUploadDir =
  process.env.NODE_ENV === "test"
    ? path.join(os.tmpdir(), "pariksha-test-uploads")
    : path.join(os.homedir(), ".local", "share", "pariksha", "uploads");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CLIENT_ORIGIN: z.string().url().default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  TEST_DATABASE_URL: z.string().optional(),
  SESSION_SECRET: z.string().min(32).default("dev-only-session-secret-change-before-production-32chars"),
  CSRF_SECRET: z.string().min(32).default("dev-only-csrf-secret-change-before-production-32chars"),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  TEMP_PASSWORD_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(900000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(10).default(300),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(900000),
  AUTH_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(5).default(20),
  UPLOAD_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(5).default(40),
  UPLOAD_DIR: z.string().default(defaultUploadDir),
  MAX_UPLOAD_SIZE_BYTES: z.coerce.number().int().min(1024).default(10 * 1024 * 1024),
  MAX_UPLOAD_FILES: z.coerce.number().int().min(1).max(20).default(5),
});

export type AppEnv = z.infer<typeof envSchema>;

let cachedEnv: AppEnv | null = null;

export function getEnv(): AppEnv {
  if (cachedEnv) {
    return cachedEnv;
  }
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${formatted}`);
  }
  cachedEnv = parsed.data;
  return cachedEnv;
}

export function resetEnvCacheForTest(): void {
  cachedEnv = null;
}
