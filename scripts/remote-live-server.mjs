import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import crypto from "node:crypto";

const PORT = 3008;
const rootDir = process.cwd();
const lhicDir = join(rootDir, ".lhic");
const statusFile = join(lhicDir, "continuous-training-status.json");
const logFile = join(lhicDir, "continuous-training.log");
const patFile = join(lhicDir, "github-pat.txt");
const pinHashFile = join(lhicDir, "security-pin-hash.txt");

mkdirSync(lhicDir, { recursive: true });

// --- SSE Client Registry ---
const sseClients = new Set();
let lastLogSize = 0;

function broadcastSSE(data) {
  const frame = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

// Watch log file for changes and broadcast to SSE clients
function startLogWatcher() {
  if (!existsSync(logFile)) return;
  lastLogSize = statSync(logFile).size;

  setInterval(() => {
    if (!existsSync(logFile)) return;
    try {
      const currentSize = statSync(logFile).size;
      if (currentSize > lastLogSize) {
        const fd = openSync(logFile, "r");
        const buf = Buffer.alloc(currentSize - lastLogSize);
        readSync(fd, buf, 0, buf.length, lastLogSize);
        closeSync(fd);
        lastLogSize = currentSize;

        const newLines = buf
          .toString("utf8")
          .split("\n")
          .filter((l) => l.trim().length > 0);

        for (const line of newLines) {
          broadcastSSE({ type: "log", line, timestamp: new Date().toISOString() });
        }
      } else if (currentSize < lastLogSize) {
        lastLogSize = 0;
      }
    } catch {
      // Ignore transient read errors
    }
  }, 500);
}

// Watch status file for changes and broadcast to SSE clients
function startStatusWatcher() {
  let lastStatusMtime = 0;

  setInterval(() => {
    if (!existsSync(statusFile)) return;
    try {
      const mtime = statSync(statusFile).mtimeMs;
      if (mtime > lastStatusMtime) {
        lastStatusMtime = mtime;
        const data = JSON.parse(readFileSync(statusFile, "utf8"));
        broadcastSSE({ type: "status", data, timestamp: new Date().toISOString() });
      }
    } catch {
      // Ignore
    }
  }, 1000);
}

startLogWatcher();
startStatusWatcher();

// --- Security: Challenge-Response Nonce ---
const activeNonces = new Map();

function cleanExpiredNonces() {
  const now = Date.now();
  for (const [nonce, ts] of activeNonces.entries()) {
    if (now - ts > 15000) {
      activeNonces.delete(nonce);
    }
  }
}
setInterval(cleanExpiredNonces, 10000);

// --- HTTP Server ---
const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Nonce, X-Timestamp, X-Signature, X-Challenge-Token"
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // 1. Issue Ephemeral Challenge Nonce
  if (url.pathname === "/api/challenge" && req.method === "GET") {
    const nonce = crypto.randomBytes(16).toString("hex");
    const timestamp = Date.now();
    activeNonces.set(nonce, timestamp);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, nonce, timestamp }));
    return;
  }

  // 2. SSE Live Log Stream — true real-time push from VM
  if (url.pathname === "/api/stream-logs" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Send initial log snapshot (last 200 lines)
    if (existsSync(logFile)) {
      const text = readFileSync(logFile, "utf8");
      const lines = text
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .slice(-200);
      res.write(`data: ${JSON.stringify({ type: "snapshot", lines, timestamp: new Date().toISOString() })}\n\n`);
    }

    // Send initial status
    if (existsSync(statusFile)) {
      try {
        const data = JSON.parse(readFileSync(statusFile, "utf8"));
        res.write(`data: ${JSON.stringify({ type: "status", data, timestamp: new Date().toISOString() })}\n\n`);
      } catch {
        // Ignore
      }
    }

    // Register client for live updates
    sseClients.add(res);

    // Heartbeat every 15s to keep connection alive
    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat\n\n`);
      } catch {
        clearInterval(heartbeat);
        sseClients.delete(res);
      }
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }

  // 3. Real-Time Live Status Endpoint (REST fallback)
  if (url.pathname === "/api/live-status" && req.method === "GET") {
    try {
      let statusData = {};
      if (existsSync(statusFile)) {
        statusData = JSON.parse(readFileSync(statusFile, "utf8"));
      }

      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(
        JSON.stringify({
          success: true,
          source: "oracle_vm_live_stream",
          vmHost: "92.5.142.29",
          timestamp: new Date().toISOString(),
          ...statusData,
        })
      );
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 4. Real-Time Live Log Endpoint (REST fallback)
  if (url.pathname === "/api/live-logs" && req.method === "GET") {
    try {
      let logs = [];
      if (existsSync(logFile)) {
        const text = readFileSync(logFile, "utf8");
        logs = text
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .slice(-200);
      }

      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify({ success: true, logs, lastUpdated: new Date().toISOString() }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 5. Remote Settings & GitHub PAT Provisioning
  if (url.pathname === "/api/settings" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { pat, pin } = JSON.parse(body);

        if (pat && pat.trim().length > 0) {
          const cleanPat = pat.trim();
          writeFileSync(patFile, cleanPat, "utf8");
          const remoteUrl = `https://${cleanPat}@github.com/chengmatt416/LHIC.git`;
          execSync(`git remote set-url origin "${remoteUrl}"`, { cwd: rootDir });
          execSync(`git push origin training-results`, { cwd: rootDir });
        }

        if (pin && pin.trim().length > 0) {
          const newHash = crypto.createHash("sha256").update(pin.trim()).digest("hex");
          writeFileSync(pinHashFile, newHash, "utf8");
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, message: "Settings updated & git push triggered on VM" }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 6. Health check
  if (url.pathname === "/api/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        uptime: process.uptime(),
        sseClients: sseClients.size,
        timestamp: new Date().toISOString(),
      })
    );
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[LHIC Live Server] Running on http://0.0.0.0:${PORT}`);
  console.log(`[LHIC Live Server] SSE stream: /api/stream-logs`);
  console.log(`[LHIC Live Server] REST fallback: /api/live-status, /api/live-logs`);
});
