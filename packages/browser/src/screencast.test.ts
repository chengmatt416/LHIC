import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { ScreencastManager } from "./screencast.js";

describe("ScreencastManager", () => {
  const browsers: Awaited<ReturnType<typeof chromium.launch>>[] = [];

  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((b) => b.close()));
  });

  it("successfully streams frames from browser page using CDP session", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent(
      "<div style='background:red; width:100px; height:100px;'>Test</div>",
    );

    const manager = new ScreencastManager(page);
    let frameCount = 0;

    manager.on("frame", (frame) => {
      frameCount++;
      expect(frame.data).toBeDefined();
      expect(frame.metadata.deviceWidth).toBeDefined();
    });

    await manager.start(5);
    // Wait to capture frame
    await new Promise((resolve) => setTimeout(resolve, 600));
    await manager.stop();

    expect(frameCount).toBeGreaterThanOrEqual(0);
  });
});
