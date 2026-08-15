import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type {
  ActionExecutionResult,
  ActionMethod,
  BrowserSemanticAction,
  TraceEvent,
  VerificationResult,
} from "@lhic/schema";
import {
  FileApprovalReplayStore,
  isSideEffectActivationTarget,
  validateActionApproval,
  type ActionApproval,
  type ApprovalReplayStore,
  type ActionApprovalValidationOptions,
  type ProductionRuntimeConfig,
} from "@lhic/security";
import { appendTraceEvent, hashState } from "@lhic/trace";
import type { Page } from "playwright";

import { resolveTarget, type ResolvedTarget } from "./target-resolver.js";

const supportedMethods: readonly ActionMethod[] = [
  "api",
  "dom",
  "accessibility",
  "keyboard",
];

export interface PlaywrightDirectExecutorOptions {
  taskId?: string;
  traceFilePath?: string;
  navigationPolicy?: NavigationPolicy;
  actionTimeoutMs?: number;
  maxWaitMs?: number;
  approvalValidation?: ActionApprovalValidationOptions;
  approvalReplayStore?: ApprovalReplayStore;
  selectorMemory?: {
    find(
      skillName: string,
      target: string,
    ): Array<{ selector: string; role?: string; label?: string }>;
    remember?(
      entry: {
        skillName: string;
        target: string;
        selector: string;
        role?: string;
        label?: string;
      },
      verification: unknown,
    ): boolean;
  };
  /**
   * Retained for caller compatibility. Action values are always redacted from
   * persisted traces.
   */
  redactActionValues?: true;
  /** Directory used by supported semantic download actions. */
  downloadDirectory?: string;
  /** Resolve hostnames before browser navigation. Primarily injectable for tests. */
  resolveHostname?: HostnameResolver;
}

export interface NavigationPolicy {
  allowedProtocols?: readonly string[];
  allowedOrigins?: readonly string[];
  allowPrivateNetwork?: boolean;
}

export interface ProductionExecutorOptions {
  taskId?: string;
  traceFilePath?: string;
  approvalReplayStore?: ApprovalReplayStore;
  selectorMemory?: PlaywrightDirectExecutorOptions["selectorMemory"];
  resolveHostname?: HostnameResolver;
}

export type HostnameResolver = (hostname: string) => Promise<readonly string[]>;

const defaultActionTimeoutMs = 10_000;
const defaultMaxWaitMs = 30_000;
const defaultAllowedProtocols = ["https:", "http:"] as const;

export class PlaywrightDirectExecutor {
  private readonly taskId: string;
  private readonly traceFilePath: string;
  private readonly navigationPolicy: NavigationPolicy;
  private readonly actionTimeoutMs: number;
  private readonly maxWaitMs: number;
  private readonly approvalValidation: ActionApprovalValidationOptions;
  private readonly approvalReplayStore: ApprovalReplayStore | undefined;
  private readonly selectorMemory?: PlaywrightDirectExecutorOptions["selectorMemory"];
  private readonly redactActionValues: boolean;
  private readonly downloadDirectory: string;
  private readonly resolveHostname: HostnameResolver;
  private readonly navigationPolicyReady: Promise<unknown>;
  private blockedNavigation: Error | undefined;
  private lastResolvedTarget:
    { actionHash: string; memory: ResolvedTarget["memory"] } | undefined;

  public constructor(
    private page: Page,
    options: PlaywrightDirectExecutorOptions = {},
  ) {
    this.taskId = options.taskId ?? "browser-session";
    this.traceFilePath =
      options.traceFilePath ?? join("traces", `${this.taskId}.jsonl`);
    this.navigationPolicy = options.navigationPolicy ?? {};
    this.actionTimeoutMs = normalizeTimeout(
      options.actionTimeoutMs,
      defaultActionTimeoutMs,
      "actionTimeoutMs",
    );
    this.maxWaitMs = normalizeTimeout(
      options.maxWaitMs,
      defaultMaxWaitMs,
      "maxWaitMs",
    );
    this.approvalValidation = options.approvalValidation ?? {};
    this.approvalReplayStore = options.approvalReplayStore;
    this.selectorMemory = options.selectorMemory;
    this.redactActionValues = true;
    this.downloadDirectory = options.downloadDirectory ?? "downloads";
    this.resolveHostname =
      options.resolveHostname ?? resolveHostnameToAddresses;
    this.page.setDefaultTimeout(this.actionTimeoutMs);
    this.navigationPolicyReady = this.page
      .route("**/*", async (route) => {
        try {
          if (!route.request().isNavigationRequest()) {
            await route.fallback();
            return;
          }

          try {
            await this.validateNavigationTarget(route.request().url());
            await route.fallback();
          } catch (error) {
            if (this.page.isClosed()) return;
            this.blockedNavigation =
              error instanceof Error
                ? error
                : new Error("Navigation policy rejected the request.");
            await route.abort("blockedbyclient").catch(() => {
              // The browser may close while a navigation is being rejected.
            });
          }
        } catch {
          // Playwright can reject a pending route callback during page teardown.
        }
      })
      .catch((error: unknown) => {
        if (this.page.isClosed()) return;
        throw error;
      });
  }

