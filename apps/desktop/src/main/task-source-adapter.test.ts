import { writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { TaskSourceConfig } from "../shared/contracts.js";
import { TaskSourceAdapter } from "./task-source-adapter.js";

const plan = {
  schemaVersion: "browser-plan-v1",
  goal: "Open the public documentation page",
  skillName: null,
  requiredVariables: [],
  steps: [
    {
      id: "open-docs",
      action: {
        scope: "browser",
        type: "navigate",
        intent: "Open the public documentation page",
        target: "https://docs.example.test/",
        value: null,
        methodPreference: ["api"],
        riskLevel: "low",
      },
      verification: {
        type: "url",
        description: "The documentation page is open",
        params: { equals: "https://docs.example.test/" },
        timeoutMs: null,
      },
    },
  ],
};

const desktopPlan = {
  schemaVersion: "desktop-plan-v1",
  goal: "Open the local notes app",
  skillName: null,
  requiredVariables: [],
  steps: [
    {
      id: "launch-notes",
      action: {
        scope: "os",
        type: "os_launch",
        intent: "Launch the Notes application",
        target: null,
        methodPreference: ["accessibility"],
        riskLevel: "medium",
        x: null,
        y: null,
        text: null,
        key: null,
        application: "Notes",
        verifier: {
          type: "process_running",
          application: "Notes",
          title: null,
        },
      },
    },
  ],
};

describe("TaskSourceAdapter", () => {
  it.each([
    [
      "openai-responses",
      { output: [{ content: [{ text: JSON.stringify(plan) }] }] },
    ],
    ["gemini", { output_text: JSON.stringify(plan) }],
    [
      "anthropic-messages",
      { content: [{ type: "text", text: JSON.stringify(plan) }] },
    ],
    [
      "openai-compatible",
      { choices: [{ message: { content: JSON.stringify(plan) } }] },
    ],
  ] as const)(
    "validates structured %s API proposals before returning a plan",
    async (kind, responseBody) => {
      const requests: Array<{ url: string; body: unknown }> = [];
      const adapter = new TaskSourceAdapter({
        credentialFor: async () => "key-only-in-test",
        fetchImplementation: async (input, init) => {
          requests.push({
            url: String(input),
            body: JSON.parse(String(init?.body)) as unknown,
          });
          return new Response(JSON.stringify(responseBody), { status: 200 });
        },
      });
      const source: TaskSourceConfig = {
        id: kind,
        kind,
        label: kind,
        model: "test-model",
        ...(kind === "openai-compatible"
          ? {
              endpoint: "https://compatible.example.test/v1/chat/completions",
              protocol: "chat-completions" as const,
            }
          : {}),
        enabled: true,
      };

      const result = await adapter.propose(source, plan.goal, process.cwd());

      expect(result).toMatchObject({
        schemaVersion: "browser-plan-v1",
        steps: [expect.objectContaining({ id: "open-docs" })],
      });
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0]?.body)).not.toContain(
        "key-only-in-test",
      );
      const serializedRequest = JSON.stringify(requests[0]?.body);
      expect(
        serializedRequest.match(/Return only one browser-plan-v1/g),
      ).toHaveLength(1);
      if (kind === "anthropic-messages") {
        expect(requests[0]?.body).toMatchObject({
          system: expect.stringContaining("Return only one browser-plan-v1"),
          messages: [
            {
              role: "user",
              content: expect.stringMatching(/^Task: /),
            },
          ],
        });
      }
    },
  );

  it.each(["openai-responses", "anthropic-messages"] as const)(
    "assembles multipart %s text without truncating the structured plan",
    async (kind) => {
      const serializedPlan = JSON.stringify(plan);
      const splitAt = Math.floor(serializedPlan.length / 2);
      const parts = [
        { type: "text", text: serializedPlan.slice(0, splitAt) },
        { type: "text", text: serializedPlan.slice(splitAt) },
      ];
      const responseBody =
        kind === "anthropic-messages"
          ? { content: parts }
          : { output: [{ content: [parts[0]] }, { content: [parts[1]] }] };
      const adapter = new TaskSourceAdapter({
        credentialFor: async () => "key-only-in-test",
        fetchImplementation: async () =>
          new Response(JSON.stringify(responseBody), { status: 200 }),
      });

      await expect(
        adapter.propose(
          {
            id: kind,
            kind,
            label: kind,
            model: "test-model",
            enabled: true,
          },
          plan.goal,
          process.cwd(),
        ),
      ).resolves.toMatchObject({
        schemaVersion: "browser-plan-v1",
        steps: [expect.objectContaining({ id: "open-docs" })],
      });
    },
  );

  it("keeps CLI sources in planning mode and validates their output", async () => {
    const invocations: string[][] = [];
    const adapter = new TaskSourceAdapter({
      credentialFor: async () => undefined,
      runProcess: async (_executable, argumentsList) => {
        invocations.push([...argumentsList]);
        if (argumentsList[0] === "exec") {
          const output =
            argumentsList[argumentsList.indexOf("--output-last-message") + 1];
          await writeFile(output!, JSON.stringify(plan), "utf8");
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (
          argumentsList[0] === "--print" &&
          argumentsList.includes("--output-format")
        ) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ result: JSON.stringify(plan) }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: JSON.stringify(plan), stderr: "" };
      },
    });

    for (const kind of [
      "codex-cli",
      "antigravity-cli",
      "claude-code-cli",
    ] as const) {
      await expect(
        adapter.propose(
          { id: kind, kind, label: kind, model: "test-model", enabled: true },
          plan.goal,
          process.cwd(),
        ),
      ).resolves.toMatchObject({ schemaVersion: "browser-plan-v1" });
    }

    expect(invocations[0]).toEqual(
      expect.arrayContaining(["--sandbox", "read-only", "--ephemeral"]),
    );
    expect(invocations[1]).toEqual(expect.arrayContaining(["--mode", "plan"]));
    expect(invocations[2]).toEqual(
      expect.arrayContaining(["--permission-mode", "plan", "--json-schema"]),
    );
  });

  it("normalizes nullable verifier fields in a desktop step decision", async () => {
    const decision = {
      status: "action",
      reason: "The observed submit control is ready.",
      action: {
        scope: "os",
        type: "os_click",
        intent: "Click the observed submit control",
        target: null,
        methodPreference: ["mouse"],
        riskLevel: "medium",
        x: 20,
        y: 30,
        text: null,
        key: null,
        application: null,
        scrollDirection: null,
        scrollAmount: null,
        verifier: {
          type: "active_window",
          application: "Editor",
          title: null,
        },
      },
    };
    const adapter = new TaskSourceAdapter({
      credentialFor: async () => "key-only-in-test",
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({ output_text: JSON.stringify(decision) }),
          { status: 200 },
        ),
    });

    await expect(
      adapter.proposeDesktopStep(
        {
          id: "gemini",
          kind: "gemini",
          label: "Gemini",
          model: "test-model",
          enabled: true,
        },
        "Click Submit",
        { accessibilityTree: "window Editor\n  button Submit" },
        process.cwd(),
      ),
    ).resolves.toEqual({
      status: "action",
      reason: decision.reason,
      action: {
        scope: "os",
        type: "os_click",
        intent: "Click the observed submit control",
        methodPreference: ["mouse"],
        riskLevel: "medium",
        x: 20,
        y: 30,
        verifier: { type: "active_window", application: "Editor" },
      },
    });
  });

  it("rejects a schema-invalid provider result", async () => {
    const adapter = new TaskSourceAdapter({
      credentialFor: async () => "key-only-in-test",
      fetchImplementation: async () =>
        new Response(JSON.stringify({ output_text: '{"not":"a plan"}' }), {
          status: 200,
        }),
    });

    await expect(
      adapter.propose(
        {
          id: "gemini",
          kind: "gemini",
          label: "Gemini",
          model: "test-model",
          enabled: true,
        },
        plan.goal,
        process.cwd(),
      ),
    ).rejects.toThrow("browser-plan-v1");
  });

  it("accepts a guarded desktop plan without giving the provider an OS handle", async () => {
    const adapter = new TaskSourceAdapter({
      credentialFor: async () => "key-only-in-test",
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({ output_text: JSON.stringify(desktopPlan) }),
          { status: 200 },
        ),
    });

    await expect(
      adapter.propose(
        {
          id: "gemini",
          kind: "gemini",
          label: "Gemini",
          model: "test-model",
          enabled: true,
        },
        desktopPlan.goal,
        process.cwd(),
      ),
    ).resolves.toMatchObject({
      schemaVersion: "desktop-plan-v1",
      steps: [expect.objectContaining({ id: "launch-notes" })],
    });
  });

  it("redacts credentials and personal data before sending a Slow Path prompt", async () => {
    let body = "";
    const adapter = new TaskSourceAdapter({
      credentialFor: async () => "key-only-in-test",
      fetchImplementation: async (_input, init) => {
        body = String(init?.body);
        return new Response(
          JSON.stringify({ output_text: JSON.stringify(plan) }),
          { status: 200 },
        );
      },
    });

    await adapter.propose(
      {
        id: "gemini",
        kind: "gemini",
        label: "Gemini",
        model: "test-model",
        enabled: true,
      },
      "Find the account for jane@example.com using sk_live_abcdefghijklmnop",
      process.cwd(),
    );

    expect(body).not.toContain("jane@example.com");
    expect(body).not.toContain("sk_live_abcdefghijklmnop");
    expect(body).toContain("[REDACTED");
  });

  it("rejects oversized provider responses before parsing a task plan", async () => {
    const adapter = new TaskSourceAdapter({
      credentialFor: async () => "key-only-in-test",
      fetchImplementation: async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-length": String(2 * 1024 * 1024) },
        }),
    });

    await expect(
      adapter.propose(
        {
          id: "gemini",
          kind: "gemini",
          label: "Gemini",
          model: "test-model",
          enabled: true,
        },
        plan.goal,
        process.cwd(),
      ),
    ).rejects.toThrow("oversized response");
  });
});
