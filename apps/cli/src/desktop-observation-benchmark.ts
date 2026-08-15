import type { ExecutionElement } from "@lhic/skills";

/** Fixture element with optional bounds for coordinate-error measurement. */
type FixtureElement = ExecutionElement & {
  bounds?: { x: number; y: number; width: number; height: number };
};

export interface ObservationFixture {
  id: string;
  kind:
    | "unique-label"
    | "duplicate-label"
    | "multilingual"
    | "stale-tree"
    | "moved-target"
    | "dpi-scaled"
    | "occluded-target"
    | "dynamic-layout";
  tree: FixtureElement[];
  target: string;
  /** True when the target is uniquely resolvable from the tree. */
  expectUnique: boolean;
  /** Expected bounds of the correct target, when known. */
  expectedBounds?: { x: number; y: number };
}

function element(partial: Partial<FixtureElement>): FixtureElement {
  return {
    id: partial.id ?? "el",
    ...(partial.label !== undefined ? { label: partial.label } : {}),
    ...(partial.role !== undefined ? { role: partial.role } : {}),
    ...(partial.frame !== undefined ? { frame: partial.frame } : {}),
    ...(partial.bounds !== undefined ? { bounds: partial.bounds } : {}),
    interactable: partial.interactable ?? true,
  };
}

/**
 * Deterministic desktop observation fixtures covering the failure modes the
 * grounding layer must survive. Scores are architecture evidence, not
 * leaderboard results.
 */
export const observationFixtures: ObservationFixture[] = [
  {
    id: "unique-submit",
    kind: "unique-label",
    target: "Submit",
    expectUnique: true,
    tree: [
      element({
        id: "cancel",
        label: "Cancel",
        bounds: { x: 10, y: 10, width: 60, height: 20 },
      }),
      element({
        id: "submit",
        label: "Submit",
        bounds: { x: 80, y: 10, width: 60, height: 20 },
      }),
    ],
    expectedBounds: { x: 80, y: 10 },
  },
  {
    id: "duplicate-submit",
    kind: "duplicate-label",
    target: "Submit",
    expectUnique: false,
    tree: [
      element({
        id: "a",
        label: "Submit",
        bounds: { x: 10, y: 10, width: 60, height: 20 },
      }),
      element({
        id: "b",
        label: "Submit",
        bounds: { x: 10, y: 40, width: 60, height: 20 },
      }),
    ],
  },
  {
    id: "multilingual",
    kind: "multilingual",
    target: "Suchen",
    expectUnique: true,
    tree: [
      element({
        id: "de",
        label: "Suchen",
        bounds: { x: 0, y: 0, width: 80, height: 20 },
      }),
      element({
        id: "en",
        label: "Search",
        bounds: { x: 0, y: 30, width: 80, height: 20 },
      }),
    ],
    expectedBounds: { x: 0, y: 0 },
  },
  {
    id: "stale-tree",
    kind: "stale-tree",
    target: "Delete",
    expectUnique: true,
    tree: [
      // The target label exists but the tree is stale: the element moved.
      element({
        id: "delete-old",
        label: "Delete",
        bounds: { x: 300, y: 300, width: 60, height: 20 },
      }),
    ],
  },
  {
    id: "moved-target",
    kind: "moved-target",
    target: "Save",
    expectUnique: true,
    tree: [
      element({
        id: "save",
        label: "Save",
        bounds: { x: 500, y: 200, width: 60, height: 20 },
      }),
    ],
    expectedBounds: { x: 500, y: 200 },
  },
  {
    id: "dpi-scaled",
    kind: "dpi-scaled",
    target: "Export",
    expectUnique: true,
    tree: [
      element({
        id: "export",
        label: "Export",
        bounds: { x: 120, y: 60, width: 80, height: 24 },
      }),
    ],
    expectedBounds: { x: 120, y: 60 },
  },
  {
    id: "occluded-target",
    kind: "occluded-target",
    target: "Confirm",
    expectUnique: true,
    tree: [
      element({
        id: "confirm",
        label: "Confirm",
        bounds: { x: 40, y: 40, width: 60, height: 20 },
      }),
      element({
        id: "modal",
        label: "Modal",
        bounds: { x: 0, y: 0, width: 400, height: 300 },
      }),
    ],
  },
  {
    id: "dynamic-layout",
    kind: "dynamic-layout",
    target: "Next",
    expectUnique: true,
    tree: [
      element({
        id: "prev",
        label: "Previous",
        bounds: { x: 10, y: 10, width: 60, height: 20 },
      }),
      element({
        id: "next",
        label: "Next",
        bounds: { x: 80, y: 10, width: 60, height: 20 },
      }),
    ],
    expectedBounds: { x: 80, y: 10 },
  },
];