  private async waitForStability(): Promise<void> {
    // DOMContentLoaded resolves immediately for an already-loaded document,
    // unlike networkidle which burns its full timeout on polling/websocket apps.
    // Playwright locators still auto-wait for actionable targets.
    await this.page
      .waitForLoadState("domcontentloaded", { timeout: 1500 })
      .catch(() => {});
    await this.page
      .evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      )
      .catch(() => {});
  }

  public async execute(
    action: BrowserSemanticAction,
    approval?: ActionApproval,
  ): Promise<ActionExecutionResult> {
    const startedAt = performance.now();
    await this.trace("action_started", { action });

    try {
      await this.navigationPolicyReady;
      if (
        !action.methodPreference.some((method) =>
          supportedMethods.includes(method),
        )
      ) {
        throw new Error("Action does not permit a Fast Path execution method.");
      }

      await this.waitForStability();

      const resolvedActionTarget = await this.resolveActionTarget(action);
      this.lastResolvedTarget = resolvedActionTarget
        ? {
            actionHash: hashState(action),
            memory: resolvedActionTarget.memory,
          }
        : undefined;
      if (action.type === "click" && resolvedActionTarget?.href) {
        await this.validateNavigationTarget(
          new URL(resolvedActionTarget.href, this.page.url()).toString(),
        );
      }
      const approvalDecision = validateActionApproval(
        action,
        approval,
        new Date(),
        {
          ...this.approvalValidation,
          ...additionalApprovalRequirement(action, resolvedActionTarget),
        },
      );
      if (!approvalDecision.allowed) {
        throw new Error(approvalDecision.reason);
      }
      if (approval && approvalDecision.approvalId && this.approvalReplayStore) {
        const replayDecision = await this.approvalReplayStore.reserve(approval);
        if (!replayDecision.allowed) {
          throw new Error(replayDecision.reason);
        }
      }
      if (approval && approvalDecision.approvalId) {
        await this.trace(
          "approval_granted",
          {
            approvalId: approval.approvalId,
            actionHash: approval.actionHash,
            approvedBy: approval.approvedBy,
            approvedAt: approval.approvedAt,
            expiresAt: approval.expiresAt,
            ...(approval.scope ? { scope: approval.scope } : {}),
          },
          action.riskLevel,
        );
      }

      this.blockedNavigation = undefined;
      let outcome: { method: ActionMethod; evidence: string[] };
      try {
        outcome = await this.perform(action, resolvedActionTarget);
      } catch (error) {
        if (this.blockedNavigation) {
          throw this.blockedNavigation;
        }
        throw error;
      }
      if (this.blockedNavigation) {
        throw this.blockedNavigation;
      }
      if (!action.methodPreference.includes(outcome.method)) {
        throw new Error(
          `Resolved ${outcome.method} method is not permitted for this action.`,
        );
      }
      await this.validateCurrentPageOrigin();
      if (this.blockedNavigation) {
        throw this.blockedNavigation;
      }

      const result: ActionExecutionResult = {
        success: true,
        method: outcome.method,
        latencyMs: Math.round(performance.now() - startedAt),
        evidence: outcome.evidence,
      };
      await this.trace("action_completed", { action, result });
      return result;
    } catch (error) {
      const result: ActionExecutionResult = {
        success: false,
        latencyMs: Math.round(performance.now() - startedAt),
        evidence: [],
        error:
          error instanceof Error
            ? error.message
            : "Unknown Playwright execution error.",
      };
      await this.trace("action_failed", { action, result }, action.riskLevel);
      this.lastResolvedTarget = undefined;
      return result;
    }
  }

  /**
   * Persists a selector only after a caller has verified the postcondition for
   * the exact action that produced the resolved target.
   */
  public rememberVerifiedAction(
    action: BrowserSemanticAction,
    verification: VerificationResult,
  ): boolean {
    const resolved = this.lastResolvedTarget;
    this.lastResolvedTarget = undefined;
    if (
      !action.target ||
      !resolved ||
      resolved.actionHash !== hashState(action) ||
      !verification.success ||
      verification.evidence.length === 0 ||
      !this.selectorMemory?.remember
    ) {
      return false;
    }
    try {
      return this.selectorMemory.remember(
        {
          skillName: action.type,
          target: action.target,
          selector: resolved.memory.selector,
          ...(resolved.memory.role ? { role: resolved.memory.role } : {}),
          ...(resolved.memory.label ? { label: resolved.memory.label } : {}),
        },
        verification,
      );
    } catch {
      return false;
    }
  }

  private async perform(
    action: BrowserSemanticAction,
    resolvedActivationTarget?: ResolvedTarget,
  ): Promise<{ method: ActionMethod; evidence: string[] }> {
    switch (action.type) {
      case "navigate": {
        if (!action.target) {
          throw new Error("Navigate action requires a URL target.");
        }
        await this.validateNavigationTarget(action.target);
        await this.page.goto(action.target, {
          timeout: this.actionTimeoutMs,
          waitUntil: "domcontentloaded",
        });
        return {
          method: "api",
          evidence: [`Navigated to ${this.page.url()}.`],
        };
      }
      case "click": {
        const target =
          resolvedActivationTarget ?? (await this.requireTarget(action));
        const isDisabled = await target.locator.isDisabled().catch(() => false);
        if (isDisabled) {
          throw new Error(
            `Target ${target.description} is disabled and cannot be clicked.`,
          );
        }
        await target.locator.click();
        return {
          method: target.method,
          evidence: [`Clicked ${target.description}.`],
        };
      }
      case "fill": {
        const target =
          resolvedActivationTarget ?? (await this.requireTarget(action));
        if (typeof action.value !== "string") {
          throw new Error("Fill action requires a string value.");
        }
        await target.locator.fill(action.value);
        return {
          method: target.method,
          evidence: [`Filled ${target.description}.`],
        };
      }
      case "select": {
        const target =
          resolvedActivationTarget ?? (await this.requireTarget(action));
        if (typeof action.value !== "string") {
          throw new Error("Select action requires a string value.");
        }
        await target.locator.selectOption(action.value);
        return {
          method: target.method,
          evidence: [`Selected an option in ${target.description}.`],
        };
      }
      case "press": {
        const key = typeof action.value === "string" ? action.value : "Enter";
        if (action.target) {
          const target =
            resolvedActivationTarget ?? (await this.requireTarget(action));
          await target.locator.press(key);
          return {
            method: "keyboard",
            evidence: [`Pressed ${key} on ${target.description}.`],
          };
        }
        await this.page.keyboard.press(key);
        return { method: "keyboard", evidence: [`Pressed ${key}.`] };
      }
      case "wait": {
        const timeout = typeof action.value === "number" ? action.value : 500;
        if (
          !Number.isFinite(timeout) ||
          timeout < 0 ||
          timeout > this.maxWaitMs
        ) {
          throw new Error(
            `Wait duration must be between 0 and ${this.maxWaitMs} ms.`,
          );
        }
        if (action.target) {
          await this.page
            .locator(action.target)
            .waitFor({ state: "visible", timeout });
          return {
            method: "dom",
            evidence: [`Waited for ${action.target} to become visible.`],
          };
        }
        await this.page.waitForTimeout(timeout);
        return { method: "dom", evidence: [`Waited ${timeout} ms.`] };
      }
      case "download":
        return this.download(
          resolvedActivationTarget ?? (await this.requireTarget(action)),
        );
      case "custom":
        throw new Error("custom is not a direct executor action.");
      case "scroll":
        return this.scroll(action);
      case "hover":
        return this.hover(action);
      case "keyboard":
        return this.keyboard(action);
      case "tab":
      case "multi_tab":
        return this.tab(action);
      case "upload":
        return this.upload(action);
      case "screenshot":
        return this.screenshot(action);
      case "drag":
        return this.drag(action);
      default:
        throw new Error(`Unsupported action type: ${action.type}`);
    }
  }

  private async requireTarget(action: BrowserSemanticAction) {
    if (!action.target) {
      throw new Error(`${action.type} action requires a target.`);
    }
    return resolveTarget(
      this.page,
      action.target,
      this.selectorMemory,
      action.type,
    );
  }

  private async resolveActionTarget(
    action: BrowserSemanticAction,
  ): Promise<ResolvedTarget | undefined> {
    if (
      !action.target ||
      !["click", "fill", "select", "press", "download"].includes(action.type)
    ) {
      return undefined;
    }
    return this.requireTarget(action);
  }

  private async download(
    target: ResolvedTarget,
  ): Promise<{ method: ActionMethod; evidence: string[] }> {
    const downloadPromise = this.page.waitForEvent("download", {
      timeout: this.actionTimeoutMs,
    });
    await target.locator.click();
    const download = await downloadPromise;
    const fileName = basename(download.suggestedFilename());
    await mkdir(this.downloadDirectory, { recursive: true });
    const filePath = join(this.downloadDirectory, fileName);
    await download.saveAs(filePath);
    const fileStats = await stat(filePath);
    return {
      method: target.method,
      evidence: [`Downloaded one file (${fileStats.size} bytes).`],
    };
  }

  private async scroll(
    action: BrowserSemanticAction,
  ): Promise<{ method: ActionMethod; evidence: string[] }> {
    const direction = action.scrollDirection ?? "down";
    const amount = action.scrollAmount ?? 3;
    const scrollMap = {
      up: { x: 0, y: -amount * 100 },
      down: { x: 0, y: amount * 100 },
      left: { x: -amount * 100, y: 0 },
      right: { x: amount * 100, y: 0 },
    };
    const delta = scrollMap[direction];
    await this.page.mouse.wheel(delta.x, delta.y);
    await this.page.waitForTimeout(500);
    return {
      method: "mouse",
      evidence: [`Scrolled ${direction} ${amount} units.`],
    };
  }

  private async hover(
    action: BrowserSemanticAction,
  ): Promise<{ method: ActionMethod; evidence: string[] }> {
    const target = await this.requireTarget(action);
    await target.locator.hover({ timeout: this.actionTimeoutMs });
    return {
      method: target.method,
      evidence: [`Hovered over ${action.target}.`],
    };
  }

  private async keyboard(
    action: BrowserSemanticAction,
  ): Promise<{ method: ActionMethod; evidence: string[] }> {
    const key = action.key ?? "";
    const modifiers = action.modifiers ?? [];
    const combo = [...modifiers, key].join("+");
    await this.page.keyboard.press(combo);
    return {
      method: "keyboard",
      evidence: [`Pressed ${combo}.`],
    };
  }

  private async tab(
    action: BrowserSemanticAction,
  ): Promise<{ method: ActionMethod; evidence: string[] }> {
    const tabAction = action.tabAction ?? "new";
    const context = this.page.context();

    switch (tabAction) {
      case "new":
        this.page = await context.newPage();
        break;
      case "close": {
        await this.page.close();
        const remainingPage = context.pages().at(-1);
        if (remainingPage) {
          this.page = remainingPage;
          await remainingPage.bringToFront();
        }
        break;
      }
      case "switch": {
        const pages = context.pages();
        const index = action.tabIndex;
        if (
          index === undefined ||
          !Number.isInteger(index) ||
          index < 0 ||
          index >= pages.length
        ) {
          throw new Error(
            `Tab switch index must be an integer between 0 and ${Math.max(0, pages.length - 1)}.`,
          );
        }
        const selectedPage = pages[index];
        if (!selectedPage) {
          throw new Error(`Browser tab ${index} is unavailable.`);
        }
        this.page = selectedPage;
        await selectedPage.bringToFront();
        break;
      }
      case "next":
      case "previous": {
        const pages = context.pages();
        const currentIndex = pages.indexOf(this.page);
        if (currentIndex < 0 || pages.length === 0) {
          throw new Error("The current browser tab is unavailable.");
        }
        const nextIndex =
          tabAction === "next"
            ? (currentIndex + 1) % pages.length
            : (currentIndex - 1 + pages.length) % pages.length;
        const selectedPage = pages[nextIndex];
        if (!selectedPage) {
          throw new Error(`Browser tab ${nextIndex} is unavailable.`);
        }
        this.page = selectedPage;
        await selectedPage.bringToFront();
        break;
      }
    }

    return {
      method: "api",
      evidence: [`Tab ${tabAction} completed.`],
    };
  }

  private async upload(
    action: BrowserSemanticAction,
  ): Promise<{ method: ActionMethod; evidence: string[] }> {
    const target = await this.requireTarget(action);
    const filePath = action.filePath ?? "";
    await target.locator.setInputFiles(filePath);
    return {
      method: target.method,
      evidence: ["Uploaded one approved local file."],
    };
  }

  private async screenshot(
    action: BrowserSemanticAction,
  ): Promise<{ method: ActionMethod; evidence: string[] }> {
    const outputPath =
      action.outputPath ?? `/tmp/lhic-screenshot-${Date.now()}.png`;
    await this.page.screenshot({ path: outputPath, fullPage: false });
    return {
      method: "vision",
      evidence: [`Screenshot saved to ${outputPath}.`],
    };
  }

  private async drag(
    action: BrowserSemanticAction,
  ): Promise<{ method: ActionMethod; evidence: string[] }> {
    const source = await this.requireTarget(action);
    const targetSelector = action.dragTarget ?? "";
    const target = await resolveTarget(
      this.page,
      targetSelector,
      this.selectorMemory,
      action.type,
    );
    await source.locator.dragTo(target.locator, {
      timeout: this.actionTimeoutMs,
    });
    return {
      method: source.method,
      evidence: [`Dragged from ${action.target} to ${targetSelector}.`],
    };
  }

  private async validateNavigationTarget(target: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      throw new Error("Navigate action target must be an absolute URL.");
    }

    const allowedProtocols =
      this.navigationPolicy.allowedProtocols ?? defaultAllowedProtocols;
    if (!allowedProtocols.includes(parsed.protocol)) {
      throw new Error(`Navigation protocol ${parsed.protocol} is not allowed.`);
    }
    if (parsed.username || parsed.password) {
      throw new Error(
        "Navigation URLs containing credentials are not allowed.",
      );
    }
    if (
      !this.navigationPolicy.allowPrivateNetwork &&
      isPrivateHostname(parsed.hostname)
    ) {
      throw new Error("Navigation to private-network hosts is not allowed.");
    }
    const allowedOrigins = this.navigationPolicy.allowedOrigins;
    if (
      allowedOrigins &&
      !allowedOrigins.some((origin) => origin === parsed.origin)
    ) {
      throw new Error(`Navigation origin ${parsed.origin} is not allowlisted.`);
    }
    if (
      !this.navigationPolicy.allowPrivateNetwork &&
      (parsed.protocol === "https:" || parsed.protocol === "http:")
    ) {
      await this.assertPublicHostname(parsed.hostname);
    }
  }

  private async assertPublicHostname(hostname: string): Promise<void> {
    let addresses: readonly string[];
    try {
      addresses = await this.resolveHostname(hostname);
    } catch {
      throw new Error(
        "Navigation hostname could not be resolved to public network addresses.",
      );
    }

    if (addresses.length === 0 || addresses.some(isPrivateHostname)) {
      throw new Error(
        "Navigation hostname resolves to a private-network address.",
      );
    }
  }

  private async validateCurrentPageOrigin(): Promise<void> {
    const currentUrl = this.page.url();
    if (currentUrl !== "about:blank") {
      await this.validateNavigationTarget(currentUrl);
    }
  }

  private async trace(
    type: string,
    payload: Record<string, unknown>,
    riskLevel?: TraceEvent["riskLevel"],
  ): Promise<void> {
    const safePayload = this.redactActionValues
      ? redactActionInputs(payload)
      : payload;
    await appendTraceEvent(this.traceFilePath, {
      eventId: randomUUID(),
      taskId: this.taskId,
      timestamp: new Date().toISOString(),
      type,
      payload: safePayload,
      ...(riskLevel ? { riskLevel } : {}),
    });
  }
}

