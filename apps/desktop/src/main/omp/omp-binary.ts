import { app } from "electron";
import { join } from "node:path";

export function resolveOmpBinary(): string {
  if (process.env.OMP_BINARY) {
    return process.env.OMP_BINARY;
  }
  const fileName = process.platform === "win32" ? "omp.exe" : "omp";
  if (app.isPackaged) {
    return join(process.resourcesPath, "omp", fileName);
  }
  return join(app.getAppPath(), "vendor", "omp", "current", fileName);
}
