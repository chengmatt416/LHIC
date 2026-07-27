import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const markerSchema = "lhic-correction-replay-v1" as const;

export interface HumanIntentCorrectionReplayReservation {
  approvalId: string;
  nonce: string;
  expiresAt: string;
}

export interface HumanIntentCorrectionReplayDecision {
  allowed: boolean;
  reason: string;
}

export interface HumanIntentCorrectionReplayStore {
  reserve(
    reservation: HumanIntentCorrectionReplayReservation,
  ): HumanIntentCorrectionReplayDecision;
  count(): number;
}

export interface InMemoryCorrectionReplayStoreOptions {
  now?: () => Date;
  maximumReservations?: number;
}

/** Intended for tests and explicitly ephemeral single-process experiments. */
export class InMemoryHumanIntentCorrectionReplayStore implements HumanIntentCorrectionReplayStore {
  private readonly now: () => Date;
  private readonly maximumReservations: number;
  private readonly approvalIds = new Map<string, number>();
  private readonly nonces = new Map<string, number>();

  public constructor(options: InMemoryCorrectionReplayStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.maximumReservations = boundedInteger(
      options.maximumReservations ?? 4_096,
      1,
      100_000,
      "maximumReservations",
    );
  }

  public reserve(
    reservation: HumanIntentCorrectionReplayReservation,
  ): HumanIntentCorrectionReplayDecision {
    const expiresAtMs = validateReservation(reservation, this.now());
    this.prune();
    if (this.approvalIds.has(reservation.approvalId)) {
      return deny("Human Intent correction approval replay was rejected.");
    }
    if (this.nonces.has(reservation.nonce)) {
      return deny(
        "Human Intent correction approval nonce replay was rejected.",
      );
    }
    if (this.approvalIds.size >= this.maximumReservations) {
      return deny(
        "Human Intent correction replay store is full of unexpired approvals.",
      );
    }
    this.approvalIds.set(reservation.approvalId, expiresAtMs);
    this.nonces.set(reservation.nonce, expiresAtMs);
    return allow();
  }

  public count(): number {
    this.prune();
    return this.approvalIds.size;
  }

  private prune(): void {
    const nowMs = this.now().getTime();
    for (const [approvalId, expiresAt] of this.approvalIds) {
      if (expiresAt <= nowMs) this.approvalIds.delete(approvalId);
    }
    for (const [nonce, expiresAt] of this.nonces) {
      if (expiresAt <= nowMs) this.nonces.delete(nonce);
    }
  }
}

export interface FileCorrectionReplayStoreOptions {
  now?: () => Date;
  maximumReservations?: number;
  expiredRetentionMs?: number;
}

/**
 * Cross-process, restart-persistent replay protection. Each approval ID and
 * nonce is atomically reserved with an `wx` marker before LearnLoop mutation.
 * A partial write or malformed marker is preserved to fail closed.
 */
export class FileHumanIntentCorrectionReplayStore implements HumanIntentCorrectionReplayStore {
  private readonly root: string;
  private readonly approvalDirectory: string;
  private readonly nonceDirectory: string;
  private readonly now: () => Date;
  private readonly maximumReservations: number;
  private readonly expiredRetentionMs: number;

  public constructor(
    directory: string,
    options: FileCorrectionReplayStoreOptions = {},
  ) {
    if (!directory.trim()) {
      throw new Error("Correction replay storage directory is required.");
    }
    this.root = resolve(directory);
    this.approvalDirectory = join(this.root, "approvals");
    this.nonceDirectory = join(this.root, "nonces");
    this.now = options.now ?? (() => new Date());
    this.maximumReservations = boundedInteger(
      options.maximumReservations ?? 4_096,
      1,
      100_000,
      "maximumReservations",
    );
    this.expiredRetentionMs = boundedInteger(
      options.expiredRetentionMs ?? 10 * 60_000,
      30_000,
      24 * 60 * 60_000,
      "expiredRetentionMs",
    );
  }

