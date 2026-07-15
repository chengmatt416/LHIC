import type { ConsoleMessage, Page, Request } from "playwright";

export interface NetworkObservation {
  consoleErrors: number;
  failedRequests: number;
  completedRequests: number;
  pendingRequests: number;
}

export class ConsoleNetworkObserver {
  private readonly pendingRequests = new Set<Request>();
  private consoleErrors = 0;
  private failedRequests = 0;
  private completedRequests = 0;

  public constructor(private readonly page: Page) {
    this.start();
  }

  public start(): void {
    this.page.on("console", this.onConsole);
    this.page.on("request", this.onRequest);
    this.page.on("requestfinished", this.onRequestFinished);
    this.page.on("requestfailed", this.onRequestFailed);
  }

  public stop(): void {
    this.page.off("console", this.onConsole);
    this.page.off("request", this.onRequest);
    this.page.off("requestfinished", this.onRequestFinished);
    this.page.off("requestfailed", this.onRequestFailed);
  }

  public snapshot(): NetworkObservation {
    return {
      consoleErrors: this.consoleErrors,
      failedRequests: this.failedRequests,
      completedRequests: this.completedRequests,
      pendingRequests: this.pendingRequests.size,
    };
  }

  private readonly onConsole = (message: ConsoleMessage): void => {
    if (message.type() === "error") {
      this.consoleErrors += 1;
    }
  };

  private readonly onRequest = (request: Request): void => {
    this.pendingRequests.add(request);
  };

  private readonly onRequestFinished = (request: Request): void => {
    this.pendingRequests.delete(request);
    this.completedRequests += 1;
  };

  private readonly onRequestFailed = (request: Request): void => {
    this.pendingRequests.delete(request);
    this.failedRequests += 1;
  };
}
