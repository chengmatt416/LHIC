import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";

export type RuntimeEnvironment = "development" | "test" | "production";

export interface ProductionRuntimeConfig {
  environment: RuntimeEnvironment;
  allowedOrigins: string[];
  allowPrivateNetwork: boolean;
  actionTimeoutMs: number;
  maxWaitMs: number;
  traceDirectory: string;
  approvalPublicKey?: string;
}

export type EnvironmentSource = Record<string, string | undefined>;

export function parseRuntimeConfig(
  environment: EnvironmentSource = process.env,
): ProductionRuntimeConfig {
  const runtimeEnvironment = parseEnvironment(environment.LHIC_ENV);
  const allowedOrigins = parseOrigins(environment.LHIC_ALLOWED_ORIGINS);
  const approvalPublicKey = parseApprovalPublicKey(
    readApprovalPublicKey(environment),
  );
  const allowPrivateNetwork = environment.LHIC_ALLOW_PRIVATE_NETWORK === "true";
  if (runtimeEnvironment === "production" && allowedOrigins.length === 0) {
    throw new Error("LHIC_ALLOWED_ORIGINS is required in production.");
  }
  if (runtimeEnvironment === "production" && !approvalPublicKey) {
    throw new Error(
      "LHIC_APPROVAL_PUBLIC_KEY or LHIC_APPROVAL_PUBLIC_KEY_FILE is required in production.",
    );
  }
  if (runtimeEnvironment === "production" && allowPrivateNetwork) {
    throw new Error(
      "LHIC_ALLOW_PRIVATE_NETWORK cannot be enabled in production.",
    );
  }

  return {
    environment: runtimeEnvironment,
    allowedOrigins,
    allowPrivateNetwork,
    actionTimeoutMs: parsePositiveInteger(
      environment.LHIC_ACTION_TIMEOUT_MS,
      10_000,
      "LHIC_ACTION_TIMEOUT_MS",
    ),
    maxWaitMs: parsePositiveInteger(
      environment.LHIC_MAX_WAIT_MS,
      30_000,
      "LHIC_MAX_WAIT_MS",
    ),
    traceDirectory: environment.LHIC_TRACE_DIRECTORY ?? "traces",
    ...(approvalPublicKey ? { approvalPublicKey } : {}),
  };
}

function readApprovalPublicKey(
  environment: EnvironmentSource,
): string | undefined {
  const inlineValue = environment.LHIC_APPROVAL_PUBLIC_KEY?.trim();
  const filePath = environment.LHIC_APPROVAL_PUBLIC_KEY_FILE?.trim();
  if (inlineValue && filePath) {
    throw new Error(
      "Configure only one of LHIC_APPROVAL_PUBLIC_KEY or LHIC_APPROVAL_PUBLIC_KEY_FILE.",
    );
  }
  if (inlineValue) {
    return inlineValue;
  }
  if (!filePath) {
    return undefined;
  }
  try {
    return readFileSync(filePath, "utf8").trim();
  } catch {
    throw new Error(
      "LHIC_APPROVAL_PUBLIC_KEY_FILE must point to a readable Ed25519 public key.",
    );
  }
}

function parseApprovalPublicKey(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("not an Ed25519 key");
    }
  } catch {
    throw new Error(
      "LHIC_APPROVAL_PUBLIC_KEY must be a valid Ed25519 public key.",
    );
  }
  return value;
}

function parseEnvironment(value: string | undefined): RuntimeEnvironment {
  if (!value || value === "development") {
    return "development";
  }
  if (value === "test" || value === "production") {
    return value;
  }
  throw new Error("LHIC_ENV must be development, test, or production.");
}

function parseOrigins(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }
  return value.split(",").map((rawOrigin) => {
    const origin = new URL(rawOrigin.trim());
    if (origin.protocol !== "https:" || origin.origin !== rawOrigin.trim()) {
      throw new Error(
        "LHIC_ALLOWED_ORIGINS must contain HTTPS origins without paths.",
      );
    }
    return origin.origin;
  });
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 120_000) {
    throw new Error(`${name} must be an integer between 1 and 120000.`);
  }
  return parsed;
}
