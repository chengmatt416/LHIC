import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";

import type { ConsoleNetworkObserver } from "@lhic/browser";

import { VerifierEngine } from "./verifier-engine.js";

describe("VerifierEngine", () => {
  const browsers: Awaited<ReturnType<typeof chromium.launch>>[] = [];

  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  });

  it("returns evidence for DOM and URL checks and errors for unavailable checks", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent(
      '<button id="save">Saved</button><input id="disabled" disabled>',
    );
    const engine = new VerifierEngine({ page });

    await expect(
      engine.verify({
        type: "dom",
        description: "save button",
        params: { selector: "#save", state: "visible" },
      }),
    ).resolves.toMatchObject({
      success: true,
      evidence: [expect.stringContaining("visible")],
    });
    await expect(
      engine.verify({
        type: "dom",
        description: "disabled input",
        params: { selector: "#disabled", state: "disabled" },
      }),
    ).resolves.toMatchObject({ success: true });
    await expect(
      engine.verify({
        type: "url",
        description: "blank url",
        params: { contains: "about:blank" },
      }),
    ).resolves.toMatchObject({ success: true });
    await expect(
      engine.verify({
        type: "custom",
        description: "not implemented",
        params: {},
      }),
    ).resolves.toMatchObject({ success: false });
  });

  it("verifies files and network observations", async () => {
    const filePath = join(tmpdir(), `lhic-verifier-${Date.now()}.txt`);
    await writeFile(filePath, "verified");
    const engine = new VerifierEngine({
      networkObserver: {
        snapshot: () => ({
          consoleErrors: 0,
          failedRequests: 0,
          completedRequests: 1,
          pendingRequests: 0,
        }),
      } as ConsoleNetworkObserver,
    });

    await expect(
      engine.verify({
        type: "file",
        description: "download",
        params: { filePath, extension: ".txt", minSize: 1 },
      }),
    ).resolves.toMatchObject({ success: true });
    await expect(
      engine.verify({
        type: "network",
        description: "request",
        params: { requestSucceeded: true, noFailedRequests: true },
      }),
    ).resolves.toMatchObject({ success: true });
  });
});
