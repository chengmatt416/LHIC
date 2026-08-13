import { createInterface, type Interface } from "node:readline";

interface PendingQuestion {
  prompt: string;
  resolve(value: string): void;
  reject(error: Error): void;
}

export class InputClosedError extends Error {
  public constructor() {
    super("Terminal input closed.");
    this.name = "InputClosedError";
  }
}

/** Owns stdin for the process and serializes every interactive question. */
export class InputArbiter {
  private readonly readline: Interface;
  private readonly queue: PendingQuestion[] = [];
  private active: PendingQuestion | undefined;
  private closed = false;

  public constructor(
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
  ) {
    this.readline = createInterface({ input, output });
    this.readline.once("close", () => this.rejectAll());
  }

  public question(prompt: string): Promise<string> {
    if (this.closed) return Promise.reject(new InputClosedError());
    return new Promise<string>((resolve, reject) => {
      this.queue.push({ prompt, resolve, reject });
      this.pump();
    });
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readline.close();
    this.rejectAll();
  }

  private pump(): void {
    if (this.closed || this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = next;
    this.readline.question(next.prompt, (answer) => {
      if (this.active !== next) return;
      this.active = undefined;
      next.resolve(answer);
      this.pump();
    });
  }

  private rejectAll(): void {
    if (!this.closed) this.closed = true;
    const error = new InputClosedError();
    this.active?.reject(error);
    this.active = undefined;
    for (const pending of this.queue.splice(0)) pending.reject(error);
  }
}
