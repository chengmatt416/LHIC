export const taskSourceKinds = [
  "codex-cli",
  "antigravity-cli",
  "claude-code-cli",
  "openai-responses",
  "gemini",
  "anthropic-messages",
  "openai-compatible",
] as const;

export type TaskSourceKind = (typeof taskSourceKinds)[number];

export interface TaskSourceConfig {
  id: string;
  kind: TaskSourceKind;
  label: string;
  model?: string;
  endpoint?: string;
  protocol?: "responses" | "chat-completions";
  credentialId?: string;
  maxOutputTokens?: number;
  enabled: boolean;
}

export interface DesktopCommand {
  id: string;
  label: string;
  category: "skill" | "task" | "mcp" | "game" | "security" | "judge";
  requiresApproval: boolean;
}

export interface CommandEvent {
  commandId: string;
  status:
    | "queued"
    | "running"
    | "awaiting_approval"
    | "proposed"
    | "blocked"
    | "completed"
    | "failed"
    | "cancelled";
  message: string;
  createdAt: string;
  evidence?: string[];
  proposal?: TaskProposalSummary;
}

export interface TaskProposalSummary {
  stepCount: number;
  steps: Array<{
    id: string;
    action:
      | "navigate"
      | "click"
      | "fill"
      | "select"
      | "press"
      | "wait"
      | "download"
      | "os_click"
      | "os_type"
      | "os_press"
      | "os_launch"
      | "os_focus";
    intent: string;
    riskLevel: "low" | "medium" | "high" | "unknown";
    verifier: string;
  }>;
}

export interface TaskApproval {
  approvalId: string;
  actionHash: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  signature?: string;
}

export const mcpClientKinds = [
  "codex",
  "antigravity",
  "claude-code",
  "openclaw",
  "hermes",
  "custom",
] as const;

export type McpClientKind = (typeof mcpClientKinds)[number];

export interface McpServerDefinition {
  command: "node";
  args: string[];
  cwd: string;
  name?: string;
}

export interface McpClientAdapter {
  id: McpClientKind;
  label: string;
  executable?: string;
  configPath?: string;
  format: "toml" | "json" | "yaml" | "command" | "custom";
  configFormat?: "toml" | "json";
  serverCollectionKey?: string;
  healthCommand?: string[];
  configurationError?: string;
  detected: boolean;
}

export interface McpConfigPreview {
  adapter: McpClientAdapter;
  before: string;
  after: string;
  changed: boolean;
  confirmationToken: string;
  confirmationExpiresAt: string;
  backupPath?: string;
  healthCheck: string;
}

export interface McpProbeResult {
  status: "passed" | "failed" | "manual";
  command?: string;
  message: string;
}

export interface TrainingJob {
  id: string;
  kind:
    | "public-web"
    | "game-setup"
    | "game-record"
    | "game-fit"
    | "game-evaluate"
    | "game-play";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  command: string[];
  report?: Record<string, unknown>;
}

/** A main-process update emitted only for a tracked long-running local job. */
export type DesktopProgressEvent =
  | { channel: "training"; job: TrainingJob }
  | { channel: "task"; task: CommandEvent };

export interface PublicWebTrainingRequest {
  scenarioId:
    | "wikipedia-search"
    | "mdn-search"
    | "github-issue-filter"
    | "openstreetmap-place-search"
    | "psycho-flow";
  query: string;
  viewable?: boolean;
  promote?: boolean;
}

export interface GameTrainingRequest {
  core: "2d" | "3d";
  action: "setup" | "lease" | "record" | "fit" | "evaluate" | "play";
  profileId: "star-trooper" | "nemesis" | "epic-shooter-3d" | "custom";
  customProfile?: GameProfile;
  windowTitle?: string;
  captureRegion?: { x: number; y: number; width: number; height: number };
  durationMs?: number;
  approvedBy?: string;
  resourcePath?: string;
}

export interface GameProfile {
  id: string;
  title: string;
  surface: "browser" | "desktop";
  target: string;
  captureRegion?: { x: number; y: number; width: number; height: number };
  allowedKeys: string[];
  allowPrimaryClick: boolean;
  attestedSinglePlayer: boolean;
}

export interface GameTrainingEnvironment {
  python: string;
  ready: boolean;
  packages: Record<string, boolean>;
  platform: string;
  detail?: string;
}

