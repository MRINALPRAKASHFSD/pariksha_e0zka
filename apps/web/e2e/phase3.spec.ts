import { expect, test } from "@playwright/test";

test.describe("Pariksha Phase 3 Full Academic Workflow (pariksha_test)", () => {
  test("executes complete Admin -> Teacher -> Student -> Teacher -> Student coursework & grading lifecycle", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    const unexpectedConsoleErrors: string[] = [];

    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (!text.includes("401 (Unauthorized)") && !text.includes("403 (Forbidden)")) {
          unexpectedConsoleErrors.push(text);
        }
      }
    });

    const uniqueCode = `CS${String(Date.now()).slice(-4)}`;
    const assignmentTitle = `Consensus Protocol Lab ${uniqueCode}`;
    const pdfPayload = Buffer.from("%PDF-1.4\n% Pariksha E2E Handout\n1 0 obj <<>> endobj\n%%EOF\n");
    const studentPdfPayload = Buffer.from("%PDF-1.4\n% Pariksha Student Solution\n1 0 obj <<>> endobj\n%%EOF\n");

    // 1. Admin logs in
    await page.goto("/login");
    await page.getByLabel("Institutional Email").fill("admin@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/admin$/);

    const nav = page.getByRole("navigation", { name: "Primary navigation" });

    // 2 & 3. Admin creates a course and assigns teacher
    await nav.getByRole("link", { name: "Courses & Enrollments" }).click();
    await expect(page).toHaveURL(/\/admin\/courses$/);
    await page.getByRole("button", { name: "Create Course" }).click();
    await page.getByLabel("Course Code").fill(uniqueCode);
    await page.getByLabel("Course Title").fill("Distributed Systems E2E");
    await page.getByLabel("Assigned Teacher").selectOption({ label: "Dr. Rao Teacher (teacher@pariksha.test)" });
    await page.getByRole("dialog").getByRole("button", { name: "Create Course" }).click();

    await expect(page.getByRole("link", { name: `${uniqueCode} — Distributed Systems E2E` })).toBeVisible();

    // 4. Admin opens course & enrolls student
    await page.getByRole("link", { name: `${uniqueCode} — Distributed Systems E2E` }).click();
    await expect(page).toHaveURL(/\/admin\/courses\/.+/);
    await page.getByRole("button", { name: "Enroll Student" }).click();
    await page.getByLabel("Student", { exact: true }).selectOption({ label: "Rohan Student (student@pariksha.test)" });
    await page.getByRole("dialog").getByRole("button", { name: "Enroll Student" }).click();
    await expect(page.locator("table").getByText("student@pariksha.test")).toBeVisible();

    // 5. Admin logs out
    await page.getByRole("button", { name: "Sign Out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    // 6 & 7. Teacher logs in and accesses assigned course
    await page.getByLabel("Institutional Email").fill("teacher@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/teacher$/);

    await nav.getByRole("link", { name: "My Courses" }).click();
    await expect(page.getByText(uniqueCode)).toBeVisible();
    await page.getByRole("link", { name: "Open Course Workspace" }).first().click();
    await expect(page.getByRole("heading", { name: `${uniqueCode} — Distributed Systems E2E` })).toBeVisible();

    // 8 & 9 & 10. Teacher creates assignment, uploads PDF attachment, and publishes it
    await nav.getByRole("link", { name: "Assignments" }).click();
    await expect(page).toHaveURL(/\/teacher\/assignments$/);
    await page.getByRole("button", { name: "Create Assignment" }).click();
    await page.getByLabel("Course", { exact: true }).selectOption({ label: `${uniqueCode} — Distributed Systems E2E` });
    await page.getByLabel("Title", { exact: true }).fill(assignmentTitle);
    await page.getByLabel("Maximum Marks").fill("100");
    await page.getByLabel("Instructions").fill("Submit a concise technical PDF.");
    await page.locator("#teacher-assignment-files").setInputFiles({
      name: "e2e-handout.pdf",
      mimeType: "application/pdf",
      buffer: pdfPayload,
    });
    await page.getByRole("dialog").getByRole("button", { name: "Save Draft" }).click();

    const assignRow = page.locator("tr", { hasText: assignmentTitle });
    await expect(assignRow).toBeVisible();
    await expect(assignRow.getByText("DRAFT")).toBeVisible();
    await assignRow.getByRole("button", { name: "Publish" }).click();
    await expect(assignRow.getByText("PUBLISHED")).toBeVisible();

    // 11. Teacher logs out
    await page.getByRole("button", { name: "Sign Out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    // 12 & 13. Student logs in and views enrolled course
    await page.getByLabel("Institutional Email").fill("student@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/student$/);

    await nav.getByRole("link", { name: "My Courses" }).click();
    await expect(page.getByText(uniqueCode, { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "View Course" }).first().click();
    await expect(page.getByRole("link", { name: assignmentTitle })).toBeVisible();

    // 14 & 15. Student opens assignment, downloads handout, and submits solution PDF
    await page.getByRole("link", { name: assignmentTitle }).click();
    await expect(page.getByText("e2e-handout.pdf")).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Download" }).first().click(),
    ]);
    expect(download.suggestedFilename()).toBe("e2e-handout.pdf");

    await page.locator("#student-submission-files").setInputFiles({
      name: "student-solution.pdf",
      mimeType: "application/pdf",
      buffer: studentPdfPayload,
    });
    await page.getByLabel("Submission Notes (optional)").fill("Completed all sections.");
    await page.getByRole("button", { name: "Submit Assignment" }).click();

    await expect(page.getByRole("heading", { name: "Your Submission" })).toBeVisible();
    await expect(page.getByText(/student-solution\.pdf/)).toBeVisible();

    // 16. Student logs out
    await page.getByRole("button", { name: "Sign Out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    // Verify unenrolled outsider student cannot view this course
    await page.getByLabel("Institutional Email").fill("outsider@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/student$/);
    await nav.getByRole("link", { name: "My Courses" }).click();
    await expect(page.getByText("You are not actively enrolled in any courses yet.")).toBeVisible();
    await page.getByRole("button", { name: "Sign Out" }).click();

    // 17 & 18. Teacher logs in, reviews submission, allocates marks and publishes feedback
    await page.getByLabel("Institutional Email").fill("teacher@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/teacher$/);

    await nav.getByRole("link", { name: "Assignments" }).click();
    await expect(page).toHaveURL(/\/teacher\/assignments$/);
    await page.getByRole("link", { name: assignmentTitle, exact: true }).click();
    await expect(page.getByText("Rohan Student")).toBeVisible();
    await page.getByRole("button", { name: "Grade" }).click();
    await page.getByLabel(/Score/).fill("94");
    await page.getByLabel("Written Feedback").fill("Clear consensus proof and diagrams.");
    await page.getByRole("dialog").getByRole("button", { name: "Save Grade" }).click();

    await expect(page.getByText("94 / 100")).toBeVisible();
    await expect(page.getByText("Published", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Sign Out" }).click();

    // 19. Student logs in and verifies published marks and feedback
    await page.getByLabel("Institutional Email").fill("student@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/student$/);

    await page.getByRole("link", { name: "View Assignments" }).click();
    await expect(page).toHaveURL(/\/student\/assignments$/);
    await page.getByRole("link", { name: assignmentTitle, exact: true }).click();
    await expect(page.getByText("Awarded Marks: 94 / 100")).toBeVisible();
    await expect(page.getByText("Feedback: Clear consensus proof and diagrams.")).toBeVisible();

    // Responsive check + zero storage / console errors
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("button", { name: "Open navigation menu" })).toBeVisible();

    const storageCounts = await page.evaluate(() => ({
      localCount: window.localStorage.length,
      sessionCount: window.sessionStorage.length,
    }));
    expect(storageCounts.localCount).toBe(0);
    expect(storageCounts.sessionCount).toBe(0);
    expect(pageErrors).toEqual([]);
    expect(unexpectedConsoleErrors).toEqual([]);
  });
});
