import { createHash } from "node:crypto";

import type { SharedSkillRecord, SharedSkillStore } from "@lhic/memory";
import {
  isBrowserSemanticAction,
  isGlobalComputerAction,
  type NormalizedUIState,
  type SemanticAction,
  type UserIntent,
} from "@lhic/schema";
import { redactPII } from "@lhic/trace";

import type { SkillRecord } from "@lhic/memory";

import type { SlowPathRequest } from "./slow-path.js";

const templateExpression = /^\{\{constraints\.([A-Za-z0-9_.-]+)\}\}$/;
const redactedValuePattern = /\[REDACTED(?:_[A-Z_]+)?\]/;
const safePressValues = new Set([
  "Enter",
  "Escape",
  "Tab",
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "Space",
]);

export interface SharedSkillPublication extends Record<string, unknown> {
  schemaVersion: "shared-skill-v1";
  name: string;
  contentHash: string;
  operationKey: string;
  fingerprint: string;
  templateVariables: string[];
  definition: Record<string, unknown>;
  fastPathEligible: boolean;
}

export interface SharedSkillPublisher {
  publish(publication: SharedSkillPublication): Promise<void>;
}

export interface ResolvedSharedSkill {
  skillId: string;
  skillName: string;
  actions: SemanticAction[];
  evidence: string[];
}

export class SharedSkillResolver {
  public constructor(
    private readonly store: SharedSkillStore,
    private readonly registryId: string,
  ) {}

  public resolve(
    intent: UserIntent,
    uiState: NormalizedUIState,
  ): ResolvedSharedSkill | undefined {
    if (intent.riskLevel !== "low" || intent.requiresConfirmation) {
      return undefined;
    }
    const candidates = this.store
      .findByFingerprint(
        this.registryId,
        createSharedSkillOperationKey(intent),
        createSharedSkillFingerprint(uiState),
      )
      .filter((candidate) => candidate.fastPathEligible)
      .map((candidate) => resolveCandidate(candidate, intent))
      .filter(
        (candidate): candidate is ResolvedSharedSkill =>
          candidate !== undefined,
      );

    return candidates.length === 1 ? candidates[0] : undefined;
  }
}

export function createSharedSkillPublication(
  request: SlowPathRequest,
  learnedSkill: SkillRecord,
): SharedSkillPublication | undefined {
  const definition = learnedSkill.definition;
  if (definition.compiler !== "slow-path-v1") {
    return undefined;
  }
  const actions = Array.isArray(definition.actions)
    ? definition.actions.filter(isSemanticActionRecord)
    : [];
  if (actions.length === 0) {
    return undefined;
  }

  const constraintValues = collectConstraintValues(
    request.userIntent.constraints,
  );
  let fastPathEligible = true;
  const templateActions = actions.map((action) => {
    const result = templateAction(action, constraintValues);
    fastPathEligible &&= result.fastPathEligible;
    return result.action;
  });

  if (
    request.userIntent.riskLevel !== "low" ||
    request.userIntent.requiresConfirmation ||
    templateActions.some(
      (action) =>
        !isBrowserSemanticAction(action) ||
        isGlobalComputerAction(action) ||
        action.riskLevel !== "low",
    )
  ) {
    fastPathEligible = false;
  }

  const publicationWithoutHash = {
    schemaVersion: "shared-skill-v1" as const,
    name: learnedSkill.name,
    operationKey: createSharedSkillOperationKey(request.userIntent),
    fingerprint: createSharedSkillFingerprint(request.uiState),
    templateVariables: [...new Set([...constraintValues.values()])].sort(),
    definition: {
      compiler: "shared-skill-v1",
      sourceCompiler: "slow-path-v1",
      actions: templateActions,
      verification: Array.isArray(definition.verification)
        ? definition.verification.map((entry) => redactPII(entry))
        : [],
    },
    fastPathEligible,
  };
  return {
    ...publicationWithoutHash,
    contentHash: hashCanonical(publicationWithoutHash),
  };
}

export function createLegacySharedSkillPublication(
  learnedSkill: SkillRecord,
): SharedSkillPublication | undefined {
  const definition = learnedSkill.definition;
  if (definition.compiler !== "slow-path-v1") {
    return undefined;
  }
  const actions = Array.isArray(definition.actions)
    ? definition.actions.filter(isSemanticActionRecord)
    : [];
  if (actions.length === 0) {
    return undefined;
  }
  const constraints = isRecord(definition.constraints)
    ? definition.constraints
    : {};
  const legacyIntent: UserIntent = {
    goal:
      typeof definition.goal === "string" ? definition.goal : learnedSkill.name,
    constraints,
    riskLevel: "unknown",
    requiresConfirmation: true,
    missingInformation: [],
  };
  const templateActions = actions.map(
    (action) => templateAction(action, new Map()).action,
  );
  const publicationWithoutHash = {
    schemaVersion: "shared-skill-v1" as const,
    name: learnedSkill.name,
    operationKey: createSharedSkillOperationKey(legacyIntent),
    fingerprint: `legacy:${hashCanonical({ name: learnedSkill.name, actions: templateActions })}`,
    templateVariables: [],
    definition: {
      compiler: "shared-skill-v1",
      sourceCompiler: "slow-path-v1",
      actions: templateActions,
      verification: [],
    },
    fastPathEligible: false,
  };
  return {
    ...publicationWithoutHash,
    contentHash: hashCanonical(publicationWithoutHash),
  };
}

