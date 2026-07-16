import { describe, expect, it } from "vitest";

import { HttpAppwriteRegistryClient } from "./appwrite-registry.js";
import type { SharedSkillsConfig } from "./config.js";

const config: SharedSkillsConfig = {
  enabled: true,
  endpoint: "https://cloud.appwrite.test/v1",
  projectId: "project",
  functionUrl: "https://registry.test",
  registryId: "project:https://registry.test",
};

describe("Appwrite registry client", () => {
  it("exchanges a completed Magic URL device pair for a session cookie", async () => {
    const requests: string[] = [];
    const client = new HttpAppwriteRegistryClient(config, {
      pollIntervalMs: 1,
      loginTimeoutMs: 100,
      fetchImplementation: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.includes("tokens/magic-url")) {
          return new Response("{}", { status: 201 });
        }
        if (url.includes("/auth/poll")) {
          return new Response(
            JSON.stringify({
              status: "complete",
              userId: "user",
              secret: "secret",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", {
          status: 201,
          headers: {
            "set-cookie": "a_session_project=session-value; HttpOnly",
          },
        });
      },
    });

    await expect(client.login("user@example.test")).resolves.toBe(
      "a_session_project=session-value",
    );
    expect(requests).toHaveLength(3);
  });

  it("forwards the Appwrite user JWT to the public Function domain", async () => {
    let functionHeaders: Headers | undefined;
    const client = new HttpAppwriteRegistryClient(config, {
      fetchImplementation: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/account/jwt")) {
          return new Response(JSON.stringify({ jwt: "user-jwt" }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        functionHeaders = new Headers(init?.headers);
        return new Response("{}", { status: 202 });
      },
    });

    await client.submit({ schemaVersion: "shared-skill-v1" }, "session=value");
    expect(functionHeaders?.get("X-Appwrite-User-JWT")).toBe("user-jwt");
    expect(functionHeaders?.get("X-Appwrite-JWT")).toBeNull();
  });
});
