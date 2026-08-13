import type {
  CommandEvent,
  DesktopProgressEvent,
  AdminControlSnapshot,
  AdminJudgeGrant,
  JudgeAuthTokenMetadata,
  AdminSecretMetadata,
  AdminSkillReview,
  DemoApiKeyMetadata,
  DemoCandidateStatus,
  DemoCodexDispatchRequest,
  DemoCodexRunStatus,
  DemoDirectorPreflight,
  DemoDirectorResult,
  DemoRecordingClipResult,
  DemoRecordingStatus,
  DashboardSnapshot,
  GameProfile,
  GameTrainingEnvironment,
  GameTrainingRequest,
  PublicWebTrainingRequest,
  PolicyPackage,
  PolicyPackageRequest,
  PolicyPackageSubmission,
  JudgeDemoAsset,
  JudgeLoginState,
  JudgeSession,
  McpClientKind,
  SharedPolicyPackage,
  SharedLibraryConnection,
  SharedLibraryStatus,
  SecurityConfiguration,
  TaskApproval,
  TaskSourceConfig,
  TrainingJob,
  OmpEvent,
  OmpMessageView,
  OmpAdvancedCommand,
  OmpModelInfo,
  OmpRuntimeState,
  OmpSessionInfo,
  OmpSessionStats,
  OmpSubagentView,
  OmpSubagentModel,
  OmpTodoPhase,
  AccountStatus,
  LibrarySearchParams,
  LibrarySearchResult,
  LibrarySkillSummary,
  SkillDetail,
  SkillVersionSummary,
  ThemeSettings,
  UserProfile,
} from "../shared/contracts.js";
import { DesktopCredentialStore } from "./keyring.js";
import { HttpAppwriteRegistryClient } from "@lhic/shared-skills";
import { ControlPlaneClient } from "./control-plane-client.js";
import { GameService } from "./game-service.js";
import { DemoDirectorService } from "./demo-director-service.js";
import { McpService } from "./mcp-service.js";
import { SkillsService } from "./skills-service.js";
import { AccountService } from "./account-service.js";
import { LibraryService } from "./library-service.js";
import { SecuritySettingsStore } from "./security-settings-store.js";
import { UiSettingsStore } from "./ui-settings-store.js";
import { TaskService } from "./task-service.js";
import { OmpSessionService } from "./omp/omp-session-service.js";
import { bakedSharedSkillsConfig } from "./appwrite-public-config.js";
import { ProvisioningService } from "./provisioning-service.js";

export class DesktopController {
  public readonly credentials = new DesktopCredentialStore();
  public readonly provisioning: ProvisioningService;
  private readonly tasks: TaskService;
  private readonly games = new GameService();
  private readonly skills: SkillsService;
  private readonly mcp: McpService;
  private readonly controlPlane: ControlPlaneClient;
  private readonly securitySettings: SecuritySettingsStore;
  private readonly uiSettings: UiSettingsStore;
  private readonly demoDirector: DemoDirectorService;
  private readonly omp: OmpSessionService;
  private readonly account: AccountService;
  private readonly library: LibraryService;
  private securityInitialization: Promise<SecurityConfiguration> | undefined;

  public constructor(
    private readonly workspaceRoot: string,
    options: {
      openExternal?: (url: string) => Promise<void>;
      focusLhicWindow?: () => boolean;
      userDataDir?: string;
      executionSourceDir?: string;
    } = {},
  ) {
    this.tasks = new TaskService(workspaceRoot, this.credentials);
    this.provisioning = new ProvisioningService({
      userDataDir: options.userDataDir ?? workspaceRoot,
      ...(options.executionSourceDir
        ? { executionSourceDir: options.executionSourceDir }
        : {}),
    });
    this.skills = new SkillsService(workspaceRoot);
    const registry = new HttpAppwriteRegistryClient(bakedSharedSkillsConfig);
    this.account = new AccountService(
      workspaceRoot,
      this.skills,
      registry,
      this.skills.sharedCredentialStore(),
    );
    this.library = new LibraryService({
      skills: this.skills,
      registry,
      credentialStore: this.skills.sharedCredentialStore(),
      isSignedIn: () =>
        this.account.status().then((status) => status.mode === "signed-in"),
    });
    this.omp = new OmpSessionService({
      workspaceRoot,
      userDataDir: options.userDataDir ?? workspaceRoot,
      tasks: this.tasks,
      ...(options.openExternal ? { openExternal: options.openExternal } : {}),
    });
    this.mcp = new McpService(workspaceRoot);
    this.controlPlane = new ControlPlaneClient(workspaceRoot, {
      ...options,
      judgeTokenStore: this.credentials,
    });
    this.securitySettings = new SecuritySettingsStore(workspaceRoot);
    this.uiSettings = new UiSettingsStore(workspaceRoot);
    this.demoDirector = new DemoDirectorService(
      workspaceRoot,
      options.focusLhicWindow ?? (() => false),
    );
  }

