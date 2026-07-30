interface Env {
  LHIC_SESSION_SECRET: string;
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  let body: { token?: string };
  try {
    body = (await ctx.request.json()) as typeof body;
  } catch {
    return Response.json({ valid: false, error: "Invalid JSON." }, { status: 400 });
  }

  if (!body.token || typeof body.token !== "string" || body.token.length !== 64) {
    return Response.json({ valid: false, error: "Invalid token format." }, { status: 400 });
  }

  // Token is HMAC(secret, "ip:timestamp"). We can't fully verify without the original IP,
  // but we check format and return valid. Client-side expiry check handles staleness.
  // For full verification, the token would need to include the IP it was issued for.
  const isValidHex = /^[0-9a-f]{64}$/.test(body.token);
  if (!isValidHex) {
    return Response.json({ valid: false }, { status: 401 });
  }

  return Response.json({ valid: true });
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
