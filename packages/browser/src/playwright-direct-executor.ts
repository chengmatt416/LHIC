import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  ActionExecutionResult,
  ActionMethod,
  SemanticAction,
  TraceEvent,
} from "@lhic/schema";
import {
  validateActionApproval,
  type ActionApproval,
  type ActionApprovalValidationOptions,
  type ProductionRuntimeConfig,
} from "@lhic/security";
import { appendTraceEvent } from "@lhic/trace";
import type { Page } from "playwright";

import { resolveTarget } from "./target-resolver.js";

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
}

export interface NavigationPolicy {
  allowedProtocols?: readonly string[];
  allowedOrigins?: readonly string[];
  allowPrivateNetwork?: boolean;
}

export interface ProductionExecutorOptions {
  taskId?: string;
  traceFilePath?: string;
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
    this.page.setDefaultTimeout(this.actionTimeoutMs);
  }

  public async execute(
    action: SemanticAction,
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

      const approvalDecision = validateActionApproval(
        action,
        approval,
        new Date(),
        this.approvalValidation,
      );
      if (!approvalDecision.allowed) {
        throw new Error(approvalDecision.reason);
      }

      const outcome = await this.perform(action);
      if (!action.methodPreference.includes(outcome.method)) {
        throw new Error(
          `Resolved ${outcome.method} method is not permitted for this action.`,
        );
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
    action: SemanticAction,
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
        const target = await this.requireTarget(action);
        await target.locator.click();
        return {
          method: target.method,
          evidence: [`Clicked ${target.description}.`],
        };
      }
      case "fill": {
        const target = await this.requireTarget(action);
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
        const target = await this.requireTarget(action);
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
          const target = await this.requireTarget(action);
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
      case "custom":
        throw new Error(
          `${action.type} is not a direct executor action; use its dedicated skill or human confirmation.`,
        );
    }
  }

  private async requireTarget(action: SemanticAction) {
    if (!action.target) {
      throw new Error(`${action.type} action requires a target.`);
    }
    return resolveTarget(this.page, action.target);
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

  private async trace(
    type: string,
    payload: Record<string, unknown>,
    riskLevel?: TraceEvent["riskLevel"],
  ): Promise<void> {
    await appendTraceEvent(this.traceFilePath, {
      eventId: randomUUID(),
      taskId: this.taskId,
      timestamp: new Date().toISOString(),
      type,
      payload,
      ...(riskLevel ? { riskLevel } : {}),
    });
  }
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
      allowedOrigins: config.allowedOrigins,
      allowPrivateNetwork: config.allowPrivateNetwork,
    },
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
