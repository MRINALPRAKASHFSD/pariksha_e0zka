import crypto from "node:crypto";
import {
  IntegrityEventConfidence,
  IntegrityEventSource,
  IntegrityEventType,
  SubmissionReason,
  type ProctoringPolicyConfig,
} from "@pariksha/shared";
import { getPrismaClient } from "../lib/prisma.js";
import { emitAttemptFinalizedRealtime, finalizeExamAttempt } from "./examFinalization.js";
import {
  emitProctoringOutcomeRealtime,
  processIntegrityEvent,
  type ProcessIntegrityEventOutcome,
} from "./proctoringEngine.js";

let workerTimer: NodeJS.Timeout | null = null;
let sweepInFlight = false;

/**
 * Multi-instance safe batch sweep for overdue active exam attempts using PostgreSQL
 * `FOR UPDATE SKIP LOCKED` inside an atomic transaction.
 */
export async function sweepExpiredExamAttempts(batchSize = 25): Promise<number> {
  const prisma = getPrismaClient();
  const finalizedResults: Awaited<ReturnType<typeof finalizeExamAttempt>>[] = [];

  await prisma.$transaction(async (tx) => {
    const overdue = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM "ExamAttempt"
      WHERE status IN ('IN_PROGRESS', 'PAUSED')
        AND "expiresAt" <= (NOW() AT TIME ZONE 'UTC')
      ORDER BY "expiresAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    `;

    for (const row of overdue) {
      const result = await finalizeExamAttempt(
        {
          attemptId: row.id,
          reason: SubmissionReason.TIMER_EXPIRED,
          auditMetadata: { source: "expiration-worker" },
        },
        tx,
      );
      finalizedResults.push(result);
    }
  });

  for (const result of finalizedResults) {
    emitAttemptFinalizedRealtime(result);
  }

  return finalizedResults.filter((r) => !r.alreadyFinalized).length;
}

/**
 * Multi-instance safe background sweep detecting missing heartbeats past
 * (heartbeatTimeoutSeconds + heartbeatGraceSeconds). Single continuous outages
 * emit at most one incident until a new heartbeat is received.
 */
export async function sweepMissingHeartbeats(batchSize = 25): Promise<number> {
  const prisma = getPrismaClient();
  const outcomes: ProcessIntegrityEventOutcome[] = [];
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    const candidates = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT a.id
      FROM "ExamAttempt" a
      JOIN "Exam" e ON e.id = a."examId"
      WHERE a.status = 'IN_PROGRESS'
        AND a."isLocked" = false
        AND a."heartbeatOutageActive" = false
        AND e."allowUnproctoredDev" = false
        AND a."expiresAt" > (NOW() AT TIME ZONE 'UTC')
      ORDER BY a."lastHeartbeatAt" ASC
      FOR UPDATE OF a SKIP LOCKED
      LIMIT ${batchSize}
    `;

    for (const row of candidates) {
      const attempt = await tx.examAttempt.findUnique({
        where: { id: row.id },
        select: {
          id: true,
          studentId: true,
          lastHeartbeatAt: true,
          lastHeartbeatSeq: true,
          heartbeatOutageActive: true,
          policySnapshotJson: true,
        },
      });
      if (!attempt || attempt.heartbeatOutageActive) continue;

      const policy = (attempt.policySnapshotJson ?? {}) as Partial<ProctoringPolicyConfig>;
      if (policy.monitorConnectionHeartbeat === false) continue;

      const timeoutSec = policy.heartbeatTimeoutSeconds ?? 30;
      const graceSec = policy.heartbeatGraceSeconds ?? 15;
      const elapsedMs = now.getTime() - attempt.lastHeartbeatAt.getTime();
      if (elapsedMs < (timeoutSec + graceSec) * 1000) continue;

      const outcome = await processIntegrityEvent(
        {
          attemptId: attempt.id,
          clientEventId: `hb-missed-${attempt.id}-${attempt.lastHeartbeatSeq}-${crypto.randomUUID().slice(0, 8)}`,
          eventType: IntegrityEventType.HEARTBEAT_MISSED,
          source: IntegrityEventSource.SERVER_HEARTBEAT,
          confidence: IntegrityEventConfidence.SERVER_DETECTED,
          description: `Heartbeat interruption exceeded ${timeoutSec}s timeout + ${graceSec}s grace (${Math.round(elapsedMs / 1000)}s since last signal).`,
          actorId: null,
          actorRole: null,
          metadata: {
            elapsedSeconds: Math.round(elapsedMs / 1000),
            timeoutSeconds: timeoutSec,
            graceSeconds: graceSec,
            lastHeartbeatSeq: attempt.lastHeartbeatSeq,
          },
        },
        tx,
      );
      outcomes.push(outcome);
    }
  });

  // Publish real-time notifications strictly after transaction commits
  for (const outcome of outcomes) {
    emitProctoringOutcomeRealtime(outcome);
  }

  return outcomes.filter((o) => !o.dto.duplicate).length;
}

/**
 * Inline lazy expiration check used by attempt read/autosave/submit paths so an
 * overdue attempt never remains writable even if a timer tick hasn't fired yet.
 */
export async function expireAttemptIfDue(attemptId: string): Promise<boolean> {
  const prisma = getPrismaClient();
  const candidate = await prisma.examAttempt.findUnique({
    where: { id: attemptId },
    select: { id: true, status: true, expiresAt: true },
  });
  if (!candidate) return false;
  if (candidate.status !== "IN_PROGRESS" && candidate.status !== "PAUSED") {
    return false;
  }
  if (candidate.expiresAt > new Date()) {
    return false;
  }

  const result = await finalizeExamAttempt({
    attemptId,
    reason: SubmissionReason.TIMER_EXPIRED,
    auditMetadata: { source: "inline-deadline-check" },
  });
  return !result.alreadyFinalized;
}

export function startExamExpirationWorker(intervalMs = 5_000): void {
  if (workerTimer) return;

  const runSweep = async () => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    try {
      await sweepExpiredExamAttempts();
      await sweepMissingHeartbeats();
    } catch (error) {
      console.error("[Pariksha] Exam expiration & heartbeat sweep failed:", error);
    } finally {
      sweepInFlight = false;
    }
  };

  // Initial server startup recovery sweep
  void runSweep();

  workerTimer = setInterval(() => {
    void runSweep();
  }, intervalMs);
  workerTimer.unref();
}

export function stopExamExpirationWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}
