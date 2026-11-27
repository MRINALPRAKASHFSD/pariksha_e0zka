-- Enforce at most one active (IN_PROGRESS or PAUSED) attempt per student per exam
CREATE UNIQUE INDEX IF NOT EXISTS "ExamAttempt_one_active_per_student_exam_idx"
  ON "ExamAttempt" ("examId", "studentId")
  WHERE "status" IN ('IN_PROGRESS', 'PAUSED');
