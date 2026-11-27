import { Router } from "express";
import type { ApiSuccessResponse, HealthCheckStatus } from "@pariksha/shared";
import { checkDatabaseHealth } from "../lib/prisma.js";

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
  const database = await checkDatabaseHealth();
  const status: HealthCheckStatus = {
    status: database.connected ? "ok" : "degraded",
    service: "pariksha-api",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    database,
  };

  const payload: ApiSuccessResponse<HealthCheckStatus> = {
    success: true,
    data: status,
    requestId: res.locals.requestId as string | undefined,
  };

  res.status(database.connected ? 200 : 503).json(payload);
});
