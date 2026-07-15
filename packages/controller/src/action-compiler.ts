import type { SemanticAction, UserIntent } from "@lhic/schema";

import type { IntentPrediction } from "./predictor.js";

export interface CompileResult {
  actions: SemanticAction[];
  missingInformation: string[];
}

export function compileActions(
  prediction: IntentPrediction,
  intent: UserIntent,
): CompileResult {
  const query =
    typeof intent.constraints.query === "string"
      ? intent.constraints.query
      : undefined;
  switch (prediction.predictedIntent) {
    case "search":
      return query
        ? {
            actions: [
              {
                type: "fill",
                intent: "fill search query",
                target: "Search",
                value: query,
                methodPreference: ["accessibility", "dom", "keyboard"],
                riskLevel: "low",
              },
              {
                type: "press",
                intent: "submit search query",
                target: "Search",
                value: "Enter",
                methodPreference: ["keyboard", "accessibility"],
                riskLevel: "low",
              },
            ],
            missingInformation: [],
          }
        : { actions: [], missingInformation: ["search_query"] };
    case "download":
      return {
        actions: [
          {
            type: "download",
            intent: "download requested file",
            target: "Download",
            methodPreference: ["dom", "accessibility"],
            riskLevel: "low",
          },
        ],
        missingInformation: [],
      };
    case "login":
      return { actions: [], missingInformation: ["credentials"] };
    case "form_filling":
      return { actions: [], missingInformation: ["form_fields"] };
    case "test_web_flow":
      return { actions: [], missingInformation: ["test_steps"] };
    case "unknown":
      return { actions: [], missingInformation: ["supported_operation"] };
  }
}
