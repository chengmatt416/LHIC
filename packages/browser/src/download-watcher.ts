import { mkdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { Download, Page } from "playwright";

import { resolveTarget } from "./target-resolver.js";

export interface DownloadResult {
  filePath: string;
  fileName: string;
  size: number;
}

export async function waitForDownload(
  page: Page,
  trigger: string,
  options: { downloadDir?: string; timeoutMs?: number } = {},
): Promise<DownloadResult> {
  const timeout = options.timeoutMs ?? 10_000;
  const target = await resolveTarget(page, trigger);
  const downloadPromise = page.waitForEvent("download", { timeout });
  await target.locator.click();
  const download: Download = await downloadPromise;
  const fileName = basename(download.suggestedFilename());
  const directory = options.downloadDir ?? "downloads";
  await mkdir(directory, { recursive: true });
  const filePath = join(directory, fileName);
  await download.saveAs(filePath);
  const fileStats = await stat(filePath);

  return { filePath, fileName, size: fileStats.size };
}

export function hasExtension(filePath: string, extension: string): boolean {
  const normalized = extension.startsWith(".") ? extension : `.${extension}`;
  return extname(filePath).toLowerCase() === normalized.toLowerCase();
}
