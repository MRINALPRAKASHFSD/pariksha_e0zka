import { Router, type Response } from "express";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { sanitizeOriginalFilename } from "../lib/fileSecurity.js";
import { getPrismaClient } from "../lib/prisma.js";
import { getStorageProvider } from "../lib/storage.js";
import { requireAuth, requirePasswordChanged } from "../middleware/auth.js";

export const filesRouter = Router();
filesRouter.use(requireAuth, requirePasswordChanged);

function isValidUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function applySafeDownloadHeaders(
  res: Response,
  filename: string,
  mimeType: string,
  sizeBytes: number,
): void {
  const safeName = sanitizeOriginalFilename(filename);
  res.setHeader("Content-Type", mimeType);
  res.setHeader("Content-Length", String(sizeBytes));
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${safeName.replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
}

filesRouter.get("/assignment-attachments/:attachmentId", async (req, res, next) => {
  try {
    const attachmentId = req.params.attachmentId ?? "";
    if (!isValidUuid(attachmentId)) {
      next(badRequest("Invalid attachment ID", "INVALID_ID"));
      return;
    }

    const user = req.auth!.user;
    const prisma = getPrismaClient();
    const attachment = await prisma.assignmentAttachment.findUnique({
      where: { id: attachmentId },
      include: {
        assignment: {
          include: { course: true },
        },
      },
    });

    if (!attachment) {
      next(notFound("Attachment not found", "ATTACHMENT_NOT_FOUND"));
      return;
    }

    if (user.role === "TEACHER") {
      if (attachment.assignment.course.teacherId !== user.id) {
        next(forbidden("You are not authorized to download this attachment", "DOWNLOAD_FORBIDDEN"));
        return;
      }
    } else if (user.role === "STUDENT") {
      const enrollment = await prisma.enrollment.findUnique({
        where: {
          courseId_studentId: {
            courseId: attachment.assignment.courseId,
            studentId: user.id,
          },
        },
      });
      if (
        !enrollment ||
        enrollment.status !== "ACTIVE" ||
        attachment.assignment.status !== "PUBLISHED" ||
        !attachment.assignment.isPublished
      ) {
        next(forbidden("You are not authorized to download this attachment", "DOWNLOAD_FORBIDDEN"));
        return;
      }
    }

    const storage = getStorageProvider();
    const stream = await storage.openReadStream(attachment.storageKey);
    applySafeDownloadHeaders(
      res,
      attachment.originalName,
      attachment.mimeType,
      attachment.sizeBytes,
    );
    stream.on("error", (err) => next(err));
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

filesRouter.get("/submission-attachments/:attachmentId", async (req, res, next) => {
  try {
    const attachmentId = req.params.attachmentId ?? "";
    if (!isValidUuid(attachmentId)) {
      next(badRequest("Invalid attachment ID", "INVALID_ID"));
      return;
    }

    const user = req.auth!.user;
    const prisma = getPrismaClient();
    const attachment = await prisma.submissionAttachment.findUnique({
      where: { id: attachmentId },
      include: {
        submission: {
          include: {
            assignment: { include: { course: true } },
          },
        },
      },
    });

    if (!attachment) {
      next(notFound("Attachment not found", "ATTACHMENT_NOT_FOUND"));
      return;
    }

    if (user.role === "TEACHER") {
      if (attachment.submission.assignment.course.teacherId !== user.id) {
        next(forbidden("You are not authorized to download this submission file", "DOWNLOAD_FORBIDDEN"));
        return;
      }
    } else if (user.role === "STUDENT") {
      if (attachment.submission.studentId !== user.id) {
        next(forbidden("You cannot download another student's submission", "DOWNLOAD_FORBIDDEN"));
        return;
      }
      const enrollment = await prisma.enrollment.findUnique({
        where: {
          courseId_studentId: {
            courseId: attachment.submission.assignment.courseId,
            studentId: user.id,
          },
        },
      });
      if (!enrollment || enrollment.status !== "ACTIVE") {
        next(forbidden("Active course enrollment required", "DOWNLOAD_FORBIDDEN"));
        return;
      }
    }

    const storage = getStorageProvider();
    const stream = await storage.openReadStream(attachment.storageKey);
    applySafeDownloadHeaders(
      res,
      attachment.originalName,
      attachment.mimeType,
      attachment.sizeBytes,
    );
    stream.on("error", (err) => next(err));
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});
