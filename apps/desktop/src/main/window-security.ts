export interface RendererNavigationPolicy {
  rendererFileUrl: string;
  devServerUrl?: string;
  allowedSearches?: readonly string[];
}

export function isTrustedRendererUrl(
  candidateUrl: string,
  policy: RendererNavigationPolicy,
): boolean {
  let candidate: URL;
  try {
    candidate = new URL(candidateUrl);
  } catch {
    return false;
  }

  const renderer = parseUrl(policy.rendererFileUrl);
  const allowedSearches = new Set([
    renderer?.search ?? "",
    ...(policy.allowedSearches ?? []),
  ]);
  if (
    renderer &&
    candidate.protocol === "file:" &&
    candidate.pathname === renderer.pathname &&
    allowedSearches.has(candidate.search)
  ) {
    return true;
  }

  const devServer = policy.devServerUrl ? parseUrl(policy.devServerUrl) : null;
  return Boolean(
    devServer &&
    candidate.origin === devServer.origin &&
    candidate.pathname === devServer.pathname &&
    allowedSearches.has(candidate.search),
  );
}

export function isAllowedExternalUrl(candidateUrl: string): boolean {
  const candidate = parseUrl(candidateUrl);
  return candidate?.protocol === "https:" || candidate?.protocol === "http:";
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
