# Contributing to Pariksha

Thanks for working on Pariksha. Follow the workflow below so database migrations, security checks, and isolated test runs stay consistent.

## Local setup

1. Install Node.js 22+ (`.nvmrc` pins `24.13.1`) and PostgreSQL 16.
2. Create two local databases on port `5432`: `pariksha` for development and `pariksha_test` for automated suites.
3. Copy `.env.example` to `~/.config/pariksha/.env` (and `.env.test` pointing at `pariksha_test`) with random 64-character hex secrets for `SESSION_SECRET` and `CSRF_SECRET`.
4. Install dependencies and apply migrations:

```bash
npm install
npm run db:generate
npm run db:migrate:deploy
NODE_ENV=test npm run db:migrate:deploy
```

## Development guidelines

- **Database safety**: Never run destructive integration or Playwright tests against `pariksha`. `apps/api/tests/testDbGuard.ts` enforces `NODE_ENV=test` and checks that `DATABASE_URL` targets a `_test` database before truncating tables.
- **No persistent client exam state**: Keep exam questions, answers, CSRF tokens, and proctoring telemetry out of `localStorage`, `sessionStorage`, and `IndexedDB`.
- **Migrations and triggers**: Add schema changes as forward-only Prisma migrations. Do not weaken the PL/pgSQL immutability triggers on `ExamAttempt`, `ExamAnswer`, or `ExamSubmission`.
- **Shared validation**: Put request/response schemas and shared enums in `packages/shared` and rebuild `@pariksha/shared` (`npm run build -w @pariksha/shared`) when changing exported contracts.

## Pre-PR checklist

Run the full verification suite locally before opening a pull request:

```bash
npm run typecheck
npm run lint
npm run build
npm run test
npm run test:e2e -w @pariksha/web
```
