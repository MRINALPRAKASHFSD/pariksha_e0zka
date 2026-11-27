import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassword, verifyPassword } from "../src/lib/crypto.js";
import { disconnectPrisma } from "../src/lib/prisma.js";

describe("Phase 1 API Foundation", () => {
  const app = createApp();

  afterAll(async () => {
    await disconnectPrisma();
  });

  it("returns security headers and request ID on /api/v1/system/capabilities", async () => {
    const res = await request(app).get("/api/v1/system/capabilities");
    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toBeTruthy();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.body.success).toBe(true);
    expect(res.body.data.defaultProctoringPolicy.violationThreshold).toBe(2);
    expect(res.body.data.browserSecurityLimitations.length).toBeGreaterThanOrEqual(4);
  });

  it("returns structured 404 JSON for unknown routes", async () => {
    const res = await request(app).get("/api/v1/nonexistent-endpoint");
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("ROUTE_NOT_FOUND");
  });

  it("hashes and verifies passwords with scrypt safely", async () => {
    const hash = await hashPassword("StrongPass!2026");
    expect(hash.startsWith("scrypt$")).toBe(true);
    await expect(verifyPassword("StrongPass!2026", hash)).resolves.toBe(true);
    await expect(verifyPassword("WrongPass!2026", hash)).resolves.toBe(false);
  });

  it("reports database connectivity on /api/v1/health", async () => {
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.service).toBe("pariksha-api");
    expect(res.body.data.database.connected).toBe(true);
    expect(typeof res.body.data.database.latencyMs).toBe("number");
  });
});
