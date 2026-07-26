import { createPublicKey, type KeyObject } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  FileHumanIntentCorrectionReplayStore,
  TrustedHumanIntentCorrectionIngestion,
} from "@lhic/controller";

import { DesktopHumanIntentAdmission } from "./prediction-first-browser-admission.js";

const maximumCorrectionPublicKeyBytes = 64 * 1_024;

export type DesktopCorrectionEnvironment = Record<string, string | undefined>;

export interface DesktopHumanIntentCorrectionRuntime {
  admission: DesktopHumanIntentAdmission;
  configured: boolean;
  message: string;
  replayDirectory?: string;
}

/**
 * Creates the Desktop correction boundary. The private signing key never
 * enters LHIC. Without an explicit Ed25519 public key, correction ingestion
 * remains disabled and DesktopHumanIntentAdmission fails closed.
 */
export function createDesktopHumanIntentCorrectionRuntime(
  workspaceRoot: string,
  environment: DesktopCorrectionEnvironment = process.env,
): DesktopHumanIntentCorrectionRuntime {
  if (!workspaceRoot.trim()) {
    throw new Error("Desktop correction runtime requires a workspace root.");
  }
  const publicKeyText = readCorrectionApprovalPublicKey(environment);
  if (!publicKeyText) {
    return {
      admission: new DesktopHumanIntentAdmission(),
      configured: false,
      message:
        "Human Intent correction ingestion is disabled because no correction approval public key is configured.",
    };
  }
  const publicKey = parseEd25519PublicKey(publicKeyText);
  const replayDirectory = resolveCorrectionReplayDirectory(
    workspaceRoot,
    environment,
  );
  const replayStore = new FileHumanIntentCorrectionReplayStore(replayDirectory);
  const correctionIngestion = new TrustedHumanIntentCorrectionIngestion({
    publicKey,
    replayStore,
  });
  return {
    admission: new DesktopHumanIntentAdmission({ correctionIngestion }),
    configured: true,
    message:
      "Human Intent correction ingestion is enabled with external Ed25519 approval and persistent replay protection.",
    replayDirectory,
  };
}

function readCorrectionApprovalPublicKey(
  environment: DesktopCorrectionEnvironment,
): string | undefined {
  const inlineValue = environment.LHIC_CORRECTION_APPROVAL_PUBLIC_KEY?.trim();
  const filePath = environment.LHIC_CORRECTION_APPROVAL_PUBLIC_KEY_FILE?.trim();
  if (inlineValue && filePath) {
    throw new Error(
      "Configure only one of LHIC_CORRECTION_APPROVAL_PUBLIC_KEY or LHIC_CORRECTION_APPROVAL_PUBLIC_KEY_FILE.",
    );
  }
  if (inlineValue) {
    assertBoundedPublicKey(inlineValue);
    return inlineValue;
  }
  if (!filePath) return undefined;
  let metadata;
  try {
    metadata = lstatSync(filePath);
  } catch {
    throw new Error(
      "LHIC_CORRECTION_APPROVAL_PUBLIC_KEY_FILE must point to a readable Ed25519 public-key file.",
    );
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > maximumCorrectionPublicKeyBytes
  ) {
    throw new Error(
      "LHIC_CORRECTION_APPROVAL_PUBLIC_KEY_FILE must be a bounded regular file, not a symlink.",
    );
  }
  let value: string;
  try {
    value = readFileSync(filePath, "utf8").trim();
  } catch {
    throw new Error(
      "LHIC_CORRECTION_APPROVAL_PUBLIC_KEY_FILE could not be read.",
    );
  }
  assertBoundedPublicKey(value);
  return value;
}

function assertBoundedPublicKey(value: string): void {
  if (
    !value.trim() ||
    Buffer.byteLength(value, "utf8") > maximumCorrectionPublicKeyBytes
  ) {
    throw new Error(
      "Human Intent correction approval public key is empty or too large.",
    );
  }
}

function parseEd25519PublicKey(value: string): KeyObject {
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("not Ed25519");
    }
    return key;
  } catch {
    throw new Error(
      "LHIC_CORRECTION_APPROVAL_PUBLIC_KEY must be a valid Ed25519 public key.",
    );
  }
}

function resolveCorrectionReplayDirectory(
  workspaceRoot: string,
  environment: DesktopCorrectionEnvironment,
): string {
  const explicit = environment.LHIC_CORRECTION_REPLAY_DIRECTORY?.trim();
  if (explicit && !isAbsolute(explicit)) {
    throw new Error(
      "LHIC_CORRECTION_REPLAY_DIRECTORY must be an absolute path.",
    );
  }
  return resolve(explicit ?? join(workspaceRoot, ".lhic", "correction-replay"));
}
