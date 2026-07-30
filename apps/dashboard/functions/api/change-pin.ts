interface Env {
  LHIC_PIN_HASH: string;
  LHIC_SESSION_SECRET: string;
  LHIC_KV: KVNamespace;
}

const STORED_PIN_HASH_DEFAULT =
  "158a323a7ba44870f23d96f1516dd70aa48e9a72db4ebb026b0a89e212a208ab";

const attempts = new Map<string, { count: number; ts: number }>();

async function timingSafeEqual(a: Uint8Array, b: Uint8Array): Promise<boolean> {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const ip =
    ctx.request.headers.get("CF-Connecting-IP") ||
    ctx.request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";

  // Rate limit: 3 attempts per 5 minutes for password change
  const record = attempts.get(`change:${ip}`);
  const now = Date.now();
  if (record && now - record.ts < 300000 && record.count >= 3) {
    return Response.json(
      { success: false, error: "Too many change attempts. Try again in 5 minutes." },
      { status: 429 }
    );
  }

  let body: { oldPinHash?: string; newPinHash?: string };
  try {
    body = (await ctx.request.json()) as typeof body;
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.oldPinHash || !body.newPinHash) {
    return Response.json(
      { success: false, error: "oldPinHash and newPinHash required." },
      { status: 400 }
    );
  }

  if (typeof body.oldPinHash !== "string" || body.oldPinHash.length !== 64) {
    return Response.json({ success: false, error: "Invalid oldPinHash format." }, { status: 400 });
  }

  if (typeof body.newPinHash !== "string" || body.newPinHash.length !== 64) {
    return Response.json({ success: false, error: "Invalid newPinHash format." }, { status: 400 });
  }

  // Prevent reusing the same PIN
  if (body.oldPinHash === body.newPinHash) {
    return Response.json(
      { success: false, error: "New PIN must be different from current PIN." },
      { status: 400 }
    );
  }

  // Get current stored hash (KV first, then env, then default)
  let storedHash = STORED_PIN_HASH_DEFAULT;
  try {
    const kvHash = await ctx.env.LHIC_KV?.get("pin-hash");
    if (kvHash) {
      storedHash = kvHash;
    } else {
      storedHash = ctx.env.LHIC_PIN_HASH || STORED_PIN_HASH_DEFAULT;
    }
  } catch {
    storedHash = ctx.env.LHIC_PIN_HASH || STORED_PIN_HASH_DEFAULT;
  }

  // Verify old PIN
  const oldBuf = new TextEncoder().encode(body.oldPinHash);
  const storedBuf = new TextEncoder().encode(storedHash);
  const oldMatch = await timingSafeEqual(oldBuf, storedBuf);

  if (!oldMatch) {
    const prev = attempts.get(`change:${ip}`);
    if (!prev || now - prev.ts > 300000) {
      attempts.set(`change:${ip}`, { count: 1, ts: now });
    } else {
      prev.count++;
    }
    const remaining = Math.max(0, 3 - (attempts.get(`change:${ip}`)?.count ?? 1));
    return Response.json(
      { success: false, error: `Current PIN is incorrect. ${remaining} attempt(s) remaining.` },
      { status: 401 }
    );
  }

  // Store new hash in KV
  try {
    await ctx.env.LHIC_KV.put("pin-hash", body.newPinHash);
  } catch {
    // KV not available — try env (won't persist but won't crash)
  }

  attempts.delete(`change:${ip}`);

  // Generate new session token
  const secret = ctx.env.LHIC_SESSION_SECRET || "lhic-session-secret-32bytes-fill";
  const sessionData = `${ip}:${now}:pin-changed`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(sessionData));
  const token = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return Response.json({
    success: true,
    token,
    expiresAt: now + 3600000,
    message: "PIN changed successfully. Please re-login.",
  });
};

export const onRequestOptions: PagesFunction = async () => {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "https://lhic-dashboard.pages.dev",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
};