export function createSharedSkillOperationKey(intent: UserIntent): string {
  const operation = intent.constraints.operation;
  if (typeof operation === "string" && operation !== "unknown") {
    return `operation:${normalizeText(operation)}`;
  }
  return `goal:${hashCanonical(normalizeText(intent.goal))}`;
}

export function createSharedSkillFingerprint(
  uiState: NormalizedUIState,
): string {
  const origin = uiState.url ? safeOrigin(uiState.url) : "";
  const structure = uiState.objects
    .filter((object) => isStableInteractiveControl(object.role))
    .map((object) => ({
      role: object.role ?? "",
      enabled: object.enabled !== false,
      category: categorizeObject(object.label, object.role),
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  return hashCanonical({ surface: uiState.surface, origin, structure });
}

function isStableInteractiveControl(role: string | undefined): boolean {
  return [
    "button",
    "textbox",
    "searchbox",
    "combobox",
    "checkbox",
    "radio",
    "switch",
  ].includes(role ?? "");
}

function resolveCandidate(
  candidate: SharedSkillRecord,
  intent: UserIntent,
): ResolvedSharedSkill | undefined {
  const rawActions = candidate.definition.actions;
  if (!Array.isArray(rawActions)) {
    return undefined;
  }
  const actions = rawActions
    .map((action) => bindTemplate(action, intent.constraints))
    .filter(
      (action): action is SemanticAction =>
        isBrowserSemanticAction(action) &&
        !isGlobalComputerAction(action) &&
        action.riskLevel === "low",
    );
  if (actions.length !== rawActions.length || actions.length === 0) {
    return undefined;
  }
  return {
    skillId: candidate.skillId,
    skillName: candidate.name,
    actions,
    evidence: [
      "Matched an approved shared skill using the local operation and UI fingerprint.",
    ],
  };
}

function templateAction(
  input: Record<string, unknown>,
  constraintValues: Map<string, string>,
): { action: Record<string, unknown>; fastPathEligible: boolean } {
  const action = redactPII(input);
  let fastPathEligible = JSON.stringify(action) === JSON.stringify(input);
  const type = typeof action.type === "string" ? action.type : "";
  const result = { ...action };

  for (const key of ["value", "text"] as const) {
    const value = result[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value === "string") {
      const constraintPath = constraintValues.get(value);
      if (constraintPath) {
        result[key] = `{{constraints.${constraintPath}}}`;
        continue;
      }
      if (key === "value" && type === "press" && safePressValues.has(value)) {
        continue;
      }
    }
    result[key] = "[REDACTED]";
    fastPathEligible = false;
  }

  return { action: result, fastPathEligible };
}

function bindTemplate(
  value: unknown,
  constraints: Record<string, unknown>,
): unknown {
  if (typeof value === "string") {
    const match = value.match(templateExpression);
    if (!match) {
      return redactedValuePattern.test(value) ? undefined : value;
    }
    return lookupConstraint(constraints, match[1]!);
  }
  if (Array.isArray(value)) {
    const bound = value.map((item) => bindTemplate(item, constraints));
    return bound.some((item) => item === undefined) ? undefined : bound;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const bound = bindTemplate(item, constraints);
    if (bound === undefined) {
      return undefined;
    }
    result[key] = bound;
  }
  return result;
}

function collectConstraintValues(
  constraints: Record<string, unknown>,
  prefix = "",
  values = new Map<string, string>(),
): Map<string, string> {
  for (const [key, value] of Object.entries(constraints)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string" && value.trim()) {
      values.set(value, path);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      collectConstraintValues(value as Record<string, unknown>, path, values);
    }
  }
  return values;
}

function lookupConstraint(
  constraints: Record<string, unknown>,
  path: string,
): unknown {
  let current: unknown = constraints;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function isSemanticActionRecord(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function categorizeObject(
  label: string | undefined,
  role: string | undefined,
): string {
  const text = `${role ?? ""} ${label ?? ""}`.toLowerCase();
  if (/search|find|query/.test(text)) {
    return "search";
  }
  if (/download|export/.test(text)) {
    return "download";
  }
  if (/password|passcode/.test(text)) {
    return "password";
  }
  if (/submit|save|continue|next/.test(text)) {
    return "submit";
  }
  return "other";
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
