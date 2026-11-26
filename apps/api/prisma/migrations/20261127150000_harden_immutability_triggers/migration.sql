-- Harden immutability triggers against INSERT bypasses, state-machine downgrades,
-- and READ COMMITTED concurrent transaction race conditions.

CREATE OR REPLACE FUNCTION pariksha_prevent_finalized_answer_mutation()
RETURNS TRIGGER AS $$
DECLARE
  target_attempt_id UUID;
  attempt_status "AttemptStatus";
  attempt_locked BOOLEAN;
BEGIN
  target_attempt_id := COALESCE(NEW."attemptId", OLD."attemptId");

  -- Lock the parent ExamAttempt row FOR SHARE so any concurrent submission/expiration
  -- transaction holding FOR UPDATE must finish before this trigger evaluates status.
  SELECT status, "isLocked"
  INTO attempt_status, attempt_locked
  FROM "ExamAttempt"
  WHERE id = target_attempt_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Parent ExamAttempt not found for ExamAnswer';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF attempt_status IN ('SUBMITTED', 'AUTO_SUBMITTED', 'EXPIRED', 'TERMINATED')
       OR attempt_locked = true THEN
      RAISE EXCEPTION 'Cannot insert exam answers for a finalized or locked attempt';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD."isFinalized" = true
       OR attempt_status IN ('SUBMITTED', 'AUTO_SUBMITTED', 'EXPIRED', 'TERMINATED') THEN
      RAISE EXCEPTION 'Finalized exam answers cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  -- TG_OP = 'UPDATE'
  IF OLD."isFinalized" = true THEN
    RAISE EXCEPTION 'Finalized exam answers are immutable';
  END IF;

  IF NEW."attemptId" IS DISTINCT FROM OLD."attemptId"
     OR NEW."questionId" IS DISTINCT FROM OLD."questionId" THEN
    RAISE EXCEPTION 'ExamAnswer foreign keys cannot be reassigned';
  END IF;

  IF attempt_status IN ('SUBMITTED', 'AUTO_SUBMITTED', 'EXPIRED', 'TERMINATED') THEN
    IF NEW."selectedOptionIds" IS DISTINCT FROM OLD."selectedOptionIds"
       OR NEW."subjectiveText" IS DISTINCT FROM OLD."subjectiveText"
       OR NEW."markedForReview" IS DISTINCT FROM OLD."markedForReview" THEN
      RAISE EXCEPTION 'Cannot modify exam answers after attempt submission or expiration';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_exam_answer_immutability ON "ExamAnswer";
CREATE TRIGGER trg_exam_answer_immutability
BEFORE INSERT OR UPDATE OR DELETE ON "ExamAnswer"
FOR EACH ROW
EXECUTE FUNCTION pariksha_prevent_finalized_answer_mutation();

-- Prevent terminal ExamAttempt status downgrade or immutable field tampering
CREATE OR REPLACE FUNCTION pariksha_protect_terminal_attempt()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('SUBMITTED', 'AUTO_SUBMITTED', 'EXPIRED', 'TERMINATED') THEN
      RAISE EXCEPTION 'Submitted or terminated ExamAttempt records cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IN ('SUBMITTED', 'AUTO_SUBMITTED', 'EXPIRED', 'TERMINATED') THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW."examId" IS DISTINCT FROM OLD."examId"
       OR NEW."studentId" IS DISTINCT FROM OLD."studentId"
       OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
       OR NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt" THEN
      RAISE EXCEPTION 'Terminal ExamAttempt state is immutable and cannot be downgraded';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_exam_attempt_terminal_protection ON "ExamAttempt";
CREATE TRIGGER trg_exam_attempt_terminal_protection
BEFORE UPDATE OR DELETE ON "ExamAttempt"
FOR EACH ROW
EXECUTE FUNCTION pariksha_protect_terminal_attempt();

-- Ensure ExamSubmission rows are only inserted for terminal attempts and remain immutable
CREATE OR REPLACE FUNCTION pariksha_prevent_submission_mutation()
RETURNS TRIGGER AS $$
DECLARE
  attempt_status "AttemptStatus";
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO attempt_status
    FROM "ExamAttempt"
    WHERE id = NEW."attemptId"
    FOR SHARE;

    IF NOT FOUND OR attempt_status NOT IN ('SUBMITTED', 'AUTO_SUBMITTED', 'EXPIRED', 'TERMINATED') THEN
      RAISE EXCEPTION 'ExamSubmission requires a finalized ExamAttempt';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'ExamSubmission records are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_exam_submission_immutability ON "ExamSubmission";
CREATE TRIGGER trg_exam_submission_immutability
BEFORE INSERT OR UPDATE OR DELETE ON "ExamSubmission"
FOR EACH ROW
EXECUTE FUNCTION pariksha_prevent_submission_mutation();
