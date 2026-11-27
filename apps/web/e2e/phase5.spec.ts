/**
 * Phase 5 Playwright Chromium E2E Suite (pariksha_test).
 *
 * NOTE ON TEST FIXTURES VS PHYSICAL MEDIA:
 * - Browser WebRTC/media permission prompts and screen capture tracks in headless Chromium are exercised
 *   using controlled HTMLCanvasElement / synthetic MediaStream & Fullscreen shims (`page.addInitScript`)
 *   so denial, grant, surface enforcement, track interruption (`ended`), recovery, and track cleanup run
 *   deterministically in CI/headless automation.
 * - Real physical macOS camera/screen-recording permission dialogs must still be manually verified
 *   against docs/PROCTORING_GUIDE.md.
 */
import { expect, test, type Page } from "@playwright/test";

async function installProctoringMediaMock(page: Page) {
  await page.addInitScript(() => {
    let denyNextCamera = false;
    let lastCameraTrack: MediaStreamTrack | null = null;
    let fullscreenEl: Element | null = null;

    const makeFakeStream = (isScreen: boolean): MediaStream => {
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 90;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = isScreen ? "#1e3a8a" : "#065f46";
        ctx.fillRect(0, 0, 160, 90);
      }

      const stream = canvas.captureStream(15);
      const track = stream.getVideoTracks()[0]!;
      const origGetSettings = track.getSettings.bind(track);
      track.getSettings = () => ({
        ...origGetSettings(),
        ...(isScreen ? { displaySurface: "monitor" } : { width: 160, height: 90 }),
      });

      if (!isScreen) {
        lastCameraTrack = track;
      }
      return stream;
    };

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          if (denyNextCamera) {
            throw new DOMException("Permission denied by test harness", "NotAllowedError");
          }
          return makeFakeStream(false);
        },
        getDisplayMedia: async () => makeFakeStream(true),
      },
    });

    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenEl,
    });

    Element.prototype.requestFullscreen = async function () {
      fullscreenEl = document.documentElement;
      document.dispatchEvent(new Event("fullscreenchange"));
    };

    document.exitFullscreen = async function () {
      fullscreenEl = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    };

    (window as unknown as Record<string, unknown>).__parikshaMediaCtl = {
      setDenyCamera(val: boolean) {
        denyNextCamera = val;
      },
      interruptCameraTrack() {
        if (!lastCameraTrack) return;
        lastCameraTrack.stop();
        lastCameraTrack.dispatchEvent(new Event("ended"));
      },
    };
  });
}

