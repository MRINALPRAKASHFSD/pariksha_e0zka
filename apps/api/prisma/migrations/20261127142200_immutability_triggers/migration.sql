-- Enforce database-level immutability for finalized student answers and submissions

CREATE OR REPLACE FUNCTION pariksha_prevent_finalized_answer_mutation()
RETURNS TRIGGER AS $$
DECLARE
  attempt_status "AttemptStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."isFinalized" = true THEN
      RAISE EXCEPTION 'Finalized exam answers cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."isFinalized" = true THEN
    RAISE EXCEPTION 'Finalized exam answers are immutable';
  END IF;

  SELECT status INTO attempt_status
  FROM "ExamAttempt"
  WHERE id = OLD."attemptId";

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

CREATE TRIGGER trg_exam_answer_immutability
BEFORE UPDATE OR DELETE ON "ExamAnswer"
FOR EACH ROW
EXECUTE FUNCTION pariksha_prevent_finalized_answer_mutation();

CREATE OR REPLACE FUNCTION pariksha_prevent_submission_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ExamSubmission records are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_exam_submission_immutability
BEFORE UPDATE OR DELETE ON "ExamSubmission"
FOR EACH ROW
EXECUTE FUNCTION pariksha_prevent_submission_mutation();
