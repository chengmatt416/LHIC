import {
  app,
  BrowserWindow,
  ipcMain as electronIpcMain,
  screen,
  session,
  shell,
} from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  GameProfile,
  GameTrainingRequest,
  DemoCodexDispatchRequest,
  JudgeDemoAsset,
  McpClientKind,
  SharedLibraryConnection,
  TaskApproval,
  TaskSourceConfig,
  PublicWebTrainingRequest,
  PolicyPackageRequest,
  PolicyPackageSubmission,
  SecurityConfiguration,
  LibrarySearchParams,
  OmpAdvancedCommand,
  OmpRuntimeState,
  OmpTodoPhase,
  UserProfile,
} from "../shared/contracts.js";
import { validateCustomGameProfile } from "../shared/policy.js";
import { DesktopController } from "./controller.js";
import {
  isAllowedExternalUrl,
  isTrustedRendererUrl,
  type RendererNavigationPolicy,
} from "./window-security.js";
import { resolveDesktopWorkspaceRoot } from "./workspace-root.js";

let controller: DesktopController;
let isQuitting = false;
let mainWindow: BrowserWindow | undefined;
let timerOverlay: BrowserWindow | undefined;
const rendererNavigationPolicy: RendererNavigationPolicy = {
  rendererFileUrl: pathToFileURL(
    join(import.meta.dirname, "../../renderer/index.html"),
  ).toString(),
  allowedSearches: ["", "?demo=1"],
  ...(process.env.LHIC_DESKTOP_DEV_SERVER
    ? { devServerUrl: process.env.LHIC_DESKTOP_DEV_SERVER }
    : {}),
};

const ipcMain = { handle: registerSecureIpcHandler };

async function createWindow(): Promise<void> {
  const demoMode = process.env.LHIC_DESKTOP_DEMO === "1";
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    fullscreen: demoMode,
    backgroundColor: "#071827",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(import.meta.dirname, "../preload/preload.cjs"),
    },
  });
  mainWindow = window;
  const unsubscribeProgress = controller.subscribeProgress((event) => {
    if (!window.isDestroyed()) {
      window.webContents.send("lhic:progress", event);
    }
  });
  const unsubscribeOmp = controller.subscribeOmp((event) => {
    if (!window.isDestroyed()) {
      window.webContents.send("lhic:omp:event", event);
    }
  });
  window.once("closed", () => {
    unsubscribeProgress();
    unsubscribeOmp();
    if (mainWindow === window) {
      mainWindow = undefined;
      hideTimerOverlay();
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void openExternalUrl(url).catch(() => undefined);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url, rendererNavigationPolicy))
      event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  const devServer = process.env.LHIC_DESKTOP_DEV_SERVER;
  if (devServer) {
    await window.loadURL(demoMode ? `${devServer}?demo=1` : devServer);
  } else {
    await window.loadFile(
      join(import.meta.dirname, "../../renderer/index.html"),
      demoMode ? { query: { demo: "1" } } : undefined,
    );
  }
}

function registerSecureIpcHandler<Args extends unknown[], Result>(
  channel: string,
  handler: (
    event: Electron.IpcMainInvokeEvent,
    ...args: Args
  ) => Result | Promise<Result>,
): void {
  electronIpcMain.handle(channel, (event, ...args) => {
    const senderUrl = event.senderFrame?.url ?? event.sender.getURL();
    if (!isTrustedRendererUrl(senderUrl, rendererNavigationPolicy)) {
      throw new Error("Untrusted renderer cannot invoke desktop capabilities.");
    }
    return handler(event, ...(args as Args));
  });
}

