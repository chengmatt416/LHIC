import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileHumanIntentCorrectionReplayStore,
  InMemoryHumanIntentCorrectionReplayStore,
  type HumanIntentCorrectionReplayReservation,
} from "./correction-replay-store.js";

const now = new Date("2026-07-27T00:00:00.000Z");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Human Intent correction replay stores", () => {
  it("persists approval and nonce reservations across process instances", () => {
    const directory = temporaryDirectory();
    const reservation = correctionReservation(
      "00000000-0000-4000-8000-000000000001",
      "a".repeat(64),
    );
    const first = new FileHumanIntentCorrectionReplayStore(directory, {
      now: () => now,
    });
    expect(first.reserve(reservation)).toMatchObject({ allowed: true });

    const restarted = new FileHumanIntentCorrectionReplayStore(directory, {
      now: () => now,
    });
    expect(restarted.reserve(reservation)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("approval replay"),
    });
    expect(restarted.count()).toBe(1);
  });

  it("rejects the same nonce under a different signed approval ID", () => {
    const directory = temporaryDirectory();
    const store = new FileHumanIntentCorrectionReplayStore(directory, {
      now: () => now,
    });
    expect(
      store.reserve(
        correctionReservation(
          "00000000-0000-4000-8000-000000000002",
          "b".repeat(64),
        ),
      ).allowed,
    ).toBe(true);
    expect(
      store.reserve(
        correctionReservation(
          "00000000-0000-4000-8000-000000000003",
          "b".repeat(64),
        ),
      ),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("nonce replay"),
    });
    // The second approval ID remains consumed after reaching the atomic
    // reservation boundary, even though its nonce was already used.
    expect(store.count()).toBe(2);
  });

  it("stores only hashes and expiry metadata, never raw approval tokens", () => {
    const directory = temporaryDirectory();
    const reservation = correctionReservation(
      "00000000-0000-4000-8000-000000000004",
      "c".repeat(64),
    );
    const store = new FileHumanIntentCorrectionReplayStore(directory, {
      now: () => now,
    });
    expect(store.reserve(reservation).allowed).toBe(true);

    const serialized = ["approvals", "nonces"]
      .flatMap((kind) => {
        const child = join(directory, kind);
        return readdirSync(child).map((entry) =>
          readFileSync(join(child, entry), "utf8"),
        );
      })
      .join("\n");
    expect(serialized).not.toContain(reservation.approvalId);
    expect(serialized).not.toContain(reservation.nonce);
    expect(serialized).toContain("lhic-correction-replay-v1");
  });

  it("fails closed when persistent storage cannot be prepared", () => {
    const parent = temporaryDirectory();
    const unavailable = join(parent, "not-a-directory");
    writeFileSync(unavailable, "occupied", "utf8");
    const store = new FileHumanIntentCorrectionReplayStore(unavailable, {
      now: () => now,
    });
    expect(
      store.reserve(
        correctionReservation(
          "00000000-0000-4000-8000-000000000005",
          "d".repeat(64),
        ),
      ),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("persistent storage"),
    });
  });

  it("keeps the in-memory store explicitly bounded for tests", () => {
    const store = new InMemoryHumanIntentCorrectionReplayStore({
      now: () => now,
      maximumReservations: 1,
    });
    expect(
      store.reserve(
        correctionReservation(
          "00000000-0000-4000-8000-000000000006",
          "e".repeat(64),
        ),
      ).allowed,
    ).toBe(true);
    expect(
      store.reserve(
        correctionReservation(
          "00000000-0000-4000-8000-000000000007",
          "f".repeat(64),
        ),
      ),
    ).toMatchObject({ allowed: false, reason: expect.stringContaining("full") });
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "lhic-correction-replay-"));
  temporaryDirectories.push(directory);
  return directory;
}

function correctionReservation(
  approvalId: string,
  nonce: string,
): HumanIntentCorrectionReplayReservation {
  return {
    approvalId,
    nonce,
    expiresAt: "2026-07-27T00:05:00.000Z",
  };
}
