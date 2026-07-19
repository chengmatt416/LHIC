import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";

import { VerifierEngine } from "@lhic/verifier";
import { createActionApproval } from "@lhic/security";

import { createDownloadAction, downloadFile } from "./download-file.js";

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
          approval: createActionApproval(
            createDownloadAction("#download"),
            "operator@example.test",
          ),
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

  it("requires a matching approval before writing a downloaded file", async () => {
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
          taskId: "download-file-unapproved",
          traceFilePath: join(directory, "events.jsonl"),
        },
        {
          trigger: "#download",
          expectedExtension: ".txt",
          downloadDir: directory,
        },
      );

      expect(result).toMatchObject({ success: false, askUser: true });
      expect(result.traces.map((event) => event.type)).toContain(
        "download_requires_human_approval",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
