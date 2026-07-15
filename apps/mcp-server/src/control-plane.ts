import { verify } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export interface ControlPlaneConfig {
  port?: number;
  jwtPublicKey?: string;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
}

export class ControlPlaneServer {
  private server: ReturnType<typeof createServer> | null = null;
  private readonly rateLimits: Map<string, { count: number; resetAt: number }> =
    new Map();
  private readonly port: number;
  private readonly jwtPublicKey: string | undefined;
  private readonly rateLimitMax: number;
  private readonly rateLimitWindowMs: number;

  public constructor(config: ControlPlaneConfig = {}) {
    this.port = config.port ?? 8000;
    this.jwtPublicKey = config.jwtPublicKey;
    this.rateLimitMax = config.rateLimitMax ?? 100;
    this.rateLimitWindowMs = config.rateLimitWindowMs ?? 60000;
  }

  private checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const limit = this.rateLimits.get(ip);

    if (!limit || now > limit.resetAt) {
      this.rateLimits.set(ip, {
        count: 1,
        resetAt: now + this.rateLimitWindowMs,
      });
      return true;
    }

    if (limit.count >= this.rateLimitMax) {
      return false;
    }

    limit.count++;
    return true;
  }

  private verifyJwt(token: string): boolean {
    if (!this.jwtPublicKey) {
      return true;
    }
    try {
      const [headerB64, payloadB64, signatureB64] = token.split(".");
      if (!headerB64 || !payloadB64 || !signatureB64) {
        return false;
      }

      const verifyPayload = `${headerB64}.${payloadB64}`;
      return verify(
        "sha256",
        Buffer.from(verifyPayload),
        this.jwtPublicKey,
        Buffer.from(signatureB64, "base64"),
      );
    } catch {
      return false;
    }
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const ip = req.socket.remoteAddress || "unknown";

        if (!this.checkRateLimit(ip)) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Too many requests. Please try again later.",
            }),
          );
          return;
        }

        const authHeader = req.headers.authorization;
        const token = authHeader?.startsWith("Bearer ")
          ? authHeader.substring(7)
          : undefined;
        if (this.jwtPublicKey && (!token || !this.verifyJwt(token))) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: Invalid JWT token." }));
          return;
        }

        const url = new URL(req.url || "", `http://localhost:${this.port}`);

        if (req.method === "POST" && url.pathname === "/v1/tasks") {
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ status: "Accepted", taskId: "new-task-uuid" }),
          );
          return;
        }

        if (req.method === "GET" && url.pathname.startsWith("/v1/tasks/")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              taskId: url.pathname.split("/").pop(),
              status: "completed",
            }),
          );
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not Found" }));
      });

      this.server.listen(this.port, () => {
        resolve();
      });

      this.server.on("error", (err) => {
        reject(err);
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
