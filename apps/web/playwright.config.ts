import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5174",
    trace: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "node ../api/scripts/e2e-test-server.mjs",
      url: "http://127.0.0.1:4001/api/v1/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "VITE_API_PORT=4001 npx vite --port 5174 --strictPort",
      url: "http://localhost:5174",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
