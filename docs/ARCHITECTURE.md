# Architecture and security design

## Workspace layout

Pariksha is split into three TypeScript workspaces:

- `packages/shared`: Zod validation schemas, role and status enums, proctoring policy defaults, and shared API DTO types.
- `apps/api`: Express 4 REST API, Socket.IO server, Prisma 6 ORM client, background expiration and heartbeat workers, and Supertest integration suites.
- `apps/web`: React 19 single-page app built with Vite and Tailwind CSS, organized by role (`admin`, `teacher`, `student`) with Playwright end-to-end tests.

## Implementation roadmap

1. **Phase 1 (Foundation)**: Monorepo setup, PostgreSQL schema, database immutability triggers, Helmet/CORS/rate-limit middleware, health checks, and base UI shell.
2. **Phase 2 (Authentication and users)**: `crypto.scrypt` password hashing, `HttpOnly` cookie sessions, session-bound CSRF validation, role-based access control, temporary password expiry, admin user management, and audit logs.
3. **Phase 3 (Courses and assignments)**: Role dashboards backed by PostgreSQL aggregates, course and enrollment management, CSV enrollment import, assignment publishing, validated file uploads, and teacher grading.
4. **Phase 4 (Examination engine)**: Multi-type question authoring, CSV/JSON import and formula-safe export, admin approval and scheduling workflow, exam versioning, server-timed student attempts, optimistic answer autosave, background expiry worker, and immutable submission receipts.
5. **Phase 5 (Proctoring and two-strike engine)**: Institutional and per-exam proctoring policies, single-use preflight handshakes, client media and lockdown hooks, pause-on-media-loss recovery, monotonic heartbeats, row-locked strike deduplication and auto-submission, Socket.IO room authorization, and CSV event exports.
6. **Phase 6 (Planned: Grading and results)**: Objective auto-grading, manual subjective grading, controlled result publication, and score distribution charts.
7. **Phase 7 (Planned: Hardening and accessibility)**: Load testing, extended WCAG keyboard/screen-reader pass, and UI polish.
8. **Phase 8 (Planned: Deployment)**: Container images, reverse-proxy configs, and production runbooks.

## Database model and immutability triggers

The Prisma schema defines 20 normalized models across 7 migrations:

- `User` has many `Session`, `Course` (as assigned teacher), `Enrollment` (as student), `ExamAttempt`, `PreflightHandshake`, and `AuditLog` records.
- `Course` groups `Enrollment`, `Assignment`, and `Exam` rows.
- `Exam` owns `Question` (with `QuestionOption`), optional `ProctoringPolicy` override, `ExamAttempt`, `ExamSubmission`, `PreflightHandshake`, and `Result` records. A partial unique index ensures only one row has `isInstitutionalDefault = true` with `examId IS NULL`.
- `ExamAttempt` owns `ExamAnswer`, `ExamSubmission`, `IntegrityEvent`, `Grade`, and `Result` records, plus frozen `questionSnapshotJson`, `answerKeySnapshotJson`, and `policySnapshotJson` columns captured when the attempt starts.

PostgreSQL PL/pgSQL triggers (`trg_exam_answer_immutability`, `trg_exam_attempt_terminal_protection`, `trg_exam_submission_immutability`) enforce three database-level guarantees even if application code has a bug:

1. `ExamAnswer` rows cannot be inserted, updated, or deleted once `isFinalized = true` or once the parent `ExamAttempt` reaches `SUBMITTED`, `AUTO_SUBMITTED`, `EXPIRED`, or `TERMINATED`.
2. Terminal `ExamAttempt` rows cannot be downgraded back to `IN_PROGRESS` or `PAUSED`.
3. `ExamSubmission` rows are append-only and reject all `UPDATE` and `DELETE` statements.

## API overview (`/api/v1`)