  public async demoPreflight(): Promise<DemoDirectorPreflight> {
    const codexMcp = await this.probeMcp("codex", this.workspaceRoot);
    const messages = [
      codexMcp.message,
      this.demoDirector.challengeAvailable()
        ? "Challenge2026.app found."
        : "Challenge2026.app is missing.",
      this.demoDirector.scenarioReady()
        ? "Sandbox demo identities are ready for this process."
        : "Private demo identities are missing from the launch environment.",
      "Fast Path will launch inside LHIC with zero LLM and zero MCP calls.",
    ];
    return {
      codexMcp,
      codexApplicationAvailable: this.demoDirector.codexAvailable(),
      challengeApplicationAvailable: this.demoDirector.challengeAvailable(),
      screenRecorderAvailable: this.demoDirector.recorderAvailable(),
      signingCertificateSha256: this.demoDirector.signingCertificateSha256(),
      scenarioReady: this.demoDirector.scenarioReady(),
      codexModel: this.demoDirector.codexModel(),
      codexApplicationLabel: this.demoDirector.codexApplicationLabel(),
      messages,
    };
  }

  public async dispatchDemoCodex(
    input: DemoCodexDispatchRequest,
  ): Promise<DemoDirectorResult> {
    const preview = await this.mcp.preview("codex", this.workspaceRoot);
    if (preview.changed) {
      await this.mcp.apply(
        "codex",
        this.workspaceRoot,
        preview.confirmationToken,
      );
    }
    const result = await this.demoDirector.dispatchCodex(input);
    return {
      ...result,
      evidence: [
        `Codex CLI MCP registration ${preview.changed ? "installed" : "verified"}: lhic-computer-use.`,
        ...result.evidence,
      ],
    };
  }

  public approveDemoCodexPermission(
    approvedBy: string,
  ): Promise<DemoDirectorResult> {
    return this.demoDirector.approveCodexPermission(approvedBy);
  }

  public demoCodexRunStatus(): Promise<DemoCodexRunStatus> {
    return this.demoDirector.codexRunStatus();
  }

  public async startDemoFastPath(): Promise<CommandEvent> {
    const event = await this.tasks.start({
      goal: this.demoDirector.fastGoal(),
      startUrl: "https://vendor.techtools.qzz.io/",
      fastOnly: true,
    });
    if (event.status !== "proposed") return event;
    await this.demoDirector.showFastPathTerminal(event.commandId);
    const focusTimer = setTimeout(
      () => void this.demoDirector.focusTerminal().catch(() => undefined),
      1_500,
    );
    focusTimer.unref();
    return this.tasks.execute(event.commandId);
  }

  public focusDemoLhic(): DemoDirectorResult {
    return this.demoDirector.focusLhic();
  }

  public launchDemoChallenge(): Promise<DemoDirectorResult> {
    return this.demoDirector.launchChallenge();
  }

  public demoCandidates(): Promise<DemoCandidateStatus[]> {
    return this.demoDirector.candidates();
  }

  public startDemoRecording(): Promise<DemoRecordingStatus> {
    return this.demoDirector.startRecording();
  }

  public stopDemoRecording(): Promise<DemoRecordingStatus> {
    return this.demoDirector.stopRecording();
  }

  public saveDemoRecordingClip(): Promise<DemoRecordingClipResult> {
    return this.demoDirector.saveRecordingClip();
  }

  public demoRecordingStatus(): DemoRecordingStatus {
    return this.demoDirector.recordingStatus();
  }

  public async dashboard(): Promise<DashboardSnapshot> {
    const [, , browser] = await Promise.all([
      this.tasks.initialize(),
      this.securityConfiguration(),
      this.tasks.browserReadiness(),
    ]);
    const [skills, sharedLibrary, mcp] = await Promise.all([
      this.skills.list(),
      this.skills.status(),
      this.mcp.list(),
    ]);
    return {
      runtime: {
        workspaceRoot: this.workspaceRoot,
        fastPathModelFree: true,
        runningJobs: this.games.runningCount(),
        browserReady: browser.ready,
        browserReadinessMessage: browser.message,
      },
      skills,
      sharedLibrary,
      sources: this.tasks.listSources(),
      mcp,
      recentEvents: this.tasks.recentEvents(),
    };
  }

