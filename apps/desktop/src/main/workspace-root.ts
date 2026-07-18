import { join, resolve } from "node:path";

export interface DesktopWorkspaceRootOptions {
  cwd: string;
  environmentWorkspaceRoot?: string | undefined;
  isPackaged: boolean;
  userData: string;
}

export function resolveDesktopWorkspaceRoot(
  options: DesktopWorkspaceRootOptions,
): string {
  const configuredRoot = options.environmentWorkspaceRoot?.trim();
  if (configuredRoot) return resolve(configuredRoot);

  if (options.isPackaged) {
    return join(resolve(options.userData), "workspace");
  }

  return resolve(options.cwd);
}
