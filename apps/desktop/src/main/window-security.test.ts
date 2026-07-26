import { describe, expect, it } from "vitest";

import {
  isAllowedExternalUrl,
  isTrustedRendererUrl,
} from "./window-security.js";

const policy = {
  rendererFileUrl:
    "file:///Applications/LHIC%20Control%20Center/resources/app/dist/renderer/index.html",
  devServerUrl: "http://127.0.0.1:4173/",
  allowedSearches: ["", "?demo=1"],
};

describe("desktop renderer navigation policy", () => {
  it("allows only the packaged renderer file or the exact dev server route", () => {
    expect(isTrustedRendererUrl(policy.rendererFileUrl, policy)).toBe(true);
    expect(isTrustedRendererUrl(`${policy.rendererFileUrl}#task`, policy)).toBe(
      true,
    );
    expect(
      isTrustedRendererUrl(`${policy.rendererFileUrl}?demo=1`, policy),
    ).toBe(true);
    expect(
      isTrustedRendererUrl("http://127.0.0.1:4173/?demo=1", policy),
    ).toBe(true);
    expect(
      isTrustedRendererUrl(`${policy.rendererFileUrl}?demo=2`, policy),
    ).toBe(false);
    expect(
      isTrustedRendererUrl(`${policy.rendererFileUrl}?demo=1&admin=1`, policy),
    ).toBe(false);
    expect(isTrustedRendererUrl("file:///tmp/evil.html", policy)).toBe(false);
    expect(isTrustedRendererUrl("http://127.0.0.1:4174/", policy)).toBe(false);
    expect(isTrustedRendererUrl("http://localhost:4173/", policy)).toBe(false);
    expect(isTrustedRendererUrl("https://example.com/", policy)).toBe(false);
  });
});

describe("external navigation policy", () => {
  it("only permits HTTP(S) links to be handed to the OS browser", () => {
    expect(isAllowedExternalUrl("https://example.com/docs")).toBe(true);
    expect(isAllowedExternalUrl("http://example.com/docs")).toBe(true);
    expect(isAllowedExternalUrl("file:///tmp/secret.txt")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
  });
});
