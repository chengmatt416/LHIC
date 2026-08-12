import { describe, expect, it } from "vitest";

import { adaptBrowserGymAction } from "./browsergym-adapter.js";

describe("BrowserGym action adapter", () => {
  it("preserves numeric BIDs and BrowserGym value aliases", () => {
    expect(
      adaptBrowserGymAction({
        name: "fill",
        args: { bid: 0, text: "Ada" },
      }),
    ).toMatchObject({ type: "fill", target: '[bid="0"]', value: "Ada" });

    expect(
      adaptBrowserGymAction({
        name: "select_option",
        args: { selector: "#priority", option: "high" },
      }),
    ).toMatchObject({
      type: "select",
      target: "#priority",
      value: "high",
    });
  });

  it("adapts perception and navigation actions without discarding their arguments", () => {
    expect(
      adaptBrowserGymAction({
        name: "scroll",
        args: { direction: "left", amount: 7 },
      }),
    ).toMatchObject({
      type: "scroll",
      scrollDirection: "left",
      scrollAmount: 7,
    });
    expect(adaptBrowserGymAction({ name: "go_back", args: {} })).toMatchObject({
      type: "keyboard",
      key: "ArrowLeft",
      modifiers: ["Alt"],
    });
    expect(
      adaptBrowserGymAction({
        name: "tab_focus",
        args: { tab_index: 2 },
      }),
    ).toMatchObject({ type: "tab", tabAction: "switch", tabIndex: 2 });

    expect(
      adaptBrowserGymAction({
        name: "scroll",
        args: { delta_x: 0, delta_y: -500 },
      }),
    ).toMatchObject({
      type: "scroll",
      scrollDirection: "up",
      scrollAmount: 500,
    });
    expect(
      adaptBrowserGymAction({ name: "tab_close", args: {} }),
    ).toMatchObject({ type: "tab", tabAction: "close" });
    expect(
      adaptBrowserGymAction({
        name: "press",
        args: { bid: "search", key_comb: "Control+Enter" },
      }),
    ).toMatchObject({
      type: "press",
      target: '[bid="search"]',
      key: "Control+Enter",
    });
  });

  it("adapts upload, download, hover, and drag targets", () => {
    expect(
      adaptBrowserGymAction({
        name: "upload_file",
        args: { bid: "file", file_path: "/tmp/input.txt" },
      }),
    ).toMatchObject({
      type: "upload",
      target: '[bid="file"]',
      filePath: "/tmp/input.txt",
    });
    expect(
      adaptBrowserGymAction({ name: "download", args: { bid: "export" } }),
    ).toMatchObject({ type: "download", target: '[bid="export"]' });
    expect(
      adaptBrowserGymAction({ name: "hover", args: { bid: "menu" } }),
    ).toMatchObject({ type: "hover", target: '[bid="menu"]' });
    expect(
      adaptBrowserGymAction({
        name: "drag",
        args: { bid: "card", target_bid: "column" },
      }),
    ).toMatchObject({
      type: "drag",
      target: '[bid="card"]',
      dragTarget: '[bid="column"]',
    });

    expect(
      adaptBrowserGymAction({
        name: "drag_and_drop",
        args: { from_bid: "card-2", to_bid: "done-column" },
      }),
    ).toMatchObject({
      type: "drag",
      target: '[bid="card-2"]',
      dragTarget: '[bid="done-column"]',
    });
    expect(
      adaptBrowserGymAction({
        name: "upload_file",
        args: { bid: "file", file: "/tmp/browsergym.txt" },
      }),
    ).toMatchObject({
      type: "upload",
      target: '[bid="file"]',
      filePath: "/tmp/browsergym.txt",
    });
  });

  it("CSS-escapes special characters in BrowserGym BIDs", () => {
    expect(
      adaptBrowserGymAction({
        name: "click",
        args: { bid: 'quote"slash\\line\n' },
      }),
    ).toMatchObject({
      target: '[bid="quote\\22 slash\\5c line\\a "]',
    });
  });

  it("retains wait targets and rejects unknown actions", () => {
    expect(
      adaptBrowserGymAction({
        name: "wait",
        args: { selector: "#loaded", timeout: 2500 },
      }),
    ).toMatchObject({ type: "wait", target: "#loaded", value: 2500 });
    expect(() => adaptBrowserGymAction({ name: "unknown", args: {} })).toThrow(
      "Unsupported BrowserGym action: unknown",
    );
  });
});
