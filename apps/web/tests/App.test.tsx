import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";

function mockFetchRoutes(routes: Record<string, { ok: boolean; status: number; body: unknown }>) {
  return vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
    const match = routes[path];
    if (match) {
      return {
        ok: match.ok,
        status: match.status,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => match.body,
      };
    }
    return {
      ok: false,
      status: 401,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        success: false,
        error: { code: "UNAUTHENTICATED", message: "Authentication required" },
      }),
    };
  });
}

describe("Phase 1 & Phase 2 Web UI", () => {
  afterEach(() => {
    window.history.pushState({}, "", "/");
    vi.restoreAllMocks();
  });

  it("renders platform overview with live health check and never writes to localStorage/sessionStorage", async () => {
    const localSetSpy = vi.spyOn(Storage.prototype, "setItem");

    vi.stubGlobal(
      "fetch",
      mockFetchRoutes({
        "/api/v1/health": {
          ok: true,
          status: 200,
          body: {
            success: true,
            data: {
              status: "ok",
              service: "pariksha-api",
              timestamp: new Date().toISOString(),
              uptimeSeconds: 12,
              database: { connected: true, latencyMs: 1.4 },
            },
          },
        },
      }),
    );

    render(<App />);

    expect(screen.getByText("Pariksha Platform Foundation")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Operational")).toBeInTheDocument();
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });

    expect(screen.getByText("2 Strikes")).toBeInTheDocument();
    expect(localSetSpy).not.toHaveBeenCalled();
  });

  it("20 & 21. Redirects unauthenticated users from protected routes to /login and never touches browser storage", async () => {
    const localSetSpy = vi.spyOn(Storage.prototype, "setItem");
    window.history.pushState({}, "", "/admin/users");

    vi.stubGlobal("fetch", mockFetchRoutes({}));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Sign in to Pariksha")).toBeInTheDocument();
    });
    expect(localSetSpy).not.toHaveBeenCalled();
  });

  it("21b. Rejects student navigation to /admin with Unauthorized page", async () => {
    window.history.pushState({}, "", "/admin");

    vi.stubGlobal(
      "fetch",
      mockFetchRoutes({
        "/api/v1/auth/me": {
          ok: true,
          status: 200,
          body: {
            success: true,
            data: {
              user: {
                id: "stu-1",
                email: "student@pariksha.test",
                fullName: "Rohan Mehta",
                role: "STUDENT",
                status: "ACTIVE",
                lastLoginAt: null,
                createdAt: new Date().toISOString(),
              },
              csrfToken: "csrf-in-memory",
            },
          },
        },
      }),
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Unauthorized Access")).toBeInTheDocument();
    });
  });

  it("authenticates admin via LoginPage without browser storage writes and renders Admin Console", async () => {
    const localSetSpy = vi.spyOn(Storage.prototype, "setItem");
    window.history.pushState({}, "", "/login");

    const fetchMock = mockFetchRoutes({
      "/api/v1/auth/csrf": {
        ok: true,
        status: 200,
        body: { success: true, data: { csrfToken: "pre-csrf" } },
      },
      "/api/v1/auth/login": {
        ok: true,
        status: 200,
        body: {
          success: true,
          data: {
            user: {
              id: "adm-1",
              email: "admin@pariksha.test",
              fullName: "Admin User",
              role: "ADMIN",
              status: "ACTIVE",
              lastLoginAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            },
            csrfToken: "sess-csrf",
          },
        },
      },
      "/api/v1/admin/dashboard": {
        ok: true,
        status: 200,
        body: {
          success: true,
          data: {
            courses: { total: 0, active: 0, archived: 0 },
            users: {
              total: 1,
              active: 1,
              inactive: 0,
              suspended: 0,
              byRole: { ADMIN: 1, TEACHER: 0, STUDENT: 0 },
            },
            enrollments: { active: 0, dropped: 0, completed: 0 },
            assignments: { total: 0, published: 0, draft: 0, submissions: 0 },
            recentActivity: [],
          },
        },
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText("Institutional Email")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Institutional Email"), {
      target: { value: "admin@pariksha.test" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "AdminPass!2026" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => {
      expect(screen.getByText("Administrator Console")).toBeInTheDocument();
    });
    expect(localSetSpy).not.toHaveBeenCalled();
  });

  it("renders student distraction-free exam workspace and saves answers strictly to server without browser storage", async () => {
    const localSetSpy = vi.spyOn(Storage.prototype, "setItem");
    const sessionSetSpy = vi.spyOn(window.sessionStorage, "setItem");

    const now = Date.now();
    const attemptId = "11111111-1111-4111-8111-111111111111";
    const examId = "22222222-2222-4222-8222-222222222222";
    const q1Id = "33333333-3333-4333-8333-333333333333";
    const opt1Id = "44444444-4444-4444-8444-444444444444";

    window.history.pushState({}, "", `/student/exams/${examId}/attempt/${attemptId}`);

    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;

      if (path === "/api/v1/auth/me") {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            success: true,
            data: {
              user: {
                id: "55555555-5555-4555-8555-555555555555",
                email: "student@pariksha.test",
                fullName: "Rohan Student",
                role: "STUDENT",
                status: "ACTIVE",
                mustChangePassword: false,
                lastLoginAt: new Date(now).toISOString(),
                createdAt: new Date(now).toISOString(),
              },
              csrfToken: "student-csrf",
            },
          }),
        };
      }

      if (path === `/api/v1/student/exams/${examId}/attempts/${attemptId}` && (!init?.method || init.method === "GET")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            success: true,
            data: {
              id: attemptId,
              examId,
              examTitle: "Distributed Systems Midterm",
              courseCode: "CS401",
              courseTitle: "Distributed Systems",
              examVersion: 1,
              instructions: null,
              status: "IN_PROGRESS",
              finalizationReason: null,
              attemptNumber: 1,
              startedAt: new Date(now).toISOString(),
              expiresAt: new Date(now + 1800_000).toISOString(),
              serverNow: new Date(now).toISOString(),
              submittedAt: null,
              durationMinutes: 30,
              remainingSeconds: 1800,
              totalMarks: 5,
              passingMarks: 2,
              shuffleQuestions: false,
              shuffleOptions: false,
              revision: 1,
              isLocked: false,
              allowUnproctoredDev: true,
              violationCount: 0,
              warningCount: 0,
              strikeThreshold: 2,
              policyVersion: 1,
              pauseReason: null,
              cameraActive: false,
              screenShareActive: false,
              fullscreenActive: false,
              lastHeartbeatAt: null,
              recentIntegrityEvents: [],
              policy: {
                requireWebcam: false,
                requireScreenShare: false,
                requireFullscreen: false,
                allowedScreenSurface: "ANY",
                detectTabSwitch: false,
                detectWindowBlur: false,
                detectFullscreenExit: false,
                detectCameraInterruption: false,
                detectScreenShareInterruption: false,
                restrictCopyPasteCut: false,
                restrictSelectAll: false,
                restrictRightClick: false,
                restrictTextSelection: false,
                detectClipboard: false,
                detectExtensionsHeuristic: false,
                extensionStrikeMode: "AUDIT_ONLY",
                monitorConnectionHeartbeat: false,
                monitorMediaHeartbeat: false,
                heartbeatIntervalSeconds: 30,
                heartbeatTimeoutSeconds: 120,
                heartbeatGraceSeconds: 60,
                mediaGraceSeconds: 30,
                dedupWindowSeconds: 5,
                violationThreshold: 2,
                pauseOnMediaLoss: false,
              },
              preflight: {
                mode: "UNPROCTORED_DEV",
                proctoringEngineImplemented: true,
                canStartAttempt: true,
                requiresPreflightHandshake: false,
                blockingCode: null,
                blockingMessage: null,
                bannerLabel: "Development-only unproctored examination mode (disabled automatically in production)",
                requirements: {
                  requireWebcam: false,
                  requireScreenShare: false,
                  requireFullscreen: false,
                  allowedScreenSurface: "ANY",
                  violationThreshold: 2,
                  heartbeatIntervalSeconds: 30,
                  heartbeatTimeoutSeconds: 120,
                  heartbeatGraceSeconds: 60,
                  mediaGraceSeconds: 30,
                  pauseOnMediaLoss: false,
                },
              },
              questions: [
                {
                  id: q1Id,
                  type: "TRUE_FALSE",
                  prompt: "Raft elects a single leader per term.",
                  marks: 5,
                  negativeMarks: 0,
                  orderIndex: 1,
                  isRequired: true,
                  options: [
                    { id: opt1Id, label: "A", text: "True", orderIndex: 1 },
                    { id: "66666666-6666-4666-8666-666666666666", label: "B", text: "False", orderIndex: 2 },
                  ],
                },
              ],
              answers: [],
              receipt: null,
            },
          }),
        };
      }

      if (path === `/api/v1/student/exams/${examId}/attempts/${attemptId}/answers`) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            success: true,
            data: {
              answer: {
                questionId: q1Id,
                selectedOptionIds: [opt1Id],
                textAnswer: null,
                markedForReview: false,
                revision: 1,
                lastClientSequence: 1,
                lastSavedAt: new Date().toISOString(),
                isFinalized: false,
              },
              serverNow: new Date().toISOString(),
              expiresAt: new Date(now + 1800_000).toISOString(),
              remainingSeconds: 1799,
              attemptStatus: "IN_PROGRESS",
              staleIgnored: false,
            },
          }),
        };
      }

      return {
        ok: false,
        status: 404,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ success: false, error: { code: "NOT_FOUND", message: "Not found" } }),
      };
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Raft elects a single leader per term.")).toBeInTheDocument();
    });

    expect(screen.getByText(/Development-Only Unproctored Mode/i)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/True/i));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/v1/student/exams/${examId}/attempts/${attemptId}/answers`,
        expect.objectContaining({ method: "PUT" }),
      );
    });

    expect(localSetSpy).not.toHaveBeenCalled();
    expect(sessionSetSpy).not.toHaveBeenCalled();
  });
});
