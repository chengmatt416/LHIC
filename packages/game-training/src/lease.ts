import { createHash, randomUUID } from "node:crypto";

import { hashState } from "@lhic/trace";

import type {
  GameCaptureRegion,
  GameControlProfile,
  GameCoreId,
} from "./types.js";

export interface GameControlLeaseRequest {
  core: GameCoreId;
  profileId: string;
  windowTitle: string;
  captureRegion: GameCaptureRegion;
  control: GameControlProfile;
}

export interface GameControlLease extends GameControlLeaseRequest {
  schemaVersion: "game-control-lease-v1";
  leaseId: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  requestHash: string;
}

export function createGameControlLease(
  request: GameControlLeaseRequest,
  approvedBy: string,
  options: { now?: Date; expiresInMs?: number } = {},
): GameControlLease {
  assertLeaseRequest(request);
  if (!approvedBy.trim()) {
    throw new Error("Game control leases require an approver identifier.");
  }
  const now = options.now ?? new Date();
  const expiresInMs = options.expiresInMs ?? 5 * 60_000;
  if (
    !Number.isSafeInteger(expiresInMs) ||
    expiresInMs < 1 ||
    expiresInMs > 5 * 60_000
  ) {
    throw new Error(
      "Game control leases may last from 1ms through five minutes.",
    );
  }
  return {
    schemaVersion: "game-control-lease-v1",
    ...request,
    leaseId: randomUUID(),
    approvedBy: approvedBy.trim(),
    approvedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + expiresInMs).toISOString(),
    requestHash: hashGameControlLeaseRequest(request),
  };
}

export function validateGameControlLease(
  lease: GameControlLease | undefined,
  request: GameControlLeaseRequest,
  now = new Date(),
): { valid: boolean; reason: string } {
  if (!lease)
    return {
      valid: false,
      reason: "A desktop game-control lease is required.",
    };
  if (lease.schemaVersion !== "game-control-lease-v1") {
    return {
      valid: false,
      reason: "Game-control lease schema is unsupported.",
    };
  }
  if (lease.requestHash !== hashGameControlLeaseRequest(request)) {
    return {
      valid: false,
      reason: "Game-control lease does not match this session.",
    };
  }
  const expiry = Date.parse(lease.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) {
    return { valid: false, reason: "Game-control lease has expired." };
  }
  return {
    valid: true,
    reason: "Game-control lease matches the active session.",
  };
}

export function hashGameControlLeaseRequest(
  request: GameControlLeaseRequest,
): string {
  return createHash("sha256").update(hashState(request)).digest("hex");
}

function assertLeaseRequest(request: GameControlLeaseRequest): void {
  if (!request.profileId.trim() || !request.windowTitle.trim()) {
    throw new Error("Game-control leases require a profile and window title.");
  }
  const region = request.captureRegion;
  if (
    ![region.x, region.y, region.width, region.height].every(Number.isFinite) ||
    region.x < 0 ||
    region.y < 0 ||
    region.width < 1 ||
    region.height < 1
  ) {
    throw new Error(
      "Game-control lease capture regions must be finite and positive.",
    );
  }
}
