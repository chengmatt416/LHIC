import type { BrowserSemanticAction } from "@lhic/schema";

export interface BrowserGymAction {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
}

export function adaptBrowserGymAction(
  bgAction: BrowserGymAction,
): BrowserSemanticAction {
  const target = browserGymTarget(bgAction.args);
  const intentTarget = target ?? "the active page";

  switch (bgAction.name) {
    case "click":
      return targetedAction("click", `Click target ${intentTarget}`, target);
    case "type":
    case "fill":
      return {
        ...targetedAction("fill", `Fill target ${intentTarget}`, target),
        value: bgAction.args.text ?? bgAction.args.value,
      };
    case "select":
    case "select_option":
      return {
        ...targetedAction(
          "select",
          `Select an option in target ${intentTarget}`,
          target,
        ),
        value:
          bgAction.args.option ?? bgAction.args.value ?? bgAction.args.options,
      };
    case "press": {
      const key = String(
        bgAction.args.key_comb ?? bgAction.args.key ?? "Enter",
      );
      return {
        type: "press",
        intent: `Press key ${key} on target ${intentTarget}`,
        ...(target === undefined ? {} : { target }),
        value: key,
        key,
        methodPreference: ["keyboard"],
        riskLevel: "low",
      };
    }
    case "goto": {
      const url = String(bgAction.args.url ?? "");
      return {
        type: "navigate",
        intent: `Navigate to ${url}`,
        target: url,
        methodPreference: ["api"],
        riskLevel: "low",
      };
    }
    case "go_back":
      return {
        type: "keyboard",
        intent: "Navigate back in browser history",
        key: "ArrowLeft",
        modifiers: ["Alt"],
        methodPreference: ["keyboard"],
        riskLevel: "low",
      };
    case "go_forward":
      return {
        type: "keyboard",
        intent: "Navigate forward in browser history",
        key: "ArrowRight",
        modifiers: ["Alt"],
        methodPreference: ["keyboard"],
        riskLevel: "low",
      };
    case "wait":
      return {
        type: "wait",
        intent:
          target === undefined
            ? `Wait for ${String(bgAction.args.timeout ?? 1000)} ms`
            : `Wait for target ${target}`,
        ...(target === undefined ? {} : { target }),
        value: bgAction.args.timeout ?? 1000,
        methodPreference: ["dom"],
        riskLevel: "low",
      };
    case "scroll": {
      const explicitDirection = bgAction.args.direction;
      const deltaX = finiteNumber(bgAction.args.delta_x);
      const deltaY = finiteNumber(bgAction.args.delta_y);
      const legacyAmount = finiteNumber(
        bgAction.args.amount ?? bgAction.args.delta,
      );
      let direction: "up" | "down" | "left" | "right";
      let amount: number;
      if (deltaX !== undefined || deltaY !== undefined) {
        const x = deltaX ?? 0;
        const y = deltaY ?? 0;
        if (Math.abs(x) > Math.abs(y)) {
          direction = x < 0 ? "left" : "right";
          amount = Math.abs(x);
        } else {
          direction = y < 0 ? "up" : "down";
          amount = Math.abs(y);
        }
      } else {
        direction =
          explicitDirection === "up" ||
          explicitDirection === "left" ||
          explicitDirection === "right"
            ? explicitDirection
            : "down";
        amount = Math.abs(legacyAmount ?? 3);
      }
      return {
        type: "scroll",
        intent: `Scroll ${direction}`,
        scrollDirection: direction,
        scrollAmount: amount,
        methodPreference: ["mouse"],
        riskLevel: "low",
      };
    }
    case "hover":
      return targetedAction(
        "hover",
        `Hover over target ${intentTarget}`,
        target,
      );
    case "new_tab":
      return tabAction("new");
    case "tab_close":
    case "close_tab":
      return tabAction("close");
    case "tab_focus":
    case "switch_tab": {
      const requestedIndex = bgAction.args.index ?? bgAction.args.tab_index;
      return {
        ...tabAction("switch"),
        tabIndex:
          typeof requestedIndex === "number" && Number.isFinite(requestedIndex)
            ? requestedIndex
            : 0,
      };
    }
    case "upload":
    case "upload_file":
      return {
        ...targetedAction(
          "upload",
          `Upload a file through target ${intentTarget}`,
          target,
        ),
        filePath: String(
          bgAction.args.file ??
            bgAction.args.file_path ??
            bgAction.args.path ??
            bgAction.args.value ??
            "",
        ),
      };
    case "download":
      return targetedAction(
        "download",
        `Download from target ${intentTarget}`,
        target,
      );
    case "drag":
    case "drag_and_drop": {
      const source =
        bgAction.args.from_bid === undefined || bgAction.args.from_bid === null
          ? target
          : browserGymBidSelector(bgAction.args.from_bid);
      const destinationBid = bgAction.args.to_bid ?? bgAction.args.target_bid;
      const destination =
        bgAction.args.target_selector ?? bgAction.args.destination;
      const dragTarget =
        destinationBid !== undefined && destinationBid !== null
          ? browserGymBidSelector(destinationBid)
          : destination === undefined || destination === null
            ? undefined
            : String(destination);
      return {
        ...targetedAction(
          "drag",
          `Drag target ${source ?? "the active page"} to ${dragTarget ?? "the destination"}`,
          source,
        ),
        ...(dragTarget === undefined ? {} : { dragTarget }),
      };
    }
    default:
      throw new Error(`Unsupported BrowserGym action: ${bgAction.name}`);
  }
}

function targetedAction(
  type: "click" | "fill" | "select" | "hover" | "upload" | "download" | "drag",
  intent: string,
  target: string | undefined,
): BrowserSemanticAction {
  return {
    type,
    intent,
    ...(target === undefined ? {} : { target }),
    methodPreference: ["dom", "accessibility"],
    riskLevel: "low",
  };
}

function browserGymTarget(args: BrowserGymAction["args"]): string | undefined {
  if (args.bid !== undefined && args.bid !== null) {
    return browserGymBidSelector(args.bid);
  }
  const value = args.selector ?? args.target;
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value);
}

function browserGymBidSelector(value: unknown): string {
  const escaped = String(value).replace(/[\p{Cc}"\\]/gu, (character) =>
    character === "\u0000"
      ? "\uFFFD"
      : `\\${character.codePointAt(0)?.toString(16)} `,
  );
  return `[bid="${escaped}"]`;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function tabAction(
  action: NonNullable<BrowserSemanticAction["tabAction"]>,
): BrowserSemanticAction {
  return {
    type: "tab",
    intent: `${action[0]?.toUpperCase()}${action.slice(1)} browser tab`,
    tabAction: action,
    methodPreference: ["api"],
    riskLevel: "low",
  };
}
