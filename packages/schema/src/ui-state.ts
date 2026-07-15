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

export function isNormalizedUIState(
  value: unknown,
): value is NormalizedUIState {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<NormalizedUIState>;
  return (
    ["browser", "desktop", "filesystem", "unknown"].includes(
      candidate.surface ?? "",
    ) &&
    Array.isArray(candidate.objects) &&
    !!candidate.signals &&
    typeof candidate.signals === "object" &&
    typeof candidate.capturedAt === "string"
  );
}
