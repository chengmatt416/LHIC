export interface BuiltinSkillDefinition {
  name: string;
  definition: Record<string, unknown>;
}

export const builtinSkillDefinitions: readonly BuiltinSkillDefinition[] = [
  {
    name: "download_file",
    definition: {
      source: "builtin",
      description: "Download a requested file and verify it exists.",
      supportedActions: ["download"],
      requiresApproval: true,
    },
  },
  {
    name: "fill_form",
    definition: {
      source: "builtin",
      description: "Fill named form fields using semantic locators.",
      supportedActions: ["fill", "select", "press"],
    },
  },
  {
    name: "login",
    definition: {
      source: "builtin",
      description: "Complete a login flow without storing credentials.",
      supportedActions: ["fill", "click", "press"],
    },
  },
  {
    name: "search",
    definition: {
      source: "builtin",
      description: "Submit a query and verify that search results are visible.",
      supportedActions: ["fill", "press"],
    },
  },
  {
    name: "test_web_flow",
    definition: {
      source: "builtin",
      description: "Run a bounded web-flow test with verifier evidence.",
      supportedActions: ["navigate", "click", "fill", "press", "wait"],
    },
  },
  {
    name: "global_computer",
    definition: {
      source: "builtin",
      description:
        "Execute an approved native macOS, Windows, or Linux desktop action and verify a window or process state.",
      supportedActions: [
        "os_click",
        "os_type",
        "os_press",
        "os_launch",
        "os_focus",
      ],
      requiresApproval: true,
    },
  },
];
