import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";

import { VerifierEngine } from "@lhic/verifier";

import { testWebFlow } from "./test-web-flow.js";

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
      <input id="name"><button id="save">Save</button><p id="result"></p>
      <script>document.querySelector('#save').addEventListener('click', () => { document.querySelector('#result').textContent = 'Saved'; });</script>
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
            {
              type: "click",
              intent: "save",
              target: "#save",
              methodPreference: ["dom"],
              riskLevel: "low",
            },
          ],
          successConditions: [
            { type: "dom", description: "saved", params: { text: "Saved" } },
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
});
