# XTF LearnLoop blinded stage-annotation rubric

Version: `stage-rubric-v1`

This rubric labels the human-intended stage represented by one frozen, non-sensitive task/UI observation. It must be used without access to participant identity, train/evaluation split, base prediction, LearnLoop prediction, confidence, admission decision, correction history, or model output.

## Allowed labels

### `login`

Choose `login` when the immediate human intent is to authenticate, enter an existing account, unlock an authenticated session, or continue an authentication flow.

Include:

- entering a username/email and password into a study fixture;
- choosing a study-provided account;
- continuing a synthetic sign-in step;
- completing a non-sensitive second-step authentication fixture.

Do not include:

- creating a new account;
- recovering a real password;
- changing profile data after authentication;
- navigating to a page that merely happens to contain a login button when login is not the task.

### `form_filling`

Choose `form_filling` when the immediate intent is to enter, edit, validate, or submit structured fields in a form.

Include:

- completing a synthetic registration, reservation, contact, or application fixture;
- correcting a field validation error;
- selecting form options before submission.

Do not include:

- authentication forms whose purpose is login;
- a search box whose purpose is information retrieval;
- free-form messaging or real sensitive information;
- a final verification-only step after the form has already been submitted.

### `search`

Choose `search` when the immediate intent is to retrieve or filter information by a query, category, or structured search control.

Include:

- entering a query into a search fixture;
- choosing filters or sorting to narrow results;
- selecting a result when selection is the direct continuation of the search task.

Do not include:

- filling a non-search form;
- downloading a known file without a retrieval step;
- browsing without a defined retrieval objective;
- testing whether a prior action succeeded.

### `download`

Choose `download` when the immediate intent is to obtain a local copy of a known non-sensitive file or artifact.

Include:

- choosing a study-provided export format;
- initiating a synthetic download;
- confirming a benign download when confirmation is part of the task.

Do not include:

- uploading a file;
- opening a document only for viewing;
- searching for a file when the file is not yet identified;
- executing or installing downloaded software.

### `test_web_flow`

Choose `test_web_flow` when the immediate intent is to verify that a previously defined website flow, state transition, or expected outcome works correctly.

Include:

- checking whether a synthetic submission produced the expected confirmation;
- running a benign study fixture designed as a test sequence;
- validating a postcondition after a controlled action.

Do not include:

- ordinary use of a website without a verification objective;
- debugging with access to source code or private logs;
- real production changes;
- selecting this label merely because the observation comes from an experiment.

### `unknown`

Choose `unknown` only when the immediate intent cannot be resolved from the approved blinded packet and rubric.

Use `unknown` when:

- two or more labels remain equally plausible;
- required context is missing;
- the task is outside all supported labels;
- the packet is malformed but still labelable as unresolved.

Do not guess a supported stage merely to avoid `unknown`.

## Decision procedure

Apply these steps in order:

1. Identify the immediate action objective, not the broader project goal.
2. Ignore visual prominence, button wording, or page branding unless it changes the action objective.
3. Distinguish authentication (`login`) from general structured entry (`form_filling`).
4. Distinguish retrieval (`search`) from obtaining a known artifact (`download`).
5. Use `test_web_flow` only when verification is itself the human objective.
6. Use `unknown` when the packet does not support one label with reasonable confidence.

## Annotation record

Each annotation must contain exactly:

```text
schemaVersion
planSha256
unitHash
annotatorHash
expectedStage
recordedAt
blindedToArm
```

`annotatorHash` must be derived with an annotator-specific secret salt or protected mapping. Do not use an email address, name, username, or unsalted low-entropy identifier.

## Independence rules

- Annotators A and B must work independently before comparing labels.
- An annotator must not label the same unit twice.
- The two annotators for a unit must be different people.
- An adjudicator must be different from both initial annotators.
- The adjudicator may see the two proposed labels and the same blinded packet, but not model-arm outputs or participant identity.
- Do not adjudicate an agreement.
- Do not change an initial annotation after seeing another label; preserve the disagreement and adjudicate it.

## Training and calibration

Before study labeling:

1. Train annotators on synthetic examples not used in the study.
2. Include difficult boundaries: login vs form filling, search vs download, and task execution vs verification.
3. Record rubric questions and publish clarifications as a versioned amendment before confirmatory labels are finalized.
4. Do not train annotators on LearnLoop predictions or corrections.
5. Keep a blinded audit sample for independent supervisor review.

## Adjudication reason codes

- `evidence_review`: the blinded packet and rubric resolve the disagreement.
- `third_rater_consensus`: the independent third label is used after applying the rubric.
- `insufficient_context`: the correct final label is `unknown` because the packet cannot support a resolved stage.

Agreement statistics measure consistency, not truth. High Fleiss’ kappa can coexist with a shared systematic error; task authorship, rubric quality, and audit results must be reported separately.