  public async configureTaskSource(
    source: TaskSourceConfig,
  ): Promise<TaskSourceConfig> {
    await this.securityConfiguration();
    return this.tasks.configure(source);
  }

  public async autoConfigureTaskSources(): Promise<TaskSourceConfig[]> {
    await this.securityConfiguration();
    return this.tasks.autoConfigureSources();
  }

  public async startTask(input: {
    goal: string;
    startUrl?: string;
    sourceId?: string;
  }): Promise<CommandEvent> {
    await this.securityConfiguration();
    return this.tasks.start(input);
  }

  public securityConfiguration(): Promise<SecurityConfiguration> {
    this.securityInitialization ??= this.loadSecurityConfiguration();
    return this.securityInitialization;
  }

  public async configureSecurity(
    input: Pick<SecurityConfiguration, "slowPathProfile">,
  ): Promise<SecurityConfiguration> {
    await this.securityConfiguration();
    const configuration = await this.securitySettings.save(input);
    this.tasks.setSlowPathProfile(configuration.slowPathProfile);
    this.securityInitialization = Promise.resolve(configuration);
    return configuration;
  }

  public approveTask(
    commandId: string,
    approval?: TaskApproval,
  ): Promise<CommandEvent> {
    return this.tasks.approve(commandId, approval);
  }

  public executeTask(commandId: string): Promise<CommandEvent> {
    return this.tasks.execute(commandId);
  }

  public cancelTask(commandId: string): Promise<void> {
    return this.tasks.cancel(commandId);
  }

  public syncSkills(): Promise<CommandEvent> {
    return this.skills.sync();
  }

  public connectSharedSkills(
    input: SharedLibraryConnection,
  ): Promise<CommandEvent> {
    return this.skills.connect(input);
  }

  public loginSharedSkills(email: string): Promise<CommandEvent> {
    return this.skills.login(email);
  }

  public sharedSkillsStatus(): Promise<SharedLibraryStatus> {
    return this.skills.status();
  }

  public startPublicWebTraining(
    input: PublicWebTrainingRequest,
  ): Promise<TrainingJob> {
    return this.skills.startPublicWebTraining(input);
  }

  public publicWebTrainingStatus(id: string): TrainingJob {
    return this.skills.publicWebTrainingStatus(id);
  }

  public cancelPublicWebTraining(id: string): Promise<void> {
    return this.skills.cancelPublicWebTraining(id);
  }

  public subscribeProgress(
    listener: (event: DesktopProgressEvent) => void,
  ): () => void {
    const publish = (job: TrainingJob) =>
      listener({ channel: "training", job });
    const removeGame = this.games.subscribe(publish);
    const removePublicWeb = this.skills.subscribePublicWebTraining(publish);
    const removeTasks = this.tasks.subscribe((task) =>
      listener({ channel: "task", task }),
    );
    return () => {
      removeGame();
      removePublicWeb();
      removeTasks();
    };
  }

  public beginJudgeGithubLogin(): Promise<JudgeLoginState> {
    return this.controlPlane.beginGithubLogin();
  }

  public pollJudgeGithubLogin(): Promise<JudgeLoginState> {
    return this.controlPlane.pollGithubLogin();
  }

  public judgeSession(): Promise<JudgeSession> {
    return this.controlPlane.judgeSession();
  }

  public authorizeJudgeToken(token: string): Promise<JudgeSession> {
    return this.controlPlane.authorizeJudgeToken(token);
  }

  public judgeCatalog(): Promise<JudgeDemoAsset[]> {
    return this.controlPlane.judgeCatalog();
  }

  public judgePolicyPackages(): Promise<SharedPolicyPackage[]> {
    return this.controlPlane.judgePolicyPackages();
  }

  public adminSnapshot(): Promise<AdminControlSnapshot> {
    return this.controlPlane.adminSnapshot();
  }

  public createAdminJudge(input: {
    kind: "github-user-id" | "github-email";
    githubUserId?: string;
    githubEmail?: string;
    label: string;
    expiresAt?: string;
  }): Promise<AdminJudgeGrant> {
    return this.controlPlane.createJudge(input);
  }

  public revokeAdminJudge(id: string): Promise<AdminJudgeGrant> {
    return this.controlPlane.revokeJudge(id);
  }

  public createAdminJudgeToken(input: {
    label: string;
    expiresAt?: string;
    maxUses?: number;
  }): Promise<{ token: string; metadata: JudgeAuthTokenMetadata }> {
    return this.controlPlane.createJudgeToken(input);
  }

