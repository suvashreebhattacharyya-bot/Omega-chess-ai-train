import { chromium } from "playwright";

const SITE = process.env.OMEGA_SITE_URL || "https://omega-chess-ai.higgsfield.app";
const MAX_SESSION_MS = 345 * 60 * 1000;
const POLL_MS = 60_000;

async function main() {
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => console.error("[OMEGA page error]", error.message));

  console.log("[OMEGA] Opening the deployed training arena:", SITE);
  const response = await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 120_000 });
  if (!response || response.status() >= 400) {
    throw new Error(`OMEGA website returned HTTP ${response?.status() ?? "no response"}`);
  }

  const arena = page.locator(".omega-arena");
  await arena.waitFor({ state: "visible", timeout: 120_000 });
  await page.getByText(/Connected to the single shared OMEGA cloud/).waitFor({ timeout: 120_000 });

  const start = arena.getByRole("button", { name: "Start / Resume" });
  const pause = arena.getByRole("button", { name: "Pause after game" });
  const deadline = Date.now() + MAX_SESSION_MS;

  // Do not fight another device or workflow for the central training lease.
  while (!(await start.isEnabled().catch(() => false))) {
    const progress = await arena.locator(".omega-arena-progress").innerText().catch(() => "");
    if (progress.includes("10,000/10,000")) {
      console.log("[OMEGA] The shared 10,000-match target is already complete.");
      return;
    }
    if (Date.now() > deadline - MAX_SESSION_MS + 120_000) {
      throw new Error("The central training lease is held by another worker, or the arena is not ready.");
    }
    console.log("[OMEGA] Waiting for the shared training lease to become available…");
    await page.waitForTimeout(10_000);
  }

  await start.click();
  await pause.waitFor({ state: "visible", timeout: 120_000 });
  console.log("[OMEGA] Background training started. Progress is saved centrally after every completed game.");

  while (Date.now() < deadline - 60_000) {
    await page.waitForTimeout(POLL_MS);
    const stats = await arena.locator(".omega-arena-stats").innerText();
    const status = await arena.locator(".omega-arena-status").first().innerText().catch(() => "");
    const progress = await arena.locator(".omega-arena-progress").innerText();
    console.log(`[OMEGA] ${new Date().toISOString()} | ${stats.replaceAll("\n", " | ")} | ${status}`);

    if (progress.includes("10,000/10,000") || status.includes("Training complete")) {
      console.log("[OMEGA] The shared training target has been reached.");
      return;
    }
    if (!(await pause.isVisible().catch(() => false))) {
      throw new Error(`The training process stopped unexpectedly: ${status}`);
    }
  }

  // Release the lease cleanly before the hosted runner's hard timeout.
  if (await pause.isVisible().catch(() => false)) {
    console.log("[OMEGA] Session window ending; pausing safely after the current game.");
    await pause.click();
    await start.waitFor({ state: "visible", timeout: 120_000 });
  }
  console.log("[OMEGA] Session finished. The next scheduled run resumes from the central match counter.");
} finally {
  await browser.close();
}

}

main().catch((error) => {
  console.error("[OMEGA] Background training controller failed:", error);
  process.exitCode = 1;
});
