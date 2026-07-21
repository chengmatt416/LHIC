const { contextBridge, ipcRenderer } = require("electron");

/**
 * Electron executes sandboxed preload scripts as CommonJS, even when the app
 * package is ESM. Keep this bridge dependency-free and deliberately narrow.
 */
contextBridge.exposeInMainWorld("lhic", {
  dashboard: () => ipcRenderer.invoke("lhic:dashboard"),
  tasks: {
    configure: (source) => ipcRenderer.invoke("lhic:task:configure", source),
    autoConfigure: () => ipcRenderer.invoke("lhic:task:auto-configure"),
    start: (input) => ipcRenderer.invoke("lhic:task:start", input),
    execute: (commandId) => ipcRenderer.invoke("lhic:task:execute", commandId),
    approve: (commandId, approval) =>
      ipcRenderer.invoke("lhic:task:approve", commandId, approval),
    cancel: (commandId) => ipcRenderer.invoke("lhic:task:cancel", commandId),
  },
  skills: {
    connect: (input) => ipcRenderer.invoke("lhic:skills:connect", input),
    login: (email) => ipcRenderer.invoke("lhic:skills:login", email),
    status: () => ipcRenderer.invoke("lhic:skills:status"),
    sync: () => ipcRenderer.invoke("lhic:skills:sync"),
    exportApproved: (destination) =>
      ipcRenderer.invoke("lhic:skills:export", destination),
    trainPublicWeb: (input) =>
      ipcRenderer.invoke("lhic:skills:train-public-web", input),
    trainingStatus: (jobId) =>
      ipcRenderer.invoke("lhic:skills:training-status", jobId),
    cancelTraining: (jobId) =>
      ipcRenderer.invoke("lhic:skills:cancel-training", jobId),
  },
  mcp: {
    preview: (client, workspaceRoot) =>
      ipcRenderer.invoke("lhic:mcp:preview", client, workspaceRoot),
    apply: (client, workspaceRoot, confirmationToken) =>
      ipcRenderer.invoke(
        "lhic:mcp:apply",
        client,
        workspaceRoot,
        confirmationToken,
      ),
    probe: (client, workspaceRoot) =>
      ipcRenderer.invoke("lhic:mcp:probe", client, workspaceRoot),
  },
  demo: {
    preflight: () => ipcRenderer.invoke("lhic:demo:preflight"),
    dispatchCodex: (input) =>
      ipcRenderer.invoke("lhic:demo:dispatch-codex", input),
    codexRunStatus: () => ipcRenderer.invoke("lhic:demo:codex-run-status"),
    approveCodexPermission: (approvedBy) =>
      ipcRenderer.invoke("lhic:demo:approve-codex-permission", approvedBy),
    startFastPath: () => ipcRenderer.invoke("lhic:demo:start-fast-path"),
    focusLhic: () => ipcRenderer.invoke("lhic:demo:focus-lhic"),
    launchChallenge: () => ipcRenderer.invoke("lhic:demo:launch-challenge"),
    candidates: () => ipcRenderer.invoke("lhic:demo:candidates"),
    startRecording: () => ipcRenderer.invoke("lhic:demo:recording:start"),
    saveRecordingClip: () =>
      ipcRenderer.invoke("lhic:demo:recording:save-clip"),
    stopRecording: () => ipcRenderer.invoke("lhic:demo:recording:stop"),
    recordingStatus: () => ipcRenderer.invoke("lhic:demo:recording:status"),
    startTimer: (kind) => ipcRenderer.invoke("lhic:demo:timer:start", kind),
    stopTimer: () => ipcRenderer.invoke("lhic:demo:timer:stop"),
  },
  game: {
    inspectRuntime: () => ipcRenderer.invoke("lhic:game:inspect-runtime"),
    prepareRuntime: () => ipcRenderer.invoke("lhic:game:prepare-runtime"),
    validate: (profile) => ipcRenderer.invoke("lhic:game:validate", profile),
    run: (input) => ipcRenderer.invoke("lhic:game:run", input),
    packagePolicy: (input) =>
      ipcRenderer.invoke("lhic:game:package-policy", input),
    submitPolicy: (input) =>
      ipcRenderer.invoke("lhic:game:submit-policy", input),
    status: (jobId) => ipcRenderer.invoke("lhic:game:status", jobId),
    cancel: (jobId) => ipcRenderer.invoke("lhic:game:cancel", jobId),
  },
  judge: {
    beginGithubLogin: () => ipcRenderer.invoke("lhic:judge:begin-github-login"),
    pollGithubLogin: () => ipcRenderer.invoke("lhic:judge:poll-github-login"),
    session: () => ipcRenderer.invoke("lhic:judge:session"),
    authorizeToken: (token) =>
      ipcRenderer.invoke("lhic:judge:authorize-token", token),
    catalog: () => ipcRenderer.invoke("lhic:judge:catalog"),
    policyPackages: () => ipcRenderer.invoke("lhic:judge:policy-packages"),
  },
  security: {
    configuration: () => ipcRenderer.invoke("lhic:security:configuration"),
    configure: (input) => ipcRenderer.invoke("lhic:security:configure", input),
  },
  admin: {
    snapshot: () => ipcRenderer.invoke("lhic:admin:snapshot"),
    createJudge: (input) =>
      ipcRenderer.invoke("lhic:admin:create-judge", input),
    revokeJudge: (id) => ipcRenderer.invoke("lhic:admin:revoke-judge", id),
    createJudgeToken: (input) =>
      ipcRenderer.invoke("lhic:admin:create-judge-token", input),
    revokeJudgeToken: (id) =>
      ipcRenderer.invoke("lhic:admin:revoke-judge-token", id),
    setSkillStatus: (id, status) =>
      ipcRenderer.invoke("lhic:admin:set-skill-status", id, status),
    setPolicyPackageStatus: (id, status) =>
      ipcRenderer.invoke("lhic:admin:set-policy-package-status", id, status),
    createDemoKey: (input) =>
      ipcRenderer.invoke("lhic:admin:create-demo-key", input),
    revokeDemoKey: (id) => ipcRenderer.invoke("lhic:admin:revoke-demo-key", id),
    createSecret: (input) =>
      ipcRenderer.invoke("lhic:admin:create-secret", input),
    revokeSecret: (id) => ipcRenderer.invoke("lhic:admin:revoke-secret", id),
    createAsset: (input) =>
      ipcRenderer.invoke("lhic:admin:create-asset", input),
    retireAsset: (id) => ipcRenderer.invoke("lhic:admin:retire-asset", id),
  },
  credentials: {
    set: (id, secret) => ipcRenderer.invoke("lhic:credential:set", id, secret),
    has: (id) => ipcRenderer.invoke("lhic:credential:has", id),
    remove: (id) => ipcRenderer.invoke("lhic:credential:remove", id),
  },
  events: {
    onProgress: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on("lhic:progress", handler);
      return () => ipcRenderer.removeListener("lhic:progress", handler);
    },
  },
});
