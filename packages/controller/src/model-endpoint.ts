export function validateCredentialedModelEndpoint(
  value: string,
  label = "model endpoint",
): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`The ${label} must be an absolute URL.`);
  }
  if (endpoint.username || endpoint.password) {
    throw new Error(`The ${label} cannot contain credentials.`);
  }
  if (endpoint.protocol === "https:") return endpoint;
  if (endpoint.protocol === "http:" && isLoopbackHostname(endpoint.hostname)) {
    return endpoint;
  }
  throw new Error(
    `The ${label} must use HTTPS, except for a loopback HTTP endpoint.`,
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.")
  );
}