  public revokeAdminJudgeToken(id: string): Promise<JudgeAuthTokenMetadata> {
    return this.controlPlane.revokeJudgeToken(id);
  }

  public setSharedSkillStatus(
    id: string,
    status: "approved" | "rejected" | "revoked",
  ): Promise<AdminSkillReview> {
    return this.controlPlane.setSkillStatus(id, status);
  }

  public setPolicyPackageStatus(
    id: string,
    status: "approved" | "rejected" | "revoked",
  ): Promise<SharedPolicyPackage> {
    return this.controlPlane.setPolicyPackageStatus(id, status);
  }

  public createDemoKey(input: {
    label: string;
    scopes: string[];
    expiresAt?: string;
    maxUses?: number;
  }): Promise<{ key: string; metadata: DemoApiKeyMetadata }> {
    return this.controlPlane.createDemoKey(input);
  }

  public revokeDemoKey(id: string): Promise<DemoApiKeyMetadata> {
    return this.controlPlane.revokeDemoKey(id);
  }

  public createSecret(input: {
    label: string;
    kind: string;
    secret: string;
  }): Promise<AdminSecretMetadata> {
    return this.controlPlane.createSecret(input);
  }

  public revokeSecret(id: string): Promise<AdminSecretMetadata> {
    return this.controlPlane.revokeSecret(id);
  }

  public createDemoAsset(
    input: Omit<JudgeDemoAsset, "id" | "createdAt">,
  ): Promise<JudgeDemoAsset> {
    return this.controlPlane.createAsset(input);
  }

  public retireDemoAsset(id: string): Promise<JudgeDemoAsset> {
    return this.controlPlane.retireAsset(id);
  }

  public exportApprovedSkills(
    destination: string,
  ): Promise<{ path: string; count: number }> {
    return this.skills.exportApproved(destination);
  }

  public previewMcp(client: McpClientKind, workspaceRoot: string) {
    return this.mcp.preview(client, workspaceRoot);
  }

  public applyMcp(
    client: McpClientKind,
    workspaceRoot: string,
    confirmationToken: string,
  ) {
    return this.mcp.apply(client, workspaceRoot, confirmationToken);
  }

  public probeMcp(client: McpClientKind, workspaceRoot: string) {
    return this.mcp.probe(client, workspaceRoot);
  }

  public validateGame(profile: GameProfile): GameProfile {
    return this.games.validate(profile);
  }

  public async submitGamePolicyPackage(
    input: PolicyPackageSubmission,
  ): Promise<SharedPolicyPackage> {
    return this.controlPlane.submitPolicyPackage(
      await this.games.preparePolicySubmission(input, this.workspaceRoot),
    );
  }

  public inspectGameRuntime(): Promise<GameTrainingEnvironment> {
    return this.games.inspectEnvironment(this.workspaceRoot);
  }

  public prepareGameRuntime(): Promise<GameTrainingEnvironment> {
    return this.games.prepareEnvironment(this.workspaceRoot);
  }

  public runGame(input: GameTrainingRequest): Promise<TrainingJob> {
    return this.games.run(input, this.workspaceRoot);
  }

  public packageGamePolicy(
    input: PolicyPackageRequest,
  ): Promise<PolicyPackage> {
    return this.games.packagePolicy(input, this.workspaceRoot);
  }

  public gameJobStatus(id: string): TrainingJob {
    return this.games.status(id);
  }

  public cancelGame(id: string): void {
    this.games.cancel(id);
  }

  public async close(): Promise<void> {
    await this.demoDirector.stopRecording();
    await this.omp.dispose();
    await this.tasks.close();
  }

  public subscribeOmp(listener: (event: OmpEvent) => void): () => void {
    return this.omp.subscribe(listener);
  }

  public ompStart(): Promise<OmpRuntimeState> {
    return this.omp.start();
  }

  public ompStop(): Promise<void> {
    return this.omp.stop();
  }

  public ompPrompt(message: string): Promise<void> {
    return this.omp.prompt(message);
  }

  public ompSteer(message: string): Promise<void> {
    return this.omp.steer(message);
  }

  public ompFollowUp(message: string): Promise<void> {
    return this.omp.followUp(message);
  }

  public ompSetThinkingLevel(
    level: OmpRuntimeState["thinkingLevel"],
  ): Promise<OmpRuntimeState> {
    return this.omp.setThinkingLevel(level);
  }

  public ompSetFastMode(enabled: boolean): Promise<OmpRuntimeState> {
    return this.omp.setFastMode(enabled);
  }

