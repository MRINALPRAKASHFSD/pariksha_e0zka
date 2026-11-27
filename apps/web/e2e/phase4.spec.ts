import { expect, test } from "@playwright/test";

test.describe("Pariksha Phase 4 Complete Online Examination Engine (pariksha_test)", () => {
  test("executes full 27-step Admin -> Teacher -> Admin -> Student -> Expiration lifecycle", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const pageErrors: string[] = [];
    const unexpectedConsoleErrors: string[] = [];

    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (
          !text.includes("401 (Unauthorized)") &&
          !text.includes("403 (Forbidden)") &&
          !text.includes("409 (Conflict)")
        ) {
          unexpectedConsoleErrors.push(text);
        }
      }
    });

    const uniqueSuffix = String(Date.now()).slice(-4);
    const courseCode = `EX${uniqueSuffix}`;
    const courseTitle = `Algorithms E2E ${uniqueSuffix}`;
    const examTitle = `Algorithms Final ${uniqueSuffix}`;
    const timedExamTitle = `Sprint Expiry Check ${uniqueSuffix}`;

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
    await expect(page.locator("table").getByText("student@pariksha.test")).toBeVisible();

    await page.getByRole("button", { name: "Sign Out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    // 2. Teacher logs in, creates Draft Exam & adds all question types + CSV import
    await page.getByLabel("Institutional Email").fill("teacher@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/teacher$/);

    await nav.getByRole("link", { name: "Examinations" }).click();
    await expect(page).toHaveURL(/\/teacher\/exams$/);

    await page.getByRole("button", { name: "New Exam Draft" }).click();
    await page
      .getByLabel("Assigned Course")
      .selectOption({ label: `${courseCode} — ${courseTitle}` });
    await page.getByLabel("Examination Title").fill(examTitle);
    await page.getByLabel("Duration (min)").fill("30");
    await page.getByLabel("Passing Marks").fill("2");
    await page.getByLabel("Candidate Instructions").fill("Initial instruction draft.");
    await page.getByRole("dialog").getByRole("button", { name: "Create Draft" }).click();
    await expect(page).toHaveURL(/\/teacher\/exams\/.+/);

    // Add MULTIPLE_CHOICE question
    await page.getByLabel("Question Type").selectOption("MULTIPLE_CHOICE");
    await page.getByLabel("Question Prompt").fill("What is the worst-case time complexity of quicksort?");
    await page.getByLabel("Marks", { exact: true }).fill("2");
    await page.getByPlaceholder("Option A").fill("O(n^2)");
    await page.getByPlaceholder("Option B").fill("O(n)");
    await page.getByPlaceholder("Option C").fill("O(log n)");
    await page.getByPlaceholder("Option D").fill("O(1)");
    await page.getByLabel("Mark option A correct").check();
    await page.getByRole("button", { name: "Add Question" }).click();
    await expect(page.getByRole("heading", { name: /Questions \(1\)/ })).toBeVisible();
    await expect(page.getByText("What is the worst-case time complexity of quicksort?")).toBeVisible();

    // Add SUBJECTIVE_SHORT question via builder
    await page.getByLabel("Question Type").selectOption("SUBJECTIVE_SHORT");
    await page.getByLabel("Question Prompt").fill("Explain why hash tables use prime or power-of-two sizing.");
    await page.getByLabel("Marks", { exact: true }).fill("3");
    await page.getByRole("button", { name: "Add Question" }).click();
    await expect(page.getByRole("heading", { name: /Questions \(2\)/ })).toBeVisible();
    await expect(page.getByText("Explain why hash tables use prime or power-of-two sizing.")).toBeVisible();

    // Import validated CSV batch (adds MSQ, TF, Long Subjective etc.)
    await page.getByRole("button", { name: "CSV / JSON Import" }).click();
    const csvBatch = [
      "type,prompt,marks,negativeMarks,isRequired,optionA,optionB,optionC,optionD,correctOptions,explanation",
      'MULTIPLE_SELECT,"Select stable sorting algorithms.",3,0,true,"Merge Sort","Insertion Sort","Quick Sort","Heap Sort","A,B","Merge and insertion sort preserve relative equal-key order."',
      'TRUE_FALSE,"Binary heaps guarantee O(1) extract-min.",1,0,false,"True","False","","","B","Extract-min requires O(log n) sift-down."',
      'SUBJECTIVE_LONG,"Compare B-Trees and LSM-Trees for write-heavy storage.",5,0,false,"","","","","","Discuss write amplification vs read amplification."',
    ].join("\n");
    await page.getByLabel("CSV / JSON Content").fill(csvBatch);
    await page.getByRole("button", { name: "Preview & Validate" }).click();
    await expect(page.getByText("Valid: 3")).toBeVisible();
    await page.getByRole("button", { name: /Commit Import/ }).click();
    await expect(page.getByText("Total Marks: 14", { exact: true })).toBeVisible();

    // Preview & submit for Admin approval
    await page.getByRole("button", { name: "Student Preview" }).click();
    await expect(page.getByText("Teacher Examination Preview")).toBeVisible();
    await page.getByRole("button", { name: "Submit for Approval" }).click();
    await expect(page.getByText("PENDING_APPROVAL", { exact: true }).first()).toBeVisible();

    const examUrl = page.url();
    const mainExamId = examUrl.split("/").pop()!;

    await page.getByRole("button", { name: "Sign Out" }).click();

    // 3. Admin inspects, tests Reject -> Teacher updates -> Admin approves with proctoring gate first
    await page.getByLabel("Institutional Email").fill("admin@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();

    await nav.getByRole("link", { name: "Examinations" }).click();
    await page
      .locator(".rounded-lg", { hasText: examTitle })
      .getByRole("link", { name: "Inspect & Control" })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: examTitle })).toBeVisible();

    await page.getByRole("button", { name: "Reject with Reason" }).click();
    await page.getByLabel("Rejection Reason").fill("Specify calculator rules in instructions.");
    await page.getByRole("dialog").getByRole("button", { name: "Confirm Reject" }).click();
    await expect(page.getByText("REJECTED", { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: "Sign Out" }).click();

    // Teacher updates instructions & resubmits
    await page.getByLabel("Institutional Email").fill("teacher@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/teacher$/);
    await page.goto(`/teacher/exams/${mainExamId}`);
    await page.getByRole("button", { name: "Exam Settings" }).click();
    await page.getByLabel("Candidate Instructions").fill("Calculators are not permitted. Read all questions.");
    await page.getByRole("button", { name: "Save Settings" }).click();
    await page.getByRole("button", { name: "Submit for Approval" }).click();
    await expect(page.getByText("PENDING_APPROVAL", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Sign Out" }).click();

    // Admin approves & activates WITHOUT unproctored dev first (checks Phase 5 gate!)
    await page.getByLabel("Institutional Email").fill("admin@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto(`/admin/exams/${mainExamId}`);
    // Ensure windowStart is already open (-5 min) so student can enter once unproctored is enabled
    const openWindowStart = new Date(Date.now() - 5 * 60_000);
    const localPad = (n: number) => String(n).padStart(2, "0");
    const openWindowVal = `${openWindowStart.getFullYear()}-${localPad(openWindowStart.getMonth() + 1)}-${localPad(openWindowStart.getDate())}T${localPad(openWindowStart.getHours())}:${localPad(openWindowStart.getMinutes())}`;
    await page.getByLabel("Window Start").fill(openWindowVal);
    await page.getByRole("button", { name: "Approve Examination" }).click();
    await expect(page.getByText("ACTIVE", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Sign Out" }).click();

    // Student verifies PREFLIGHT_REQUIRED gate blocks direct unproctored start before Admin enables unproctored dev
    await page.getByLabel("Institutional Email").fill("student@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await nav.getByRole("link", { name: "Examinations" }).click();
    await expect(page.getByText("PREFLIGHT REQUIRED")).toBeVisible();
    await page.getByRole("button", { name: "Verify & Start" }).click();
    await expect(page).toHaveURL(new RegExp(`/student/exams/${mainExamId}/preflight$`));
    await expect(page.getByRole("button", { name: /Launch Proctored Examination/i })).toBeDisabled();
    await page.getByRole("button", { name: "Sign Out" }).click();

    // Outsider non-enrolled student cannot see exam
    await page.getByLabel("Institutional Email").fill("outsider@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await nav.getByRole("link", { name: "Examinations" }).click();
    await expect(page.getByText("No examinations found")).toBeVisible();
    await page.getByRole("button", { name: "Sign Out" }).click();

    // Admin toggles Enable Development-Only Unproctored Delivery ON
    await page.getByLabel("Institutional Email").fill("admin@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto(`/admin/exams/${mainExamId}`);
    await page.getByLabel(/Enable Development-Only Unproctored Delivery/).check();
    await page.getByRole("button", { name: "Save Configuration" }).click();
    await expect(page.getByText("Development Unproctored")).toBeVisible();
    await page.getByRole("button", { name: "Sign Out" }).click();

    // Student starts exam, answers all 5 question types, marks for review, reloads page & verifies zero storage + full DB recovery
    await page.getByLabel("Institutional Email").fill("student@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await nav.getByRole("link", { name: "Examinations" }).click();
    await page.getByRole("button", { name: "Start Examination" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Begin Attempt Now" }).click();

    await expect(page).toHaveURL(new RegExp(`/student/exams/${mainExamId}/attempt/.+`));
    await expect(page.getByText(/Development-Only Unproctored Mode/)).toBeVisible();

    // Q1 (MCQ)
    await page.getByLabel(/O\(n\^2\)/).check();
    await page.getByRole("button", { name: "Mark for Review" }).click();
    await expect(page.getByText(/Saved /)).toBeVisible();

    // Q2 (Short Subjective)
    await page.getByRole("button", { name: "Jump to question 2" }).click();
    await page
      .getByLabel("Answer for question 2")
      .fill("Minimizes modular clustering collisions.");
    await page.waitForTimeout(600);
    await expect(page.getByText(/Saved /)).toBeVisible();

    // Q3 (MSQ)
    await page.getByRole("button", { name: "Jump to question 3" }).click();
    await page.getByLabel(/Merge Sort/).check();
    await page.getByLabel(/Insertion Sort/).check();

    // Q4 (True/False)
    await page.getByRole("button", { name: "Jump to question 4" }).click();
    await page.getByLabel(/False/).check();

    // Q5 (Long Subjective)
    await page.getByRole("button", { name: "Jump to question 5" }).click();
    await page
      .getByLabel("Answer for question 5")
      .fill("LSM trees batch random writes into sequential SSTables.");
    await page.waitForTimeout(650);

    // Reload browser page and verify recovery strictly from server + zero browser storage
    await page.reload();
    await expect(page.getByText("5 answered")).toBeVisible();
    const storageStats = await page.evaluate(() => ({
      localLen: window.localStorage.length,
      sessionLen: window.sessionStorage.length,
    }));
    expect(storageStats.localLen).toBe(0);
    expect(storageStats.sessionLen).toBe(0);

    await page.getByRole("button", { name: "Jump to question 2" }).click();
    await expect(page.getByLabel("Answer for question 2")).toHaveValue(
      "Minimizes modular clustering collisions.",
    );

    // Submit exam & verify immutable receipt
    await page.getByRole("button", { name: "Submit Exam" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Confirm Final Submit" }).click();
    await expect(page.getByText("Examination Finalized")).toBeVisible();
    const receiptText = await page.locator("p.font-mono").first().innerText();
    expect(receiptText).toMatch(/^PRK-/);
    await page.getByRole("link", { name: "Return to Examinations" }).click();
    await expect(page.getByText("COMPLETED", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Sign Out" }).click();

    // Scenario B (Step 27): Real countdown timer expiration locks attempt via background worker
    // Teacher creates 2nd short exam and submits; Admin sets tight windowEnd (+9s) and unproctored dev
    await page.getByLabel("Institutional Email").fill("teacher@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await nav.getByRole("link", { name: "Examinations" }).click();
    await page.getByRole("button", { name: "New Exam Draft" }).click();
    await page
      .getByLabel("Assigned Course")
      .selectOption({ label: `${courseCode} — ${courseTitle}` });
    await page.getByLabel("Examination Title").fill(timedExamTitle);
    await page.getByLabel("Duration (min)").fill("1");
    await page.getByRole("dialog").getByRole("button", { name: "Create Draft" }).click();
    await page.getByLabel("Question Type").selectOption("TRUE_FALSE");
    await page.getByLabel("Question Prompt").fill("Server enforces expiry deadlines.");
    await page.getByRole("button", { name: "Add Question" }).click();
    await expect(page.getByRole("heading", { name: /Questions \(1\)/ })).toBeVisible();
    await page.getByRole("button", { name: "Submit for Approval" }).click();
    await expect(page.getByText("PENDING_APPROVAL", { exact: true }).first()).toBeVisible();
    const timedExamId = page.url().split("/").pop()!;
    await page.getByRole("button", { name: "Sign Out" }).click();

    await page.getByLabel("Institutional Email").fill("admin@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.evaluate(async (id) => {
      const csrfRes = await fetch("/api/v1/auth/csrf", { credentials: "include" });
      const csrf = (await csrfRes.json()).data.csrfToken;
      const now = Date.now();
      await fetch(`/api/v1/admin/exams/${id}/approve`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({
          windowStart: new Date(now - 60_000).toISOString(),
          windowEnd: new Date(now + 9_000).toISOString(),
          durationMinutes: 1,
          allowUnproctoredDev: true,
          activateImmediately: true,
        }),
      });
    }, timedExamId);
    await page.getByRole("button", { name: "Sign Out" }).click();

    await page.getByLabel("Institutional Email").fill("student@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await nav.getByRole("link", { name: "Examinations" }).click();
    const timedCard = page.locator("div.rounded-lg", { hasText: timedExamTitle }).first();
    await timedCard.getByRole("button", { name: "Start Examination" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Begin Attempt Now" }).click();
    await expect(page.getByText("Server enforces expiry deadlines.")).toBeVisible();

    // Wait up to 15s for real server timer expiration & receipt transition
    await expect(page.getByText("Examination Finalized")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("EXPIRED", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("TIMER_EXPIRED", { exact: true }).first()).toBeVisible();

    expect(pageErrors).toEqual([]);
    expect(unexpectedConsoleErrors).toEqual([]);
  });
});