function registerIpc(): void {
  ipcMain.handle("lhic:dashboard", async () => controller.dashboard());
  ipcMain.handle("lhic:task:configure", (_event, source: TaskSourceConfig) =>
    controller.configureTaskSource(requiredTaskSource(source)),
  );
  ipcMain.handle("lhic:task:auto-configure", () =>
    controller.autoConfigureTaskSources(),
  );
  ipcMain.handle(
    "lhic:task:start",
    (_event, input: { goal: string; startUrl?: string; sourceId?: string }) =>
      controller.startTask({
        goal: requiredString(input?.goal, "task goal"),
        ...(input?.startUrl === undefined || input.startUrl === ""
          ? {}
          : { startUrl: requiredString(input.startUrl, "start URL") }),
        ...(input?.sourceId === undefined || input.sourceId === ""
          ? {}
          : { sourceId: requiredString(input.sourceId, "task source") }),
      }),
  );
  ipcMain.handle(
    "lhic:mcp:probe",
    (_event, client: McpClientKind, workspaceRoot: string) =>
      controller.probeMcp(
        requiredMcpClient(client),
        requiredString(workspaceRoot, "workspace root"),
      ),
  );
  ipcMain.handle(
    "lhic:task:approve",
    (_event, commandId: string, approval?: TaskApproval) =>
      controller.approveTask(
        requiredString(commandId, "command id"),
        approval === undefined ? undefined : requiredTaskApproval(approval),
      ),
  );
  ipcMain.handle("lhic:task:execute", (_event, commandId: string) =>
    controller.executeTask(requiredString(commandId, "command id")),
  );
  ipcMain.handle("lhic:task:cancel", (_event, commandId: string) =>
    controller.cancelTask(requiredString(commandId, "command id")),
  );
  ipcMain.handle("lhic:skills:sync", () => controller.syncSkills());
  ipcMain.handle("lhic:skills:status", () => controller.sharedSkillsStatus());
  ipcMain.handle(
    "lhic:skills:connect",
    (_event, input: SharedLibraryConnection) =>
      controller.connectSharedSkills(requiredSharedLibraryConnection(input)),
  );
  ipcMain.handle("lhic:skills:login", (_event, email: string) =>
    controller.loginSharedSkills(requiredString(email, "shared Skill email")),
  );
  ipcMain.handle("lhic:skills:export", (_event, destination: string) =>
    controller.exportApprovedSkills(requiredString(destination, "destination")),
  );
  ipcMain.handle("lhic:skills:train-public-web", (_event, input: unknown) =>
    controller.startPublicWebTraining(requiredPublicWebTrainingRequest(input)),
  );
  ipcMain.handle("lhic:skills:training-status", (_event, jobId: string) =>
    controller.publicWebTrainingStatus(
      requiredString(jobId, "training job id"),
    ),
  );
  ipcMain.handle("lhic:skills:cancel-training", (_event, jobId: string) =>
    controller.cancelPublicWebTraining(
      requiredString(jobId, "training job id"),
    ),
  );
  ipcMain.handle(
    "lhic:mcp:preview",
    (_event, client: McpClientKind, workspaceRoot: string) =>
      controller.previewMcp(
        requiredMcpClient(client),
        requiredString(workspaceRoot, "workspace root"),
      ),
  );
  ipcMain.handle(
    "lhic:mcp:apply",
    (
      _event,
      client: McpClientKind,
      workspaceRoot: string,
      confirmationToken: string,
    ) =>
      controller.applyMcp(
        requiredMcpClient(client),
        requiredString(workspaceRoot, "workspace root"),
        requiredString(confirmationToken, "MCP confirmation token"),
      ),
  );
  ipcMain.handle("lhic:demo:preflight", () => controller.demoPreflight());
  ipcMain.handle("lhic:demo:dispatch-codex", (_event, input: unknown) =>
    controller.dispatchDemoCodex(requiredDemoCodexDispatch(input)),
  );
  ipcMain.handle("lhic:demo:codex-run-status", () =>
    controller.demoCodexRunStatus(),
  );
  ipcMain.handle(
    "lhic:demo:approve-codex-permission",
    (_event, approvedBy: string) =>
      controller.approveDemoCodexPermission(
        requiredString(approvedBy, "demo approver"),
      ),
  );
  ipcMain.handle("lhic:demo:start-fast-path", () =>
    controller.startDemoFastPath(),
  );
  ipcMain.handle("lhic:demo:focus-lhic", () => controller.focusDemoLhic());
  ipcMain.handle("lhic:demo:launch-challenge", () =>
    controller.launchDemoChallenge(),
  );
  ipcMain.handle("lhic:demo:candidates", () => controller.demoCandidates());
  ipcMain.handle("lhic:demo:recording:start", () =>
    controller.startDemoRecording(),
  );
  ipcMain.handle("lhic:demo:recording:save-clip", () =>
    controller.saveDemoRecordingClip(),
  );
  ipcMain.handle("lhic:demo:recording:stop", () =>
    controller.stopDemoRecording(),
  );
  ipcMain.handle("lhic:demo:recording:status", () =>
    controller.demoRecordingStatus(),
  );
  ipcMain.handle("lhic:demo:timer:start", (_event, kind: unknown) =>
    showTimerOverlay(requiredDemoTimerKind(kind)),
  );
  ipcMain.handle("lhic:demo:timer:stop", () => hideTimerOverlay());
  ipcMain.handle("lhic:game:validate", (_event, profile: GameProfile) =>
    controller.validateGame(profile),
  );
  ipcMain.handle("lhic:game:inspect-runtime", () =>
    controller.inspectGameRuntime(),
  );
  ipcMain.handle("lhic:game:prepare-runtime", () =>
    controller.prepareGameRuntime(),
  );
  ipcMain.handle("lhic:game:run", (_event, input: GameTrainingRequest) =>
    controller.runGame(requiredGameTrainingRequest(input)),
  );
  ipcMain.handle("lhic:game:package-policy", (_event, input: unknown) =>
    controller.packageGamePolicy(requiredPolicyPackageRequest(input)),
  );
  ipcMain.handle("lhic:game:submit-policy", (_event, input: unknown) =>
    controller.submitGamePolicyPackage(requiredPolicyPackageSubmission(input)),
  );
  ipcMain.handle("lhic:game:status", (_event, jobId: string) =>
    controller.gameJobStatus(requiredString(jobId, "game job id")),
  );
  ipcMain.handle("lhic:game:cancel", (_event, jobId: string) =>
    controller.cancelGame(requiredString(jobId, "game job id")),
  );
  ipcMain.handle("lhic:judge:begin-github-login", () =>
    controller.beginJudgeGithubLogin(),
  );
  ipcMain.handle("lhic:judge:poll-github-login", () =>
    controller.pollJudgeGithubLogin(),
  );
  ipcMain.handle("lhic:judge:session", () => controller.judgeSession());
  ipcMain.handle("lhic:judge:authorize-token", (_event, token: string) =>
    controller.authorizeJudgeToken(
      requiredString(token, "judge authorization token"),
    ),
  );
  ipcMain.handle("lhic:judge:catalog", () => controller.judgeCatalog());
  ipcMain.handle("lhic:judge:policy-packages", () =>
    controller.judgePolicyPackages(),
  );
  ipcMain.handle("lhic:security:configuration", () =>
    controller.securityConfiguration(),
  );
  ipcMain.handle("lhic:security:configure", (_event, input: unknown) =>
    controller.configureSecurity(requiredSecurityConfiguration(input)),
  );
  ipcMain.handle("lhic:admin:snapshot", () => controller.adminSnapshot());
  ipcMain.handle("lhic:admin:create-judge", (_event, input: unknown) => {
    const value = requiredRecord(input, "judge grant");
    const kind = value.kind;
    if (kind !== "github-user-id" && kind !== "github-email") {
      throw new Error("Judge grant type is invalid.");
    }
    return controller.createAdminJudge({
      kind,
      ...(kind === "github-user-id"
        ? { githubUserId: requiredString(value.githubUserId, "GitHub user ID") }
        : { githubEmail: requiredString(value.githubEmail, "GitHub email") }),
      label: requiredString(value.label, "judge label"),
      ...(value.expiresAt === undefined || value.expiresAt === ""
        ? {}
        : { expiresAt: requiredIsoDate(value.expiresAt, "judge expiration") }),
    });
  });
  ipcMain.handle("lhic:admin:revoke-judge", (_event, id: string) =>
    controller.revokeAdminJudge(requiredString(id, "judge grant ID")),
  );
  ipcMain.handle("lhic:admin:create-judge-token", (_event, input: unknown) => {
    const value = requiredRecord(input, "judge authorization token");
    return controller.createAdminJudgeToken({
      label: requiredString(value.label, "judge token label"),
      ...(value.expiresAt === undefined || value.expiresAt === ""
        ? {}
        : {
            expiresAt: requiredIsoDate(
              value.expiresAt,
              "judge token expiration",
            ),
          }),
      ...(value.maxUses === undefined || value.maxUses === ""
        ? {}
        : {
            maxUses: requiredPositiveInteger(
              value.maxUses,
              "judge token max uses",
            ),
          }),
    });
  });
  ipcMain.handle("lhic:admin:revoke-judge-token", (_event, id: string) =>
    controller.revokeAdminJudgeToken(requiredString(id, "judge token ID")),
  );
  ipcMain.handle(
    "lhic:admin:set-skill-status",
    (_event, id: string, status: unknown) =>
      controller.setSharedSkillStatus(
        requiredString(id, "shared Skill ID"),
        requiredSkillStatus(status),
      ),
  );
  ipcMain.handle(
    "lhic:admin:set-policy-package-status",
    (_event, id: string, status: unknown) =>
      controller.setPolicyPackageStatus(
        requiredString(id, "policy package ID"),
        requiredSkillStatus(status),
      ),
  );
  ipcMain.handle("lhic:admin:create-demo-key", (_event, input: unknown) => {
    const value = requiredRecord(input, "Demo API key");
    return controller.createDemoKey({
      label: requiredString(value.label, "Demo key label"),
      scopes: requiredScopes(value.scopes),
      ...(value.expiresAt === undefined || value.expiresAt === ""
        ? {}
        : {
            expiresAt: requiredIsoDate(value.expiresAt, "Demo key expiration"),
          }),
      ...(value.maxUses === undefined || value.maxUses === ""
        ? {}
        : {
            maxUses: requiredPositiveInteger(
              value.maxUses,
              "Demo key max uses",
            ),
          }),
    });
  });
  ipcMain.handle("lhic:admin:revoke-demo-key", (_event, id: string) =>
    controller.revokeDemoKey(requiredString(id, "Demo API key ID")),
  );
  ipcMain.handle("lhic:admin:create-secret", (_event, input: unknown) => {
    const value = requiredRecord(input, "credential");
    return controller.createSecret({
      label: requiredString(value.label, "credential label"),
      kind: requiredString(value.kind, "credential kind"),
      secret: requiredString(value.secret, "credential value"),
    });
  });
  ipcMain.handle("lhic:admin:revoke-secret", (_event, id: string) =>
    controller.revokeSecret(requiredString(id, "credential ID")),
  );
  ipcMain.handle("lhic:admin:create-asset", (_event, input: unknown) =>
    controller.createDemoAsset(requiredDemoAsset(input)),
  );
  ipcMain.handle("lhic:admin:retire-asset", (_event, id: string) =>
    controller.retireDemoAsset(requiredString(id, "demo asset ID")),
  );
  ipcMain.handle("lhic:credential:set", (_event, id: string, secret: string) =>
    controller.credentials.set(
      requiredString(id, "credential id"),
      requiredString(secret, "credential"),
    ),
  );
  ipcMain.handle("lhic:credential:has", (_event, id: string) =>
    controller.credentials.has(requiredString(id, "credential id")),
  );
  ipcMain.handle("lhic:credential:remove", (_event, id: string) =>
    controller.credentials.remove(requiredString(id, "credential id")),
  );
  ipcMain.handle("lhic:omp:start", () => controller.ompStart());
  ipcMain.handle("lhic:omp:stop", () => controller.ompStop());
  ipcMain.handle("lhic:omp:prompt", (_event, message: string) =>
    controller.ompPrompt(requiredString(message, "agent message")),
  );
  ipcMain.handle("lhic:omp:steer", (_event, message: string) =>
    controller.ompSteer(requiredString(message, "agent steering message")),
  );
  ipcMain.handle("lhic:omp:follow-up", (_event, message: string) =>
    controller.ompFollowUp(requiredString(message, "agent follow-up message")),
  );
  ipcMain.handle("lhic:omp:set-thinking-level", (_event, level: unknown) =>
    controller.ompSetThinkingLevel(requiredThinkingLevel(level)),
  );
  ipcMain.handle("lhic:omp:set-fast-mode", (_event, enabled: unknown) =>
    controller.ompSetFastMode(requiredBoolean(enabled, "fast mode")),
  );
  ipcMain.handle("lhic:omp:set-interrupt-mode", (_event, mode: unknown) =>
    controller.ompSetInterruptMode(requiredInterruptMode(mode)),
  );
  ipcMain.handle("lhic:omp:rename-session", (_event, name: string) =>
    controller.ompRenameSession(requiredString(name, "session name")),
  );
  ipcMain.handle("lhic:omp:available-commands", () =>
    controller.ompAvailableCommands(),
  );
  ipcMain.handle("lhic:omp:messages", (_event, cursor: unknown) =>
    controller.ompMessages(
      cursor === undefined || cursor === null || cursor === ""
        ? undefined
        : requiredString(cursor, "message cursor"),
    ),
  );
  ipcMain.handle("lhic:omp:session-stats", () => controller.ompSessionStats());
  ipcMain.handle("lhic:omp:advanced", (_event, input: unknown) =>
    controller.ompAdvanced(requiredOmpAdvancedCommand(input)),
  );
  ipcMain.handle("lhic:omp:subagents", () => controller.ompSubagents());
  ipcMain.handle("lhic:omp:abort", () => controller.ompAbort());
  ipcMain.handle("lhic:omp:new-session", () => controller.ompNewSession());
  ipcMain.handle("lhic:omp:state", () => controller.ompState());
  ipcMain.handle("lhic:omp:list-sessions", () => controller.ompListSessions());
  ipcMain.handle("lhic:omp:switch-session", (_event, path: string) =>
    controller.ompSwitchSession(requiredString(path, "session path")),
  );
  ipcMain.handle("lhic:omp:set-model", (_event, input: unknown) => {
    const value = requiredRecord(input, "model selection");
    return controller.ompSetModel(
      requiredString(value.provider, "model provider"),
      requiredString(value.modelId, "model id"),
    );
  });
  ipcMain.handle("lhic:omp:list-models", () => controller.ompListModels());
  ipcMain.handle("lhic:omp:list-subagent-models", () =>
    controller.ompListSubagentModels(),
  );
  ipcMain.handle("lhic:omp:set-subagent-models", (_event, selectors: unknown) =>
    controller.ompSetSubagentModels(requiredModelSelectors(selectors)),
  );
  ipcMain.handle("lhic:omp:set-todos", (_event, phases: unknown) =>
    controller.ompSetTodos(requiredOmpPhases(phases)),
  );
  ipcMain.handle("lhic:omp:export-html", () => controller.ompExportHtml());
  ipcMain.handle("lhic:omp:login-providers", () =>
    controller.ompLoginProviders(),
  );
  ipcMain.handle("lhic:omp:login", (_event, providerId: string) =>
    controller.ompLogin(requiredString(providerId, "provider id")),
  );
  ipcMain.handle("lhic:omp:provider-key:status", () =>
    controller.ompProviderKeyStatus(),
  );
  ipcMain.handle(
    "lhic:omp:provider-key:set",
    (_event, provider: string, key: string) =>
      controller.ompSetProviderKey(
        requiredString(provider, "provider id"),
        requiredString(key, "API key"),
      ),
  );
  ipcMain.handle("lhic:omp:provider-key:remove", (_event, provider: string) =>
    controller.ompRemoveProviderKey(requiredString(provider, "provider id")),
  );
  ipcMain.handle("lhic:omp:respond-ui", (_event, requestId, response) =>
    controller.ompRespondUi(
      requiredString(requestId, "agent UI request id"),
      requiredOmpUiResponse(response),
    ),
  );
  ipcMain.handle("lhic:omp:approve-host-tool", (_event, callId, approvedBy) =>
    controller.ompApproveHostTool(
      requiredString(callId, "host tool call id"),
      requiredString(approvedBy, "host tool approver"),
    ),
  );
  ipcMain.handle("lhic:omp:reject-host-tool", (_event, callId) =>
    controller.ompRejectHostTool(requiredString(callId, "host tool call id")),
  );
  ipcMain.handle("lhic:account:status", () => controller.accountStatus());
  ipcMain.handle("lhic:account:login", (_event, email: string) =>
    controller.accountLogin(requiredEmail(email)),
  );
  ipcMain.handle("lhic:account:logout", () => controller.accountLogout());
  ipcMain.handle("lhic:account:update-profile", (_event, profile: unknown) =>
    controller.accountUpdateProfile(requiredProfile(profile)),
  );
  ipcMain.handle("lhic:library:search", (_event, params: unknown) =>
    controller.librarySearch(requiredLibrarySearch(params)),
  );
  ipcMain.handle("lhic:library:detail", (_event, id: string) =>
    controller.libraryDetail(requiredString(id, "library skill id")),
  );
  ipcMain.handle("lhic:library:versions", (_event, id: string) =>
    controller.libraryVersions(requiredString(id, "library skill id")),
  );
  ipcMain.handle("lhic:library:rate", (_event, id: string, rating: unknown) =>
    controller.libraryRate(
      requiredString(id, "library skill id"),
      requiredRating(rating),
    ),
  );
  ipcMain.handle("lhic:library:download", (_event, id: string) =>
    controller.libraryDownload(requiredString(id, "library skill id")),
  );
  ipcMain.handle("lhic:settings:theme", () => controller.theme());
  ipcMain.handle("lhic:settings:set-theme", (_event, theme: unknown) =>
    controller.setTheme(requiredTheme(theme)),
  );
}

