import { describe, expect, it, afterEach } from "vitest";
import { BrowserPool } from "./browser-pool.js";

describe("BrowserPool", () => {
  let pool: BrowserPool | null = null;

  afterEach(async () => {
    if (pool) {
      await pool.close();
      pool = null;
    }
  });

  it("prewarms, acquires and releases page contexts successfully", async () => {
    pool = new BrowserPool({ warmInstances: 2, maxSize: 3 });

    await pool.prewarm();
    expect(pool.getPoolSize()).toBe(2);

    const { page: page1, context: context1 } = await pool.acquirePage();
    expect(page1).toBeDefined();
    expect(pool.getPoolSize()).toBe(1);

    const { page: page2, context: context2 } = await pool.acquirePage();
    expect(page2).toBeDefined();
    expect(pool.getPoolSize()).toBe(0);

    const { page: page3, context: context3 } = await pool.acquirePage();
    expect(page3).toBeDefined();
    expect(pool.getPoolSize()).toBe(0);

    await pool.releasePage(context1);
    expect(pool.getPoolSize()).toBe(1);

    await pool.releasePage(context2);
    expect(pool.getPoolSize()).toBe(2);

    await pool.releasePage(context3);
    expect(pool.getPoolSize()).toBe(3);

    const extraContext = await (await page1.context().browser()!).newContext();
    await pool.releasePage(extraContext);
    expect(pool.getPoolSize()).toBe(3);
  });

  it("applies stealth settings and configures proxy configuration options without crashing", async () => {
    pool = new BrowserPool({
      stealth: true,
      proxies: ["http://127.0.0.1:8080", "http://127.0.0.1:8081"],
      warmInstances: 1,
    });
    await pool.prewarm();
    const { page, context } = await pool.acquirePage();
    expect(page).toBeDefined();
    expect(context).toBeDefined();

    // Verify navigator.webdriver evasion init script runs on page evaluate
    const isWebdriver = await page.evaluate(() => navigator.webdriver);
    expect(isWebdriver).toBeUndefined();
  });
});
