# Participant information and consent template — LHIC LearnLoop offline intent study

Template version: `[CONSENT_VERSION]`

Study ID: `[STUDY_ID]`

Principal student researcher: `[NAME]`

Adult supervisor / responsible institution: `[NAME AND ORGANIZATION]`

Contact for questions: `[EMAIL OR OTHER APPROVED CONTACT]`

Contact for complaints or participant-rights questions: `[INDEPENDENT CONTACT]`

This is a template. It must be reviewed and adapted by the responsible adult or institution before recruitment. It is not ethics approval or legal advice.

## Why is this study being done?

This study evaluates whether a local Human Intent Controller can predict a person’s immediate web-task stage more accurately after bounded, verified corrections. The study compares two local prediction conditions on the same non-sensitive, frozen task observation. It does not test autonomous high-risk decisions and does not require real personal accounts.

## Why am I being invited?

You are being invited because `[ELIGIBILITY CRITERIA]`. Participation is optional. Choosing not to participate will not affect your grades, services, relationship with the researcher, or eligibility for any activity.

## What will I do?

If you agree, you will:

1. use study-provided, non-sensitive web fixtures;
2. complete approximately `[NUMBER]` tasks in `[LANGUAGE]`;
3. use only synthetic values supplied by the study;
4. allow the software to record bounded prediction and timing measurements;
5. tell the researcher if a task is unclear, uncomfortable, or appears to request real sensitive information.

Expected duration: approximately `[MINUTES]` minutes.

The study will not ask you to enter a real password, private message, financial information, medical information, government identifier, or other sensitive personal data.

## What information is recorded?

The research dataset may contain:

- a study-specific secret-salted participant hash;
- secret-salted session, task, and UI-variant hashes;
- language and preregistered study split;
- timestamps;
- consent and withdrawal status;
- bounded model predictions, confidence, admission category, and local latency;
- preregistered exclusion codes.

The analysis dataset must not contain your name, contact details, raw task text, raw UI text, screenshots, URLs, selectors, passwords, private messages, free-form notes, or the secret salt.

A separate restricted contact mapping may be kept only as long as necessary for scheduling and withdrawal. The responsible adult or institution must specify its deletion date before recruitment.

## Are there risks?

Foreseeable risks include:

- inconvenience, fatigue, or frustration;
- accidental display or entry of personal information if instructions are not followed;
- confidentiality risk if pseudonymous research files are accessed improperly;
- misunderstanding a synthetic task as a real action;
- unintended network activity from opening a study page.

Risk controls include synthetic tasks, no real credentials, local bounded data, restricted access, exact-schema validation, encrypted storage, and a stop procedure. Stop immediately and notify the study operator if a task requests sensitive information or appears to affect a real account or service.

## Are there benefits?

You may not receive a direct personal benefit. The study may help evaluate safer and faster local intent-prediction methods. Participation does not guarantee any improvement to software you use.

## Compensation

`[STATE THE AMOUNT AND CONDITIONS, OR: No compensation is offered.]`

Compensation must not depend on producing a particular result. Explain whether partial compensation is available after withdrawal: `[POLICY]`.

## Is participation voluntary?

Yes. You may skip a task, pause, or stop at any time without giving a reason. The study operator may also stop a session for safety, technical, or protocol reasons.

## How do I withdraw my data?

Until `[WITHDRAWAL DEADLINE OR CONDITION]`, contact `[WITHDRAWAL CONTACT]` and provide `[APPROVED REQUEST METHOD]`. The coordinator will use the separately stored contact mapping to identify your study code.

Withdrawal requires the project team to remove your matching blind units and linked labels from active study files, invalidate prior derived reports, and regenerate analysis. The repository command creates redacted replacement files; operational deletion of originals, backups under project control, and prior exports must be performed separately. Complete deletion may not be possible after irreversible anonymized aggregate publication; state the actual boundary here: `[BOUNDARY]`.

## How long will data be kept?

- Contact mapping deletion date: `[DATE]`
- Raw blind-unit deletion date: `[DATE]`
- Annotation/adjudication deletion date: `[DATE]`
- Finalized pseudonymous record deletion date: `[DATE]`
- Aggregate report retention: `[PERIOD]`
- Backup expiration: `[DATE OR POLICY]`

Data will be stored at `[LOCATION / SYSTEM]`, protected by `[ENCRYPTION AND ACCESS CONTROLS]`, and accessible to `[AUTHORIZED ROLES]`.

## How will results be shared?

Results may be submitted to XTF or other academic/competition venues and may be published in a paper, presentation, repository, or demonstration. Only aggregate results and non-sensitive reproducibility materials should be shared. Participant hashes, contact mappings, secret salts, restricted schedules, and raw study files must not be published.

## Questions or complaints

For study questions, contact `[STUDY CONTACT]`.

For concerns about your rights or to make a complaint to someone independent of the student researcher, contact `[INDEPENDENT ADULT / INSTITUTIONAL CONTACT]`.

## Consent statement

Please initial or check each statement:

- `[ ]` I have read or had explained the information above.
- `[ ]` I had an opportunity to ask questions.
- `[ ]` I understand participation is voluntary and I may stop.
- `[ ]` I understand what data will and will not be recorded.
- `[ ]` I understand the withdrawal procedure and its limits.
- `[ ]` I agree to participate in this study.

Participant name or approved code: ______________________________

Participant signature / approved electronic consent: ______________________________

Date and time: ______________________________

Person obtaining consent: ______________________________

Signature: ______________________________

Date and time: ______________________________

## Additional permission when required

The responsible adult or institution must determine whether participant assent, parent/guardian permission, school approval, or another authorization is required. Do not use this section as a substitute for that determination.

Parent/guardian name: ______________________________

Relationship: ______________________________

Permission signature: ______________________________

Date and time: ______________________________
