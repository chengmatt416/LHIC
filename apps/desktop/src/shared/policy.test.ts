import { describe, expect, it } from "vitest";

import {
  validateCustomGameProfile,
  validateTaskSourceConfig,
} from "./policy.js";

describe("desktop policy boundaries", () => {
  it("accepts only public HTTPS OpenAI-compatible endpoints", () => {
    expect(
      validateTaskSourceConfig({
        id: "custom",
        kind: "openai-compatible",
        label: "Custom provider",
        endpoint: "https://models.example.com/v1/responses",
        protocol: "responses",
        enabled: true,
      }).endpoint,
    ).toBe("https://models.example.com/v1/responses");

    expect(() =>
      validateTaskSourceConfig({
        id: "private",
        kind: "openai-compatible",
        label: "Private provider",
        endpoint: "http://127.0.0.1/v1/responses",
        protocol: "responses",
        enabled: true,
      }),
    ).toThrow("HTTPS");

    expect(() =>
      validateTaskSourceConfig({
        id: "openai-proxy",
        kind: "openai-responses",
        label: "OpenAI Responses",
        endpoint: "http://localhost:3000/v1/responses",
        enabled: true,
      }),
    ).toThrow("HTTPS");
  });

  it("requires an attestation and bounded action map for custom games", () => {
    const profile = {
      id: "local-game",
      title: "Local game",
      surface: "desktop" as const,
      target: "Game window",
      allowedKeys: ["KeyW", "KeyA", "Space"],
      allowPrimaryClick: true,
      attestedSinglePlayer: true,
    };
    expect(validateCustomGameProfile(profile).allowedKeys).toEqual(
      profile.allowedKeys,
    );
    expect(() =>
      validateCustomGameProfile({ ...profile, attestedSinglePlayer: false }),
    ).toThrow("attest");
    expect(() =>
      validateCustomGameProfile({ ...profile, allowedKeys: ["MetaLeft"] }),
    ).toThrow("disallowed");
  });
});
