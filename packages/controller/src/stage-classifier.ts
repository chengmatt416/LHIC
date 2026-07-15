import type { NormalizedUIState, UserIntent } from "@lhic/schema";

export type ControllerStage =
  | "login"
  | "form_filling"
  | "search"
  | "download"
  | "test_web_flow"
  | "unknown";

export interface StageClassification {
  stage: ControllerStage;
  candidates: ControllerStage[];
  evidence: string[];
}

function objectText(state: NormalizedUIState): string[] {
  return state.objects.map((object) =>
    `${object.role ?? ""} ${object.label ?? ""} ${object.selector ?? ""}`.toLowerCase(),
  );
}

export function classifyStage(
  intent: UserIntent,
  state: NormalizedUIState,
): StageClassification {
  const text = objectText(state);
  const goal = intent.goal.toLowerCase();
  const candidates: Array<{ stage: ControllerStage; evidence: string[] }> = [];
  const hasEmail = text.some((value) => /email|username|user/.test(value));
  const hasPassword = text.some((value) => /password|passcode/.test(value));
  if (hasEmail && hasPassword) {
    candidates.push({
      stage: "login",
      evidence: ["Found username/email and password fields."],
    });
  }

  const hasRequiredField = text.some((value) => /required|\*/.test(value));
  const hasDisabledSubmit = state.objects.some(
    (object) =>
      object.enabled === false &&
      /submit|save|continue|next/.test(
        `${object.label ?? ""} ${object.role ?? ""}`.toLowerCase(),
      ),
  );
  if (hasRequiredField && hasDisabledSubmit) {
    candidates.push({
      stage: "form_filling",
      evidence: [
        "Found required-looking fields and a disabled submit control.",
      ],
    });
  }

  const hasSearchField = text.some(
    (value) =>
      /search|find|query/.test(value) && /textbox|searchbox|input/.test(value),
  );
  if (hasSearchField && /\b(search|find|look up|lookup)\b/.test(goal)) {
    candidates.push({
      stage: "search",
      evidence: ["Goal requests search and a search field is available."],
    });
  }

  const hasDownload = text.some((value) => /download|export/.test(value));
  if (hasDownload && /\b(download|export)\b/.test(goal)) {
    candidates.push({
      stage: "download",
      evidence: [
        "Goal requests download/export and a matching control is available.",
      ],
    });
  }

  const pageLoaded = Boolean(
    state.url || state.title || state.objects.length > 0,
  );
  if (pageLoaded && /\b(test|check|verify)\b/.test(goal)) {
    candidates.push({
      stage: "test_web_flow",
      evidence: ["Goal requests testing and the page is loaded."],
    });
  }

  const preferred =
    candidates.find((candidate) => candidate.stage === "login") ??
    candidates[0];
  return {
    stage: preferred?.stage ?? "unknown",
    candidates: candidates.map((candidate) => candidate.stage),
    evidence: preferred?.evidence ?? [
      "No supported local stage matched the UI state and goal.",
    ],
  };
}
