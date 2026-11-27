-- AlterTable
ALTER TABLE "ExamAttempt" ADD COLUMN     "heartbeatOutageActive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastHeartbeatSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastMediaHeartbeatAt" TIMESTAMP(3),
ADD COLUMN     "mediaGraceStartedAt" TIMESTAMP(3),
ADD COLUMN     "mediaLossActive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pauseReason" VARCHAR(255),
ADD COLUMN     "policyVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "preflightHandshakeId" UUID;

-- AlterTable
ALTER TABLE "IntegrityEvent" ADD COLUMN     "confidence" VARCHAR(32) NOT NULL DEFAULT 'OBSERVED',
ADD COLUMN     "incidentKey" VARCHAR(96),
ADD COLUMN     "ruleEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "source" VARCHAR(32) NOT NULL DEFAULT 'CLIENT',
ADD COLUMN     "violationNumberAfter" INTEGER;

-- AlterTable
ALTER TABLE "ProctoringPolicy" ADD COLUMN     "allowedScreenSurface" VARCHAR(24) NOT NULL DEFAULT 'ANY',
ADD COLUMN     "detectFullscreenExit" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "extensionStrikeMode" VARCHAR(24) NOT NULL DEFAULT 'STRIKE',
ADD COLUMN     "heartbeatGraceSeconds" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "mediaGraceSeconds" INTEGER NOT NULL DEFAULT 8,
ADD COLUMN     "monitorConnectionHeartbeat" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "monitorMediaHeartbeat" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "PreflightHandshake" (
    "id" UUID NOT NULL,
    "examId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "tokenHash" VARCHAR(128) NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "policySnapshotJson" JSONB NOT NULL,
    "cameraStatus" VARCHAR(32) NOT NULL,
    "screenShareStatus" VARCHAR(32) NOT NULL,
    "displaySurface" VARCHAR(32),
    "fullscreenStatus" VARCHAR(32) NOT NULL,
    "connectivityOk" BOOLEAN NOT NULL DEFAULT true,
    "consentAccepted" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedAttemptId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PreflightHandshake_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PreflightHandshake_tokenHash_key" ON "PreflightHandshake"("tokenHash");

-- CreateIndex
CREATE INDEX "PreflightHandshake_examId_studentId_expiresAt_idx" ON "PreflightHandshake"("examId", "studentId", "expiresAt");

-- CreateIndex
CREATE INDEX "PreflightHandshake_sessionId_idx" ON "PreflightHandshake"("sessionId");

-- AddForeignKey
ALTER TABLE "PreflightHandshake" ADD CONSTRAINT "PreflightHandshake_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreflightHandshake" ADD CONSTRAINT "PreflightHandshake_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreflightHandshake" ADD CONSTRAINT "PreflightHandshake_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ensure at most one active institutional default proctoring policy row
CREATE UNIQUE INDEX IF NOT EXISTS "ProctoringPolicy_institutional_default_unique_idx"
  ON "ProctoringPolicy" ("isInstitutionalDefault")
  WHERE "isInstitutionalDefault" = true AND "examId" IS NULL;
