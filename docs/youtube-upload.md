# YouTube upload metadata — Build Week demo

Use this only with the rendered file:

```text
demo-output/lhic-build-week-demo-2m36s.mp4
```

The file is 156 seconds, 1920×1080, H.264 video with AAC narration. It uses a
locally generated Kokoro voice; the video itself visibly discloses that the
voiceover is AI-generated.

## Title

```text
LHIC — Local-First Human Intent Controller | OpenAI Build Week Demo
```

## Description

```text
LHIC is a local-first execution runtime for computer-use agents. It separates probabilistic planning from deterministic, policy-controlled browser actions and records verifier evidence for every completed step.

This 2:36 demo shows a real local Playwright workflow, direct semantic execution, verifier evidence, selector recovery after a UI change, and a high-risk publish operation that is blocked until a human approves it.

GPT-5.6 is LHIC's explicit Slow Path planner for uncertain work. When enabled, its structured output is redacted, schema-checked, policy-checked, and cannot bypass approval or verification. The Fast Path makes no model or MCP calls.

The 50-fixture figures shown here are controlled local regression measurements, not public-web, market, or SOTA claims. Run the safe local demo without an account or credential using the repository instructions.

Voiceover in this video is AI-generated locally with the open-weight Kokoro model. No cloud TTS service, real account, API key, or production website is used in the recorded workflow.

Repository: https://github.com/chengmatt416/LHIC
Release-candidate evidence: https://github.com/chengmatt416/LHIC/actions/runs/29517027617

Chapters
0:00 The production computer-use gap
0:19 GPT-5.6 Slow Path safety boundary
0:33 Real local workflow and verifier evidence
1:03 UI change recovery and human approval gate
1:30 Fast Path benchmark scope
1:44 Codex collaboration and reproducibility
2:09 Closing
```

## Tags

```text
OpenAI Build Week, GPT-5.6, Codex, computer use, browser automation, Playwright, AI agents, agent safety, MCP, TypeScript
```

## Upload and public-release checklist

1. Upload the exact file above to the intended project channel.
2. Set language to English and audience to **not made for kids** when that is
   accurate for the channel and its policy settings.
3. Paste the title, description, chapters, and tags above without adding an
   unverified npm, GPT runtime, Devpost, or `/feedback` claim.
4. Confirm the rendered preview includes audio, the AI-voice disclosure, and
   no notifications, credentials, PII, or private browser data.
5. Before selecting **Public**, get the maintainer's final confirmation. That
   action creates a public, representational post.
6. After publication, open the public URL while signed out, replay it, record
   the URL and upload timestamp in the Notion handoff, then add the URL to the
   Devpost submission.
