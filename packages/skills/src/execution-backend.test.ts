import { describe, expect, it, vi } from "vitest";

import type { GlobalComputerAction } from "@lhic/schema";
import type { execFile } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ElementGroundedDispatcher,
  executionBackendOptionsFromEnvironment,
  FlaUIBackend,
  normalizePressKey,
  OmniParserBackend,
  PeekabooBackend,
  resolveExecutionChain,
} from "./execution-backend.js";
import type { GlobalCommand } from "./os-bridge.js";

function fakeExecFile(
  handler: (
    file: string,
    args: string[],
  ) => { stdout?: string; stderr?: string; error?: Error } = () => ({}),
) {
  return ((
    file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const response = handler(file, args);
    if (response.error) {
      callback(response.error, "", response.stderr ?? "");
      return;
    }
    callback(null, response.stdout ?? "", response.stderr ?? "");
  }) as unknown as typeof execFile;
}

function screenshotFixture(name: string): string {
  return join(tmpdir(), "lhic-execution-backend-test", name);
}

function clickAction(
  overrides: Partial<GlobalComputerAction> = {},
): GlobalComputerAction {
  return {
    scope: "os",
    type: "os_click",
    intent: "Click the button",
    methodPreference: ["accessibility", "mouse"],
    riskLevel: "medium",
    verifier: { type: "process_running", application: "TestApp" },
    ...overrides,
  };
}

describe("execution backend key normalization", () => {
  it("maps conventional keys to backend grammars", () => {
    expect(normalizePressKey("Enter")).toBe("Return");
    expect(normalizePressKey("escape")).toBe("Escape");
    expect(normalizePressKey("space")).toBe("Space");
    expect(normalizePressKey("cmd+l")).toBe("cmd+l");
    expect(normalizePressKey("control+c")).toBe("ctrl+c");
    expect(normalizePressKey("shift+F5")).toBe("shift+F5");
    expect(normalizePressKey("ArrowUp")).toBe("ArrowUp");
  });
});