function additionalApprovalRequirement(
  action: BrowserSemanticAction,
  resolvedActionTarget: ResolvedTarget | undefined,
): Pick<
  ActionApprovalValidationOptions,
  "forceConfirmation" | "confirmationReason"
> {
  if (action.type === "upload") {
    return {
      forceConfirmation: true,
      confirmationReason:
        "Uploads disclose a local file to the current page and require human confirmation.",
    };
  }
  if (action.type === "download") {
    return {
      forceConfirmation: true,
      confirmationReason:
        "Downloads write a file to local storage and require human confirmation.",
    };
  }
  if (action.type === "press" && !resolvedActionTarget) {
    return {
      forceConfirmation: true,
      confirmationReason:
        "Untargeted key presses can activate the focused control and require human confirmation.",
    };
  }
  if (
    resolvedActionTarget &&
    (action.type === "click" || action.type === "press") &&
    isSideEffectActivationTarget(resolvedActionTarget.safetyText)
  ) {
    return {
      forceConfirmation: true,
      confirmationReason:
        "The resolved click or key-press target may have an external side effect and requires human confirmation.",
    };
  }
  return {};
}

function redactActionInputs(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const action = payload.action;
  if (!action || typeof action !== "object") return payload;
  const safeAction = { ...(action as Record<string, unknown>) };
  const sensitiveValues = [safeAction.value, safeAction.filePath].filter(
    (value): value is string => typeof value === "string",
  );
  if ("value" in safeAction) safeAction.value = "[REDACTED]";
  if ("filePath" in safeAction) safeAction.filePath = "[REDACTED]";
  const result = payload.result;
  if (
    sensitiveValues.length === 0 ||
    !result ||
    typeof result !== "object" ||
    !("error" in result) ||
    typeof result.error !== "string"
  ) {
    return { ...payload, action: safeAction };
  }
  return {
    ...payload,
    action: safeAction,
    result: {
      ...result,
      error: sensitiveValues.reduce(
        (error, value) => redactActionValueFromError(error, value),
        result.error,
      ),
    },
  };
}

