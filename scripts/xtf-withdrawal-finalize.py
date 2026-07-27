from pathlib import Path
import subprocess

path = Path("apps/cli/src/learnloop-study-schedule.test.ts")
text = path.read_text()
replacements = [
    (
        '''    expect(forward.counts.evaluationAssignments).toBe(8);
    expect(forward.counts.evaluationAssignmentsPerLanguage).toEqual({
      en: 4,
      "zh-TW": 4,
    });''',
        '''    expect(forward.counts.evaluationAssignments).toBe(14);
    expect(forward.counts.evaluationAssignmentsPerLanguage).toEqual({
      en: 8,
      "zh-TW": 6,
    });''',
    ),
    (
        '''    const insufficient = fixture.participants.filter(
      (participant) =>
        participant.split === "training" || participant.language === "en",
    );
    expect(() =>
      buildLearnLoopStudySchedule(fixture.plan, fixture.manifest, insufficient),
    ).toThrow("evaluation minimum for zh-TW");''',
        '''    const totalInsufficient = fixture.participants.filter(
      (participant) =>
        participant.split === "training" || participant.language === "en",
    );
    expect(() =>
      buildLearnLoopStudySchedule(
        fixture.plan,
        fixture.manifest,
        totalInsufficient,
      ),
    ).toThrow("minimumEvaluationUnits");

    const languageInsufficient = fixture.participants.filter(
      (participant) =>
        participant.split === "training" ||
        participant.language === "en" ||
        participant.participantHash === digest("evaluation-zh-a"),
    );
    expect(() =>
      buildLearnLoopStudySchedule(
        fixture.plan,
        fixture.manifest,
        languageInsufficient,
      ),
    ).toThrow("evaluation minimum for zh-TW");''',
    ),
    (
        '''    participant(planSha256, "evaluation-en-a", "evaluation", "en"),
    participant(planSha256, "evaluation-en-b", "evaluation", "en"),
    participant(planSha256, "evaluation-zh-a", "evaluation", "zh-TW"),
    participant(planSha256, "evaluation-zh-b", "evaluation", "zh-TW"),''',
        '''    participant(planSha256, "evaluation-en-a", "evaluation", "en"),
    participant(planSha256, "evaluation-en-b", "evaluation", "en"),
    participant(planSha256, "evaluation-en-c", "evaluation", "en"),
    participant(planSha256, "evaluation-en-d", "evaluation", "en"),
    participant(planSha256, "evaluation-zh-a", "evaluation", "zh-TW"),
    participant(planSha256, "evaluation-zh-b", "evaluation", "zh-TW"),
    participant(planSha256, "evaluation-zh-c", "evaluation", "zh-TW"),''',
    ),
    ("    minimumEvaluationUnits: 8,", "    minimumEvaluationUnits: 10,"),
]
for old, new in replacements:
    if text.count(old) != 1:
        raise RuntimeError(f"Expected exactly one scheduler fixture match: {old!r}")
    text = text.replace(old, new, 1)
path.write_text(text)
subprocess.run(["npx", "prettier", "--write", str(path)], check=True)
subprocess.run(["git", "add", str(path)], check=True)
