import express from "express";
import cookieParser from "cookie-parser";
import {
  createApiRateLimiter,
  createCorsMiddleware,
  createHelmetMiddleware,
  requestIdMiddleware,
} from "./middleware/security.js";
import { errorHandler, notFoundHandler } from "./middleware/errorAndValidation.js";
import { healthRouter } from "./routes/health.js";
import { createAuthRouter } from "./routes/auth.js";
import { adminRouter } from "./routes/adminUsers.js";
import { adminAcademicRouter } from "./routes/adminAcademic.js";
import { createAdminExamsRouter } from "./routes/adminExams.js";
import { createAdminProctoringRouter } from "./routes/adminProctoring.js";
import { createTeacherAcademicRouter } from "./routes/teacherAcademic.js";
import { createTeacherExamsRouter } from "./routes/teacherExams.js";
import { createStudentAcademicRouter } from "./routes/studentAcademic.js";
import {
  createStudentAttemptsRouter,
  createStudentExamsRouter,
} from "./routes/studentExams.js";
import { filesRouter } from "./routes/files.js";
import { BROWSER_SECURITY_LIMITATIONS, DEFAULT_PROCTORING_POLICY } from "@pariksha/shared";

export function createApp() {
  const app = express();

  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(requestIdMiddleware);
  app.use(createHelmetMiddleware());
  app.use(createCorsMiddleware());
  app.use(cookieParser());
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false, limit: "2mb" }));
  app.use("/api", createApiRateLimiter());

  app.use("/api/v1/health", healthRouter);
  app.use("/api/v1/auth", createAuthRouter());
  app.use("/api/v1/admin", adminRouter);
  app.use("/api/v1/admin", adminAcademicRouter);
  app.use("/api/v1/admin/exams", createAdminExamsRouter());
  app.use("/api/v1/admin/proctoring", createAdminProctoringRouter());
  app.use("/api/v1/teacher", createTeacherAcademicRouter());
  app.use("/api/v1/teacher/exams", createTeacherExamsRouter());
  app.use("/api/v1/student", createStudentAcademicRouter());
  app.use("/api/v1/student/exams", createStudentExamsRouter());
  app.use("/api/v1/student/attempts", createStudentAttemptsRouter());
  app.use("/api/v1/files", filesRouter);

  app.get("/api/v1/system/capabilities", (_req, res) => {
    res.json({
      success: true,
      data: {
        defaultProctoringPolicy: DEFAULT_PROCTORING_POLICY,
        browserSecurityLimitations: BROWSER_SECURITY_LIMITATIONS,
        proctoringEngineImplemented: true,
        phase: "phase-5-proctoring-and-two-strike-engine",
      },
      requestId: res.locals.requestId as string | undefined,
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
