# Proctoring guide and verification checklist

## How proctoring works in Phase 5

1. **Policy inheritance and snapshotting**: `ProctoringPolicy` has a single institutional default row (`isInstitutionalDefault = true`, `examId = null`) and optional exam-level overrides. Editing a policy bumps its integer `version` and writes an `AuditLog` entry. Starting an attempt copies the resolved policy JSON, version, and `violationThreshold` onto the `ExamAttempt` row so rule changes mid-exam never affect students already taking the test.
2. **Single-use preflight handshakes**: Unless `allowUnproctoredDev` is enabled in a non-production environment, `POST /api/v1/student/exams/:examId/start` requires a `preflightToken` minted by `POST /api/v1/student/exams/:examId/preflight`. The token is stored as an HMAC-SHA256 hash using `CSRF_SECRET`, expires after 5 minutes, and is bound to `(studentId, examId, sessionId, policyVersion)`. Replaying a consumed token returns `409 PREFLIGHT_REPLAYED`.
3. **Client media and lockdown hooks**:
   - `useProctoringMedia` (`apps/web/src/hooks/useProctoringMedia.ts`) requests webcam and screen-share video tracks (`audio: false`), checks `displaySurface` against `allowedScreenSurface`, deduplicates `ended` events per stream ID, hands live streams in memory from the preflight screen to the attempt view, and stops all tracks on submit or unmount.
   - `useExamLockdown` (`apps/web/src/hooks/useExamLockdown.ts`) attaches and cleans up listeners safely under React StrictMode. It blocks copy, cut, paste, right-click, prompt text selection, and outside-input select-all according to policy while leaving normal typing inside subjective `<textarea>` fields untouched.
4. **Row-locked strike counter**: `processIntegrityEvent` (`apps/api/src/services/proctoringEngine.ts`) locks the attempt row with `SELECT ... FOR UPDATE`, ignores duplicate `clientEventId` retries, expires overdue attempts first (`TIMER_EXPIRED`), checks whether the rule is active, collapses overlapping signals within `dedupWindowSeconds`, and either logs a warning or calls `finalizeExamAttempt(..., VIOLATION_THRESHOLD)` when strikes hit `strikeThreshold`.
5. **Heartbeats and media pause recovery**: The exam page posts monotonic sequence numbers to `/heartbeat`. A background worker (`sweepMissingHeartbeats`) claims overdue active attempts with `FOR UPDATE OF a SKIP LOCKED` and records a single `HEARTBEAT_MISSED` event per outage. If webcam or screen sharing stops when `pauseOnMediaLoss` is enabled, the attempt enters `PAUSED`, answer autosaves return `409 ATTEMPT_PAUSED`, and the student must re-enable the missing stream and call `/resume` while the original `expiresAt` clock keeps running.

## Phase 5 API endpoints (`/api/v1`)

### Admin proctoring (`ADMIN`)
- `GET /admin/proctoring/policies`
- `GET /admin/proctoring/default-policy`
- `PATCH /admin/proctoring/default-policy`
- `POST /admin/proctoring/default-policy/restore`
- `GET /admin/proctoring/exams/:examId/policy` and `GET /admin/exams/:examId/proctoring-policy`
- `PATCH /admin/proctoring/exams/:examId/policy` and `PATCH /admin/exams/:examId/proctoring-policy`
- `POST /admin/proctoring/exams/:examId/policy/reset` and `POST /admin/exams/:examId/proctoring-policy/reset`
- `GET /admin/proctoring/attempts`
- `GET /admin/proctoring/attempts/:attemptId/events`
- `GET /admin/proctoring/events`
- `GET /admin/proctoring/events/export`
- `POST /admin/exams/:examId/attempts/:attemptId/terminate`

### Teacher integrity review (`TEACHER`, assigned courses only)
- `GET /teacher/exams/:examId/integrity-events`
- `GET /teacher/exams/:examId/attempts/:attemptId/events`

### Student proctoring lifecycle (`STUDENT`, own attempts only)
- `GET /student/exams/:examId/preflight`
- `POST /student/exams/:examId/preflight`
- `POST /student/exams/:examId/start`
- `POST /student/attempts/:attemptId/integrity-events` (also `/student/exams/:examId/attempts/:attemptId/integrity-events`)
- `POST /student/attempts/:attemptId/heartbeat` (also `/student/exams/:examId/attempts/:attemptId/heartbeat`)
- `POST /student/attempts/:attemptId/resume` (also `/student/exams/:examId/attempts/:attemptId/resume`)

### Socket.IO events
- Client -> Server: `proctoring:join-attempt` (`{ attemptId }`), `proctoring:join-admin-monitor`
- Server -> Client (emitted after DB transaction commit): `proctoring:event`, `proctoring:warning`, `proctoring:attempt-paused`, `exam:attempt-finalized`

## Manual macOS verification checklist

Automated Playwright tests (`apps/web/e2e/phase5.spec.ts`) exercise permission denial, retry, surface validation, camera track interruption, pause/resume, and two-strike auto-submission using synthetic `HTMLCanvasElement.captureStream` and fullscreen mocks in headless Chromium. Before running a live exam on macOS laptops, run through these physical browser checks:

1. **Chrome on macOS**:
   - Open `/student/exams/:examId/preflight` for an active proctored exam and click **Enable Camera** and **Share Screen**. Confirm macOS prompts for Camera and Screen Recording (`System Settings -> Privacy & Security -> Screen & System Audio Recording`).
   - Open DevTools -> Network and verify that no video frames or binary media blobs leave the browser during the attempt.
   - Set `allowedScreenSurface` to `MONITOR` in `/admin/proctoring`, pick a single Chrome tab instead of the full screen, and confirm preflight rejects the surface and stops the track immediately.
   - Start the attempt, click Chrome's native **Stop sharing** bar, confirm the attempt switches to `PAUSED` with autosave blocked, re-share the screen, and click **Resume Examination** to confirm the strike count stays at `1 / 2` and the timer deadline does not extend.
2. **Safari on macOS**:
   - Run through the preflight checks, type multi-line answers in a subjective question to verify keyboard shortcuts do not interfere with normal text entry, and submit the attempt. Confirm the green macOS menu-bar camera indicator turns off right after submission.
3. **Production guard**:
   - Start the API with `NODE_ENV=production` and confirm attempting to approve or launch an exam with `allowUnproctoredDev: true` fails with `403`.
