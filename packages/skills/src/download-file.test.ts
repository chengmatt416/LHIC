import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";

import { VerifierEngine } from "@lhic/verifier";

import { downloadFile } from "./download-file.js";

describe("downloadFile", () => {
  const browsers: Awaited<ReturnType<typeof chromium.launch>>[] = [];

  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  });

  it("downloads, saves, and verifies a local fixture file", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent(
      '<a id="download" download="report.txt" href="data:text/plain,verified%20download">Download report</a>',
    );
    const directory = await mkdtemp(join(tmpdir(), "lhic-download-"));
    try {
      const result = await downloadFile(
        {
          page,
          verifier: new VerifierEngine({ page }),
          taskId: "download-file",
          traceFilePath: join(directory, "events.jsonl"),
        },
        {
          trigger: "#download",
          expectedExtension: ".txt",
          downloadDir: directory,
        },
      );

      expect(result.success).toBe(true);
      expect(result.evidence.join(" ")).toContain("size=");
      expect(result.traces.map((event) => event.type)).toContain(
        "download_verified",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
