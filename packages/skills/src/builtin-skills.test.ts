import { describe, expect, it } from "vitest";

import { builtinSkillDefinitions } from "./builtin-skills.js";

describe("builtinSkillDefinitions", () => {
  it("registers each shipped browser skill exactly once", () => {
    expect(builtinSkillDefinitions.map((skill) => skill.name)).toEqual([
      "download_file",
      "fill_form",
      "login",
      "search",
      "test_web_flow",
    ]);
  });
});