describe("PeekabooBackend (macOS)", () => {
  it("is unavailable on non-macOS operating systems", async () => {
    const backend = new PeekabooBackend({ platform: "linux" });
    const probe = await backend.probe();
    expect(probe.available).toBe(false);
    expect(probe.detail).toContain("macOS execution layer");
  });

  it("falls back to the traditional layer when macOS is below 15", async () => {
    const execFile = fakeExecFile((file) => {
      if (file === "sw_vers") return { stdout: "14.6.1\n" };
      return { stdout: "peekaboo/4.0.0\n" };
    });
    const backend = new PeekabooBackend({
      platform: "darwin",
      execFileImplementation: execFile,
    });
    const probe = await backend.probe();
    expect(probe.available).toBe(false);
    expect(probe.detail).toContain("macOS 15 or later");
    expect(probe.detail).toContain("traditional osascript layer");
  });

  it("is available on macOS 15+ when the CLI is installed", async () => {
    const execFile = fakeExecFile((file, args) => {
      if (file === "sw_vers") return { stdout: "15.4\n" };
      if (args[0] === "--version") return { stdout: "peekaboo/4.0.0\n" };
      return {};
    });
    const backend = new PeekabooBackend({
      platform: "darwin",
      execFileImplementation: execFile,
    });
    const probe = await backend.probe();
    expect(probe.available).toBe(true);
  });

  it("maps actions to peekaboo commands and element targeting", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const execFile = fakeExecFile((file, args) => {
      calls.push({ file, args });
      return { stdout: "ok\n" };
    });
    const backend = new PeekabooBackend({
      platform: "darwin",
      execFileImplementation: execFile,
    });

    const observation = {
      observationId: "obs-test",
      capturedAt: "2026-08-12T00:00:00.000Z",
      elements: [
        { id: "el-1", label: "Reload", role: "AXButton" },
        { id: "el-2", label: "Address and search bar", role: "AXTextField" },
      ],
    };
    const element = backend.findElement("Reload", observation);
    expect(element?.id).toBe("el-1");

    await backend.execute(clickAction({ application: "Safari" }), element);
    expect(calls[0]?.args).toEqual([
      "click",
      "--on",
      "el-1",
      "--app",
      "Safari",
    ]);

    calls.length = 0;
    await backend.execute(
      { ...clickAction({ application: "Safari" }), target: "Reload" },
      undefined,
    );
    expect(calls[0]?.args).toEqual(["click", "Reload", "--app", "Safari"]);

    calls.length = 0;
    await backend.execute(
      {
        scope: "os",
        type: "os_type",
        intent: "Type URL",
        methodPreference: ["accessibility", "keyboard"],
        riskLevel: "low",
        application: "Safari",
        text: "example.com",
        verifier: { type: "process_running", application: "Safari" },
      },
      observation.elements[1],
    );
    expect(calls[0]?.args).toEqual([
      "set-value",
      "example.com",
      "--on",
      "el-2",
      "--app",
      "Safari",
    ]);

    calls.length = 0;
    await backend.execute(
      {
        scope: "os",
        type: "os_press",
        intent: "Confirm",
        methodPreference: ["keyboard"],
        riskLevel: "low",
        key: "Enter",
        verifier: { type: "process_running", application: "TestApp" },
      },
      undefined,
    );
    expect(calls[0]?.args).toEqual(["press", "Return"]);

    calls.length = 0;
    await backend.execute(
      {
        scope: "os",
        type: "os_launch",
        intent: "Launch",
        methodPreference: ["api"],
        riskLevel: "low",
        application: "Finder",
        verifier: { type: "process_running", application: "Finder" },
      },
      undefined,
    );
    expect(calls[0]?.args).toEqual(["app", "launch", "Finder"]);
  });

  it("parses see --json output into elements", async () => {
    const execFile = fakeExecFile(() => ({
      stdout: JSON.stringify({
        root: {
          id: "root",
          children: [
            {
              id: "btn",
              label: "Send",
              role: "AXButton",
              frame: { x: 10, y: 20, width: 60, height: 30 },
            },
          ],
        },
      }),
    }));
    const backend = new PeekabooBackend({
      platform: "darwin",
      execFileImplementation: execFile,
    });
    const observation = await backend.observe({ application: "Mail" });
    expect(observation.elements).toContainEqual(
      expect.objectContaining({
        id: "btn",
        label: "Send",
        frame: { x: 10, y: 20, width: 60, height: 30 },
      }),
    );
  });
});

describe("FlaUIBackend (Windows)", () => {
  it("is unavailable on non-Windows operating systems", async () => {
    const backend = new FlaUIBackend({ platform: "darwin" });
    const probe = await backend.probe();
    expect(probe.available).toBe(false);
    expect(probe.detail).toContain("Windows execution layer");
  });

  it("falls back to the traditional layer below Windows 10 1607", async () => {
    const execFile = fakeExecFile((file) => {
      if (file === "powershell") return { stdout: "6.3.9600.0\n" };
      return { stdout: JSON.stringify({ ok: true, version: "flaui-1" }) };
    });
    const backend = new FlaUIBackend({
      platform: "win32",
      execFileImplementation: execFile,
    });
    const probe = await backend.probe();
    expect(probe.available).toBe(false);
    expect(probe.detail).toContain("Windows 10 1607");
    expect(probe.detail).toContain("traditional PowerShell layer");
  });

  it("is available on Windows 10+ when the bridge DLL exists", async () => {
    const execFile = fakeExecFile((file, args) => {
      if (file === "powershell") return { stdout: "10.0.19045.0\n" };
      if (args[0] === "probe")
        return { stdout: JSON.stringify({ ok: true, version: "flaui-1" }) };
      return {};
    });
    const backend = new FlaUIBackend({
      platform: "win32",
      execFileImplementation: execFile,
    });
    const probe = await backend.probe();
    expect(probe.available).toBe(true);
  });

  it("maps actions to bridge commands", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const execFile = fakeExecFile((file, args) => {
      calls.push({ file, args });
      return { stdout: JSON.stringify({ ok: true }) };
    });
    const backend = new FlaUIBackend({
      platform: "win32",
      execFileImplementation: execFile,
    });
    const element = { id: "btn-1", label: "Send" };
    await backend.execute(clickAction({}), element);
    expect(calls[0]?.args).toEqual([
      "lhic-flaui/lhic-flaui.dll",
      "click",
      "--on",
      "btn-1",
    ]);
  });
});