test.describe("Pariksha Phase 5 Proctoring, Lockdown & Two-Strike Engine (pariksha_test)", () => {
  test("executes preflight denial -> recovery -> launch -> two-strike auto-submit, media pause/resume, and Admin/Teacher telemetry", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    page.setDefaultTimeout(10_000);
    await installProctoringMediaMock(page);

    const uniqueSuffix = String(Date.now()).slice(-4);
    const courseCode = `PR${uniqueSuffix}`;
    const courseTitle = `Proctoring E2E ${uniqueSuffix}`;
    const twoStrikeExamTitle = `Proctored Two-Strike ${uniqueSuffix}`;
    const pauseResumeExamTitle = `Proctored Media Recovery ${uniqueSuffix}`;

    // 1. Admin creates course & enrolls student
    await page.goto("/login");
    await page.getByLabel("Institutional Email").fill("admin@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/admin$/);

    const nav = page.getByRole("navigation", { name: "Primary navigation" });
    await nav.getByRole("link", { name: "Courses & Enrollments" }).click();
    await page.getByRole("button", { name: "Create Course" }).click();
    await page.getByLabel("Course Code").fill(courseCode);
    await page.getByLabel("Course Title").fill(courseTitle);
    await page
      .getByLabel("Assigned Teacher")
      .selectOption({ label: "Dr. Rao Teacher (teacher@pariksha.test)" });
    await page.getByRole("dialog").getByRole("button", { name: "Create Course" }).click();

    await page.getByRole("link", { name: `${courseCode} — ${courseTitle}` }).click();
    await page.getByRole("button", { name: "Enroll Student" }).click();
    await page
      .getByLabel("Student", { exact: true })
      .selectOption({ label: "Rohan Student (student@pariksha.test)" });
    await page.getByRole("dialog").getByRole("button", { name: "Enroll Student" }).click();
    await page.getByRole("button", { name: "Sign Out" }).click();

    // 2. Teacher creates Two-Strike Exam + Media Pause/Resume Exam and submits both for approval
    await page.getByLabel("Institutional Email").fill("teacher@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();

    const createAndSubmitExam = async (title: string): Promise<string> => {
      await nav.getByRole("link", { name: "Examinations" }).click();
      await page.getByRole("button", { name: "New Exam Draft" }).click();
      await page
        .getByLabel("Assigned Course")
        .selectOption({ label: `${courseCode} — ${courseTitle}` });
      await page.getByLabel("Examination Title").fill(title);
      await page.getByLabel("Duration (min)").fill("45");
      await page.getByLabel("Passing Marks").fill("1");
      await page.getByRole("dialog").getByRole("button", { name: "Create Draft" }).click();
      await expect(page).toHaveURL(/\/teacher\/exams\/[0-9a-f-]+$/);
      const createdExamId = page.url().split("/").pop()!;

      await page.getByLabel("Question Type").selectOption("MULTIPLE_CHOICE");
      await page.getByLabel("Question Prompt").fill("Proctored MCQ: Which tier enforces strikes?");
      await page.getByPlaceholder("Option A").fill("PostgreSQL Transaction");
      await page.getByPlaceholder("Option B").fill("Client Storage");
      await page.getByPlaceholder("Option C").fill("Session Cookie");
      await page.getByPlaceholder("Option D").fill("URL Query");
      await page.getByLabel("Mark option A correct").check();
      await page.getByRole("button", { name: "Add Question" }).click();
      await expect(page.getByRole("heading", { name: /Questions \(1\)/ })).toBeVisible();

      await page.getByLabel("Question Type").selectOption("SUBJECTIVE_SHORT");
      await page.getByLabel("Question Prompt").fill("Summarize local privacy posture.");
      await page.getByRole("button", { name: "Add Question" }).click();
      await expect(page.getByRole("heading", { name: /Questions \(2\)/ })).toBeVisible();

      await page.getByRole("button", { name: "Submit for Approval" }).click();
      await expect(page.getByText("PENDING_APPROVAL", { exact: true }).first()).toBeVisible();
      return createdExamId;
    };

    const twoStrikeExamId = await createAndSubmitExam(twoStrikeExamTitle);
    const pauseResumeExamId = await createAndSubmitExam(pauseResumeExamTitle);
    await page.getByRole("button", { name: "Sign Out" }).click();

    // 3. Admin approves both exams WITH proctoring required (allowUnproctoredDev unchecked) and checks Proctoring Control Center
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Institutional Email").fill("admin@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/admin$/);

    const approveOpenExam = async (examId: string) => {
      await page.goto(`/admin/exams/${examId}`);
      const openStart = new Date(Date.now() - 5 * 60_000);
      const pad = (n: number) => String(n).padStart(2, "0");
      const val = `${openStart.getFullYear()}-${pad(openStart.getMonth() + 1)}-${pad(openStart.getDate())}T${pad(openStart.getHours())}:${pad(openStart.getMinutes())}`;
      await page.getByLabel("Window Start").fill(val);
      await page.getByRole("button", { name: "Approve Examination" }).click();
      await expect(page.getByText("ACTIVE", { exact: true }).first()).toBeVisible();
    };

    await approveOpenExam(twoStrikeExamId);
    await approveOpenExam(pauseResumeExamId);

    // Admin verifies Proctoring Control page renders institutional policy (2 strikes default)
    await nav.getByRole("link", { name: "Proctoring Control" }).click();
    await expect(page.getByRole("heading", { name: /Proctoring & Integrity Control Center/i })).toBeVisible();
    await expect(page.getByLabel("Strike Threshold")).toHaveValue("2");
    await page.getByRole("button", { name: "Sign Out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    // 4. Student enters Preflight -> test Camera Denial -> Retry Grant -> Screen Share -> Fullscreen -> Consent -> Launch
    await page.getByLabel("Institutional Email").fill("student@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/student$/);
    await page.goto(`/student/exams/${twoStrikeExamId}/preflight`);

    await expect(page.getByRole("heading", { name: /Pre-Examination System/i })).toBeVisible();

    // Force permission denial first
    await page.evaluate(() => {
      (window as unknown as { __parikshaMediaCtl: { setDenyCamera: (v: boolean) => void } }).__parikshaMediaCtl.setDenyCamera(true);
    });
    await page.getByRole("button", { name: "Enable Camera" }).click();
    await expect(page.getByRole("alert")).toContainText("Camera permission was denied");
    await expect(page.getByRole("button", { name: "Launch Proctored Examination" })).toBeDisabled();

    // Grant camera, screen share, fullscreen, and accept consent
    await page.evaluate(() => {
      (window as unknown as { __parikshaMediaCtl: { setDenyCamera: (v: boolean) => void } }).__parikshaMediaCtl.setDenyCamera(false);
    });
    await page.getByRole("button", { name: "Enable Camera" }).click();
    await expect(page.getByLabel("Local camera preview")).toBeVisible();
    await page.getByRole("button", { name: "Share Screen" }).click();
    await page.getByRole("button", { name: "Enter Fullscreen" }).click();
    await page.getByRole("checkbox").check();

    const launchBtn = page.getByRole("button", { name: "Launch Proctored Examination" });
    await expect(launchBtn).toBeEnabled();
    await launchBtn.click();

    await expect(page).toHaveURL(new RegExp(`/student/exams/${twoStrikeExamId}/attempt/[0-9a-f-]+$`));

    // Answer MCQ + test normal typing inside subjective response field
    await page.getByLabel(/PostgreSQL Transaction/).click();
    await page.getByRole("button", { name: "Next" }).click();
    const subjectiveBox = page.getByLabel("Answer for question 2");
    await subjectiveBox.fill("Video remains strictly local in browser memory.");
    await expect(subjectiveBox).toHaveValue("Video remains strictly local in browser memory.");

    // Strike 1: Right-click triggers Warning Dialog (Strike 1 of 2)
    await page.locator("h1").click({ button: "right" });
    await expect(page.getByText(/Proctoring Integrity Warning \(Strike 1 of 2\)/i)).toBeVisible();
    await page.getByRole("button", { name: /Acknowledge & Continue Examination/i }).click();
    await expect(page.getByText("Strikes: 1 / 2")).toBeVisible();

    // Strike 2: Restricted Copy shortcut triggers automatic submission & immutable receipt!
    await page.keyboard.press("Control+c");
    await expect(page.getByText("Examination Finalized")).toBeVisible();
    await expect(page.getByText("VIOLATION_THRESHOLD")).toBeVisible();

    // Verify ZERO browser storage writes across entire exam session
    const storageCounts = await page.evaluate(() => ({
      localCount: window.localStorage.length,
      sessionCount: window.sessionStorage.length,
    }));
    expect(storageCounts.localCount).toBe(0);
    expect(storageCounts.sessionCount).toBe(0);

    // 5. Media Interruption -> PAUSED -> Recovery Overlay -> Resume workflow
    await page.goto(`/student/exams/${pauseResumeExamId}/preflight`);
    await page.getByRole("button", { name: "Enable Camera" }).click();
    await page.getByRole("button", { name: "Share Screen" }).click();
    await page.getByRole("button", { name: "Enter Fullscreen" }).click();
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Launch Proctored Examination" }).click();
    await expect(page).toHaveURL(new RegExp(`/student/exams/${pauseResumeExamId}/attempt/[0-9a-f-]+$`));

    // Simulate active webcam track interruption -> triggers PAUSED overlay (Strike 1)
    await page.evaluate(() => {
      (window as unknown as { __parikshaMediaCtl: { interruptCameraTrack: () => void } }).__parikshaMediaCtl.interruptCameraTrack();
    });
    await expect(page.getByText(/Examination Attempt Paused/i)).toBeVisible();

    // Recover camera and click Resume Examination
    await page.getByRole("dialog").getByRole("button", { name: "Enable Camera" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Resume Examination" }).click();
    await expect(page.getByText(/Examination Attempt Paused/i)).not.toBeVisible();
    await expect(page.getByText("Strikes: 1 / 2")).toBeVisible();

    // Exit distraction-free workspace so sidebar Sign Out is visible
    await page.goto("/student/exams");
    await page.getByRole("button", { name: "Sign Out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    // 6. Admin verifies live attempts monitor + integrity event timeline
    await page.getByLabel("Institutional Email").fill("admin@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto("/admin/proctoring?tab=attempts");
    await expect(page.locator("table").getByText("AUTO_SUBMITTED").first()).toBeVisible();
    await page.goto("/admin/proctoring?tab=events");
    await expect(page.locator("table").getByText("COPY_ATTEMPT").first()).toBeVisible();
    await page.getByRole("button", { name: "Sign Out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    // 7. Teacher reviews course-scoped read-only integrity events
    await page.getByLabel("Institutional Email").fill("teacher@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/teacher$/);
    await page.goto(`/teacher/exams/${twoStrikeExamId}`);
    await page.getByRole("button", { name: /Integrity Events/i }).click();
    await expect(page.getByText("Course Examination Integrity Events (Read-Only)")).toBeVisible();
    await expect(page.getByText("RIGHT_CLICK_ATTEMPT").first()).toBeVisible();
  });
});
