# Demo recording script

## 0:00–0:15 — problem

Explain that production computer-use systems need a boundary between
probabilistic planning and real computer actions: credentials, unstable UI,
high-risk actions, and unverifiable success are not solved by a model alone.

## 0:15–0:35 — solution

Show the README and say: GPT-5.6 is optional Slow Path planning; LHIC locally
validates, executes, verifies, redacts, and audits. Fast Path never calls a
model.

## 0:35–1:30 — safe local demo

Run `npm run demo -- --safe` with a large terminal font. Show the successful local
browser fixture, the verifier evidence count, and the `ask_user` result for a
destructive intent. State that no account, credential, or external website is
used.

## 1:30–1:55 — GPT-5.6

In a clean terminal with no secret visible, enable the environment variables
before recording or use a preconfigured safe shell. Show the structured plan,
then point to the provider's `store: false`, redaction, schema, and policy
checks. Do not execute a high-risk model proposal.

## 1:55–2:20 — benchmark

Run `npm run bench:internal` and state the controlled-fixture scope. Show the
command, environment, sample count, and raw output. Do not call it a public
benchmark or SOTA result.

## 2:20–2:45 — Codex collaboration

Show a core implementation diff, a test, and a passing result. Explain the
maintainer's product, architecture, security, and acceptance decisions and
Codex's implementation and verification assistance. Display the official
`/feedback` Session ID only after it is obtained.

## 2:45–2:58 — closing

State: “GPT-5.6 provides intelligence. LHIC makes computer actions safe,
deterministic, and verifiable.” Confirm the final public video is under three
minutes and has clear voiceover and subtitles.
