import { createServer, type Server } from "node:http";

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

  it("clears cookies and browser storage before reusing a context", async () => {
    pool = new BrowserPool({ warmInstances: 1, maxSize: 1 });
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end("<title>pool isolation</title>");
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not expose a TCP port.");
    }
    const url = `http://127.0.0.1:${address.port}`;

    try {
      const first = await pool.acquirePage();
      await first.page.goto(url);
      await first.page.evaluate(async () => {
        localStorage.setItem("local-secret", "should-not-leak");
        sessionStorage.setItem("session-secret", "should-not-leak");
        document.cookie = "cookie-secret=should-not-leak; Path=/";
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("pool-isolation", 1);
          request.onupgradeneeded = () => {
            request.result.createObjectStore("secrets");
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise<void>((resolve, reject) => {
          const request = database
            .transaction("secrets", "readwrite")
            .objectStore("secrets")
            .put("should-not-leak", "token");
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
        database.close();
      });
      await pool.releasePage(first.context);

      const second = await pool.acquirePage();
      await second.page.goto(url);
      const leaked = await second.page.evaluate(async () => {
        const databaseNames = indexedDB.databases
          ? (await indexedDB.databases()).map((database) => database.name)
          : [];
        return {
          local: localStorage.getItem("local-secret"),
          session: sessionStorage.getItem("session-secret"),
          cookie: document.cookie,
          databaseNames,
        };
      });
      expect(leaked).toEqual({
        local: null,
        session: null,
        cookie: "",
        databaseNames: [],
      });
      await pool.releasePage(second.context);
    } finally {
      await closeServer(server);
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

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