  public ompSetInterruptMode(
    mode: "immediate" | "wait",
  ): Promise<OmpRuntimeState> {
    return this.omp.setInterruptMode(mode);
  }

  public ompRenameSession(name: string): Promise<void> {
    return this.omp.renameSession(name);
  }

  public ompAvailableCommands(): Promise<
    Array<{ name: string; description?: string; aliases?: string[] }>
  > {
    return this.omp.availableCommands();
  }

  public ompMessages(cursor?: string): Promise<{
    messages: OmpMessageView[];
    nextCursor?: string;
    totalMessages: number;
  }> {
    return this.omp.messages(cursor);
  }
  public ompSessionStats(): Promise<OmpSessionStats> {
    return this.omp.sessionStats();
  }

  public ompAdvanced(
    input: OmpAdvancedCommand,
  ): Promise<Record<string, unknown>> {
    return this.omp.advanced(input);
  }

  public ompSubagents(): Promise<OmpSubagentView[]> {
    return this.omp.subagents();
  }

  public ompAbort(): Promise<void> {
    return this.omp.abort();
  }

  public ompNewSession(): Promise<OmpRuntimeState> {
    return this.omp.newSession();
  }

  public ompState(): Promise<OmpRuntimeState> {
    return this.omp.state();
  }

  public ompListSessions(): Promise<OmpSessionInfo[]> {
    return this.omp.listSessions();
  }

  public ompSwitchSession(path: string): Promise<OmpRuntimeState> {
    return this.omp.switchSession(path);
  }

  public ompSetModel(
    provider: string,
    modelId: string,
  ): Promise<OmpRuntimeState> {
    return this.omp.setModel(provider, modelId);
  }

  public ompListModels(): Promise<OmpModelInfo[]> {
    return this.omp.listModels();
  }

  public ompListSubagentModels(): Promise<OmpSubagentModel[]> {
    return this.omp.listSubagentModels();
  }

  public ompSetSubagentModels(
    selectors: string[],
  ): Promise<OmpSubagentModel[]> {
    return this.omp.setSubagentModels(selectors);
  }

  public ompSetTodos(phases: OmpTodoPhase[]): Promise<void> {
    return this.omp.setTodos(phases);
  }

  public ompExportHtml(): Promise<string> {
    return this.omp.exportHtml();
  }

  public ompLoginProviders(): Promise<Array<{ id: string }>> {
    return this.omp.loginProviders();
  }

  public ompLogin(providerId: string): Promise<void> {
    return this.omp.login(providerId);
  }

  public ompRespondUi(
    requestId: string,
    response: {
      value?: string;
      confirmed?: boolean;
      cancelled?: boolean;
    },
  ): Promise<void> {
    return this.omp.respondUi(requestId, response);
  }

  public ompApproveHostTool(callId: string, approvedBy: string): Promise<void> {
    return this.omp.approveHostTool(callId, approvedBy);
  }

  public ompRejectHostTool(callId: string): Promise<void> {
    return this.omp.rejectHostTool(callId);
  }

  public accountStatus(): Promise<AccountStatus> {
    return this.account.status();
  }

  public accountLogin(email: string): Promise<AccountStatus> {
    return this.account.login(email);
  }

  public accountLogout(): Promise<AccountStatus> {
    return this.account.logout();
  }

  public accountUpdateProfile(
    profile: Partial<Omit<UserProfile, "userId">>,
  ): Promise<AccountStatus> {
    return this.account.updateProfile(profile);
  }

  public librarySearch(
    params: LibrarySearchParams,
  ): Promise<LibrarySearchResult> {
    return this.library.search(params);
  }

  public libraryDetail(id: string): Promise<SkillDetail> {
    return this.library.detail(id);
  }

  public libraryVersions(id: string): Promise<SkillVersionSummary[]> {
    return this.library.versions(id);
  }

  public libraryRate(id: string, rating: number): Promise<SkillDetail> {
    return this.library.rate(id, rating);
  }

  public libraryDownload(id: string): Promise<LibrarySkillSummary> {
    return this.library.download(id);
  }

  public theme(): Promise<ThemeSettings> {
    return this.uiSettings.load();
  }

  public setTheme(theme: "light" | "dark"): Promise<ThemeSettings> {
    return this.uiSettings.save(theme);
  }

  private async loadSecurityConfiguration(): Promise<SecurityConfiguration> {
    const configuration = await this.securitySettings.load();
    this.tasks.setSlowPathProfile(configuration.slowPathProfile);
    return configuration;
  }
}
