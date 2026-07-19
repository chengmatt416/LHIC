export const gameCoreIds = ["2d", "3d"] as const;

export type GameCoreId = (typeof gameCoreIds)[number];

export const gameSurfaces = ["browser", "desktop"] as const;

export type GameSurface = (typeof gameSurfaces)[number];

export type GameAimMode = "none" | "absolute" | "relative";

export interface GameViewport {
  width: number;
  height: number;
}

export interface GameCaptureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GameControlProfile {
  allowedKeys: readonly string[];
  allowPrimaryClick: boolean;
  aimMode: GameAimMode;
  maxPointerDelta?: number;
}

export interface GameTelemetryProfile {
  scoreSelector?: string;
  healthSelector?: string;
  scoreStorageKey?: string;
  healthStorageKey?: string;
  startSelector?: string;
  startSelectors?: readonly string[];
  restartSelector?: string;
  /** A post-start element that proves the playable target is ready. */
  readySelector?: string;
}

export interface GameProfileStartInput {
  selector: string;
  value: string;
}

export interface GameTargetOriginPolicy {
  kind: "local" | "remote";
  /**
   * The browser entry point for a remote target. Local targets derive their
   * URL from the registered static server instead.
   */
  url?: string;
  /** Exact origins the browser runner may load for this profile. */
  allowedOrigins?: readonly string[];
  /** Remote targets do not receive the local seeded RNG preload. */
  supportsInjectedSeed: boolean;
}

export interface GameTargetProfile {
  id: string;
  core: GameCoreId;
  title: string;
  sourceRepository: string;
  supportedSurfaces: readonly GameSurface[];
  viewport: GameViewport;
  control: GameControlProfile;
  telemetry: GameTelemetryProfile;
  frameRate: number;
  startInput?: GameProfileStartInput;
  targetOrigin?: GameTargetOriginPolicy;
  requiresPointerLock?: boolean;
}

export interface GameFrameSpec {
  width: number;
  height: number;
  channels: 3;
  history: number;
}

export interface GameInputSample {
  timestampMs: number;
  heldKeys: string[];
  primaryDown: boolean;
  pointerX?: number;
  pointerY?: number;
  pointerDeltaX?: number;
  pointerDeltaY?: number;
}

export interface GameTelemetrySample {
  score?: number;
  health?: number;
  terminal: boolean;
}

export interface GameEpisodeSample {
  timestampMs: number;
  frame: string;
  input: GameInputSample;
  telemetry: GameTelemetrySample;
}

export interface GameDatasetManifest {
  schemaVersion: "game-dataset-v1";
  core: GameCoreId;
  profileId: string;
  profileDigest: string;
  preprocessingVersion: string;
  actionCodec: string;
  seed: number;
  seedMode?: "injected" | "uncontrolled";
  surface: GameSurface;
  captureRegion?: GameCaptureRegion;
  createdAt: string;
  samples: GameEpisodeSample[];
}

export interface GamePolicyArtifact {
  schemaVersion: "game-policy-v1";
  core: GameCoreId;
  profileId: string;
  profileDigest: string;
  preprocessingVersion: string;
  frameSpec: GameFrameSpec;
  actionCodec: string;
  weightsFile: string;
  weightsSha256: string;
  modelType?: string;
  training: {
    algorithm: "behavior-cloning-v1";
    seed: number;
    datasetSha256: string;
    validationSplit: number;
    trainingSampleCount: number;
    validationSampleCount: number;
  };
  metrics: {
    behaviorCloningLoss: number;
    datasetReward: number;
    validationLoss: number;
    validationActionAccuracy: number;
  };
  createdAt: string;
}

export interface GameTraceMetadata {
  core: GameCoreId;
  profileId: string;
  surface: GameSurface;
  sessionId: string;
}

export interface GameTrainingPaths {
  root: string;
  coreRoot: string;
  datasetsRoot: string;
  skillsRoot: string;
  reportsRoot: string;
  tracesRoot: string;
  targetsRoot: string;
  environmentRoot: string;
}
