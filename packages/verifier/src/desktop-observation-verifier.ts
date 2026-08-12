export interface DesktopObservationVerificationParams {
  /** Expected application name (case-insensitive substring match). */
  expectedApplication?: string;
  /** Expected window title (case-insensitive substring match). */
  expectedTitle?: string;
  /** Minimum number of interactive elements expected. */
  minInteractiveElements?: number;
  /** Expected role to be present in the observation. */
  expectedRole?: string;
  /** Expected element name to be present. */
  expectedElementName?: string;
}

export interface DesktopObservation {
  application: string;
  title?: string;
  interactiveElements?: Array<{
    role: string;
    name?: string;
    enabled: boolean;
  }>;
}

/**
 * Verifies a desktop observation meets expected criteria.
 * This is the desktop equivalent of DOM verification — it proves what's in the UI.
 */
export async function verifyDesktopObservation(
  observation: DesktopObservation,
  params: DesktopObservationVerificationParams,
): Promise<{
  success: boolean;
  evidence: string[];
  error?: string;
}> {
  const evidence: string[] = [];

  // Check application name
  if (params.expectedApplication) {
    if (
      !observation.application
        .toLowerCase()
        .includes(params.expectedApplication.toLowerCase())
    ) {
      return {
        success: false,
        evidence,
        error: `Expected application "${params.expectedApplication}" but found "${observation.application}".`,
      };
    }
    evidence.push(`application=${observation.application}`);
  }

  // Check window title
  if (params.expectedTitle) {
    if (
      !observation.title ||
      !observation.title
        .toLowerCase()
        .includes(params.expectedTitle.toLowerCase())
    ) {
      return {
        success: false,
        evidence,
        error: `Expected window title containing "${params.expectedTitle}" but found "${observation.title ?? "none"}".`,
      };
    }
    evidence.push(`title=${observation.title}`);
  }

  // Check interactive elements count
  if (params.minInteractiveElements !== undefined) {
    const count = observation.interactiveElements?.length ?? 0;
    if (count < params.minInteractiveElements) {
      return {
        success: false,
        evidence: [...evidence, `interactive_elements=${count}`],
        error: `Expected at least ${params.minInteractiveElements} interactive elements but found ${count}.`,
      };
    }
    evidence.push(`interactive_elements=${count}`);
  }

  // Check for expected role
  if (params.expectedRole) {
    const found = observation.interactiveElements?.some((el) =>
      el.role.toLowerCase().includes(params.expectedRole!.toLowerCase()),
    );
    if (!found) {
      return {
        success: false,
        evidence,
        error: `Expected element with role "${params.expectedRole}" not found.`,
      };
    }
    evidence.push(`found_role=${params.expectedRole}`);
  }

  // Check for expected element name
  if (params.expectedElementName) {
    const found = observation.interactiveElements?.some((el) =>
      el.name
        ?.toLowerCase()
        .includes(params.expectedElementName!.toLowerCase()),
    );
    if (!found) {
      return {
        success: false,
        evidence,
        error: `Expected element with name "${params.expectedElementName}" not found.`,
      };
    }
    evidence.push(`found_element=${params.expectedElementName}`);
  }

  return {
    success: true,
    evidence: [
      `Desktop observation verified for ${observation.application}`,
      ...evidence,
    ],
  };
}
