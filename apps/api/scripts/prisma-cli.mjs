import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootEnv = path.resolve(__dirname, "../../../.env");
const testEnv = path.resolve(__dirname, "../../../.env.test");
const isTest = process.env.NODE_ENV === "test";
const externalConfigDir = path.join(os.homedir(), ".config", "pariksha");

const explicitFile = isTest ? process.env.PARIKSHA_TEST_ENV_FILE : process.env.PARIKSHA_ENV_FILE;
if (explicitFile && fs.existsSync(explicitFile)) {
  dotenv.config({ path: explicitFile, override: false });
}

const externalDefault = path.join(externalConfigDir, isTest ? ".env.test" : ".env");
if (fs.existsSync(externalDefault)) {
  dotenv.config({ path: externalDefault, override: false });
}

if (isTest && fs.existsSync(testEnv)) {
  dotenv.config({ path: testEnv, override: false });
} else if (fs.existsSync(rootEnv)) {
  dotenv.config({ path: rootEnv, override: false });
}

const args = process.argv.slice(2);
const result = spawnSync("npx", ["prisma", ...args], {
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
