import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { SecurityConfiguration } from "../shared/contracts.js";

const configName = ".lhic/security-settings.json";

const defaultConfiguration: Omit<SecurityConfiguration, "updatedAt"> = {
  slowPathProfile: "balanced",
  requireInteractiveApproval: true,
  redactSensitiveData: true,
  fastPathModelFree: true,
};

/**
 * Stores only local safety posture metadata. Credentials, approvals and trace
 * payloads are deliberately outside this file.
 */
export class SecuritySettingsStore {
  private readonly path: string;

  public constructor(workspaceRoot: string) {
    this.path = resolve(workspaceRoot, configName);
  }

  public async load(): Promise<SecurityConfiguration> {
    try {
      return validateSecurityConfiguration(
        JSON.parse(await readFile(this.path, "utf8")) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return defaultSecurityConfiguration();
      }
      throw error;
    }
  }

  public async save(
    input: Pick<SecurityConfiguration, "slowPathProfile">,
  ): Promise<SecurityConfiguration> {
    const configuration: SecurityConfiguration = {
      ...defaultConfiguration,
      slowPathProfile: validateSlowPathProfile(input.slowPathProfile),
      updatedAt: new Date().toISOString(),
    };
    const content = `${JSON.stringify(configuration, null, 2)}\n`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
    return configuration;
  }
}

export function defaultSecurityConfiguration(): SecurityConfiguration {
  return { ...defaultConfiguration };
}

export function validateSecurityConfiguration(
  value: unknown,
): SecurityConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Security configuration is invalid.");
  }
  const configuration = value as Partial<SecurityConfiguration>;
  if (
    configuration.requireInteractiveApproval !== true ||
    configuration.redactSensitiveData !== true ||
    configuration.fastPathModelFree !== true ||
    typeof configuration.updatedAt !== "string" ||
    Number.isNaN(Date.parse(configuration.updatedAt))
  ) {
    throw new Error("Security configuration cannot weaken mandatory controls.");
  }
  return {
    slowPathProfile: validateSlowPathProfile(configuration.slowPathProfile),
    requireInteractiveApproval: true,
    redactSensitiveData: true,
    fastPathModelFree: true,
    updatedAt: new Date(configuration.updatedAt).toISOString(),
  };
}

function validateSlowPathProfile(
  value: unknown,
): SecurityConfiguration["slowPathProfile"] {
  if (
    value === "fast_only" ||
    value === "balanced" ||
    value === "deliberative"
  ) {
    return value;
  }
  throw new Error("Slow Path safety profile is invalid.");
}