export interface ObservationMetrics {
  elementRecall: number;
  targetUniquenessRate: number;
  labelAccuracy: number;
  staleTargetRate: number;
  fallbackRate: number;
  coordinateErrorPx: number;
  falseMatchRate: number;
  ambiguousCount: number;
}

/**
 * Scores the fixtures with the same match semantics as the accessibility
 * backends: exact label/id first, then case-insensitive substring; more than
 * one candidate is ambiguous. A unique accessibility match means no
 * vision/native fallback is needed.
 */
export function scoreObservationFixtures(
  fixtures: ObservationFixture[],
): ObservationMetrics {
  let recalled = 0;
  let unique = 0;
  let labelHits = 0;
  let stale = 0;
  let fallback = 0;
  let coordinateError = 0;
  let coordinateCases = 0;
  let falseMatches = 0;
  let ambiguousCount = 0;

  for (const fixture of fixtures) {
    const candidates = fixture.tree.filter(
      (candidate) =>
        candidate.label?.toLocaleLowerCase() ===
          fixture.target.toLocaleLowerCase() ||
        candidate.id === fixture.target ||
        candidate.label
          ?.toLocaleLowerCase()
          .includes(fixture.target.toLocaleLowerCase()),
    );
    const isUnique = candidates.length === 1;
    if (candidates.length > 0) recalled += 1;
    if (isUnique) {
      unique += 1;
      labelHits += 1;
    }
    if (isUnique && fixture.expectUnique) {
      if (fixture.kind === "stale-tree") stale += 1;
    }
    if (!isUnique) fallback += 1; // Needs vision/native fallback.
    if (isUnique && fixture.expectedBounds && candidates[0]?.bounds) {
      coordinateError += Math.abs(
        candidates[0]!.bounds!.x - fixture.expectedBounds.x,
      );
      coordinateCases += 1;
    }
    if (isUnique && !fixture.expectUnique) falseMatches += 1;
  }

  for (const fixture of fixtures) {
    const candidates = fixture.tree.filter(
      (candidate) =>
        candidate.label?.toLocaleLowerCase() ===
          fixture.target.toLocaleLowerCase() ||
        candidate.id === fixture.target ||
        candidate.label
          ?.toLocaleLowerCase()
          .includes(fixture.target.toLocaleLowerCase()),
    );
    if (candidates.length > 1) ambiguousCount += 1;
  }

  return {
    elementRecall: fixtures.length === 0 ? 0 : recalled / fixtures.length,
    targetUniquenessRate: fixtures.length === 0 ? 0 : unique / fixtures.length,
    labelAccuracy: fixtures.length === 0 ? 0 : labelHits / fixtures.length,
    staleTargetRate: fixtures.length === 0 ? 0 : stale / fixtures.length,
    fallbackRate: fixtures.length === 0 ? 0 : fallback / fixtures.length,
    coordinateErrorPx:
      coordinateCases === 0 ? 0 : coordinateError / coordinateCases,
    falseMatchRate: fixtures.length === 0 ? 0 : falseMatches / fixtures.length,
    ambiguousCount,
  };
}

export async function runDesktopObservationBenchmarkCommand(): Promise<number> {
  const metrics = scoreObservationFixtures(observationFixtures);
  console.log(
    JSON.stringify(
      { metrics, fixtureCount: observationFixtures.length },
      null,
      2,
    ),
  );
  return 0;
}
