import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";

import { VerifierEngine } from "@lhic/verifier";
import { createActionApproval } from "@lhic/security";

import { testWebFlow, type DurableWorkflowLookup } from "./test-web-flow.js";

describe("testWebFlow", () => {
  const browsers: Awaited<ReturnType<typeof chromium.launch>>[] = [];

  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  });

  it("executes direct actions and verifies flow success conditions", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent(`
      <input id="name"><p id="result"></p>
      <script>document.querySelector('#name').addEventListener('input', () => { document.querySelector('#result').textContent = 'Ready'; });</script>
    `);
    const directory = await mkdtemp(join(tmpdir(), "lhic-flow-"));
    try {
      const result = await testWebFlow(
        {
          page,
          verifier: new VerifierEngine({ page }),
          taskId: "flow",
          traceFilePath: join(directory, "events.jsonl"),
        },
        {
          steps: [
            {
              type: "fill",
              intent: "fill name",
              target: "#name",
              value: "Ada",
              methodPreference: ["dom"],
              riskLevel: "low",
            },
          ],
          successConditions: [
            { type: "dom", description: "ready", params: { text: "Ready" } },
          ],
          stopBeforeHighRisk: true,
        },
      );
      expect(result.success).toBe(true);
      expect(result.traces.map((event) => event.type)).toContain(
        "test_web_flow_verified",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops before a high-risk action when configured", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    const directory = await mkdtemp(join(tmpdir(), "lhic-high-risk-flow-"));
    try {
      const result = await testWebFlow(
        {
          page,
          verifier: new VerifierEngine({ page }),
          taskId: "high-risk-flow",
          traceFilePath: join(directory, "events.jsonl"),
        },
        {
          steps: [
            {
              type: "click",
              intent: "delete account",
              target: "#delete",
              methodPreference: ["dom"],
              riskLevel: "high",
            },
          ],
          successConditions: [],
          stopBeforeHighRisk: true,
        },
      );
      expect(result).toMatchObject({ success: false, askUser: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("executes an approved side-effecting step and verifies the outcome", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent(`
      <button id="account-action">Save profile</button><p id="result"></p>
      <script>document.querySelector('#account-action').addEventListener('click', () => { document.querySelector('#result').textContent = 'Saved'; });</script>
    `);
    const directory = await mkdtemp(join(tmpdir(), "lhic-approved-flow-"));
    const saveAction = {
      type: "click" as const,
      intent: "save profile",
      target: "#account-action",
      methodPreference: ["dom" as const],
      riskLevel: "low" as const,
    };
    try {
      const result = await testWebFlow(
        {
          page,
          verifier: new VerifierEngine({ page }),
          taskId: "approved-flow",
          traceFilePath: join(directory, "events.jsonl"),
        },
        {
          steps: [saveAction],
          approvals: {
            0: createActionApproval(saveAction, "operator@example.test"),
          },
          successConditions: [
            { type: "dom", description: "saved", params: { text: "Saved" } },
          ],
          stopBeforeHighRisk: true,
        },
      );

      expect(result.success).toBe(true);
      expect(await page.locator("#result").textContent()).toBe("Saved");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("restores progress from DurableWorkflowLookup and skips completed steps", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent(`
      <input id="step2-input"><p id="result"></p>
      <script>document.querySelector('#step2-input').addEventListener('input', () => { document.querySelector('#result').textContent = 'Done'; });</script>
    `);

    const savedState = {
      lastCompletedStep: 1,
      url: page.url(),
      cookiesJson: "[]",
      localStorageJson: '{"key":"value"}',
      sessionStorageJson: '{"sessionKey":"sessionValue"}',
    };

    let saveCalled = false;
    let deleteCalled = false;

    const mockStore: DurableWorkflowLookup = {
      get: (taskId: string) => {
        expect(taskId).toBe("durable-flow");
        return savedState;
      },
      save: (state) => {
        saveCalled = true;
        expect(state.lastCompletedStep).toBe(2);
      },
      delete: (taskId: string) => {
        deleteCalled = true;
        expect(taskId).toBe("durable-flow");
      },
    };

    const directory = await mkdtemp(join(tmpdir(), "lhic-durable-flow-"));
    try {
      const result = await testWebFlow(
        {
          page,
          verifier: new VerifierEngine({ page }),
          taskId: "durable-flow",
          traceFilePath: join(directory, "events.jsonl"),
        },
        {
          steps: [
            {
              type: "fill",
              intent: "step 1 - should be skipped",
              target: "#step1-nonexistent",
              value: "Skipped",
              methodPreference: ["dom"],
              riskLevel: "low",
            },
            {
              type: "fill",
              intent: "step 2 - should run",
              target: "#step2-input",
              value: "Hello Step 2",
              methodPreference: ["dom"],
              riskLevel: "low",
            },
          ],
          successConditions: [
            { type: "dom", description: "done", params: { text: "Done" } },
          ],
          durableStore: mockStore,
        },
      );

      expect(result.success).toBe(true);
      expect(result.evidence).toContain(
        "Skipped step 1 (already completed and hydrated).",
      );
      expect(saveCalled).toBe(true);
      expect(deleteCalled).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
