import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const SITE = process.env.OMEGA_SITE_URL || "https://omega-chess-ai.higgsfield.app";
const MAX_SESSION_MS = 330 * 60 * 1000;
const POLL_MS = 60_000;
// One OMEGA training search can retry once at a 10-minute timeout. Allow a
// little more than both attempts before declaring the browser session stalled.
const STALL_TIMEOUT_MS = 25 * 60 * 1000;
const RECOVERY_WAIT_MS = 10_000;
const LEASE_WAIT_MS = 150_000;
const RECOVERY_DIR = "omega-training-recovery";

async function acceptDisclosure(page) {
  const consent = page.locator(".omega-entry-accept");
  if (await consent.isVisible().catch(() => false)) {
    console.log("[OMEGA] Accepting the Play & Learn disclosure for this training session.");
    await consent.click();
    await page.locator(".omega-entry-backdrop").waitFor({ state: "hidden", timeout: 30_000 });
  }
}

async function waitForArena(page, navigate = false) {
  const response = navigate
    ? await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 120_000 })
    : await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
  if (!response || response.status() >= 400) {
    throw new Error(`OMEGA website returned HTTP ${response?.status() ?? "no response"}`);
  }
  const arena = page.locator(".omega-arena");
  await arena.waitFor({ state: "visible", timeout: 120_000 });
  await acceptDisclosure(page);
  await page.getByText(/Connected to the single shared OMEGA cloud/).first().waitFor({ timeout: 120_000 });
  return {
    arena,
    start: arena.getByRole("button", { name: "Start / Resume" }),
    pause: arena.getByRole("button", { name: "Pause after game" }),
    progress: arena.locator(".omega-arena-progress"),
    status: arena.locator(".omega-arena-status").first(),
    stats: arena.locator(".omega-arena-stats"),
  };
}

async function captureRecoveryScreenshot(page, recoveryNumber) {
  try {
    await mkdir(RECOVERY_DIR, { recursive: true });
    const path = `${RECOVERY_DIR}/recovery-${String(recoveryNumber).padStart(2, "0")}.png`;
    await page.screenshot({ path, fullPage: true, timeout: 30_000 });
    console.log("[OMEGA] Recovery screenshot saved:", path);
  } catch (error) {
    console.warn("[OMEGA] Could not save recovery screenshot:", error instanceof Error ? error.message : String(error));
  }
}

