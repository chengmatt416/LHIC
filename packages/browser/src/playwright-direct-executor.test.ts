import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";

import {
  createActionApproval,
  parseRuntimeConfig,
  signActionApproval,
} from "@lhic/security";

import {
  createProductionExecutor,
  PlaywrightDirectExecutor,
} from "./playwright-direct-executor.js";

describe("PlaywrightDirectExecutor", () => {
  const browsers: Awaited<ReturnType<typeof chromium.launch>>[] = [];

  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  });

  it("fills and submits a local form using direct DOM actions with trace evidence", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent(`
      <form><input id="email"><button id="submit">Submit</button></form>
      <p id="result"></p>
      <script>document.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); document.querySelector('#result').textContent = 'Saved'; });</script>
    `);
    const directory = await mkdtemp(join(tmpdir(), "lhic-browser-"));

    try {
      const executor = new PlaywrightDirectExecutor(page, {
        taskId: "form-task",
        traceFilePath: join(directory, "events.jsonl"),
      });
      const fillResult = await executor.execute({
        type: "fill",
        intent: "fill email",
        target: "#email",
        value: "person@example.com",
        methodPreference: ["dom", "accessibility"],
        riskLevel: "low",
      });
      const submitAction = {
        type: "click" as const,
        intent: "submit form",
        target: "#submit",
        methodPreference: ["dom" as const, "accessibility" as const],
        riskLevel: "low" as const,
      };
      const clickResult = await executor.execute(
        submitAction,
        createActionApproval(submitAction, "operator@example.test"),
      );

      expect(fillResult).toMatchObject({ success: true, method: "dom" });
      expect(clickResult.success).toBe(true);
      expect(await page.locator("#result").textContent()).toBe("Saved");
      const trace = await readFile(join(directory, "events.jsonl"), "utf8");
      expect(trace).toContain("action_completed");
      expect(trace).not.toContain("person@example.com");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("supports direct navigation, select, press, and wait actions", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    const executor = new PlaywrightDirectExecutor(page, {
      taskId: "action-coverage",
      traceFilePath: join(tmpdir(), `lhic-action-coverage-${Date.now()}.jsonl`),
      navigationPolicy: { allowedProtocols: ["data:"] },
    });
    const fixture = `data:text/html,${encodeURIComponent(`
      <input id="query"><select id="kind"><option value="all">All</option><option value="books">Books</option></select><p id="status"></p>
      <script>document.querySelector('#query').addEventListener('keydown', (event) => { if (event.key === 'Enter') document.querySelector('#status').textContent = 'Ready'; });</script>
    `)}`;

    expect(
      await executor.execute({
        type: "navigate",
        intent: "open local fixture",
        target: fixture,
        methodPreference: ["api"],
        riskLevel: "low",
      }),
    ).toMatchObject({ success: true, method: "api" });
    expect(
      await executor.execute({
        type: "select",
        intent: "choose books",
        target: "#kind",
        value: "books",
        methodPreference: ["dom"],
        riskLevel: "low",
      }),
    ).toMatchObject({ success: true, method: "dom" });
    expect(
      await executor.execute({
        type: "press",
        intent: "submit query",
        target: "#query",
        value: "Enter",
        methodPreference: ["keyboard"],
        riskLevel: "low",
      }),
    ).toMatchObject({ success: true, method: "keyboard" });
    expect(
      await executor.execute({
        type: "wait",
        intent: "wait for status",
        target: "#status",
        value: 1_000,
        methodPreference: ["dom"],
        riskLevel: "low",
      }),
    ).toMatchObject({ success: true, method: "dom" });
    expect(await page.locator("#kind").inputValue()).toBe("books");
    expect(await page.locator("#status").textContent()).toBe("Ready");
  });

  it("fills a searchbox before a same-named button", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent(`
      <div role="searchbox" aria-label="Search" contenteditable="true"></div>
      <button>Search</button>
    `);
    const executor = new PlaywrightDirectExecutor(page, {
      taskId: "searchbox-target",
      traceFilePath: join(tmpdir(), `lhic-searchbox-${Date.now()}.jsonl`),
    });

    await expect(
      executor.execute({
        type: "fill",
        intent: "fill documentation search",
        target: "Search",
        value: "grid layout",
        methodPreference: ["accessibility"],
        riskLevel: "low",
      }),
    ).resolves.toMatchObject({ success: true, method: "accessibility" });
    expect(await page.getByRole("searchbox").textContent()).toBe("grid layout");
  });

  it("clicks a visible button before a hidden same-named searchbox", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent(`
      <input type="search" aria-label="Search" hidden>
      <button>Search</button>
      <p id="result"></p>
      <script>document.querySelector('button').addEventListener('click', () => { document.querySelector('#result').textContent = 'opened'; });</script>
    `);
    const executor = new PlaywrightDirectExecutor(page, {
      taskId: "search-trigger-target",
      traceFilePath: join(tmpdir(), `lhic-search-trigger-${Date.now()}.jsonl`),
    });

    await expect(
      executor.execute({
        type: "click",
        intent: "open documentation search",
        target: "Search",
        methodPreference: ["accessibility"],
        riskLevel: "low",
      }),
    ).resolves.toMatchObject({ success: true, method: "accessibility" });
    expect(await page.locator("#result").textContent()).toBe("opened");
  });

  it("downloads through Playwright and redacts non-PII form values from demo traces", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent(
      '<input id="query"><a id="download" href="data:text/plain,report" download="report.txt">Download report</a>',
    );
    const directory = await mkdtemp(join(tmpdir(), "lhic-download-"));
    try {
      const executor = new PlaywrightDirectExecutor(page, {
        taskId: "download-task",
        traceFilePath: join(directory, "events.jsonl"),
        downloadDirectory: join(directory, "downloads"),
        redactActionValues: true,
      });
      await expect(
        executor.execute({
          type: "fill",
          intent: "fill search query",
          target: "#query",
          value: "non-sensitive-private-query",
          methodPreference: ["dom"],
          riskLevel: "low",
        }),
      ).resolves.toMatchObject({ success: true });
      await expect(
        executor.execute(
          {
            type: "download",
            intent: "download report",
            target: "#download",
            methodPreference: ["dom"],
            riskLevel: "low",
          },
          createActionApproval(
            {
              type: "download",
              intent: "download report",
              target: "#download",
              methodPreference: ["dom"],
              riskLevel: "low",
            },
            "operator@example.test",
          ),
        ),
      ).resolves.toMatchObject({
        success: true,
        evidence: [expect.stringContaining("Downloaded one file")],
      });
      expect(await readdir(join(directory, "downloads"))).toEqual([
        "report.txt",
      ]);
      const trace = await readFile(join(directory, "events.jsonl"), "utf8");
      expect(trace).not.toContain("non-sensitive-private-query");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("redacts a failed action value from Playwright error trace data", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent('<input id="hidden-query" hidden>');
    const directory = await mkdtemp(join(tmpdir(), "lhic-redacted-failure-"));
    const query = "trace-private-query";

    try {
      const result = await new PlaywrightDirectExecutor(page, {
        taskId: "redacted-failure",
        traceFilePath: join(directory, "events.jsonl"),
        actionTimeoutMs: 100,
        redactActionValues: true,
      }).execute({
        type: "fill",
        intent: "fill hidden query",
        target: "#hidden-query",
        value: query,
        methodPreference: ["dom"],
        riskLevel: "low",
      });

      expect(result.success).toBe(false);
      const trace = await readFile(join(directory, "events.jsonl"), "utf8");
      expect(trace).not.toContain(query);
      expect(trace).toContain("[REDACTED]");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains a stable selector and heals a renamed direct selector", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent(
      '<input id="query" name="search" aria-label="Query">',
    );
    const remembered: Array<{
      skillName: string;
      target: string;
      selector: string;
    }> = [];
    const executor = createProductionExecutor(page, parseRuntimeConfig({}), {
      taskId: "selector-memory",
      traceFilePath: join(tmpdir(), `lhic-selector-memory-${Date.now()}.jsonl`),
      selectorMemory: {
        find: (skillName, target) =>
          remembered.filter(
            (entry) => entry.skillName === skillName && entry.target === target,
          ),
        remember: (entry) => {
          remembered.push(entry);
          return true;
        },
      },
    });

    expect(
      await executor.execute({
        type: "fill",
        intent: "fill query",
        target: 'input[name="search"]',
        value: "local-only",
        methodPreference: ["dom"],
        riskLevel: "low",
      }),
    ).toMatchObject({ success: true, method: "dom" });
    expect(remembered).toEqual([
      expect.objectContaining({
        skillName: "fill",
        target: 'input[name="search"]',
        selector: "#query",
      }),
    ]);

    await page.setContent(
      '<input id="query" name="renamed" aria-label="Query">',
    );
    expect(
      await executor.execute({
        type: "fill",
        intent: "fill query after markup change",
        target: 'input[name="search"]',
        value: "healed-local-only",
        methodPreference: ["dom"],
        riskLevel: "low",
      }),
    ).toMatchObject({ success: true, method: "dom" });
    expect(await page.locator("#query").inputValue()).toBe("healed-local-only");
  });

  it("enforces approval and navigation policy at the executor boundary", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent('<button id="delete">Delete</button>');
    const executor = new PlaywrightDirectExecutor(page, {
      taskId: "policy-coverage",
      traceFilePath: join(tmpdir(), `lhic-policy-${Date.now()}.jsonl`),
      navigationPolicy: { allowedOrigins: ["https://example.test"] },
    });
    const action = {
      type: "click" as const,
      intent: "delete account",
      target: "#delete",
      methodPreference: ["dom" as const],
      riskLevel: "high" as const,
    };

    expect(await executor.execute(action)).toMatchObject({
      success: false,
      error: expect.stringContaining("No action approval"),
    });
    expect(
      await executor.execute(
        action,
        createActionApproval(action, "operator@example.test"),
      ),
    ).toMatchObject({ success: true, method: "dom" });
    expect(
      await executor.execute({
        type: "navigate",
        intent: "open local file",
        target: "file:///etc/passwd",
        methodPreference: ["api"],
        riskLevel: "low",
      }),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining("protocol"),
    });
    expect(
      await executor.execute({
        type: "navigate",
        intent: "open unapproved public site",
        target: "https://unapproved.example",
        methodPreference: ["api"],
        riskLevel: "low",
      }),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining("allowlisted"),
    });
  });

  it("does not trust a client-provided low-risk label for a destructive click target", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent(`
      <button id="account-action">Delete account</button>
      <p id="result"></p>
      <script>document.querySelector('#account-action').addEventListener('click', () => { document.querySelector('#result').textContent = 'deleted'; });</script>
    `);
    const executor = new PlaywrightDirectExecutor(page, {
      taskId: "target-risk-policy",
      traceFilePath: join(tmpdir(), `lhic-target-risk-${Date.now()}.jsonl`),
    });
    const misleadingAction = {
      type: "click" as const,
      intent: "open account menu",
      target: "#account-action",
      methodPreference: ["dom" as const],
      riskLevel: "low" as const,
    };

    expect(await executor.execute(misleadingAction)).toMatchObject({
      success: false,
      error: expect.stringContaining("No action approval"),
    });
    expect(await page.locator("#result").textContent()).toBe("");
    expect(
      await executor.execute(
        misleadingAction,
        createActionApproval(misleadingAction, "operator@example.test"),
      ),
    ).toMatchObject({ success: true, method: "dom" });
    expect(await page.locator("#result").textContent()).toBe("deleted");
  });

  it("requires approval for an opaque submit control", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent(
      '<button id="continue-action">Submit application</button>',
    );
    const executor = new PlaywrightDirectExecutor(page, {
      taskId: "opaque-submit-policy",
      traceFilePath: join(tmpdir(), `lhic-opaque-submit-${Date.now()}.jsonl`),
    });

    expect(
      await executor.execute({
        type: "click",
        intent: "continue form flow",
        target: "#continue-action",
        methodPreference: ["dom"],
        riskLevel: "low",
      }),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining("external side effect"),
    });
  });

  it("refuses an ambiguous selector instead of clicking the first matching control", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent(`
      <button class="account-action">First</button>
      <button class="account-action">Second</button>
      <p id="result"></p>
      <script>document.querySelectorAll('.account-action').forEach((button) => button.addEventListener('click', () => { document.querySelector('#result').textContent += button.textContent; }));</script>
    `);
    const executor = new PlaywrightDirectExecutor(page, {
      taskId: "ambiguous-target",
      traceFilePath: join(
        tmpdir(),
        `lhic-ambiguous-target-${Date.now()}.jsonl`,
      ),
    });

    expect(
      await executor.execute({
        type: "click",
        intent: "open account action",
        target: ".account-action",
        methodPreference: ["dom"],
        riskLevel: "low",
      }),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining("matched 2 elements"),
    });
    expect(await page.locator("#result").textContent()).toBe("");
  });

  it("requires an externally signed approval for production opaque destructive targets", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent(
      '<button id="account-action">Delete account</button>',
    );
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const config = parseRuntimeConfig({
      LHIC_ENV: "production",
      LHIC_ALLOWED_ORIGINS: "https://app.example.test",
      LHIC_APPROVAL_PUBLIC_KEY: publicKey
        .export({ format: "pem", type: "spki" })
        .toString(),
    });
    const action = {
      type: "click" as const,
      intent: "open account menu",
      target: "#account-action",
      methodPreference: ["dom" as const],
      riskLevel: "low" as const,
    };
    const approval = createActionApproval(action, "operator@example.test");
    const executor = createProductionExecutor(page, config, {
      traceFilePath: join(tmpdir(), `lhic-production-${Date.now()}.jsonl`),
    });

    expect(await executor.execute(action, approval)).toMatchObject({
      success: false,
      error: expect.stringContaining("signature"),
    });
    expect(
      await executor.execute(action, signActionApproval(approval, privateKey)),
    ).toMatchObject({ success: true, method: "dom" });
  });

  it("fails fast when attempting to click a disabled button", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent('<button id="submit" disabled>Submit</button>');
    const executor = new PlaywrightDirectExecutor(page, {
      taskId: "disabled-target",
      traceFilePath: join(tmpdir(), `lhic-disabled-target-${Date.now()}.jsonl`),
    });

    const clickAction = {
      type: "click" as const,
      intent: "click disabled button",
      target: "#submit",
      methodPreference: ["dom" as const],
      riskLevel: "low" as const,
    };

    const clickResult = await executor.execute(
      clickAction,
      createActionApproval(clickAction, "operator@example.test"),
    );

    expect(clickResult.success).toBe(false);
    expect(clickResult.error).toContain("is disabled and cannot be clicked");
  });
});
