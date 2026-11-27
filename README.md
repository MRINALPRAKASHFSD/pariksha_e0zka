# Pariksha

Pariksha is an online examination, coursework, and browser proctoring platform built with TypeScript, React, Express, and PostgreSQL. The repository is organized as an npm workspace monorepo across `packages/shared`, `apps/api`, and `apps/web`.

## Requirements

- Node.js 22 or newer (tested on v24.13.1)
- npm 10 or newer (tested on 11.8.0)
- PostgreSQL 16 running on port `5432` with two databases: `pariksha` and `pariksha_test`

## Keeping secrets out of iCloud Drive

If you clone this repository inside an iCloud Drive folder, keep real credentials and uploaded files outside the synced directory tree. The backend loads environment files in this order without overwriting variables already set in your shell:

1. `PARIKSHA_ENV_FILE` (or `PARIKSHA_TEST_ENV_FILE` when `NODE_ENV=test`)
2. `~/.config/pariksha/.env` (or `~/.config/pariksha/.env.test` when `NODE_ENV=test`)
3. Workspace `.env` or `.env.test` as a gitignored local fallback

Uploaded assignment files default to `~/.local/share/pariksha/uploads` in development and `/tmp/pariksha-test-uploads` during automated tests.

## Setup and database migrations

```bash
npm install
npm run db:generate

# Apply migrations to the development database (pariksha)
npm run db:migrate:deploy

# Apply migrations to the isolated test database (pariksha_test)
NODE_ENV=test npm run db:migrate:deploy

# Check migration state
npm run db:status
```

## Bootstrapping accounts

Seed scripts read credentials from environment variables instead of hardcoding passwords in source control.

```bash
# Bootstrap only the initial administrator account
BOOTSTRAP_ADMIN_EMAIL=admin@example.edu \
BOOTSTRAP_ADMIN_PASSWORD='<strong-password>' \
BOOTSTRAP_ADMIN_NAME='System Administrator' \
npm run db:seed

# Optional local development accounts (admin, teacher, and student)
SEED_DEV_ACCOUNTS=true \
BOOTSTRAP_ADMIN_EMAIL=admin@pariksha.local \
BOOTSTRAP_ADMIN_PASSWORD='<admin-password>' \
SEED_DEV_TEACHER_PASSWORD='<teacher-password>' \
SEED_DEV_STUDENT_PASSWORD='<student-password>' \
npm run db:seed
```

## Running locally

```bash
# Starts the Express API on http://localhost:4000 and Vite on http://localhost:5173
npm run dev
```

## What is built so far

### Authentication, sessions, and coursework
Users sign in with opaque 256-bit session tokens stored as `HttpOnly` cookies, backed by hashed `Session` rows in PostgreSQL and session-bound CSRF tokens on every state-changing request. Administrators manage users, courses, bulk CSV student enrollments, and audit logs. Teachers publish assignments, collect validated file submissions, and release grades.

### Examination engine
Teachers author draft exams with five question types (`MULTIPLE_CHOICE`, `MULTIPLE_SELECT`, `TRUE_FALSE`, `SUBJECTIVE_SHORT`, `SUBJECTIVE_LONG`), reorder items, and import or export CSV and JSON question banks. Administrators review, reject, schedule, pause, version, or cancel exams. When a student starts an attempt, the server freezes question and answer-key snapshots on the attempt row, enforces server-side deadlines through a background `FOR UPDATE SKIP LOCKED` worker, and locks finalized submissions with PostgreSQL triggers.

### Browser proctoring and two-strike enforcement
Administrators set an institutional default proctoring policy and optional per-exam overrides at `/admin/proctoring`. Before starting a monitored exam, students complete a hardware and permission preflight check (webcam preview, screen-share surface check, fullscreen mode, server ping, and consent) that mints a single-use `PreflightHandshake` token bound to their session and policy version.

During an active attempt, the browser monitors media track continuity, fullscreen state, tab switches, window focus, and restricted clipboard shortcuts while keeping raw video local to the student's machine. Integrity events are processed inside row-locked PostgreSQL transactions (`SELECT ... FOR UPDATE`) with configurable deduplication windows. Media loss pauses the attempt until streams are restored without extending the deadline, and reaching the configured strike count automatically submits and locks the attempt. Exam questions, answers, CSRF tokens, and violation state stay in memory and PostgreSQL, never in `localStorage`, `sessionStorage`, or `IndexedDB`.

## Running checks and tests

```bash
npm run typecheck
npm run lint
npm run build
npm run test

# End-to-end Playwright suite (runs against pariksha_test on ports 4001 and 5174)
npm run test:e2e -w @pariksha/web
```

Integration and Playwright suites check the database name before truncating tables and refuse to run against any database other than `pariksha_test`.

## Security notes

- Uploaded files go through extension, MIME, size, magic-byte, and OOXML archive checks (blocking macro-enabled Office files) and are stored under random UUID filenames outside the web root. No built-in antivirus engine is bundled; wire up ClamAV or an object-storage scanner before accepting untrusted uploads in production.
- `npm audit` currently flags 4 high-severity advisories inside the dev-only `prisma` CLI dependency chain (`@prisma/config` -> `deepmerge-ts`, `effect`). The runtime `@prisma/client` package has zero reported vulnerabilities.

## Further reading

- [Architecture and data model](docs/ARCHITECTURE.md)
- [Browser security limits and privacy model](docs/SECURITY_LIMITATIONS.md)
- [Proctoring API and macOS verification checklist](docs/PROCTORING_GUIDE.md)
