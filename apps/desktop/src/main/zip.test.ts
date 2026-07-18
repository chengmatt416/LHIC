import { describe, expect, it } from "vitest";

import { createZip } from "./zip.js";

describe("createZip", () => {
  it("writes a ZIP local header, central directory, and end record", () => {
    const zip = createZip([
      { name: "manifest.json", content: Buffer.from("{}") },
    ]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.includes(Buffer.from("manifest.json"))).toBe(true);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
  });
});
