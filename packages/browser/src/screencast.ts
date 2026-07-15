import { EventEmitter } from "node:events";
import type { Page } from "playwright";

export interface ScreencastFrame {
  data: string; // Base64 jpeg encoded frame
  timestamp: number;
  metadata: {
    deviceWidth: number;
    deviceHeight: number;
    pageScaleFactor: number;
  };
}

export class ScreencastManager extends EventEmitter {
  private isStreaming = false;

  public constructor(private readonly page: Page) {
    super();
  }

  /**
   * Starts capturing page frames using Playwright CDP.
   */
  public async start(fps = 10): Promise<void> {
    if (this.isStreaming) {
      return;
    }
    this.isStreaming = true;

    try {
      const client = await this.page.context().newCDPSession(this.page);

      client.on("Page.screencastFrame", async (event) => {
        this.emit("frame", {
          data: event.data,
          timestamp: event.metadata.timestamp,
          metadata: {
            deviceWidth: event.metadata.deviceWidth,
            deviceHeight: event.metadata.deviceHeight,
            pageScaleFactor: event.metadata.pageScaleFactor,
          },
        });

        try {
          await client.send("Page.screencastFrameAck", {
            sessionId: event.sessionId as number,
          });
        } catch {
          // session closed
        }
      });

      await client.send("Page.startScreencast", {
        format: "jpeg",
        quality: 80,
        maxWidth: 1024,
        maxHeight: 768,
        everyNthFrame: Math.max(1, Math.round(60 / fps)),
      });
    } catch (error) {
      this.isStreaming = false;
      throw error;
    }
  }

  /**
   * Stops the screencast stream.
   */
  public async stop(): Promise<void> {
    if (!this.isStreaming) {
      return;
    }
    this.isStreaming = false;
    try {
      const client = await this.page.context().newCDPSession(this.page);
      await client.send("Page.stopScreencast");
    } catch {
      // ignore session errors
    }
  }
}
