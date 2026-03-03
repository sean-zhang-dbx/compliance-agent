/**
 * One-off script to capture a screenshot of the GSK Compliance Agent v2 app.
 * Run: npx playwright test e2e/capture-screenshot.ts --project=chromium
 * Or: npx ts-node --esm (if ts-node available)
 */
import { chromium } from "playwright";
import * as path from "path";

const APP_URL =
  "https://gsk-compliance-agent-v2-7405607844735163.3.azure.databricksapps.com/";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto(APP_URL, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(2000); // Let any dynamic content render

    const screenshotPath = path.join(
      process.cwd(),
      "test-results",
      "gsk-v2-screenshot.png"
    );
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log("Screenshot saved to:", screenshotPath);

    // Log what we see
    const title = await page.title();
    const onLogin = await page.locator('h2:has-text("Log in")').isVisible();
    const onApp = await page.locator("#root").isVisible();
    const hasProjects = await page.locator('text=Projects').isVisible();
    const hasProjectCards = (await page.locator('[style*="projectCard"]').count()) > 0;

    console.log("Page title:", title);
    console.log("On login page:", onLogin);
    console.log("App root visible:", onApp);
    console.log("Projects section visible:", hasProjects);
    console.log("Project cards visible:", hasProjectCards);
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await browser.close();
  }
}

main();