export interface PolicyPackage {
  packageId: string;
  core: "2d" | "3d";
  profileId: string;
  artifactPath: string;
  manifestPath: string;
  bundlePath: string;
  reportPath?: string;
  actionCodec: string;
  weightsSha256: string;
  manifestSha256: string;
  bundleSha256: string;
  evaluationReportSha256?: string;
  status: "local" | "pending" | "approved" | "rejected" | "revoked";
  createdAt: string;
}

export interface PolicyPackageSubmission {
  package: PolicyPackage;
  bundleUrl: string;
  version: string;
}

/** Metadata shared for review; the policy archive itself stays at its HTTPS URL. */
export interface SharedPolicyPackage {
  id: string;
  packageId: string;
  core: "2d" | "3d";
  profileId: string;
  bundleUrl: string;
  bundleSha256: string;
  manifestSha256: string;
  weightsSha256: string;
  actionCodec: string;
  evaluationReportSha256?: string;
  version: string;
  status: Exclude<PolicyPackage["status"], "local">;
  createdAt: string;
  updatedAt: string;
}

export interface PolicyPackageRequest {
  artifactPath: string;
  destinationDirectory: string;
  evaluationReportPath?: string;
}

export type JudgeGrantKind = "github-user-id" | "github-email";

export interface JudgeGrant {
  kind: JudgeGrantKind;
  githubUserId?: string;
  githubEmail?: string;
  label: string;
  active: boolean;
  expiresAt?: string;
}

export interface JudgeAuthTokenMetadata {
  id: string;
  label: string;
  expiresAt?: string;
  maxUses?: number;
  revokedAt?: string;
  createdAt: string;
}

