-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ExamStatus" ADD VALUE 'REJECTED';
ALTER TYPE "ExamStatus" ADD VALUE 'PAUSED';
ALTER TYPE "ExamStatus" ADD VALUE 'CANCELLED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "QuestionType" ADD VALUE 'SUBJECTIVE_SHORT';
ALTER TYPE "QuestionType" ADD VALUE 'SUBJECTIVE_LONG';

-- AlterEnum
ALTER TYPE "SubmissionReason" ADD VALUE 'EXAM_CANCELLED';

-- AlterTable
ALTER TABLE "Exam" ADD COLUMN     "activatedAt" TIMESTAMP(3),
ADD COLUMN     "allowUnproctoredDev" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "cancellationReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "isEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "maxAttempts" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "parentExamId" UUID,
ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "submittedForApprovalAt" TIMESTAMP(3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "ExamAnswer" ADD COLUMN     "lastClientSequence" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "ExamAttempt" ADD COLUMN     "answerKeySnapshotJson" JSONB,
ADD COLUMN     "examVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "finalizationReason" "SubmissionReason",
ADD COLUMN     "policySnapshotJson" JSONB,
ADD COLUMN     "questionSnapshotJson" JSONB,
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "isRequired" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Exam_status_isEnabled_idx" ON "Exam"("status", "isEnabled");

-- CreateIndex
CREATE INDEX "ExamAttempt_status_expiresAt_idx" ON "ExamAttempt"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_parentExamId_fkey" FOREIGN KEY ("parentExamId") REFERENCES "Exam"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Enforce at most one active (IN_PROGRESS or PAUSED) attempt per student per exam
CREATE UNIQUE INDEX IF NOT EXISTS "ExamAttempt_one_active_per_student_exam_idx"
  ON "ExamAttempt" ("examId", "studentId")
  WHERE "status" IN ('IN_PROGRESS', 'PAUSED');
