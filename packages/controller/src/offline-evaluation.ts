import type { SkillStore } from "@lhic/memory";
import type { VerificationResult } from "@lhic/schema";

export type OfflineEvaluationEnvironment =
  "local_fixture" | "allowlisted_sandbox" | "registered_test_account";

export interface OfflineEvaluationRequest {
  candidateName: string;
  environment: OfflineEvaluationEnvironment;
  targetUrl: string;
  /** A unique evaluation run identifier, not a production task identifier. */
  evaluationId: string;
  /** Hash of the redacted holdout DOM/AX shape observed by the evaluator. */
  uiFingerprint: string;
  verifierVersion: string;
  allowlistedOrigins?: readonly string[];
  registeredTestAccountId?: string;
  /** The caller owns execution; this worker only admits safe targets. */
  verify(): Promise<VerificationResult>;
}

export interface RegisteredTestAccountRegistry {
  has(accountId: string, origin: string): boolean;
}

export interface OfflineEvaluationResult {
  verification: VerificationResult;
  promotionEligible: boolean;
}

export interface FailureCluster {
  signature: string;
  occurrences: number;
  recommendation?: string;
}

export interface OfflinePracticeTask {
  id: string;
  environment: "local_fixture";
  goal: string;
  requiresCredentials: false;
}

/**
 * A deliberately narrow offline worker. It can evaluate an existing candidate
 * for promotion, but cannot run arbitrary production targets, alter policy,
 * or manufacture verifier evidence.
 */
export class OfflineEvaluationWorker {
  public constructor(
    private readonly skillStore: SkillStore,
    private readonly testAccountRegistry?: RegisteredTestAccountRegistry,
  ) {}

  public async evaluateCandidate(
    request: OfflineEvaluationRequest,
  ): Promise<OfflineEvaluationResult> {
    assertOfflineTarget(request, this.testAccountRegistry);
    const verification = await request.verify();
    if (!verification.success || verification.evidence.length === 0) {
      return { verification, promotionEligible: false };
    }
    const candidate = this.skillStore.getCandidate(request.candidateName);
    if (!candidate) {
      throw new Error("Candidate Skill does not exist.");
    }
    const target = new URL(request.targetUrl);
    this.skillStore.recordCandidateHoldout(
      request.candidateName,
      verification,
      {
        evaluator: "offline-evaluation-v1",
        environment: request.environment,
        evaluationId: request.evaluationId,
        origin: target.origin,
        uiFingerprint: request.uiFingerprint,
        verifierVersion: request.verifierVersion,
        candidateDefinitionSha256: candidate.definitionSha256,
      },
    );
    const updated = this.skillStore.getCandidate(request.candidateName);
    return {
      verification,
      promotionEligible:
        updated !== undefined &&
        updated.verifiedRunCount >= 3 &&
        updated.holdoutPassed &&
        !updated.promoted,
    };
  }
}

/** Creates local-only practice tasks from failures without executing them. */
export function deriveOfflinePracticeTasks(
  failures: readonly FailureCluster[],
): OfflinePracticeTask[] {
  return failures
    .filter(
      (failure) =>
        failure.signature.trim().length > 0 &&
        Number.isSafeInteger(failure.occurrences) &&
        failure.occurrences > 0,
    )
    .sort(
      (left, right) =>
        right.occurrences - left.occurrences ||
        left.signature.localeCompare(right.signature),
    )
    .map((failure, index) => ({
      id: `practice-${index + 1}-${failure.signature}`,
      environment: "local_fixture" as const,
      goal:
        failure.recommendation ?? `Reproduce and verify ${failure.signature}.`,
      requiresCredentials: false as const,
    }));
}

export function assertOfflineTarget(
  request: OfflineEvaluationRequest,
  testAccountRegistry?: RegisteredTestAccountRegistry,
): void {
  if (
    !request.evaluationId.trim() ||
    !/^[a-f0-9]{64}$/.test(request.uiFingerprint)
  ) {
    throw new Error(
      "Offline evaluations require a unique evaluation ID and a redacted UI fingerprint.",
    );
  }
  if (!request.verifierVersion.trim() || request.verifierVersion.length > 128) {
    throw new Error("Offline evaluations require a verifier version.");
  }
  let target: URL;
  try {
    target = new URL(request.targetUrl);
  } catch {
    throw new Error("Offline evaluation targets must be absolute URLs.");
  }

  if (request.environment === "local_fixture") {
    if (!isLoopback(target.hostname)) {
      throw new Error("Local fixture evaluations must use a loopback target.");
    }
    return;
  }

  if (request.environment === "allowlisted_sandbox") {
    if (!request.allowlistedOrigins?.includes(target.origin)) {
      throw new Error(
        "Sandbox evaluation target is not explicitly allowlisted.",
      );
    }
    return;
  }

  if (!request.registeredTestAccountId?.trim()) {
    throw new Error(
      "Registered test-account evaluations require an account identifier.",
    );
  }
  if (!request.allowlistedOrigins?.includes(target.origin)) {
    throw new Error(
      "Test-account evaluation target is not explicitly allowlisted.",
    );
  }
  if (
    !testAccountRegistry?.has(request.registeredTestAccountId, target.origin)
  ) {
    throw new Error(
      "Test-account evaluation account is not registered for this origin.",
    );
  }
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
  );
}
