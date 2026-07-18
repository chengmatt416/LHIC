import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import type {
  ActionExecutionResult,
  ActionMethod,
  BrowserSemanticAction,
  TraceEvent,
} from "@lhic/schema";
import {
  isSideEffectActivationTarget,
  validateActionApproval,
  type ActionApproval,
  type ActionApprovalValidationOptions,
  type ProductionRuntimeConfig,
} from "@lhic/security";
import { appendTraceEvent } from "@lhic/trace";
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
  /** Do not persist action values to the trace file. */
  redactActionValues?: boolean;
  /** Directory used by supported semantic download actions. */
  downloadDirectory?: string;
}

export interface NavigationPolicy {
  allowedProtocols?: readonly string[];
  allowedOrigins?: readonly string[];
  allowPrivateNetwork?: boolean;
}

export interface ProductionExecutorOptions {
  taskId?: string;
  traceFilePath?: string;
  selectorMemory?: PlaywrightDirectExecutorOptions["selectorMemory"];
}

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
  private readonly selectorMemory?: PlaywrightDirectExecutorOptions["selectorMemory"];
  private readonly redactActionValues: boolean;
  private readonly downloadDirectory: string;

  public constructor(
    private readonly page: Page,
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
    this.selectorMemory = options.selectorMemory;
    this.redactActionValues = options.redactActionValues ?? false;
    this.downloadDirectory = options.downloadDirectory ?? "downloads";
    this.page.setDefaultTimeout(this.actionTimeoutMs);
  }

  private async waitForStability(): Promise<void> {
    // Dimension 2: Smart Adaptive Wait
    // 1. Wait for network idle with a short timeout to prevent hanging forever
    await this.page
      .waitForLoadState("networkidle", { timeout: 1500 })
      .catch(() => {});
    // 2. Wait for rendering frame stability
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
      if (
        !action.methodPreference.some((method) =>
          supportedMethods.includes(method),
        )
      ) {
        throw new Error("Action does not permit a Fast Path execution method.");
      }

      await this.waitForStability();

      const resolvedActionTarget = await this.resolveActionTarget(action);
      if (action.type === "click" && resolvedActionTarget?.href) {
        this.validateNavigationTarget(
          new URL(resolvedActionTarget.href, this.page.url()).toString(),
        );
      }
      const approvalDecision = validateActionApproval(
        action,
        approval,
        new Date(),
        {
          ...this.approvalValidation,
          ...(resolvedActionTarget &&
          (action.type === "click" || action.type === "press") &&
          isSideEffectActivationTarget(resolvedActionTarget.safetyText)
            ? {
                forceConfirmation: true,
                confirmationReason:
                  "The resolved click or key-press target may have an external side effect and requires human confirmation.",
              }
            : {}),
        },
      );
      if (!approvalDecision.allowed) {
        throw new Error(approvalDecision.reason);
      }

      const outcome = await this.perform(action, resolvedActionTarget);
      if (!action.methodPreference.includes(outcome.method)) {
        throw new Error(
          `Resolved ${outcome.method} method is not permitted for this action.`,
        );
      }
      this.validateCurrentPageOrigin();

      // Store only the target strategy that produced a successful local action.
      if (
        action.target &&
        resolvedActionTarget &&
        this.selectorMemory?.remember
      ) {
        try {
          this.selectorMemory.remember(
            {
              skillName: action.type,
              target: action.target,
              selector: resolvedActionTarget.memory.selector,
              ...(resolvedActionTarget.memory.role
                ? { role: resolvedActionTarget.memory.role }
                : {}),
              ...(resolvedActionTarget.memory.label
                ? { label: resolvedActionTarget.memory.label }
                : {}),
            },
            { success: true, evidence: outcome.evidence },
          );
        } catch {
          // ignore memory errors in runtime
        }
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
      return result;
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
        this.validateNavigationTarget(action.target);
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

  private validateNavigationTarget(target: string): void {
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
  }

  private validateCurrentPageOrigin(): void {
    const currentUrl = this.page.url();
    if (
      this.navigationPolicy.allowedOrigins?.length &&
      currentUrl !== "about:blank"
    ) {
      this.validateNavigationTarget(currentUrl);
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

function redactActionInputs(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const action = payload.action;
  if (!action || typeof action !== "object") return payload;
  const safeAction = { ...(action as Record<string, unknown>) };
  const actionValue = safeAction.value;
  if ("value" in safeAction) safeAction.value = "[REDACTED]";
  const result = payload.result;
  if (
    typeof actionValue !== "string" ||
    !result ||
    typeof result !== "object" ||
    typeof (result as { error?: unknown }).error !== "string"
  ) {
    return { ...payload, action: safeAction };
  }
  return {
    ...payload,
    action: safeAction,
    result: {
      ...(result as Record<string, unknown>),
      error: redactActionValueFromError(
        (result as { error: string }).error,
        actionValue,
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
  return new PlaywrightDirectExecutor(page, {
    taskId,
    traceFilePath:
      options.traceFilePath ?? join(config.traceDirectory, `${taskId}.jsonl`),
    actionTimeoutMs: config.actionTimeoutMs,
    maxWaitMs: config.maxWaitMs,
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
    ...(options.selectorMemory
      ? { selectorMemory: options.selectorMemory }
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

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".local")) {
    return true;
  }
  if (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  ) {
    return true;
  }
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) {
    return false;
  }
  const octets = ipv4.slice(1).map(Number);
  const [first, second] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}
