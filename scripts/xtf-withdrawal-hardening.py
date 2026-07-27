from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if text.count(old) != 1:
        raise RuntimeError(f"Expected exactly one match in {path}: {old!r}")
    file.write_text(text.replace(old, new, 1))


labeling = "apps/cli/src/learnloop-study-labeling.ts"
replace_once(
    labeling,
    '''  if (value.length < 1 || value.length > maximumAnnotations) {
    throw new Error(
      `Study annotations must contain 1-${maximumAnnotations} records.`,
    );
  }''',
    '''  if (value.length > maximumAnnotations) {
    throw new Error(
      `Study annotations must contain 0-${maximumAnnotations} records.`,
    );
  }''',
)

withdrawal = "apps/cli/src/learnloop-study-withdrawal.ts"
replace_once(
    withdrawal,
    '''    unitHashes: string[];''',
    '''    unitSetSha256: string;''',
)
replace_once(
    withdrawal,
    '''  const planSha256 = [...planHashes][0]!;
  assertRowsBoundToKnownUnits(''',
    '''  const planSha256 = [...planHashes][0]!;
  const latestSourceRecordedAtMs = Math.max(
    ...units.map((unit) => Date.parse(unit.recordedAt)),
    ...annotations.map((annotation) => Date.parse(annotation.recordedAt)),
    ...adjudications.map((adjudication) => Date.parse(adjudication.recordedAt)),
  );
  if (Date.parse(withdrawnAt) < latestSourceRecordedAtMs) {
    throw new Error("Study withdrawal timestamp predates a source record.");
  }
  assertRowsBoundToKnownUnits(''',
)
replace_once(
    withdrawal,
    '''      unitHashes: removedUnitHashes,''',
    '''      unitSetSha256: hashState(removedUnitHashes),''',
)

withdrawal_test = "apps/cli/src/learnloop-study-withdrawal.test.ts"
replace_once(
    withdrawal_test,
    '''    expect(redacted.receipt.removed.unitHashes).toEqual(
      fixture.units
        .filter(
          (unit) => unit.participantHash === fixture.withdrawnParticipantHash,
        )
        .map((unit) => hashLearnLoopStudyBlindUnit(unit))
        .sort(),
    );''',
    '''    const removedUnitHashes = fixture.units
      .filter(
        (unit) => unit.participantHash === fixture.withdrawnParticipantHash,
      )
      .map((unit) => hashLearnLoopStudyBlindUnit(unit))
      .sort();
    expect(redacted.receipt.removed.unitSetSha256).toBe(
      hashState(removedUnitHashes),
    );
    expect(redacted.receipt.removed).not.toHaveProperty("unitHashes");''',
)
replace_once(
    withdrawal_test,
    '''  it("rolls back all newly created files if one output is reserved", async () => {''',
    '''  it("supports withdrawal before labeling and rejects an impossible timestamp", () => {
    const fixture = withdrawalFixture();
    const beforeLabeling = redactLearnLoopStudyParticipant(
      fixture.units,
      [],
      [],
      fixture.withdrawnParticipantHash,
      "2026-07-27T01:00:00.000Z",
    );
    expect(beforeLabeling.annotations).toHaveLength(0);
    expect(beforeLabeling.adjudications).toHaveLength(0);

    expect(() =>
      redactLearnLoopStudyParticipant(
        fixture.units,
        fixture.annotations,
        fixture.adjudications,
        fixture.withdrawnParticipantHash,
        "2026-07-26T23:59:59.000Z",
      ),
    ).toThrow("predates a source record");
  });

  it("rolls back all newly created files if one output is reserved", async () => {''',
)

protocol = "docs/xtf-study-preregistration.md"
replace_once(
    protocol,
    '''The receipt includes before/after counts and order-independent digests, removed unit hashes, a non-linkable withdrawal-subject commitment, and explicit invalidation flags.''',
    '''The receipt includes before/after counts and order-independent digests, a digest of the removed unit set, a plan-and-time-bound withdrawal-subject commitment, and explicit invalidation flags. It does not retain the participant hash or individual removed unit hashes.''',
)

review = "docs/xtf-adversarial-review.md"
replace_once(
    review,
    '''The withdrawal command removes every participant unit and linked labeling row, emits before/after digests and invalidation flags, rolls back partial outputs, and requires deletion and regeneration of all derived records and reports.''',
    '''The withdrawal command removes every participant unit and linked labeling row, emits before/after digests and invalidation flags, omits participant and individual unit join keys from the receipt, accepts pre-labeling withdrawal, rejects impossible timestamps, rolls back partial outputs, and requires deletion and regeneration of all derived records and reports.''',
)
