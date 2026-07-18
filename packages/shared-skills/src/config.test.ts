import { describe, expect, it } from "vitest";

import { createSharedSkillsConfig } from "./config.js";

describe("shared Skills configuration", () => {
  it("rejects Appwrite URLs that embed credentials", () => {
    expect(() =>
      createSharedSkillsConfig({
        endpoint: "https://operator:password@appwrite.example.test/v1",
        projectId: "project-1",
        functionUrl: "https://registry.example.test",
      }),
    ).toThrow("credentials");
  });
});
