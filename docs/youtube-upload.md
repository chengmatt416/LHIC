# YouTube upload metadata — Build Week demo

Use this only with the rendered file:

```text
demo-output/lhic-build-week-demo-commerce-learning.mp4
```

The file is 171 seconds, 1920×1080, H.264 video with AAC narration. It uses a
locally generated Kokoro voice; the video itself visibly discloses that the
voiceover is AI-generated.

## Title

```text
LHIC — Local-First Human Intent Controller | OpenAI Build Week Demo
```

## Description

```text
LHIC is a local-first execution runtime for computer-use agents. It separates probabilistic planning from deterministic, policy-controlled browser actions and records verifier evidence for every completed step.

This 2:51 demo opens a real local HTTP shopping site in Playwright. A complex Slow Path cart plan searches, configures a keyboard, opens checkout, survives a checkout UI mutation, redeems a promotion, selects delivery, and verifies the cart preview. Every action must have verifier evidence before LHIC saves a redacted local candidate; three independent runs and a deterministic offline holdout are required before promotion.

The video then opens a fresh cart and routes an explicitly preloaded deterministic fixture skill through the Fast Path: zero model calls and zero MCP calls. It does not claim that the just-recorded candidate is already Fast Path eligible. The Fast Path still refuses to place an order until a human provides approval.

GPT-5.6 is LHIC's explicit Slow Path planner for uncertain work. When enabled, its structured output is redacted, schema-checked, policy-checked, and cannot bypass approval or verification. The Fast Path makes no model or MCP calls.

For a credential-free, reproducible recording, the shopping-plan input is a deterministic fixture at the Slow Path boundary; it exercises the real SlowPathLearningCoordinator, SkillStore, FastPathRouter, direct executor, and verifier path without claiming a live GPT request in the video.

The 50-fixture figures shown here are controlled local regression measurements, not public-web, market, or SOTA claims. Run the safe local demo without an account or credential using the repository instructions.

Voiceover in this video is AI-generated locally with the open-weight Kokoro model. No cloud TTS service, real account, API key, or production website is used in the recorded workflow.

Repository: https://github.com/chengmatt416/LHIC
Release-candidate evidence: https://github.com/chengmatt416/LHIC/actions/runs/29517027617

Chapters
0:00 The production computer-use gap
0:19 GPT-5.6 Slow Path safety boundary
0:33 Slow Path shopping cart and verifier evidence
0:47 Verified skill saved locally
0:51 Learned Fast Path and approval gate
1:31 Verification-to-learning rule
1:45 Security boundary
2:00 Fast Path benchmark scope
2:14 Codex collaboration and reproducibility
2:39 Closing
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
