import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";

import { VerifierEngine } from "@lhic/verifier";

import { search } from "./search.js";

describe("search", () => {
  const browsers: Awaited<ReturnType<typeof chromium.launch>>[] = [];

  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  });

  it("finds a search field, submits a query, and verifies expected results", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent(`
      <label>Search <input type="search"></label><button>Search</button><p id="result"></p>
      <script>document.querySelector('button').addEventListener('click', () => { document.querySelector('#result').textContent = 'Result: notebooks'; });</script>
    `);
    const directory = await mkdtemp(join(tmpdir(), "lhic-search-"));
    try {
      const result = await search(
        {
          page,
          verifier: new VerifierEngine({ page }),
          taskId: "search",
          traceFilePath: join(directory, "events.jsonl"),
        },
        { query: "notebooks", expectedText: "Result: notebooks" },
      );
      expect(result.success).toBe(true);
      expect(result.evidence.join(" ")).toContain("visible");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