async function showTimerOverlay(kind: "slow" | "fast"): Promise<void> {
  hideTimerOverlay();
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = 344;
  const height = 104;
  const overlay = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - 18,
    y: workArea.y + 18,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  timerOverlay = overlay;
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.once("closed", () => {
    if (timerOverlay === overlay) timerOverlay = undefined;
  });
  await overlay.loadFile(
    join(import.meta.dirname, "../../renderer/timer-overlay.html"),
    {
      query: {
        label:
          kind === "slow" ? "SLOW PATH · CODEX + MCP" : "FAST PATH · LOCAL",
        accent: kind === "slow" ? "#ffb457" : "#71e3bc",
        startedAt: String(Date.now()),
      },
    },
  );
  if (!overlay.isDestroyed()) overlay.showInactive();
}

function hideTimerOverlay(): void {
  const overlay = timerOverlay;
  timerOverlay = undefined;
  if (overlay && !overlay.isDestroyed()) overlay.destroy();
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  controller = new DesktopController(
    resolveDesktopWorkspaceRoot({
      cwd: process.cwd(),
      environmentWorkspaceRoot: process.env.LHIC_WORKSPACE_ROOT,
      isPackaged: app.isPackaged,
      userData: app.getPath("userData"),
    }),
    {
      openExternal: openExternalUrl,
      focusLhicWindow: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return false;
        mainWindow.show();
        mainWindow.focus();
        return mainWindow.isFocused();
      },
      userDataDir: app.getPath("userData"),
      executionSourceDir: app.isPackaged
        ? join(process.resourcesPath, "execution")
        : join(
            import.meta.dirname,
            "..",
            "..",
            "..",
            "..",
            "packages",
            "skills",
            "src",
            "execution",
          ),
    },
  );
  registerIpc();
  void controller.provisioning.ensureProvisioned().then((steps) => {
    for (const step of steps) {
      console.log(`[provisioning] ${step.name}: ${step.message}`);
    }
  });
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (!controller || isQuitting) return;
  isQuitting = true;
  event.preventDefault();
  void controller.close().finally(() => app.exit());
});

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 16_384) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function requiredDemoCodexDispatch(value: unknown): DemoCodexDispatchRequest {
  const input = requiredRecord(value, "Codex demo dispatch");
  return {
    approvedBy: requiredString(input.approvedBy, "demo approver"),
  };
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function requiredSkillStatus(
  value: unknown,
): "approved" | "rejected" | "revoked" {
  if (value === "approved" || value === "rejected" || value === "revoked") {
    return value;
  }
  throw new Error("Shared Skill status is invalid.");
}

function requiredScopes(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 16 ||
    !value.every(
      (scope) =>
        typeof scope === "string" && /^[a-z][a-z0-9:_-]{0,63}$/.test(scope),
    )
  ) {
    throw new Error("Demo key scopes are invalid.");
  }
  return [...new Set(value)].sort();
}