describe("ElementGroundedDispatcher chain", () => {
  it("dispatches through the element backend when an element matches", async () => {
    const backend = {
      id: "peekaboo",
      observe: vi.fn(async () => ({
        observationId: "obs-test",
        capturedAt: "2026-08-12T00:00:00.000Z",
        elements: [{ id: "el-1", label: "Reload" }],
      })),
      findElement: vi.fn(() => ({ id: "el-1", label: "Reload" })),
      execute: vi.fn(async () => ({
        result: { stdout: "ok", stderr: "" },
        backend: "peekaboo",
        evidence: ["Targeted el-1"],
      })),
    };
    const runner = { run: vi.fn(async () => ({ stdout: "", stderr: "" })) };
    const buildNative = vi.fn();
    const dispatcher = new ElementGroundedDispatcher({
      backend: backend as never,
      runner,
      platform: "darwin",
      buildNative,
    });
    const result = await dispatcher.dispatch(clickAction({ target: "Reload" }));
    expect(result?.backend).toBe("peekaboo");
    expect(backend.execute).toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("returns a bounded redacted normalized observation", async () => {
    const backend = {
      id: "peekaboo",
      observe: vi.fn(async () => ({
        observationId: "obs-test",
        capturedAt: "2026-08-12T00:00:00.000Z",
        elements: Array.from({ length: 510 }, (_, index) => ({
          id: `el-${index}`,
          label: index === 0 ? "Token private-value" : `Button ${index}`,
          role: "button",
          interactable: true,
        })),
      })),
      findElement: vi.fn(),
      execute: vi.fn(),
    };
    const dispatcher = new ElementGroundedDispatcher({
      backend: backend as never,
      runner: { run: vi.fn() },
      platform: "darwin",
      buildNative: vi.fn(),
      redactValues: ["private-value"],
    });
    const observation = await dispatcher.observe({
      scope: "os",
      type: "os_observe",
      intent: "observe active window",
      methodPreference: ["accessibility", "vision"],
      riskLevel: "medium",
      observeScope: "active_window",
      verifier: { type: "active_window" },
    });
    expect(observation?.elements).toHaveLength(500);
    expect(observation?.elements[0]).toMatchObject({
      label: "Token [REDACTED]",
      backend: "peekaboo",
    });
    expect(Buffer.byteLength(JSON.stringify(observation))).toBeLessThanOrEqual(
      256 * 1024,
    );
    expect(observation?.evidence.join(" ")).toContain("truncated");
  });

  it("falls back to OmniParser V2 coordinate grounding when the element tree has no match", async () => {
    const omniparser = new OmniParserBackend({});
    const parseScreenshot = vi
      .spyOn(omniparser, "parseScreenshot")
      .mockResolvedValue({
        observationId: "obs-test",
        capturedAt: "",
        elements: [
          {
            id: "0",
            label: "Submit",
            frame: { x: 100, y: 50, width: 40, height: 20 },
          },
        ],
      });
    const runner = { run: vi.fn(async () => ({ stdout: "ok", stderr: "" })) };
    const buildNative = vi.fn(
      (action: GlobalComputerAction) =>
        ({
          file: "native",
          args: [String(action.x), String(action.y)],
        }) as GlobalCommand,
    );
    const dispatcher = new ElementGroundedDispatcher({
      omniparser,
      runner,
      platform: "darwin",
      buildNative,
      captureScreenshot: async () => screenshotFixture("screen.png"),
    });
    const result = await dispatcher.dispatch(
      clickAction({ target: "Submit", x: 0, y: 0 }),
    );
    expect(result?.backend).toBe("omniparser");
    expect(parseScreenshot).toHaveBeenCalledWith(
      screenshotFixture("screen.png"),
    );
    expect(runner.run).toHaveBeenCalledOnce();
    const nativeAction = buildNative.mock.calls[0]?.[0] as GlobalComputerAction;
    expect(nativeAction.x).toBe(120); // 100 + 40/2
    expect(nativeAction.y).toBe(60); // 50 + 20/2
    expect(result?.evidence[0]).toContain("OmniParser V2 located");
  });

  it("returns undefined when every layer fails, letting the native executor dispatch", async () => {
    const backend = {
      id: "peekaboo",
      observe: vi.fn(async () => {
        throw new Error("AX unavailable");
      }),
      findElement: vi.fn(),
      execute: vi.fn(),
    };
    const omniparser = new OmniParserBackend({});
    vi.spyOn(omniparser, "parseScreenshot").mockRejectedValue(
      new Error("no weights"),
    );
    const runner = { run: vi.fn() };
    const dispatcher = new ElementGroundedDispatcher({
      backend: backend as never,
      omniparser,
      runner,
      platform: "darwin",
      buildNative: vi.fn(),
      captureScreenshot: async () => "/tmp/screen.png",
    });
    const result = await dispatcher.dispatch(clickAction({ target: "X" }));
    expect(result).toBeUndefined();
    expect(runner.run).not.toHaveBeenCalled();
  });
});

describe("resolveExecutionChain", () => {
  it("auto: uses FlaUI on Windows 10+ with OmniParser as the fallback", async () => {
    const execFile = fakeExecFile((file, args) => {
      if (file === "powershell") return { stdout: "10.0.19045.0\n" };
      if (args[0] === "probe") return { stdout: JSON.stringify({ ok: true }) };
      return {};
    });
    const chain = await resolveExecutionChain({
      platform: "win32",
      execFileImplementation: execFile,
    });
    expect(chain.backend?.id).toBe("flaui");
    expect(chain.omniparser).toBeDefined();
    expect(chain.probe.available).toBe(true);
  });

  it("auto: uses Peekaboo on macOS 15+ with OmniParser as the fallback", async () => {
    const execFile = fakeExecFile((file, args) => {
      if (file === "sw_vers") return { stdout: "15.4\n" };
      if (args[0] === "--version") return { stdout: "peekaboo/4.0.0\n" };
      if (args[0] === "probe") return { stdout: JSON.stringify({ ok: true }) };
      return {};
    });
    const chain = await resolveExecutionChain({
      platform: "darwin",
      execFileImplementation: execFile,
    });
    expect(chain.backend?.id).toBe("peekaboo");
    expect(chain.omniparser).toBeDefined();
    expect(chain.probe.available).toBe(true);
  });

  it("auto: falls back to the traditional layer when the OS or tools are unsupported", async () => {
    const execFile = fakeExecFile(() => {
      throw new Error("not installed");
    });
    const chain = await resolveExecutionChain({
      platform: "darwin",
      execFileImplementation: execFile,
    });
    expect(chain.backend).toBeUndefined();
    expect(chain.omniparser).toBeUndefined();
    expect(chain.probe.id).toBe("native");
    expect(chain.probe.detail).toContain("Traditional platform layer");
  });

  it("forced native always uses the traditional layer", async () => {
    const chain = await resolveExecutionChain({ backendMode: "native" });
    expect(chain.backend).toBeUndefined();
    expect(chain.probe.id).toBe("native");
  });

  it("rejects invalid LHIC_EXECUTION_BACKEND values", () => {
    expect(() =>
      executionBackendOptionsFromEnvironment({
        LHIC_EXECUTION_BACKEND: "nonsense",
      } as NodeJS.ProcessEnv),
    ).toThrow("auto, peekaboo, flaui, omniparser, or native");
  });
});