export interface DemoApiKeyMetadata {
  id: string;
  label: string;
  scopes: string[];
  expiresAt?: string;
  maxUses?: number;
  revokedAt?: string;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  actorId: string;
  action: string;
  target: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

/** Local safety settings. Invariant approval and redaction controls are not mutable. */
export interface SecurityConfiguration {
  slowPathProfile: "fast_only" | "balanced" | "deliberative";
  requireInteractiveApproval: true;
  redactSensitiveData: true;
  fastPathModelFree: true;
  updatedAt?: string;
}

export interface SkillSummary {
  name: string;
  source: "builtin" | "local" | "shared";
  version?: string;
  status: "ready" | "pending" | "approved" | "rejected" | "revoked";
  fastPathEligible: boolean;
  updatedAt?: string;
}

export interface SharedLibraryStatus {
  configured: boolean;
  enabled: boolean;
  registryId?: string;
  cachedSkillCount: number;
  pendingSubmissionCount: number;
  lastSuccessAt?: string;
  lastError?: string;
}

export interface SharedLibraryConnection {
  endpoint: string;
  projectId: string;
  functionUrl: string;
  email: string;
}

export interface JudgeSession {
  subject: string;
  authentication: "github" | "token";
  githubUserId?: string;
  allowed: true;
}

export interface JudgeLoginState {
  status: "pending" | "complete";
  expiresAt: string;
  message: string;
}

export interface JudgeDemoAsset {
  id: string;
  title: string;
  kind: "benchmark" | "trace" | "presentation" | "guide" | "report";
  sourceUrl: string;
  generatedAt: string;
  sha256: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  retiredAt?: string;
}

export interface AdminSession {
  accountId: string;
  admin: true;
  githubUserId?: string;
}

export interface AdminJudgeGrant extends JudgeGrant {
  id: string;
}

export interface AdminSkillReview {
  id: string;
  name: string;
  version: string;
  status: SkillSummary["status"];
  fastPathEligible: boolean;
  updatedAt: string;
}

export interface AdminControlSnapshot {
  session: AdminSession;
  judges: AdminJudgeGrant[];
  judgeTokens: JudgeAuthTokenMetadata[];
  skills: AdminSkillReview[];
  demoKeys: DemoApiKeyMetadata[];
  secrets: AdminSecretMetadata[];
  assets: JudgeDemoAsset[];
  policyPackages: SharedPolicyPackage[];
}

export interface AdminSecretMetadata {
  id: string;
  label: string;
  kind: string;
  keyVersion: string;
  revokedAt?: string;
  createdAt: string;
}

export interface DashboardSnapshot {
  runtime: {
    workspaceRoot: string;
    fastPathModelFree: true;
    runningJobs: number;
  };
  skills: SkillSummary[];
  sharedLibrary: SharedLibraryStatus;
  sources: TaskSourceConfig[];
  mcp: McpClientAdapter[];
  recentEvents: CommandEvent[];
}

export interface DesktopApi {
  dashboard(): Promise<DashboardSnapshot>;
  tasks: {
    configure(source: TaskSourceConfig): Promise<TaskSourceConfig>;
    autoConfigure(): Promise<TaskSourceConfig[]>;
    start(input: {
      goal: string;
      startUrl?: string;
      sourceId?: string;
    }): Promise<CommandEvent>;
    execute(commandId: string): Promise<CommandEvent>;
    approve(commandId: string, approval?: TaskApproval): Promise<CommandEvent>;
    cancel(commandId: string): Promise<void>;
  };
  skills: {
    connect(input: SharedLibraryConnection): Promise<CommandEvent>;
    login(email: string): Promise<CommandEvent>;
    status(): Promise<SharedLibraryStatus>;
    sync(): Promise<CommandEvent>;
    exportApproved(
      destination: string,
    ): Promise<{ path: string; count: number }>;
    trainPublicWeb(input: PublicWebTrainingRequest): Promise<TrainingJob>;
    trainingStatus(jobId: string): Promise<TrainingJob>;
    cancelTraining(jobId: string): Promise<void>;
  };
  mcp: {
    preview(
      client: McpClientKind,
      workspaceRoot: string,
    ): Promise<McpConfigPreview>;
    apply(
      client: McpClientKind,
      workspaceRoot: string,
      confirmationToken: string,
    ): Promise<McpConfigPreview>;
    probe(
      client: McpClientKind,
      workspaceRoot: string,
    ): Promise<McpProbeResult>;
  };
  game: {
    inspectRuntime(): Promise<GameTrainingEnvironment>;
    prepareRuntime(): Promise<GameTrainingEnvironment>;
    validate(profile: GameProfile): Promise<GameProfile>;
    run(input: GameTrainingRequest): Promise<TrainingJob>;
    packagePolicy(input: PolicyPackageRequest): Promise<PolicyPackage>;
    submitPolicy(input: PolicyPackageSubmission): Promise<SharedPolicyPackage>;
    status(jobId: string): Promise<TrainingJob>;
    cancel(jobId: string): Promise<void>;
  };
  judge: {
    beginGithubLogin(): Promise<JudgeLoginState>;
    pollGithubLogin(): Promise<JudgeLoginState>;
    session(): Promise<JudgeSession>;
    authorizeToken(token: string): Promise<JudgeSession>;
    catalog(): Promise<JudgeDemoAsset[]>;
    policyPackages(): Promise<SharedPolicyPackage[]>;
  };
  security: {
    configuration(): Promise<SecurityConfiguration>;
    configure(
      input: Pick<SecurityConfiguration, "slowPathProfile">,
    ): Promise<SecurityConfiguration>;
  };
  admin: {
    snapshot(): Promise<AdminControlSnapshot>;
    createJudge(input: Omit<JudgeGrant, "active">): Promise<AdminJudgeGrant>;
    revokeJudge(id: string): Promise<AdminJudgeGrant>;
    createJudgeToken(input: {
      label: string;
      expiresAt?: string;
      maxUses?: number;
    }): Promise<{ token: string; metadata: JudgeAuthTokenMetadata }>;
    revokeJudgeToken(id: string): Promise<JudgeAuthTokenMetadata>;
    setSkillStatus(
      id: string,
      status: "approved" | "rejected" | "revoked",
    ): Promise<AdminSkillReview>;
    setPolicyPackageStatus(
      id: string,
      status: "approved" | "rejected" | "revoked",
    ): Promise<SharedPolicyPackage>;
    createDemoKey(input: {
      label: string;
      scopes: string[];
      expiresAt?: string;
      maxUses?: number;
    }): Promise<{ key: string; metadata: DemoApiKeyMetadata }>;
    revokeDemoKey(id: string): Promise<DemoApiKeyMetadata>;
    createSecret(input: {
      label: string;
      kind: string;
      secret: string;
    }): Promise<AdminSecretMetadata>;
    revokeSecret(id: string): Promise<AdminSecretMetadata>;
    createAsset(
      input: Omit<JudgeDemoAsset, "id" | "createdAt">,
    ): Promise<JudgeDemoAsset>;
    retireAsset(id: string): Promise<JudgeDemoAsset>;
  };
  credentials: {
    set(id: string, secret: string): Promise<void>;
    has(id: string): Promise<boolean>;
    remove(id: string): Promise<void>;
  };
  events: {
    onProgress(listener: (event: DesktopProgressEvent) => void): () => void;
  };
}
