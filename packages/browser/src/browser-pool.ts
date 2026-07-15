import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export interface BrowserPoolConfig {
  maxSize?: number;
  headless?: boolean;
  warmInstances?: number;
  proxies?: string[];
  stealth?: boolean;
}

export class BrowserPool {
  private browser: Browser | null = null;
  private readonly contexts: Set<BrowserContext> = new Set();
  private readonly maxSize: number;
  private readonly headless: boolean;
  private readonly warmInstances: number;
  private readonly proxies: string[];
  private readonly stealth: boolean;

  public constructor(config: BrowserPoolConfig = {}) {
    this.maxSize = config.maxSize ?? 5;
    this.headless = config.headless ?? true;
    this.warmInstances = config.warmInstances ?? 1;
    this.proxies = config.proxies ?? [];
    this.stealth = config.stealth ?? true;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: this.headless });
    }
    return this.browser;
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

    let context: BrowserContext;
    if (this.contexts.size > 0) {
      const next = this.contexts.values().next().value;
      if (!next) {
        throw new Error("Pool context not found.");
      }
      context = next;
      this.contexts.delete(context);
    } else {
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
      await context.clearCookies();
      const pages = await context.pages();
      for (const page of pages) {
        await page.evaluate(() => {
          try {
            localStorage.clear();
            sessionStorage.clear();
          } catch {
            // ignore security error on unique origin (about:blank)
          }
        });
        try {
          await page.goto("about:blank");
        } catch {
          // ignore
        }
      }

      if (this.contexts.size < this.maxSize) {
        this.contexts.add(context);
      } else {
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
