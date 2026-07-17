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
  metrics: {
    behaviorCloningLoss: number;
    ppoReward: number;
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
