import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "node:crypto";

const STORED_PIN_HASH =
  process.env.LHIC_PIN_HASH || "158a323a7ba44870f23d96f1516dd70aa48e9a72db4ebb026b0a89e212a208ab";

const attempts = new Map<string, { count: number; ts: number }>();

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  const ip = ((req.headers["x-forwarded-for"] as string) || "unknown").split(",")[0].trim();
  const record = attempts.get(ip);
  const now = Date.now();
  if (record && now - record.ts < 60000 && record.count >= 5) {
    return res.status(429).json({ success: false, error: "Too many attempts. Try again in 60 seconds." });
  }
  const { pinHash } = req.body as { pinHash?: string };
  if (!pinHash || typeof pinHash !== "string" || pinHash.length !== 64) {
    return res.status(400).json({ success: false, error: "Invalid PIN hash format." });
  }
  const match = crypto.timingSafeEqual(Buffer.from(pinHash, "hex"), Buffer.from(STORED_PIN_HASH, "hex"));
  if (!match) {
    const prev = attempts.get(ip);
    if (!prev || now - prev.ts > 60000) {
      attempts.set(ip, { count: 1, ts: now });
    } else {
      prev.count++;
    }
    const remaining = Math.max(0, 5 - (attempts.get(ip)?.count ?? 1));
    return res.status(401).json({ success: false, error: `Invalid PIN. ${remaining} attempt(s) remaining.` });
  }
  attempts.delete(ip);
  const secret = process.env.LHIC_SESSION_SECRET || "lhic-session-secret-32bytes-fill";
  const sessionData = `${ip}:${now}`;
  const token = crypto.createHmac("sha256", secret).update(sessionData).digest("hex");
  res.status(200).json({ success: true, token, expiresAt: now + 3600000 });
}
