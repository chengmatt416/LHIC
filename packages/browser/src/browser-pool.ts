import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";

export interface BrowserPoolConfig {
  maxSize?: number;
  headless?: boolean;
  warmInstances?: number;
  proxies?: string[];
  stealth?: boolean;
}

export class BrowserPool {
  private browser: Browser | null = null;
  private browserLaunch: Promise<Browser> | null = null;
  private readonly contexts: Set<BrowserContext> = new Set();
  private readonly leasedContexts: Set<BrowserContext> = new Set();
  private readonly releasingContexts: Set<BrowserContext> = new Set();
  private readonly maxSize: number;
  private readonly headless: boolean;
  private readonly warmInstances: number;
  private readonly proxies: string[];
  private readonly stealth: boolean;
  private acquireLock: Promise<void> = Promise.resolve();
  private closed = false;

  public constructor(config: BrowserPoolConfig = {}) {
    this.maxSize = config.maxSize ?? 5;
    this.headless = config.headless ?? true;
    this.warmInstances = config.warmInstances ?? 1;
    this.proxies = config.proxies ?? [];
    this.stealth = config.stealth ?? true;
    if (!Number.isSafeInteger(this.maxSize) || this.maxSize < 1) {
      throw new Error("Browser pool maxSize must be a positive integer.");
    }
    if (
      !Number.isSafeInteger(this.warmInstances) ||
      this.warmInstances < 0 ||
      this.warmInstances > this.maxSize
    ) {
      throw new Error(
        "Browser pool warmInstances must be an integer between zero and maxSize.",
      );
    }
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.closed) {
      throw new Error("Browser pool is closed.");
    }
    if (this.browser) {
      return this.browser;
    }
    if (!this.browserLaunch) {
      this.browserLaunch = chromium
        .launch({ headless: this.headless })
        .then(async (browser) => {
          if (this.closed) {
            await browser.close();
            throw new Error("Browser pool is closed.");
          }
          this.browser = browser;
          return browser;
        })
        .finally(() => {
          this.browserLaunch = null;
        });
    }
    return this.browserLaunch;
  }

  private getNextProxy(): { server: string } | undefined {
    if (this.proxies.length === 0) {
      return undefined;
    }
    const randomIndex = Math.floor(Math.random() * this.proxies.length);
    const proxyUrl = this.proxies[randomIndex];
    return proxyUrl ? { server: proxyUrl } : undefined;
  }

  private async configureContext(context: BrowserContext): Promise<void> {
    if (this.stealth) {
      // Evade standard automation fingerprinting check
      await context.addInitScript(() => {
        try {
          Object.defineProperty(navigator, "webdriver", {
            get: () => undefined,
          });
        } catch {
          // ignore error
        }
      });
    }
  }

  /**
   * Serializes access to the shared `contexts` Set via a promise-chain mutex.
   * Returns a release function that MUST be called (typically in a `finally` block)
   * to allow the next waiter through.
   */
  private async withLock(): Promise<() => void> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.acquireLock;
    this.acquireLock = prev.then(() => gate);
    await prev;
    return release;
  }

  /**
   * Pre-warms the browser pool by ensuring the browser is launched and instantiating contexts.
   */
  public async prewarm(): Promise<void> {
    const browser = await this.ensureBrowser();
    const release = await this.withLock();
    try {
      if (this.closed) throw new Error("Browser pool is closed.");
      while (this.contexts.size < this.warmInstances) {
        const proxy = this.getNextProxy();
        const context = await browser.newContext(proxy ? { proxy } : {});
        try {
          await this.configureContext(context);
          await context.newPage();
          this.contexts.add(context);
        } catch (error) {
          await context.close().catch(() => undefined);
          throw error;
        }
      }
    } finally {
      release();
    }
  }

  /**
   * Acquires a fresh isolated page from the pool.
   */
  public async acquirePage(): Promise<{ page: Page; context: BrowserContext }> {
    const browser = await this.ensureBrowser();
    let context: BrowserContext | undefined;

    const release = await this.withLock();
    try {
      if (this.closed) throw new Error("Browser pool is closed.");
      const next = this.contexts.values().next().value;
      if (next) {
        context = next;
        this.contexts.delete(context);
        this.leasedContexts.add(context);
      }
    } finally {
      release();
    }

    if (!context) {
      const proxy = this.getNextProxy();
      const created = await browser.newContext(proxy ? { proxy } : {});
      try {
        await this.configureContext(created);
        const registerRelease = await this.withLock();
        try {
          if (this.closed) throw new Error("Browser pool is closed.");
          this.leasedContexts.add(created);
          context = created;
        } finally {
          registerRelease();
        }
      } catch (error) {
        await created.close().catch(() => undefined);
        throw error;
      }
    }
    const acquiredContext = context;
    if (!acquiredContext) {
      throw new Error("Browser pool failed to acquire a context.");
    }

    try {
      let page = (await acquiredContext.pages())[0];
      if (!page) page = await acquiredContext.newPage();
      return { page, context: acquiredContext };
    } catch (error) {
      const cleanupRelease = await this.withLock();
      this.leasedContexts.delete(acquiredContext);
      cleanupRelease();
      await acquiredContext.close().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Releases and cleans up a context to avoid memory leaks.
   */
  public async releasePage(context: BrowserContext): Promise<void> {
    const startRelease = await this.withLock();
    if (this.contexts.has(context) || this.releasingContexts.has(context)) {
      startRelease();
      return;
    }
    this.leasedContexts.delete(context);
    if (this.closed) {
      startRelease();
      await context.close().catch(() => undefined);
      return;
    }
    this.releasingContexts.add(context);
    startRelease();

    let reusable = true;
    try {
      await this.clearContextStorage(context);
    } catch {
      reusable = false;
    }

    const finishRelease = await this.withLock();
    this.releasingContexts.delete(context);
    const shouldClose =
      !reusable || this.closed || this.contexts.size >= this.maxSize;
    if (!shouldClose) this.contexts.add(context);
    finishRelease();

    if (shouldClose) await context.close().catch(() => undefined);
  }

  private async clearContextStorage(context: BrowserContext): Promise<void> {
    await context.clearCookies();
    await context.clearPermissions();
    const pages = context.pages();
    await Promise.all(
      pages.map(async (page) => {
        const origin = getWebOrigin(page.url());
        if (origin) {
          const client = await context.newCDPSession(page);
          try {
            await client.send("Storage.clearDataForOrigin", {
              origin,
              storageTypes: "all",
            });
          } catch {
            // Browser implementations without CDP still use page cleanup below.
          } finally {
            await client.detach().catch(() => undefined);
          }
          await page.evaluate(async () => {
            localStorage.clear();
            sessionStorage.clear();
            if ("indexedDB" in window && indexedDB.databases) {
              const databases = await indexedDB.databases();
              await Promise.all(
                databases.map(
                  (database) =>
                    new Promise<void>((resolve) => {
                      if (!database.name) {
                        resolve();
                        return;
                      }
                      const request = indexedDB.deleteDatabase(database.name);
                      request.onsuccess =
                        request.onerror =
                        request.onblocked =
                          () => resolve();
                    }),
                ),
              );
            }
            if ("caches" in window) {
              await Promise.all(
                (await caches.keys()).map((cacheName) =>
                  caches.delete(cacheName),
                ),
              );
            }
            if ("serviceWorker" in navigator) {
              await Promise.all(
                (await navigator.serviceWorker.getRegistrations()).map(
                  (registration) => registration.unregister(),
                ),
              );
            }
          });
        }
        await page.goto("about:blank");
      }),
    );
  }

  /**
   * Closes the entire pool and releases all browser processes.
   */
  public async close(): Promise<void> {
    const browserLaunch = this.browserLaunch;
    this.closed = true;
    await browserLaunch?.catch(() => undefined);

    const release = await this.withLock();
    const allContexts = new Set([
      ...this.contexts,
      ...this.leasedContexts,
      ...this.releasingContexts,
    ]);
    this.contexts.clear();
    this.leasedContexts.clear();
    this.releasingContexts.clear();
    const browser = this.browser;
    this.browser = null;
    release();

    const contextResults = await Promise.allSettled(
      [...allContexts].map((context) => context.close()),
    );
    let browserFailure: unknown;
    try {
      await browser?.close();
    } catch (error) {
      browserFailure = error;
    }
    const failures = contextResults
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason);
    if (browserFailure) failures.push(browserFailure);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Browser pool cleanup failed.");
    }
  }

  public getPoolSize(): number {
    return this.contexts.size;
  }
}

function getWebOrigin(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
}
