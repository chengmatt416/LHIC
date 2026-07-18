import type {
  CommandEvent,
  DesktopProgressEvent,
  AdminControlSnapshot,
  AdminJudgeGrant,
  JudgeAuthTokenMetadata,
  AdminSecretMetadata,
  AdminSkillReview,
  DemoApiKeyMetadata,
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
} from "../shared/contracts.js";
import { DesktopCredentialStore } from "./keyring.js";
import { ControlPlaneClient } from "./control-plane-client.js";
import { GameService } from "./game-service.js";
import { McpService } from "./mcp-service.js";
import { SkillsService } from "./skills-service.js";
import { SecuritySettingsStore } from "./security-settings-store.js";
import { TaskService } from "./task-service.js";

export class DesktopController {
  public readonly credentials = new DesktopCredentialStore();
  private readonly tasks: TaskService;
  private readonly games = new GameService();
  private readonly skills: SkillsService;
  private readonly mcp: McpService;
  private readonly controlPlane: ControlPlaneClient;
  private readonly securitySettings: SecuritySettingsStore;
  private securityInitialization: Promise<SecurityConfiguration> | undefined;

  public constructor(
    private readonly workspaceRoot: string,
    options: { openExternal?: (url: string) => Promise<void> } = {},
  ) {
    this.tasks = new TaskService(workspaceRoot, this.credentials);
    this.skills = new SkillsService(workspaceRoot);
    this.mcp = new McpService(workspaceRoot);
    this.controlPlane = new ControlPlaneClient(workspaceRoot, {
      ...options,
      judgeTokenStore: this.credentials,
    });
    this.securitySettings = new SecuritySettingsStore(workspaceRoot);
  }

  public async dashboard(): Promise<DashboardSnapshot> {
    await Promise.all([this.tasks.initialize(), this.securityConfiguration()]);
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

  public cancelTask(commandId: string): void {
    this.tasks.cancel(commandId);
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

  public close(): Promise<void> {
    return this.tasks.close();
  }

  private async loadSecurityConfiguration(): Promise<SecurityConfiguration> {
    const configuration = await this.securitySettings.load();
    this.tasks.setSlowPathProfile(configuration.slowPathProfile);
    return configuration;
  }
}