  public reserve(
    reservation: HumanIntentCorrectionReplayReservation,
  ): HumanIntentCorrectionReplayDecision {
    const now = this.now();
    validateReservation(reservation, now);
    try {
      this.prepareDirectories();
      this.pruneExpiredMarkers(this.approvalDirectory, now.getTime());
      this.pruneExpiredMarkers(this.nonceDirectory, now.getTime());
      if (
        this.markerCount(this.approvalDirectory) >= this.maximumReservations
      ) {
        return deny(
          "Human Intent correction replay store is full of unexpired approvals.",
        );
      }
    } catch {
      return deny(
        "Human Intent correction replay protection could not prepare persistent storage.",
      );
    }

    const approvalResult = this.reserveMarker(
      this.approvalDirectory,
      "approval",
      reservation.approvalId,
      reservation.expiresAt,
    );
    if (!approvalResult.allowed) return approvalResult;

    const nonceResult = this.reserveMarker(
      this.nonceDirectory,
      "nonce",
      reservation.nonce,
      reservation.expiresAt,
    );
    if (!nonceResult.allowed) {
      // Preserve the already-created approval marker. A valid signed attempt
      // reached the one-time boundary, so retrying it must fail closed.
      return nonceResult;
    }
    return allow();
  }

  public count(): number {
    try {
      this.prepareDirectories();
      const nowMs = this.now().getTime();
      this.pruneExpiredMarkers(this.approvalDirectory, nowMs);
      this.pruneExpiredMarkers(this.nonceDirectory, nowMs);
      return this.markerCount(this.approvalDirectory);
    } catch {
      throw new Error(
        "Human Intent correction replay protection could not read persistent storage.",
      );
    }
  }

  private prepareDirectories(): void {
    this.prepareDirectory(this.root);
    this.prepareDirectory(this.approvalDirectory);
    this.prepareDirectory(this.nonceDirectory);
  }

  private prepareDirectory(directory: string): void {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Correction replay storage must be a real directory.");
    }
    if (process.platform !== "win32") chmodSync(directory, 0o700);
  }

  private reserveMarker(
    directory: string,
    kind: "approval" | "nonce",
    value: string,
    expiresAt: string,
  ): HumanIntentCorrectionReplayDecision {
    const markerPath = join(directory, `${hashToken(value)}.json`);
    let descriptor: number;
    try {
      descriptor = openSync(markerPath, "wx", 0o600);
    } catch (error) {
      if (hasCode(error, "EEXIST")) {
        return deny(
          kind === "approval"
            ? "Human Intent correction approval replay was rejected."
            : "Human Intent correction approval nonce replay was rejected.",
        );
      }
      return deny(
        "Human Intent correction replay protection could not atomically reserve this approval.",
      );
    }

    try {
      writeFileSync(
        descriptor,
        `${JSON.stringify({ schemaVersion: markerSchema, kind, tokenSha256: hashToken(value), expiresAt })}\n`,
        { encoding: "utf8" },
      );
      if (process.platform !== "win32") chmodSync(markerPath, 0o600);
      return allow();
    } catch {
      return deny(
        "Human Intent correction replay protection could not persist this reservation.",
      );
    } finally {
      closeSync(descriptor);
    }
  }

  private pruneExpiredMarkers(directory: string, nowMs: number): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(directory, entry.name);
      try {
        const marker = JSON.parse(readFileSync(path, "utf8")) as {
          schemaVersion?: unknown;
          expiresAt?: unknown;
        };
        const expiresAt =
          marker.schemaVersion === markerSchema &&
          typeof marker.expiresAt === "string"
            ? Date.parse(marker.expiresAt)
            : Number.NaN;
        if (
          Number.isFinite(expiresAt) &&
          expiresAt + this.expiredRetentionMs <= nowMs
        ) {
          try {
            unlinkSync(path);
          } catch (error) {
            if (!hasCode(error, "ENOENT")) throw error;
          }
        }
      } catch {
        // Preserve malformed markers: deleting them could re-enable a replay.
      }
    }
  }

  private markerCount(directory: string): number {
    return readdirSync(directory, { withFileTypes: true }).filter(
      (entry) => entry.isFile() && entry.name.endsWith(".json"),
    ).length;
  }
}

function validateReservation(
  reservation: HumanIntentCorrectionReplayReservation,
  now: Date,
): number {
  if (!isUuid(reservation.approvalId)) {
    throw new Error("Correction replay reservation approval ID is invalid.");
  }
  if (!/^[a-f0-9]{64}$/.test(reservation.nonce)) {
    throw new Error("Correction replay reservation nonce is invalid.");
  }
  const expiresAtMs = Date.parse(reservation.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) {
    throw new Error("Correction replay reservation is expired.");
  }
  return expiresAtMs;
}

function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function allow(): HumanIntentCorrectionReplayDecision {
  return {
    allowed: true,
    reason: "Human Intent correction approval was reserved for one-time use.",
  };
}

function deny(reason: string): HumanIntentCorrectionReplayDecision {
  return { allowed: false, reason };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return value;
}
