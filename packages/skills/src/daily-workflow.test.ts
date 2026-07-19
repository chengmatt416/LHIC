import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";

import { PlaywrightDirectExecutor } from "@lhic/browser";
import { createActionApproval } from "@lhic/security";
import { VerifierEngine } from "@lhic/verifier";

import { createDownloadAction, downloadFile } from "./download-file.js";
import { fillForm } from "./fill-form.js";
import { login } from "./login.js";
import { search } from "./search.js";

describe("daily browser workflow", () => {
  const browsers: Awaited<ReturnType<typeof chromium.launch>>[] = [];

  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  });

  it("completes login, search, form update, approved save, and approved download with verifier evidence", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent(`
      <form id="login-form">
        <label>Email <input type="email"></label>
        <label>Password <input type="password"></label>
        <button type="submit">Sign in</button>
      </form>
      <p id="login-result"></p>
      <section id="workspace" hidden>
        <label>Search <input type="search"></label>
        <button id="find-project" type="button">Find project</button>
        <p id="search-result"></p>
        <form id="daily-update-form">
          <label>Project <input name="Project"></label>
          <label>Daily update <textarea name="Daily update"></textarea></label>
          <label>Priority <select name="Priority"><option value="normal">Normal</option><option value="high">High</option></select></label>
          <button id="save-draft" type="submit">Save draft</button>
        </form>
        <p id="save-result"></p>
        <a id="download-report" download="daily-report.txt" href="data:text/plain,verified%20daily%20report">Download report</a>
      </section>
      <script>
        document.querySelector('#login-form').addEventListener('submit', (event) => {
          event.preventDefault();
          document.querySelector('#login-result').textContent = 'Welcome back';
          document.querySelector('#workspace').hidden = false;
        });
        document.querySelector('#find-project').addEventListener('click', () => {
          document.querySelector('#search-result').textContent = 'Project result ready';
        });
        document.querySelector('#daily-update-form').addEventListener('submit', (event) => {
          event.preventDefault();
          document.querySelector('#save-result').textContent = 'Draft saved';
        });
      </script>
    `);
    const directory = await mkdtemp(join(tmpdir(), "lhic-daily-workflow-"));
    const context = {
      page,
      verifier: new VerifierEngine({ page }),
      taskId: "daily-workflow",
      traceFilePath: join(directory, "events.jsonl"),
    };
    const saveAction = {
      type: "click" as const,
      intent: "save the daily update draft",
      target: "#save-draft",
      methodPreference: ["dom" as const],
      riskLevel: "low" as const,
    };

    try {
      const loginResult = await login(context, {
        username: "worker@example.test",
        password: "daily-workflow-password",
        successText: "Welcome back",
      });
      const searchResult = await search(context, {
        query: "release planning",
        expectedText: "Project result ready",
      });
      const formResult = await fillForm(context, {
        fields: {
          Project: "Release planning",
          "Daily update": "blue-orchid-launch-status",
          Priority: "high",
        },
      });
      const saveResult = await new PlaywrightDirectExecutor(page, {
        taskId: "daily-workflow",
        traceFilePath: context.traceFilePath,
      }).execute(
        saveAction,
        createActionApproval(saveAction, "daily-workflow-reviewer"),
      );
      const saveVerification = await context.verifier.verify({
        type: "dom",
        description: "daily draft save confirmation is visible",
        params: { text: "Draft saved" },
      });
      const downloadResult = await downloadFile(context, {
        trigger: "#download-report",
        expectedExtension: ".txt",
        downloadDir: directory,
        approval: createActionApproval(
          createDownloadAction("#download-report"),
          "daily-workflow-reviewer",
        ),
      });

      expect(loginResult.success).toBe(true);
      expect(searchResult.success).toBe(true);
      expect(formResult.success).toBe(true);
      expect(saveResult.success).toBe(true);
      expect(saveVerification).toMatchObject({ success: true });
      expect(downloadResult.success).toBe(true);
      expect(
        [
          ...loginResult.evidence,
          ...searchResult.evidence,
          ...formResult.evidence,
          ...saveResult.evidence,
          ...saveVerification.evidence,
          ...downloadResult.evidence,
        ].length,
      ).toBeGreaterThan(0);

      const trace = await readFile(context.traceFilePath, "utf8");
      expect(trace).not.toContain("worker@example.test");
      expect(trace).not.toContain("daily-workflow-password");
      expect(trace).not.toContain("blue-orchid-launch-status");
      expect(trace).toContain("download_verified");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
