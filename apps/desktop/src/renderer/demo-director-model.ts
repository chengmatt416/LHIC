export const demoStages = [
  "slide-1",
  "slide-2",
  "mcp-link",
  "slow-approval",
  "slow-live",
  "learning",
  "fast-ready",
  "fast-live",
  "comparison",
  "slide-3",
  "game",
  "slide-4",
  "complete",
] as const;

export type DemoStage = (typeof demoStages)[number];

export interface DemoTiming {
  startedAt?: number;
  completedAt?: number;
}

export interface DemoDirectorState {
  stage: DemoStage;
  slow: DemoTiming;
  fast: DemoTiming;
}

export const initialDemoDirectorState: DemoDirectorState = {
  stage: "slide-1",
  slow: {},
  fast: {},
};

export function advanceDemoStage(
  state: DemoDirectorState,
  options: {
    slowComplete?: boolean;
    fastComplete?: boolean;
    fastEligible?: boolean;
  } = {},
): DemoDirectorState {
  switch (state.stage) {
    case "slide-1":
      return { ...state, stage: "slide-2" };
    case "slide-2":
      return { ...state, stage: "mcp-link" };
    case "mcp-link":
      return { ...state, stage: "slow-approval" };
    case "slow-live":
      return options.slowComplete ? { ...state, stage: "learning" } : state;
    case "learning":
      return options.fastEligible ? { ...state, stage: "fast-ready" } : state;
    case "fast-live":
      return options.fastComplete ? { ...state, stage: "comparison" } : state;
    case "comparison":
      return { ...state, stage: "slide-3" };
    case "slide-3":
      return { ...state, stage: "game" };
    case "game":
      return { ...state, stage: "slide-4" };
    case "slide-4":
      return { ...state, stage: "complete" };
    case "slow-approval":
    case "fast-ready":
    case "complete":
      return state;
  }
}

export function elapsedMs(timing: DemoTiming, now = Date.now()): number {
  if (timing.startedAt === undefined) return 0;
  return Math.max(0, (timing.completedAt ?? now) - timing.startedAt);
}