function requiredModelSelectors(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    !value.every(
      (selector) =>
        typeof selector === "string" &&
        /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:/-]+$/.test(selector),
    )
  ) {
    throw new Error("OMP subagent model selectors are invalid.");
  }
  return [...new Set(value)];
}

function requiredIsoDate(value: unknown, name: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${name} is invalid.`);
  }
  return new Date(value).toISOString();
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 1_000_000
  ) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function requiredDemoAsset(
  value: unknown,
): Omit<JudgeDemoAsset, "id" | "createdAt"> {
  const asset = requiredRecord(value, "demo asset");
  const kind = requiredString(asset.kind, "demo asset kind");
  if (
    !["benchmark", "trace", "presentation", "guide", "report"].includes(kind)
  ) {
    throw new Error("Demo asset kind is invalid.");
  }
  const sourceUrl = requiredHttpsUrl(asset.sourceUrl, "demo asset source URL");
  const sha256 = requiredString(
    asset.sha256,
    "demo asset SHA-256",
  ).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("Demo asset SHA-256 is invalid.");
  }
  const generatedAt = requiredIsoDate(
    asset.generatedAt,
    "demo asset generation time",
  );
  const metadata = asset.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Demo asset metadata is invalid.");
  }
  return {
    title: requiredString(asset.title, "demo asset title"),
    kind: kind as JudgeDemoAsset["kind"],
    sourceUrl,
    generatedAt,
    sha256,
    metadata: metadata as Record<string, unknown>,
  };
}

function requiredHttpsUrl(value: unknown, name: string): string {
  const raw = requiredString(value, name);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is invalid.`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${name} must be a credential-free HTTPS URL.`);
  }
  return url.toString();
}

async function openExternalUrl(value: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("External navigation URL is invalid.");
  }
  if (!isAllowedExternalUrl(url.toString())) {
    throw new Error("Only HTTP(S) links may be opened externally.");
  }
  await shell.openExternal(url.toString());
}

function requiredPublicWebTrainingRequest(
  value: unknown,
): PublicWebTrainingRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Public-web training request is invalid.");
  }
  const input = value as Partial<PublicWebTrainingRequest>;
  if (
    ![
      "wikipedia-search",
      "mdn-search",
      "github-issue-filter",
      "openstreetmap-place-search",
    ].includes(input.scenarioId ?? "")
  ) {
    throw new Error("Public-web training scenario is invalid.");
  }
  const request: PublicWebTrainingRequest = {
    scenarioId: input.scenarioId as PublicWebTrainingRequest["scenarioId"],
    query: requiredString(input.query, "public-web training query"),
  };
  if (input.viewable !== undefined) {
    if (typeof input.viewable !== "boolean") {
      throw new Error("Public-web training view mode is invalid.");
    }
    request.viewable = input.viewable;
  }
  return request;
}

function requiredGameTrainingRequest(value: unknown): GameTrainingRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Game training request is invalid.");
  }
  const input = value as Partial<GameTrainingRequest>;
  if (
    (input.core !== "2d" && input.core !== "3d") ||
    !["setup", "lease", "record", "fit", "evaluate", "play"].includes(
      input.action ?? "",
    ) ||
    !["star-trooper", "nemesis", "epic-shooter-3d", "custom"].includes(
      input.profileId ?? "",
    )
  ) {
    throw new Error("Game training request is invalid.");
  }
  if (
    (input.core === "2d" && input.profileId !== "star-trooper") ||
    (input.core === "3d" && input.profileId === "star-trooper")
  ) {
    throw new Error("Game core does not match the selected target.");
  }
  const request: GameTrainingRequest = {
    core: input.core,
    action: input.action as GameTrainingRequest["action"],
    profileId: input.profileId as GameTrainingRequest["profileId"],
  };
  if (input.profileId === "custom") {
    if (!input.customProfile) {
      throw new Error("A custom recording requires a custom Game profile.");
    }
    request.customProfile = validateCustomGameProfile(input.customProfile);
  }
  if (input.windowTitle !== undefined) {
    request.windowTitle = requiredString(
      input.windowTitle,
      "game window title",
    );
  }
  if (input.approvedBy !== undefined) {
    request.approvedBy = requiredString(input.approvedBy, "operator identity");
  }
  if (input.resourcePath !== undefined) {
    request.resourcePath = requiredString(
      input.resourcePath,
      "game resource path",
    );
  }
  if (input.durationMs !== undefined) {
    if (
      !Number.isSafeInteger(input.durationMs) ||
      input.durationMs < 1_000 ||
      input.durationMs > 5 * 60_000
    ) {
      throw new Error("Game recording duration is invalid.");
    }
    request.durationMs = input.durationMs;
  }
  if (input.captureRegion !== undefined) {
    const region = input.captureRegion;
    if (
      ![region.x, region.y, region.width, region.height].every(
        Number.isSafeInteger,
      ) ||
      region.x < 0 ||
      region.y < 0 ||
      region.width < 1 ||
      region.height < 1
    ) {
      throw new Error("Game capture region is invalid.");
    }
    request.captureRegion = { ...region };
  }
  return request;
}

function requiredPolicyPackageRequest(value: unknown): PolicyPackageRequest {
  const input = requiredRecord(value, "policy package request");
  const request: PolicyPackageRequest = {
    artifactPath: requiredString(input.artifactPath, "policy artifact path"),
    destinationDirectory: requiredString(
      input.destinationDirectory,
      "policy package destination",
    ),
  };
  if (
    input.evaluationReportPath !== undefined &&
    input.evaluationReportPath !== ""
  ) {
    request.evaluationReportPath = requiredString(
      input.evaluationReportPath,
      "evaluation report path",
    );
  }
  return request;
}

function requiredPolicyPackageSubmission(
  value: unknown,
): PolicyPackageSubmission {
  const input = requiredRecord(value, "policy package submission");
  const packageValue = requiredRecord(input.package, "policy package");
  const core = packageValue.core;
  if (core !== "2d" && core !== "3d") {
    throw new Error("Policy package core is invalid.");
  }
  const packageRecord: PolicyPackageSubmission["package"] = {
    packageId: requiredSha256(packageValue.packageId, "policy package ID"),
    core,
    profileId: requiredString(packageValue.profileId, "policy profile ID"),
    artifactPath: requiredString(
      packageValue.artifactPath,
      "policy artifact path",
    ),
    manifestPath: requiredString(
      packageValue.manifestPath,
      "policy manifest path",
    ),
    bundlePath: requiredString(packageValue.bundlePath, "policy bundle path"),
    ...(packageValue.reportPath === undefined || packageValue.reportPath === ""
      ? {}
      : {
          reportPath: requiredString(
            packageValue.reportPath,
            "policy evaluation report path",
          ),
        }),
    actionCodec: requiredString(
      packageValue.actionCodec,
      "policy action codec",
    ),
    weightsSha256: requiredSha256(
      packageValue.weightsSha256,
      "policy weights digest",
    ),
    manifestSha256: requiredSha256(
      packageValue.manifestSha256,
      "policy manifest digest",
    ),
    bundleSha256: requiredSha256(
      packageValue.bundleSha256,
      "policy bundle digest",
    ),
    ...(packageValue.evaluationReportSha256 === undefined ||
    packageValue.evaluationReportSha256 === ""
      ? {}
      : {
          evaluationReportSha256: requiredSha256(
            packageValue.evaluationReportSha256,
            "policy evaluation report digest",
          ),
        }),
    status: "local",
    createdAt: requiredIsoDate(
      packageValue.createdAt,
      "policy package creation",
    ),
  };
  if (packageValue.status !== "local") {
    throw new Error("Only a local policy package may be submitted.");
  }
  return {
    package: packageRecord,
    bundleUrl: requiredString(input.bundleUrl, "policy bundle URL"),
    version: requiredString(input.version, "policy package version"),
  };
}

function requiredSecurityConfiguration(
  value: unknown,
): Pick<SecurityConfiguration, "slowPathProfile"> {
  const input = requiredRecord(value, "security configuration");
  if (
    input.slowPathProfile !== "fast_only" &&
    input.slowPathProfile !== "balanced" &&
    input.slowPathProfile !== "deliberative"
  ) {
    throw new Error("Slow Path safety profile is invalid.");
  }
  return { slowPathProfile: input.slowPathProfile };
}

function requiredSha256(value: unknown, label: string): string {
  const digest = requiredString(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`${label} must be a SHA-256 digest.`);
  }
  return digest;
}

function requiredMcpClient(value: unknown): McpClientKind {
  if (
    [
      "codex",
      "antigravity",
      "claude-code",
      "openclaw",
      "hermes",
      "custom",
    ].includes(value as string)
  ) {
    return value as McpClientKind;
  }
  throw new Error("MCP client is unsupported.");
}

function requiredDemoTimerKind(value: unknown): "slow" | "fast" {
  if (value === "slow" || value === "fast") return value;
  throw new Error("Demo timer kind is unsupported.");
}

function requiredTaskSource(value: unknown): TaskSourceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Task source is invalid.");
  }
  const source = value as Partial<TaskSourceConfig>;
  const kind = source.kind;
  if (
    typeof source.id !== "string" ||
    typeof source.label !== "string" ||
    typeof source.enabled !== "boolean" ||
    ![
      "codex-cli",
      "antigravity-cli",
      "claude-code-cli",
      "openai-responses",
      "gemini",
      "anthropic-messages",
      "openai-compatible",
    ].includes(kind ?? "")
  ) {
    throw new Error("Task source is invalid.");
  }
  return {
    id: source.id,
    kind: kind as TaskSourceConfig["kind"],
    label: source.label,
    enabled: source.enabled,
    ...(typeof source.model === "string" ? { model: source.model } : {}),
    ...(typeof source.endpoint === "string"
      ? { endpoint: source.endpoint }
      : {}),
    ...(source.protocol === "responses" ||
    source.protocol === "chat-completions"
      ? { protocol: source.protocol }
      : {}),
    ...(typeof source.credentialId === "string"
      ? { credentialId: source.credentialId }
      : {}),
    ...(typeof source.maxOutputTokens === "number"
      ? { maxOutputTokens: source.maxOutputTokens }
      : {}),
  };
}

function requiredTaskApproval(value: unknown): TaskApproval {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Task approval is invalid.");
  }
  const approval = value as Partial<TaskApproval>;
  if (
    ![
      approval.approvalId,
      approval.actionHash,
      approval.approvedBy,
      approval.approvedAt,
      approval.expiresAt,
    ].every((field) => typeof field === "string" && field.trim()) ||
    (approval.signature !== undefined && typeof approval.signature !== "string")
  ) {
    throw new Error("Task approval is invalid.");
  }
  return {
    approvalId: approval.approvalId!,
    actionHash: approval.actionHash!,
    approvedBy: approval.approvedBy!,
    approvedAt: approval.approvedAt!,
    expiresAt: approval.expiresAt!,
    ...(approval.signature ? { signature: approval.signature } : {}),
  };
}

function requiredSharedLibraryConnection(
  value: unknown,
): SharedLibraryConnection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Shared Skill connection is invalid.");
  }
  const connection = value as Partial<SharedLibraryConnection>;
  return {
    endpoint: requiredString(connection.endpoint, "Appwrite endpoint"),
    projectId: requiredString(connection.projectId, "Appwrite project ID"),
    functionUrl: requiredString(
      connection.functionUrl,
      "Appwrite Function URL",
    ),
    email: requiredString(connection.email, "shared Skill email"),
  };
}

function requiredEmail(value: unknown): string {
  const email = requiredString(value, "email");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("email is invalid.");
  }
  return email;
}

function requiredRating(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 5
  ) {
    throw new Error("Skill rating is invalid.");
  }
  return value as number;
}

function requiredLibrarySearch(value: unknown): LibrarySearchParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Library search is invalid.");
  }
  const input = value as Partial<LibrarySearchParams>;
  return {
    ...(input.category === undefined || input.category === ""
      ? {}
      : { category: requiredString(input.category, "library category") }),
    ...(input.q === undefined || input.q === ""
      ? {}
      : { q: requiredString(input.q, "library query") }),
    ...(input.cursor === undefined || input.cursor === ""
      ? {}
      : { cursor: requiredString(input.cursor, "library cursor") }),
  };
}

function requiredProfile(value: unknown): Partial<Omit<UserProfile, "userId">> {
  const input = requiredRecord(value, "user profile");
  const profile: Partial<Omit<UserProfile, "userId">> = {};
  if (input.displayName !== undefined) {
    const displayName = input.displayName;
    if (
      typeof displayName !== "string" ||
      !displayName.trim() ||
      displayName.length > 128
    ) {
      throw new Error("displayName is invalid.");
    }
    profile.displayName = displayName;
  }
  if (input.bio !== undefined) {
    const bio = input.bio;
    if (typeof bio !== "string" || bio.length > 512) {
      throw new Error("bio is invalid.");
    }
    profile.bio = bio;
  }
  if (input.avatarUrl !== undefined) {
    const avatarUrl = input.avatarUrl;
    if (typeof avatarUrl !== "string" || avatarUrl.length > 2048) {
      throw new Error("avatarUrl is invalid.");
    }
    profile.avatarUrl = avatarUrl;
  }
  return profile;
}

function requiredOmpUiResponse(value: unknown): {
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
} {
  const input = requiredRecord(value, "agent UI response");
  const response: { value?: string; confirmed?: boolean; cancelled?: boolean } =
    {};
  if (input.value !== undefined) {
    response.value = requiredString(input.value, "agent UI response value");
  }
  if (input.confirmed !== undefined) {
    if (typeof input.confirmed !== "boolean") {
      throw new Error("agent UI confirmation is invalid.");
    }
    response.confirmed = input.confirmed;
  }
  if (input.cancelled !== undefined) {
    if (typeof input.cancelled !== "boolean") {
      throw new Error("agent UI cancellation is invalid.");
    }
    response.cancelled = input.cancelled;
  }
  return response;
}

function requiredOmpAdvancedCommand(value: unknown): OmpAdvancedCommand {
  const input = requiredRecord(value, "OMP advanced command");
  const allowed = new Set<OmpAdvancedCommand["command"]>([
    "abortAndPrompt",
    "cycleModel",
    "cycleThinkingLevel",
    "compact",
    "setAutoCompaction",
    "setAutoRetry",
    "abortRetry",
    "bash",
    "abortBash",
    "setSteeringMode",
    "setFollowUpMode",
    "branch",
    "getBranchMessages",
    "getLastAssistantText",
    "handoff",
    "setSubagentSubscription",
    "getSubagentMessages",
  ]);
  if (
    typeof input.command !== "string" ||
    !allowed.has(input.command as OmpAdvancedCommand["command"])
  ) {
    throw new Error("OMP advanced command is invalid.");
  }
  const command: OmpAdvancedCommand = {
    command: input.command as OmpAdvancedCommand["command"],
  };
  if (input.message !== undefined) {
    command.message = requiredString(input.message, "OMP command message");
  }
  if (input.entryId !== undefined) {
    command.entryId = requiredString(input.entryId, "OMP branch entry id");
  }
  if (input.subagentId !== undefined) {
    command.subagentId = requiredString(input.subagentId, "OMP subagent id");
  }
  if (input.sessionFile !== undefined) {
    command.sessionFile = requiredString(
      input.sessionFile,
      "OMP subagent session file",
    );
  }
  if (input.fromByte !== undefined) {
    if (
      typeof input.fromByte !== "number" ||
      !Number.isSafeInteger(input.fromByte) ||
      input.fromByte < 0
    ) {
      throw new Error("OMP subagent byte offset is invalid.");
    }
    command.fromByte = input.fromByte;
  }
  if (input.enabled !== undefined) {
    command.enabled = requiredBoolean(input.enabled, "OMP command enabled");
  }
  if (input.mode !== undefined) {
    if (input.mode !== "all" && input.mode !== "one-at-a-time") {
      throw new Error("OMP queue mode is invalid.");
    }
    command.mode = input.mode;
  }
  if (input.subscription !== undefined) {
    if (
      input.subscription !== "off" &&
      input.subscription !== "progress" &&
      input.subscription !== "events"
    ) {
      throw new Error("OMP subagent subscription is invalid.");
    }
    command.subscription = input.subscription;
  }
  return command;
}

function requiredOmpPhases(value: unknown): OmpTodoPhase[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error("agent todos are invalid.");
  }
  return value.map((phase) => {
    const record = requiredRecord(phase, "agent todo phase");
    const tasks = record.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > 200) {
      throw new Error("agent todo phase tasks are invalid.");
    }
    return {
      id: requiredString(record.id, "agent todo phase id"),
      name: requiredString(record.name, "agent todo phase name"),
      tasks: tasks.map((task) => {
        const taskRecord = requiredRecord(task, "agent todo task");
        const status = taskRecord.status;
        if (
          status !== "pending" &&
          status !== "in_progress" &&
          status !== "completed"
        ) {
          throw new Error("agent todo task status is invalid.");
        }
        return {
          id: requiredString(taskRecord.id, "agent todo task id"),
          content: requiredString(
            taskRecord.content,
            "agent todo task content",
          ),
          status,
        };
      }),
    };
  });
}

function requiredTheme(value: unknown): "light" | "dark" {
  if (value === "light" || value === "dark") return value;
  throw new Error("theme is invalid.");
}

function requiredThinkingLevel(
  value: unknown,
): NonNullable<OmpRuntimeState["thinkingLevel"]> {
  if (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  ) {
    return value;
  }
  throw new Error("agent thinking level is invalid.");
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function requiredInterruptMode(value: unknown): "immediate" | "wait" {
  if (value === "immediate" || value === "wait") return value;
  throw new Error("agent interrupt mode is invalid.");
}
