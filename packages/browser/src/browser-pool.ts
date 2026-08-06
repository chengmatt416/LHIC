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
  private readonly maxSize: number;
  private readonly headless: boolean;
  private readonly warmInstances: number;
  private readonly proxies: string[];
  private readonly stealth: boolean;
  private acquireLock: Promise<void> = Promise.resolve();

  public constructor(config: BrowserPoolConfig = {}) {
    this.maxSize = config.maxSize ?? 5;
    this.headless = config.headless ?? true;
    this.warmInstances = config.warmInstances ?? 1;
    this.proxies = config.proxies ?? [];
    this.stealth = config.stealth ?? true;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser) {
      return this.browser;
    }
    if (!this.browserLaunch) {
      this.browserLaunch = chromium
        .launch({ headless: this.headless })
        .then((browser) => {
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
    while (this.contexts.size < this.warmInstances) {
      const proxy = this.getNextProxy();
      const context = await browser.newContext(proxy ? { proxy } : {});
      await this.configureContext(context);
      await context.newPage();
      this.contexts.add(context);
    }
  }

  /**
   * Acquires a fresh isolated page from the pool.
   */
  public async acquirePage(): Promise<{ page: Page; context: BrowserContext }> {
    const browser = await this.ensureBrowser();

    let context: BrowserContext | undefined;

    // Atomically check-and-remove a pre-warmed context from the pool.
    const release = await this.withLock();
    if (this.contexts.size > 0) {
      const next = this.contexts.values().next().value;
      if (next) {
        context = next;
        this.contexts.delete(context);
      }
    }
    release();

    // No pooled context available — create a fresh one outside the lock.
    if (!context) {
      const proxy = this.getNextProxy();
      context = await browser.newContext(proxy ? { proxy } : {});
      await this.configureContext(context);
    }

    let page = (await context.pages())[0];
    if (!page) {
      page = await context.newPage();
    }
    return { page, context };
  }

  /**
   * Releases and cleans up a context to avoid memory leaks.
   */
  public async releasePage(context: BrowserContext): Promise<void> {
    try {
      await this.clearContextStorage(context);

      let shouldClose = false;
      const release = await this.withLock();
      if (this.contexts.size < this.maxSize) {
        this.contexts.add(context);
      } else {
        shouldClose = true;
      }
      release();

      if (shouldClose) {
        await context.close();
      }
    } catch {
      try {
        await context.close();
      } catch {
        // ignore
      }
    }
  }

  private async clearContextStorage(context: BrowserContext): Promise<void> {
    await context.clearCookies();
    await context.clearPermissions();
    const pages = await context.pages();
    for (const page of pages) {
      const origin = getWebOrigin(page.url());
      if (origin) {
        try {
          const client = await context.newCDPSession(page);
          await client.send("Storage.clearDataForOrigin", {
            origin,
            storageTypes: "all",
          });
          await client.detach();
        } catch {
          // Browser implementations without CDP still use the page cleanup below.
        }
      }
      await page
        .evaluate(async () => {
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
        })
        .catch(() => undefined);
      await page.goto("about:blank").catch(() => undefined);
    }
  }

  /**
   * Closes the entire pool and releases all browser processes.
   */
  public async close(): Promise<void> {
    const activeContexts = Array.from(this.contexts);
    this.contexts.clear();
    await Promise.all(activeContexts.map((ctx) => ctx.close().catch(() => {})));
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
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