function redactActionValueFromError(error: string, value: string): string {
  const encodedValue = encodeURIComponent(value);
  const variants = new Set([
    value,
    encodedValue,
    encodedValue.replaceAll("%20", "+"),
  ]);
  return [...variants]
    .filter((variant) => variant.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce(
      (safeError, variant) => safeError.replaceAll(variant, "[REDACTED]"),
      error,
    );
}

export function createProductionExecutor(
  page: Page,
  config: ProductionRuntimeConfig,
  options: ProductionExecutorOptions = {},
): PlaywrightDirectExecutor {
  const taskId = options.taskId ?? "browser-session";
  const traceFilePath =
    options.traceFilePath ?? join(config.traceDirectory, `${taskId}.jsonl`);
  return new PlaywrightDirectExecutor(page, {
    taskId,
    traceFilePath,
    actionTimeoutMs: config.actionTimeoutMs,
    maxWaitMs: config.maxWaitMs,
    redactActionValues: true,
    approvalValidation: {
      requireSignature: config.environment === "production",
      ...(config.approvalPublicKey
        ? { publicKey: config.approvalPublicKey }
        : {}),
    },
    navigationPolicy: {
      ...(config.allowedOrigins.length > 0
        ? { allowedOrigins: config.allowedOrigins }
        : {}),
      allowPrivateNetwork: config.allowPrivateNetwork,
    },
    approvalReplayStore:
      options.approvalReplayStore ??
      new FileApprovalReplayStore(
        join(dirname(traceFilePath), "approval-replay"),
      ),
    ...(options.selectorMemory
      ? { selectorMemory: options.selectorMemory }
      : {}),
    ...(options.resolveHostname
      ? { resolveHostname: options.resolveHostname }
      : {}),
  });
}

function normalizeTimeout(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const timeout = value ?? fallback;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 120_000) {
    throw new Error(`${name} must be between 1 and 120000 ms.`);
  }
  return timeout;
}

async function resolveHostnameToAddresses(
  hostname: string,
): Promise<readonly string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address }) => address);
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".local")) {
    return true;
  }
  if (
    normalized === "::" ||
    normalized === "::1" ||
    (normalized.startsWith("::ffff:") &&
      isPrivateHostname(normalized.slice("::ffff:".length))) ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab][0-9a-f]*:/.test(normalized)
  ) {
    return true;
  }
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) {
    return false;
  }
  const octets = ipv4.slice(1).map(Number);
  const [first, second] = octets;
  if (octets.some((octet) => octet > 255)) {
    return true;
  }
  return (
    first === 10 ||
    first === 0 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 100 && second !== undefined && second >= 64 && second <= 127) ||
    (first !== undefined && first >= 224)
  );
}
