import { isIP } from "node:net";

import type { GameProfile, TaskSourceConfig } from "./contracts.js";

const allowedGameKeys = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
  "ShiftLeft",
  "ShiftRight",
]);

/** Custom model endpoints may not bypass the production network policy. */
export function validateTaskSourceConfig(
  input: TaskSourceConfig,
): TaskSourceConfig {
  if (
    !input.id.trim() ||
    !input.label.trim() ||
    input.id.length > 96 ||
    input.label.length > 128
  ) {
    throw new Error("Task source id and label are required.");
  }
  if (
    input.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(input.maxOutputTokens) ||
      input.maxOutputTokens < 128 ||
      input.maxOutputTokens > 8_192)
  ) {
    throw new Error(
      "Task source maxOutputTokens must be between 128 and 8192.",
    );
  }
  if (
    input.protocol !== undefined &&
    input.protocol !== "responses" &&
    input.protocol !== "chat-completions"
  ) {
    throw new Error("Task source protocol is unsupported.");
  }
  if (input.credentialId !== undefined && !input.credentialId.trim()) {
    throw new Error("Task source credential id is invalid.");
  }
  if (input.kind === "openai-compatible" && !input.protocol) {
    throw new Error("An OpenAI-compatible source requires an HTTPS endpoint.");
  }
  if (input.kind === "openai-compatible" && !input.endpoint) {
    throw new Error("An OpenAI-compatible source requires an HTTPS endpoint.");
  }
  if (!input.endpoint) return { ...input };
  const endpoint = new URL(input.endpoint);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error(
      "Custom model endpoints must be credential-free HTTPS URLs.",
    );
  }
  if (isPrivateHostname(endpoint.hostname)) {
    throw new Error("Custom model endpoints may not target a private network.");
  }
  return { ...input, endpoint: endpoint.toString() };
}

export function validateCustomGameProfile(input: GameProfile): GameProfile {
  if (!input.id.trim() || !input.title.trim() || !input.target.trim()) {
    throw new Error("Custom games require an id, title, and approved target.");
  }
  if (!input.attestedSinglePlayer) {
    throw new Error(
      "The operator must attest that custom game automation is authorised, single-player, and non-transactional.",
    );
  }
  if (input.allowedKeys.length === 0) {
    throw new Error("Custom games require a non-empty keyboard allowlist.");
  }
  if (input.allowedKeys.some((key) => !allowedGameKeys.has(key))) {
    throw new Error("The custom game action map includes a disallowed key.");
  }
  if (input.captureRegion) {
    const { x, y, width, height } = input.captureRegion;
    if (
      ![x, y, width, height].every(Number.isSafeInteger) ||
      width <= 0 ||
      height <= 0
    ) {
      throw new Error("The custom game capture region is invalid.");
    }
  }
  return { ...input, allowedKeys: [...new Set(input.allowedKeys)] };
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".local")) return true;
  const address = isIP(normalized);
  if (address === 4) {
    return (
      normalized.startsWith("10.") ||
      normalized.startsWith("127.") ||
      normalized.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(normalized)
    );
  }
  return (
    address === 6 &&
    (normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd"))
  );
}
