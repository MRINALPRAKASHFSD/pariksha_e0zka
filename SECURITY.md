# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Security model

- **Authentication**: Sessions use opaque 256-bit random tokens in `HttpOnly; SameSite=Lax` cookies (`Secure` in production), stored as SHA-256 digests in PostgreSQL.
- **CSRF protection**: Every mutating API route validates a session-bound HMAC CSRF token passed in `X-CSRF-Token`.
- **Submission immutability**: PostgreSQL triggers block updates, deletes, or status downgrades on finalized `ExamAttempt`, `ExamAnswer`, and `ExamSubmission` rows.
- **Browser proctoring boundaries**: Client-side lockdown and media checks operate within standard browser sandboxes. Read [docs/SECURITY_LIMITATIONS.md](docs/SECURITY_LIMITATIONS.md) for documented browser constraints and privacy guarantees.

## Reporting a vulnerability

Please do not open public GitHub issues for suspected security vulnerabilities, authentication bypasses, or privilege escalation bugs.

Instead, report findings privately through GitHub's [Private Vulnerability Reporting](https://github.com/MRINALPRAKASHFSD/pariksha_e0zka/security/advisories/new) tab on this repository with:

1. Affected endpoint, component, or database trigger.
2. Minimal reproduction steps or proof-of-concept request.
3. Expected vs. observed authorization or state behavior.
