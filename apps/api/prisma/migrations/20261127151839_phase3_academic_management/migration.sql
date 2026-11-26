-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "allowLateSubmissions" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "allowResubmission" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "instructions" TEXT,
ADD COLUMN     "lateDueAt" TIMESTAMP(3),
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "status" "AssignmentStatus" NOT NULL DEFAULT 'DRAFT',
ALTER COLUMN "isPublished" SET DEFAULT false;

-- AlterTable
ALTER TABLE "AssignmentSubmission" ADD COLUMN     "gradePublishedAt" TIMESTAMP(3),
ADD COLUMN     "gradePublishedById" UUID,
ADD COLUMN     "isGradePublished" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "submissionCount" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "fileName" DROP NOT NULL,
ALTER COLUMN "filePath" DROP NOT NULL,
ALTER COLUMN "fileMimeType" DROP NOT NULL,
ALTER COLUMN "fileSizeBytes" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Course" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "capacity" INTEGER;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "temporaryPasswordExpiresAt" TIMESTAMP(3),
ADD COLUMN     "temporaryPasswordUsedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AssignmentAttachment" (
    "id" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "uploadedById" UUID NOT NULL,
    "originalName" VARCHAR(255) NOT NULL,
    "storageKey" VARCHAR(512) NOT NULL,
    "mimeType" VARCHAR(128) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssignmentAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionAttachment" (
    "id" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "uploadedById" UUID NOT NULL,
    "originalName" VARCHAR(255) NOT NULL,
    "storageKey" VARCHAR(512) NOT NULL,
    "mimeType" VARCHAR(128) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubmissionAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AssignmentAttachment_storageKey_key" ON "AssignmentAttachment"("storageKey");

-- CreateIndex
CREATE INDEX "AssignmentAttachment_assignmentId_idx" ON "AssignmentAttachment"("assignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionAttachment_storageKey_key" ON "SubmissionAttachment"("storageKey");

-- CreateIndex
CREATE INDEX "SubmissionAttachment_submissionId_idx" ON "SubmissionAttachment"("submissionId");

-- CreateIndex
CREATE INDEX "Assignment_courseId_status_idx" ON "Assignment"("courseId", "status");

-- CreateIndex
CREATE INDEX "Course_isActive_createdAt_idx" ON "Course"("isActive", "createdAt");

-- AddForeignKey
ALTER TABLE "AssignmentAttachment" ADD CONSTRAINT "AssignmentAttachment_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentAttachment" ADD CONSTRAINT "AssignmentAttachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentSubmission" ADD CONSTRAINT "AssignmentSubmission_gradePublishedById_fkey" FOREIGN KEY ("gradePublishedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionAttachment" ADD CONSTRAINT "SubmissionAttachment_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "AssignmentSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionAttachment" ADD CONSTRAINT "SubmissionAttachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
