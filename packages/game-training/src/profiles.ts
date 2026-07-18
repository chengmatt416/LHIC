import { createHash } from "node:crypto";

import type { GameTargetProfile } from "./types.js";

export const gameTargetProfiles: readonly GameTargetProfile[] = [
  {
    id: "star-trooper",
    core: "2d",
    title: "Star Trooper",
    sourceRepository: "https://github.com/idgm5/shootergame",
    supportedSurfaces: ["browser", "desktop"],
    viewport: { width: 480, height: 640 },
    control: {
      allowedKeys: ["KeyW", "KeyA", "KeyS", "KeyD", "Space"],
      allowPrimaryClick: false,
      aimMode: "none",
    },
    telemetry: {
      scoreStorageKey: "currentScore",
      startSelectors: ["#play", "#button"],
    },
    frameRate: 20,
    targetOrigin: { kind: "local", supportsInjectedSeed: true },
  },
  {
    id: "nemesis",
    core: "3d",
    title: "Nemesis",
    sourceRepository: "https://github.com/IceCreamYou/Nemesis",
    supportedSurfaces: ["browser", "desktop"],
    viewport: { width: 1024, height: 768 },
    control: {
      allowedKeys: ["KeyW", "KeyA", "KeyS", "KeyD"],
      allowPrimaryClick: true,
      aimMode: "relative",
      maxPointerDelta: 48,
    },
    telemetry: {
      scoreSelector: "#score",
      healthSelector: "#health",
      startSelector: "#intro",
      restartSelector: "#intro",
    },
    frameRate: 20,
    targetOrigin: { kind: "local", supportsInjectedSeed: true },
  },
  {
    id: "epic-shooter-3d",
    core: "3d",
    title: "Epic Shooter 3D (single-player)",
    sourceRepository: "https://www.epicshooter3d.com/",
    supportedSurfaces: ["browser", "desktop"],
    viewport: { width: 1024, height: 768 },
    control: {
      allowedKeys: ["KeyW", "KeyA", "KeyS", "KeyD"],
      allowPrimaryClick: true,
      aimMode: "relative",
      maxPointerDelta: 48,
    },
    telemetry: {
      scoreSelector: "#score-value",
      healthSelector: "#health-value",
      startSelectors: ["#btn-map-house", "#btn-easy"],
      readySelector: "#btn-pause",
    },
    startInput: { selector: "#player-name", value: "LHIC" },
    targetOrigin: {
      kind: "remote",
      url: "https://www.epicshooter3d.com/",
      allowedOrigins: ["https://www.epicshooter3d.com"],
      supportsInjectedSeed: false,
    },
    frameRate: 12,
    requiresPointerLock: true,
  },
] as const;

export function getGameTargetProfile(id: string): GameTargetProfile {
  const profile = gameTargetProfiles.find((candidate) => candidate.id === id);
  if (!profile) {
    throw new Error(
      `Unknown game target ${id}. Available targets: ${gameTargetProfiles.map((candidate) => candidate.id).join(", ")}.`,
    );
  }
  return profile;
}

export function gameTargetProfileDigest(profile: GameTargetProfile): string {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex");
}

/** Injected before the target loads; it does not alter the upstream checkout. */
export function createSeededRandomInitScript(seed: number): string {
  if (!Number.isSafeInteger(seed)) {
    throw new Error("Game seeds must be safe integers.");
  }
  return `(() => {
    let state = ${seed >>> 0};
    Math.random = () => {
      state = (state + 0x6d2b79f5) | 0;
      let value = Math.imul(state ^ (state >>> 15), 1 | state);
      value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  })();`;
}

export function assertLoopbackTargetUrl(value: string): URL {
  const parsed = new URL(value);
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !loopbackHosts.has(parsed.hostname)
  ) {
    throw new Error("Game targets must run on a local loopback HTTP origin.");
  }
  return parsed;
}
