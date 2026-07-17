import { describe, expect, it } from "vitest";

import { validateDemoModelEndpoint } from "./demo-model-endpoint.js";
import { validatePublicHttpsUrl } from "./interactive-demo.js";

describe("interactive demo URL validation", () => {
  it("accepts public HTTPS URLs and rejects local or credentialed targets", () => {
    expect(validatePublicHttpsUrl("https://example.com/demo").origin).toBe(
      "https://example.com",
    );
    expect(() => validatePublicHttpsUrl("http://example.com")).toThrow(
      "public HTTPS",
    );
    expect(() => validatePublicHttpsUrl("https://localhost:3000")).toThrow(
      "private host",
    );
    expect(() =>
      validatePublicHttpsUrl("https://user:pass@example.com"),
    ).toThrow("credentials");
  });
});

describe("interactive demo model endpoint validation", () => {
  it("accepts provider HTTPS and local loopback endpoints", () => {
    expect(
      validateDemoModelEndpoint(
        "https://models.example.com/v1/responses",
      ).toString(),
    ).toBe("https://models.example.com/v1/responses");
    expect(
      validateDemoModelEndpoint("http://127.0.0.1:11434/v1").toString(),
    ).toBe("http://127.0.0.1:11434/v1");
    expect(validateDemoModelEndpoint("http://[::1]:11434/v1").toString()).toBe(
      "http://[::1]:11434/v1",
    );
  });

  it("rejects credentialed and insecure remote model endpoints", () => {
    expect(() =>
      validateDemoModelEndpoint("https://key@example.com/v1"),
    ).toThrow("cannot contain credentials");
    expect(() =>
      validateDemoModelEndpoint("http://models.example.com/v1"),
    ).toThrow("must use HTTPS");
  });
});
