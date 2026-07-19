import { EventEmitter } from "node:events";
import type { CDPSession, Page } from "playwright";

export interface ScreencastFrame {
  data: string; // Base64 jpeg encoded frame
  timestamp: number;
  metadata: {
    deviceWidth: number;
    deviceHeight: number;
    pageScaleFactor: number;
  };
}

interface ScreencastFrameEvent {
  data: string;
  sessionId: number;
  metadata: {
    deviceWidth?: number;
    deviceHeight?: number;
    pageScaleFactor?: number;
    timestamp?: number;
  };
}

export class ScreencastManager extends EventEmitter {
  private isStreaming = false;
  private client: CDPSession | null = null;
  private frameHandler: ((event: ScreencastFrameEvent) => void) | null = null;
  private startPromise: Promise<void> | null = null;

  public constructor(private readonly page: Page) {
    super();
  }

  /**
   * Starts capturing page frames using one persistent Playwright CDP session.
   */
  public async start(fps = 10): Promise<void> {
    if (this.isStreaming) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    if (!Number.isFinite(fps) || fps <= 0 || fps > 60) {
      throw new Error("Screencast FPS must be greater than 0 and at most 60.");
    }
    this.startPromise = this.startInternal(fps).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  /**
   * Stops the stream on the same CDP session that started it, then detaches
   * that session so a later start cannot leave an old frame listener running.
   */
  public async stop(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise.catch(() => undefined);
    }
    const client = this.client;
    const frameHandler = this.frameHandler;
    this.isStreaming = false;
    this.client = null;
    this.frameHandler = null;
    if (!client) {
      return;
    }

    if (frameHandler) {
      client.off("Page.screencastFrame", frameHandler);
    }
    try {
      await client.send("Page.stopScreencast");
    } catch {
      // Ignore page/session teardown errors.
    }
    await client.detach().catch(() => undefined);
  }

  private async startInternal(fps: number): Promise<void> {
    const client = await this.page.context().newCDPSession(this.page);
    const frameHandler = (event: ScreencastFrameEvent): void => {
      if (this.isStreaming && this.client === client) {
        this.emit("frame", {
          data: event.data,
          timestamp: event.metadata.timestamp ?? 0,
          metadata: {
            deviceWidth: event.metadata.deviceWidth ?? 0,
            deviceHeight: event.metadata.deviceHeight ?? 0,
            pageScaleFactor: event.metadata.pageScaleFactor ?? 1,
          },
        } satisfies ScreencastFrame);
      }
      void client
        .send("Page.screencastFrameAck", { sessionId: event.sessionId })
        .catch(() => undefined);
    };
    client.on("Page.screencastFrame", frameHandler);
    this.client = client;
    this.frameHandler = frameHandler;
    try {
      await client.send("Page.startScreencast", {
        format: "jpeg",
        quality: 80,
        maxWidth: 1024,
        maxHeight: 768,
        everyNthFrame: Math.max(1, Math.round(60 / fps)),
      });
      this.isStreaming = true;
    } catch (error) {
      client.off("Page.screencastFrame", frameHandler);
      this.client = null;
      this.frameHandler = null;
      await client.detach().catch(() => undefined);
      throw error;
    }
  }
}
