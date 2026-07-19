import { chromium } from "playwright";
import type { Page } from "playwright";
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
    await page.evaluate(() => {
      document.body.style.background = "blue";
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await manager.stop();
    const stoppedFrameCount = frameCount;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(frameCount).toBe(stoppedFrameCount);

    await manager.start(5);
    await page.evaluate(() => {
      document.body.style.background = "green";
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await manager.stop();

    expect(frameCount).toBeGreaterThanOrEqual(stoppedFrameCount);
  });

  it("stops and detaches the exact CDP session used to start", async () => {
    const calls: string[] = [];
    const listeners = new Set<(...args: unknown[]) => void>();
    const client = {
      on: (_event: string, listener: (...args: unknown[]) => void) => {
        listeners.add(listener);
        return client;
      },
      off: (_event: string, listener: (...args: unknown[]) => void) => {
        listeners.delete(listener);
        return client;
      },
      send: async (method: string) => {
        calls.push(method);
      },
      detach: async () => {
        calls.push("detach");
      },
    };
    const fakePage = {
      context: () => ({
        newCDPSession: async () => client,
      }),
    } as unknown as Page;
    const manager = new ScreencastManager(fakePage);

    await manager.start(10);
    await manager.stop();

    expect(calls).toEqual([
      "Page.startScreencast",
      "Page.stopScreencast",
      "detach",
    ]);
    expect(listeners.size).toBe(0);
  });

  it("rejects invalid frame rates before opening a CDP session", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    const manager = new ScreencastManager(page);

    await expect(manager.start(0)).rejects.toThrow("FPS");
    await expect(manager.start(61)).rejects.toThrow("FPS");
  });
});
