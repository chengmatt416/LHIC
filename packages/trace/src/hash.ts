import { createHash } from "node:crypto";

function stableSerialize(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`).join(",")}}`;
}

export function hashState(input: unknown): string {
  return createHash("sha256").update(stableSerialize(input)).digest("hex");
}
