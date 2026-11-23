import { chromium } from "playwright";

const SITE = process.env.OMEGA_SITE_URL || "https://omega-chess-ai.higgsfield.app";
const MAX_SESSION_MS = 345 * 60 * 1000;
const POLL_MS = 60_000;
const MAX_RECOVERIES = 8;
const RECOVERY_WAIT_MS = 10_000;

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

    // A fresh browser session displays OMEGA's Play & Learn disclosure.
    // This workflow was explicitly configured for shared OMEGA training.
    const consent = page.locator(".omega-entry-accept");
    if (await consent.isVisible().catch(() => false)) {
      console.log("[OMEGA] Accepting the Play & Learn disclosure for this training session.");
      await consent.click();
      await page.locator(".omega-entry-backdrop").waitFor({ state: "hidden", timeout: 30_000 });
    }

    await page.getByText(/Connected to the single shared OMEGA cloud/).first().waitFor({ timeout: 120_000 });

    const start = arena.getByRole("button", { name: "Start / Resume" });
    const pause = arena.getByRole("button", { name: "Pause after game" });
    const progressEl = arena.locator(".omega-arena-progress");
    const statusEl = arena.locator(".omega-arena-status").first();
    const statsEl = arena.locator(".omega-arena-stats");
    const deadline = Date.now() + MAX_SESSION_MS;
    let recoveries = 0;
    let started = false;

    while (Date.now() < deadline - 60_000) {
      if (await pause.isVisible().catch(() => false)) {
        started = true;
        await page.waitForTimeout(POLL_MS);

        const stats = await statsEl.innerText().catch(() => "stats unavailable");
        const status = await statusEl.innerText().catch(() => "status unavailable");
        const progress = await progressEl.innerText().catch(() => "");
        console.log(`[OMEGA] ${new Date().toISOString()} | ${stats.replaceAll("\n", " | ")} | ${status}`);

        if (progress.includes("10,000/10,000") || status.includes("Training complete")) {
          console.log("[OMEGA] The shared training target has been reached.");
          return;
        }

        if (await pause.isVisible().catch(() => false)) continue;
        console.warn("[OMEGA] Arena stopped between polls; checking whether the shared lease was released.");
      }

      const progress = await progressEl.innerText().catch(() => "");
      const status = await statusEl.innerText().catch(() => "status unavailable");
      if (progress.includes("10,000/10,000") || status.includes("Training complete")) {
        console.log("[OMEGA] The shared training target has been reached.");
        return;
      }

      if (recoveries >= MAX_RECOVERIES) {
        throw new Error(`Training stopped after ${recoveries} bounded recovery attempts. Last status: ${status}`);
      }

      // Wait for the central lease to expire/release before attempting a resume.
      let ready = false;
      for (let wait = 0; wait < 12 && Date.now() < deadline - 60_000; wait += 1) {
        if (await start.isEnabled().catch(() => false)) {
          ready = true;
          break;
        }
        console.log("[OMEGA] Waiting for the shared training lease to release…");
        await page.waitForTimeout(RECOVERY_WAIT_MS);
      }
      if (!ready) {
        throw new Error(`Could not reacquire the shared training lease. Last status: ${status}`);
      }

      recoveries += 1;
      console.warn(`[OMEGA] Resume attempt ${recoveries}/${MAX_RECOVERIES}; central progress is retained.`);
      await start.click();
      try {
        await pause.waitFor({ state: "visible", timeout: 120_000 });
        started = true;
        console.log("[OMEGA] Training is running; completed games remain saved centrally.");
      } catch {
        const latestStatus = await statusEl.innerText().catch(() => "status unavailable");
        console.warn(`[OMEGA] Start did not remain active: ${latestStatus}`);
        await page.waitForTimeout(RECOVERY_WAIT_MS);
      }
    }

    // Release the lease cleanly before the hosted runner's hard timeout.
    if (await pause.isVisible().catch(() => false)) {
      console.log("[OMEGA] Session window ending; pausing safely after the current game.");
      await pause.click();
      await start.waitFor({ state: "visible", timeout: 120_000 });
    }
    console.log(`[OMEGA] Session finished. Training was ${started ? "started/resumed" : "not started"}; the next run resumes from the central match counter.`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("[OMEGA] Background training controller failed:", error);
  process.exitCode = 1;
});