- **System**: `GET /health`, `GET /system/capabilities`
- **Auth**: `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `GET /auth/csrf`, `POST /auth/change-password`
- **Admin users and academics**:
  - `GET/POST /admin/users`, `PATCH /admin/users/:id`, `PATCH /admin/users/:id/status`, `POST /admin/users/:id/reset-password`, `POST /admin/users/:id/revoke-sessions`
  - `GET /admin/dashboard`, `GET /admin/audit-logs`
  - `GET/POST /admin/courses`, `GET/PATCH /admin/courses/:id`, `POST /admin/courses/:id/enrollments`, `POST /admin/courses/:id/enrollments/bulk`, `PATCH/DELETE /admin/courses/:id/enrollments/:enrollmentId`
- **Admin exams and proctoring**:
  - `GET /admin/exams`, `GET /admin/exams/:examId`, `POST /admin/exams/:examId/{approve,reject,activate,pause,cancel,create-version}`, `PATCH /admin/exams/:examId/config`, `GET /admin/exams/:examId/attempts`, `POST /admin/exams/:examId/attempts/:attemptId/terminate`, `GET /admin/exams/:examId/questions/export`
  - `GET /admin/proctoring/policies`, `GET/PATCH /admin/proctoring/default-policy`, `POST /admin/proctoring/default-policy/restore`
  - `GET/PATCH /admin/proctoring/exams/:examId/policy`, `POST /admin/proctoring/exams/:examId/policy/reset` (also aliased under `/admin/exams/:examId/proctoring-policy`)
  - `GET /admin/proctoring/attempts`, `GET /admin/proctoring/attempts/:attemptId/events`, `GET /admin/proctoring/events`, `GET /admin/proctoring/events/export`
- **Teacher**:
  - `GET /teacher/dashboard`, `GET /teacher/courses`, `GET /teacher/courses/:id`
  - `GET/POST /teacher/assignments`, `GET/PATCH /teacher/assignments/:id`, `POST /teacher/assignments/:id/{publish,archive}`, `POST /teacher/assignments/:id/submissions/:subId/grade`
  - `GET/POST /teacher/exams`, `GET/PATCH /teacher/exams/:examId`, `POST /teacher/exams/:examId/{duplicate,submit-for-approval}`, `GET /teacher/exams/:examId/{preview,attempts,integrity-events}`, `GET /teacher/exams/:examId/attempts/:attemptId/events`
  - `POST /teacher/exams/:examId/questions`, `PATCH /teacher/exams/:examId/questions/reorder`, `PATCH/DELETE /teacher/exams/:examId/questions/:questionId`, `POST /teacher/exams/:examId/questions/import`, `GET /teacher/exams/:examId/questions/export`, `GET /teacher/exams/templates/:format`
- **Student**:
  - `GET /student/dashboard`, `GET /student/courses`, `GET /student/courses/:id`
  - `GET /student/assignments`, `GET /student/assignments/:id`, `POST /student/assignments/:id/submit`
  - `GET /student/exams`, `GET/POST /student/exams/:examId/preflight`, `POST /student/exams/:examId/start`
  - `GET /student/exams/:examId/attempts/:attemptId`, `PUT /student/exams/:examId/attempts/:attemptId/answers`, `POST /student/exams/:examId/attempts/:attemptId/submit`, `GET /student/exams/:examId/attempts/:attemptId/receipt`
  - `POST /student/attempts/:attemptId/{integrity-events,heartbeat,resume}` (also mounted under `/student/exams/:examId/attempts/:attemptId/*`)
- **Files**: `GET /files/:fileId` (authenticated role and course enrollment check before streaming from disk)

## Security and concurrency mechanics

- **Session cookies and CSRF**: Raw session tokens are 32 random bytes encoded as hex in an `HttpOnly; SameSite=Lax; Path=/` cookie (`Secure` in production). Only the HMAC/SHA-256 digest is stored in PostgreSQL. Every mutating endpoint checks an HMAC CSRF token tied to the active `sessionId`.
- **Passwords**: `crypto.scrypt` (`N=16384, r=8, p=1`, 64-byte derived key) with random 16-byte salts and constant-time buffer comparison via `crypto.timingSafeEqual`.
- **Socket.IO revalidation**: Every incoming socket packet re-checks session validity in PostgreSQL, and a 30-second timer disconnects sockets whose sessions expired or whose user accounts were deactivated. Joining `attempt:<id>` or `admin:proctoring` checks database ownership first.
- **Row-locked strike processing**: `processIntegrityEvent` runs inside `prisma.$transaction`, locks the `ExamAttempt` row with `FOR UPDATE`, checks `(attemptId, clientEventId)` for idempotent retries, verifies `now < expiresAt`, deduplicates grouped events within `dedupWindowSeconds`, updates strike or pause state, and calls `finalizeExamAttempt` in the same transaction when `violationCount >= strikeThreshold`. Socket events fire only after the transaction commits.

## Local iCloud Drive precautions

When developing inside an iCloud-synced folder on macOS:

- Keep `.env` files in `~/.config/pariksha/` so real secrets are never uploaded to iCloud or committed to Git.
- Keep `UPLOAD_DIR` outside the repository (default `~/.local/share/pariksha/uploads`).
- PostgreSQL data files stay in Homebrew's local `var/postgresql@16` directory outside iCloud Drive.
