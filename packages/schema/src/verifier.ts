export const verificationConditionTypes = [
  "dom",
  "url",
  "network",
  "file",
  "screenshot",
  "custom",
] as const;

export type VerificationConditionType =
  (typeof verificationConditionTypes)[number];

export interface VerificationCondition {
  type: VerificationConditionType;
  description: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
}

export interface VerificationResult {
  success: boolean;
  evidence: string[];
  error?: string;
}

export function isVerificationCondition(
  value: unknown,
): value is VerificationCondition {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<VerificationCondition>;
  if (
    typeof candidate.type !== "string" ||
    !(verificationConditionTypes as readonly string[]).includes(
      candidate.type,
    ) ||
    typeof candidate.description !== "string" ||
    candidate.description.trim().length === 0 ||
    candidate.description.length > 512 ||
    !isPlainRecord(candidate.params) ||
    (candidate.timeoutMs !== undefined &&
      (!Number.isSafeInteger(candidate.timeoutMs) ||
        candidate.timeoutMs < 1 ||
        candidate.timeoutMs > 120_000))
  ) {
    return false;
  }

  switch (candidate.type) {
    case "dom":
      return isDomParams(candidate.params);
    case "url":
      return isUrlParams(candidate.params);
    case "network":
      return isNetworkParams(candidate.params);
    case "file":
      return isFileParams(candidate.params);
    case "screenshot":
    case "custom":
      return true;
  }
}

const domStates = new Set(["exists", "visible", "enabled", "disabled"]);

function isDomParams(params: Record<string, unknown>): boolean {
  if (!hasOnlyKeys(params, ["selector", "text", "role", "name", "state"])) {
    return false;
  }
  const hasTarget = ["selector", "text", "role"].some((key) =>
    isNonEmptyString(params[key]),
  );
  return (
    hasTarget &&
    optionalString(params.selector) &&
    optionalString(params.text) &&
    optionalString(params.role) &&
    optionalString(params.name) &&
    (params.state === undefined ||
      (typeof params.state === "string" && domStates.has(params.state)))
  );
}

function isUrlParams(params: Record<string, unknown>): boolean {
  const keys = [
    "contains",
    "equals",
    "notEquals",
    "notContains",
    "hasQueryParam",
  ];
  return (
    hasOnlyKeys(params, keys) &&
    keys.some((key) => isNonEmptyString(params[key])) &&
    keys.every(
      (key) => params[key] === undefined || isNonEmptyString(params[key]),
    )
  );
}

function isNetworkParams(params: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(params, ["requestSucceeded", "noFailedRequests"]) &&
    (params.requestSucceeded === true || params.noFailedRequests === true) &&
    (params.requestSucceeded === undefined ||
      typeof params.requestSucceeded === "boolean") &&
    (params.noFailedRequests === undefined ||
      typeof params.noFailedRequests === "boolean")
  );
}

function isFileParams(params: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(params, ["filePath", "allowedRoot", "extension", "minSize"]) &&
    isNonEmptyString(params.filePath) &&
    isNonEmptyString(params.allowedRoot) &&
    (params.extension === undefined || isNonEmptyString(params.extension)) &&
    (params.minSize === undefined ||
      (typeof params.minSize === "number" &&
        Number.isSafeInteger(params.minSize) &&
        params.minSize >= 0))
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}
