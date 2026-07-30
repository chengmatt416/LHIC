interface Env {
  LHIC_PIN_HASH: string;
  LHIC_SESSION_SECRET: string;
  LHIC_KV: KVNamespace;
}

const STORED_PIN_HASH_DEFAULT =
  "158a323a7ba44870f23d96f1516dd70aa48e9a72db4ebb026b0a89e212a208ab";

const attempts = new Map<string, { count: number; ts: number }>();

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Pragma": "no-cache",
};

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const ip =
    ctx.request.headers.get("CF-Connecting-IP") ||
    ctx.request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";

  const record = attempts.get(ip);
  const now = Date.now();
  if (record && now - record.ts < 60000 && record.count >= 5) {
    return new Response(
      JSON.stringify({ success: false, error: "Too many attempts. Try again in 60 seconds." }),
      { status: 429, headers: { "Content-Type": "application/json", ...SECURITY_HEADERS } }
    );
  }

  let pinHash: string | undefined;
  try {
    const body = (await ctx.request.json()) as { pinHash?: string };
    pinHash = body.pinHash;
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: "Invalid JSON body." }),
      { status: 400, headers: { "Content-Type": "application/json", ...SECURITY_HEADERS } }
    );
  }

  if (!pinHash || typeof pinHash !== "string" || pinHash.length !== 64) {
    return new Response(
      JSON.stringify({ success: false, error: "Invalid PIN hash format." }),
      { status: 400, headers: { "Content-Type": "application/json", ...SECURITY_HEADERS } }
    );
  }

  // Validate hex format to prevent injection
  if (!/^[0-9a-f]{64}$/.test(pinHash)) {
    return new Response(
      JSON.stringify({ success: false, error: "PIN hash must be lowercase hex." }),
      { status: 400, headers: { "Content-Type": "application/json", ...SECURITY_HEADERS } }
    );
  }

  // Get stored hash: KV first, then env, then default
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

  // Timing-safe comparison
  const a = new TextEncoder().encode(pinHash);
  const b = new TextEncoder().encode(storedHash);
  let match = a.length === b.length;
  if (match) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    match = diff === 0;
  }

  if (!match) {
    const prev = attempts.get(ip);
    if (!prev || now - prev.ts > 60000) {
      attempts.set(ip, { count: 1, ts: now });
    } else {
      prev.count++;
    }
    const remaining = Math.max(0, 5 - (attempts.get(ip)?.count ?? 1));
    return new Response(
      JSON.stringify({ success: false, error: `Invalid PIN. ${remaining} attempt(s) remaining.` }),
      { status: 401, headers: { "Content-Type": "application/json", ...SECURITY_HEADERS } }
    );
  }

  attempts.delete(ip);

  const secret = ctx.env.LHIC_SESSION_SECRET || "lhic-session-secret-32bytes-fill";
  const sessionData = `${ip}:${now}`;

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

  return new Response(
    JSON.stringify({ success: true, token, expiresAt: now + 3600000 }),
    { status: 200, headers: { "Content-Type": "application/json", ...SECURITY_HEADERS } }
  );
};

export const onRequestOptions: PagesFunction = async () => {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "https://lhic-dashboard.pages.dev",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      ...SECURITY_HEADERS,
    },
  });
};
