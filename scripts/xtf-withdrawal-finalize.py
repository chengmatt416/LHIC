from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if text.count(old) != 1:
        raise RuntimeError(f"Expected exactly one match in {path}: {old!r}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "apps/cli/src/learnloop-study-withdrawal.ts",
    '''  const annotations = parseLearnLoopStudyAnnotations(annotationsInput);''',
    '''  const annotations =
    annotationsInput.length === 0
      ? []
      : parseLearnLoopStudyAnnotations(annotationsInput);''',
)

replace_once(
    "docs/xtf-study-preregistration.md",
    '''The receipt includes before/after counts and order-independent digests, removed unit hashes, a non-linkable withdrawal-subject commitment, and explicit invalidation flags.''',
    '''The receipt includes before/after counts and order-independent digests, a digest of the removed unit set, a plan-and-time-bound withdrawal-subject commitment, and explicit invalidation flags. It does not retain the participant hash or individual removed unit hashes.''',
)

replace_once(
    "docs/xtf-adversarial-review.md",
    '''The withdrawal command removes every participant unit and linked labeling row, emits before/after digests and invalidation flags, rolls back partial outputs, and requires deletion and regeneration of all derived records and reports.''',
    '''The withdrawal command removes every participant unit and linked labeling row, emits before/after digests and invalidation flags, omits participant and individual unit join keys from the receipt, accepts pre-labeling withdrawal, rejects impossible timestamps, rolls back partial outputs, and requires deletion and regeneration of all derived records and reports.''',
)