async function waitForLeaseAndResume(ui, page, deadline) {
  const waitUntil = Math.min(deadline - 60_000, Date.now() + LEASE_WAIT_MS);
  while (Date.now() < waitUntil) {
    const status = await ui.status.innerText().catch(() => "status unavailable");
    const progress = await ui.progress.innerText().catch(() => "");
    if (progress.includes("10,000/10,000") || status.includes("Training complete")) return true;
    if (await ui.pause.isVisible().catch(() => false)) return true;
    if (await ui.start.isEnabled().catch(() => false)) {
      console.warn("[OMEGA] Shared lease is available; starting from the centrally saved match count.");
      await ui.start.click();
      try {
        await ui.pause.waitFor({ state: "visible", timeout: 120_000 });
        return true;
      } catch (error) {
        console.warn("[OMEGA] Resume is still waiting for the UI/lease:", error instanceof Error ? error.message : String(error));
      }
    }
    await page.waitForTimeout(RECOVERY_WAIT_MS);
  }
  console.warn("[OMEGA] Shared lease is still unavailable after the recovery wait; the watchdog will keep monitoring and retry.");
  return false;
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => console.error("[OMEGA page error]", error.stack || error.message));
    page.on("crash", () => console.error("[OMEGA page crash] Chromium page crashed."));
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        console[message.type() === "error" ? "error" : "warn"]("[OMEGA browser]", message.text().slice(0, 1000));
      }
    });
    page.on("requestfailed", (request) => {
      console.warn("[OMEGA request failed]", request.method(), request.url().split("?")[0], request.failure()?.errorText || "unknown");
    });

    console.log("[OMEGA] Opening the deployed training arena:", SITE);
    let ui = await waitForArena(page, true);
    const deadline = Date.now() + MAX_SESSION_MS;
    let recoveries = 0;
    let lastSignal = "";
    let lastActivityAt = Date.now();
    let started = false;

    while (Date.now() < deadline - 60_000) {
      const status = await ui.status.innerText().catch(() => "status unavailable");
      const progress = await ui.progress.innerText().catch(() => "");
      const stats = await ui.stats.innerText().catch(() => "stats unavailable");
      const signal = `${progress}\n${status}`;
      if (signal !== lastSignal) {
        lastSignal = signal;
        lastActivityAt = Date.now();
      }

      console.log(`[OMEGA] ${new Date().toISOString()} | ${stats.replaceAll("\n", " | ")} | ${status}`);

      if (progress.includes("10,000/10,000") || status.includes("Training complete")) {
        console.log("[OMEGA] The shared training target has been reached.");
        return;
      }

      const pauseVisible = await ui.pause.isVisible().catch(() => false);
      const startVisible = await ui.start.isVisible().catch(() => false);
      const startEnabled = startVisible && await ui.start.isEnabled().catch(() => false);

      if (pauseVisible && Date.now() - lastActivityAt >= STALL_TIMEOUT_MS) {
        recoveries += 1;
        console.error(`[OMEGA] No training progress/status change for ${Math.round(STALL_TIMEOUT_MS / 60_000)} minutes. Recycling the browser worker; central saved matches will be resumed. Recovery ${recoveries}.`);
        await captureRecoveryScreenshot(page, recoveries);
        // Reloading terminates crashed/hung browser workers. The server lease
        // expires automatically if the page cannot release it cleanly.
        try {
          ui = await waitForArena(page, false);
          const resumed = await waitForLeaseAndResume(ui, page, deadline);
          if (resumed) started = true;
        } catch (error) {
          console.error("[OMEGA] Page reload did not restore the arena:", error instanceof Error ? error.stack || error.message : String(error));
          await page.waitForTimeout(RECOVERY_WAIT_MS);
          continue;
        }
        lastSignal = "";
        lastActivityAt = Date.now();
        continue;
      }

      if (pauseVisible) {
        started = true;
        await page.waitForTimeout(POLL_MS);
        continue;
      }

      if (startEnabled) {
        recoveries += 1;
        console.warn(`[OMEGA] Arena is stopped. Attempting resume ${recoveries}; shared progress is preserved.`);
        await ui.start.click();
        try {
          await ui.pause.waitFor({ state: "visible", timeout: 120_000 });
          started = true;
          lastSignal = "";
          lastActivityAt = Date.now();
          console.log("[OMEGA] Training resumed; completed games remain saved centrally.");
        } catch (error) {
          const latestStatus = await ui.status.innerText().catch(() => "status unavailable");
          console.warn("[OMEGA] Resume did not become active yet:", latestStatus, error instanceof Error ? error.message : String(error));
          await page.waitForTimeout(RECOVERY_WAIT_MS);
        }
        continue;
      }

      // The lease may still be expiring or the UI may still be loading the
      // central worker record. Do not fail the whole scheduled run for this.
      if (Date.now() - lastActivityAt >= STALL_TIMEOUT_MS) {
        recoveries += 1;
        console.warn(`[OMEGA] Arena controls have not recovered for ${Math.round(STALL_TIMEOUT_MS / 60_000)} minutes. Reloading to refresh cloud/lease state. Recovery ${recoveries}.`);
        await captureRecoveryScreenshot(page, recoveries);
        try {
          ui = await waitForArena(page, false);
          const resumed = await waitForLeaseAndResume(ui, page, deadline);
          if (resumed) started = true;
          lastSignal = "";
          lastActivityAt = Date.now();
        } catch (error) {
          console.error("[OMEGA] Recovery reload failed:", error instanceof Error ? error.stack || error.message : String(error));
        }
      }
      await page.waitForTimeout(RECOVERY_WAIT_MS);
    }

    // Keep a 20-minute margin before the GitHub job timeout. Request a safe
    // pause, but never mark the run failed if the final game needs longer:
    // closing the browser stops heartbeats and the 90-second lease expires.
    if (await ui.pause.isVisible().catch(() => false)) {
      console.log("[OMEGA] Session window ending; requesting pause after the current game.");
      await ui.pause.click().catch((error) => console.warn("[OMEGA] Pause request failed:", error instanceof Error ? error.message : String(error)));
      try {
        await ui.start.waitFor({ state: "visible", timeout: 15 * 60_000 });
        console.log("[OMEGA] Training paused cleanly at the end of this hosted session.");
      } catch {
        console.warn("[OMEGA] Safe pause did not finish within the cleanup window. The browser will close; the central lease will expire and the next scheduled run will resume from the last saved game.");
      }
    }
    console.log(`[OMEGA] Session finished. Training was ${started ? "started/resumed" : "not started"}; ${recoveries} recovery action(s) were attempted. The next scheduled run resumes from the central match counter.`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("[OMEGA] Background training controller failed:", error.stack || error);
  process.exitCode = 1;
});
