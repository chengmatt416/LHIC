/**
 * Versioned, machine-readable host capability manifest. Capabilities are
 * never fabricated: an unsupported or undetected backend stays
 * unsupported/unknown.
 */
export interface LhicHostCapabilities {
  schemaVersion: "lhic-host-capabilities-v1";
  browser: {
    available: boolean;
    planVersions: string[];
    verifierTypes: string[];
    approvalMode: string;
  };
  desktop: {
    available: boolean;
    planVersions: string[];
    observe: boolean;
    activeBackend?: string;
    fallbackBackends: string[];
  };
  code: {
    ompRpcVersion?: number;
    verifierAdapters: string[];
  };
}

export function isLhicHostCapabilities(
  value: unknown,
): value is LhicHostCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== "lhic-host-capabilities-v1") return false;
  const browser = manifest.browser as Record<string, unknown> | undefined;
  if (!browser || typeof browser !== "object") return false;
  if (typeof browser.available !== "boolean") return false;
  if (!Array.isArray(browser.planVersions)) return false;
  if (!Array.isArray(browser.verifierTypes)) return false;
  if (typeof browser.approvalMode !== "string") return false;
  const desktop = manifest.desktop as Record<string, unknown> | undefined;
  if (!desktop || typeof desktop !== "object") return false;
  if (typeof desktop.available !== "boolean") return false;
  if (!Array.isArray(desktop.planVersions)) return false;
  if (typeof desktop.observe !== "boolean") return false;
  if (!Array.isArray(desktop.fallbackBackends)) return false;
  if (
    desktop.activeBackend !== undefined &&
    typeof desktop.activeBackend !== "string"
  ) {
    return false;
  }
  const code = manifest.code as Record<string, unknown> | undefined;
  if (!code || typeof code !== "object") return false;
  if (
    code.ompRpcVersion !== undefined &&
    typeof code.ompRpcVersion !== "number"
  ) {
    return false;
  }
  if (!Array.isArray(code.verifierAdapters)) return false;
  return true;
}
