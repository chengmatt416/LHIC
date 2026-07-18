import {
  createSharedSkillsConfig,
  type SharedSkillsConfig,
} from "@lhic/shared-skills";

/**
 * Public Appwrite routing only. This is safe to ship in the desktop bundle;
 * API keys, Function variables, OAuth secrets, and user sessions are never
 * represented here.
 */
export const bakedSharedSkillsConfig: SharedSkillsConfig =
  createSharedSkillsConfig({
    endpoint: "https://fra.cloud.appwrite.io/v1",
    projectId: "lhic-shared-skills",
    functionUrl: "https://lhic-shared-registry.fra.appwrite.run",
    enabled: true,
  });
