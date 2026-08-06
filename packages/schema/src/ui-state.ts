export type UISurface = "browser" | "desktop" | "filesystem" | "unknown";
export type UIObjectSource = "dom" | "accessibility" | "ocr" | "vision" | "api";

export interface UIObject {
  id: string;
  role?: string;
  label?: string;
  value?: string;
  enabled?: boolean;
  focused?: boolean;
  source: UIObjectSource;
  selector?: string;
  ref?: string;
  bbox?: [number, number, number, number];
}

export interface NormalizedUIState {
  surface: UISurface;
  app?: string;
  url?: string;
  title?: string;
  screenType?: string;
  objects: UIObject[];
  signals: Record<string, unknown>;
  capturedAt: string;
}

function isUIObject(value: unknown): value is UIObject {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as Partial<UIObject>;
  if (typeof obj.id !== "string" || !obj.id.trim()) {
    return false;
  }
  if (
    typeof obj.source !== "string" ||
    !["dom", "accessibility", "ocr", "vision", "api"].includes(obj.source)
  ) {
    return false;
  }
  if (obj.bbox !== undefined) {
    if (
      !Array.isArray(obj.bbox) ||
      obj.bbox.length !== 4 ||
      !obj.bbox.every((v) => typeof v === "number" && Number.isFinite(v))
    ) {
      return false;
    }
  }
  if (obj.enabled !== undefined && typeof obj.enabled !== "boolean") {
    return false;
  }
  if (obj.focused !== undefined && typeof obj.focused !== "boolean") {
    return false;
  }
  return true;
}

export function isNormalizedUIState(
  value: unknown,
): value is NormalizedUIState {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<NormalizedUIState>;
  if (
    !["browser", "desktop", "filesystem", "unknown"].includes(
      candidate.surface ?? "",
    )
  ) {
    return false;
  }
  if (!Array.isArray(candidate.objects) || !candidate.objects.every(isUIObject)) {
    return false;
  }
  if (!candidate.signals || typeof candidate.signals !== "object") {
    return false;
  }
  if (typeof candidate.capturedAt !== "string") {
    return false;
  }
  return true;
}
