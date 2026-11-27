import { expect, test } from "@playwright/test";

test.describe("Pariksha Phase 2 Live Browser Verification (pariksha_test)", () => {
  test("verifies health, admin auth & user management, session restore, RBAC redirects, logout, responsive layout, and zero browser storage", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    const unexpectedConsoleErrors: string[] = [];

    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (!text.includes("401 (Unauthorized)")) {
          unexpectedConsoleErrors.push(text);
        }
      }
    });

    // 1. Landing Overview & live health check
    await page.goto("/");
    await expect(page.getByText("Pariksha Platform Foundation")).toBeVisible();
    await expect(page.getByText("Operational")).toBeVisible();
    await expect(page.getByText("Connected")).toBeVisible();

    // 2. Login page & password visibility toggle
    await page.goto("/login");
    await expect(page.getByText("Sign in to Pariksha")).toBeVisible();
    const passwordInput = page.getByLabel("Password", { exact: true });
    await expect(passwordInput).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Show password" }).click();
    await expect(passwordInput).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "Hide password" }).click();

    // 3. Admin login & redirect to /admin
    await page.getByLabel("Institutional Email").fill("admin@pariksha.test");
    await passwordInput.fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByText("Administrator Console")).toBeVisible();

    // 4. Admin User Management: create, filter, deactivate, reactivate
    await page.getByRole("link", { name: "User Management" }).click();
    await expect(page).toHaveURL(/\/admin\/users$/);
    await expect(page.locator("table").getByText("admin@pariksha.test")).toBeVisible();

    const uniqueEmail = `e2e.student.${Date.now()}@pariksha.test`;
    await page.getByRole("button", { name: "Create Account" }).click();
    await page.getByLabel("Full Name").fill("Playwright Verify Student");
    await page.getByLabel("Email").fill(uniqueEmail);
    await page.getByRole("dialog").getByLabel("Role", { exact: true }).selectOption("STUDENT");
    await page.getByLabel("Initial Password").fill("VerifyPass!2026");
    await page.getByRole("dialog").getByRole("button", { name: "Create Account" }).click();

    await page.getByLabel("Search users").fill(uniqueEmail);
    const userRow = page.locator("tr", { hasText: uniqueEmail });
    await expect(userRow).toBeVisible();
    await expect(userRow.getByText("ACTIVE")).toBeVisible();

    await userRow.getByRole("button", { name: "Deactivate" }).click();
    await expect(userRow.getByText("INACTIVE")).toBeVisible();

    await userRow.getByRole("button", { name: "Activate" }).click();
    await expect(userRow.getByText("ACTIVE")).toBeVisible();

    // 5. Reload page restores authenticated Admin session via /auth/me
    await page.reload();
    await expect(page).toHaveURL(/\/admin\/users$/);
    await expect(page.getByRole("heading", { name: "User Management" })).toBeVisible();

    // 6. Logout
    await page.getByRole("button", { name: "Sign Out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    // 7. Teacher login & unauthorized /admin rejection
    await page.getByLabel("Institutional Email").fill("teacher@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/teacher$/);
    await expect(page.getByRole("heading", { name: "Teacher Workspace" })).toBeVisible();

    await page.goto("/admin");
    await expect(page).toHaveURL(/\/unauthorized$/);
    await expect(page.getByText("Unauthorized Access")).toBeVisible();
    await page.getByRole("button", { name: "Return to Dashboard" }).click();
    await expect(page).toHaveURL(/\/teacher$/);

    await page.getByRole("button", { name: "Sign Out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    // 8. Student login, unauthorized rejection & mobile responsive layout
    await page.getByLabel("Institutional Email").fill("student@pariksha.test");
    await page.getByLabel("Password", { exact: true }).fill("E2ETestPass!2026");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/student$/);
    await expect(page.getByRole("heading", { name: "Student Portal" })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("button", { name: "Open navigation menu" })).toBeVisible();
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    await expect(page.getByRole("button", { name: "Close navigation menu" })).toBeVisible();
    await page.getByRole("button", { name: "Close navigation menu" }).click();

    await page.goto("/admin");
    await expect(page).toHaveURL(/\/unauthorized$/);

    // 9. Verify zero localStorage / sessionStorage writes & zero unexpected console/page errors
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
