# Demo video renderer

`npm run demo:render` records real local Playwright workflows, runs the
project's local benchmarks, generates English narration with the local,
open-weight `Kokoro-82M` model, and edits the following 1080p MP4 files into
`demo-output/`:

- `lhic-demo-1m.mp4` — a 60-second product overview with a live application
  surface and Operator Console.
- `lhic-demo-5m.mp4` — a five-minute walkthrough with dynamic UI mutation,
  selector-memory recovery, reconciliation evidence, and a policy-blocked
  publish action that visibly requires human approval.

The renderer requires the project Chromium runtime, `ffmpeg`, and Python 3.11
through 3.13. On first run it creates an isolated environment and downloads the
Kokoro INT8 model and its voice pack to `demo-output/.kokoro/`; subsequent runs
are offline. No API key or cloud TTS service is used. `LHIC_KOKORO_VOICE`
(default `af_heart`), `LHIC_KOKORO_SPEED` (default `1.15`), and
`LHIC_KOKORO_PYTHON` optionally customize local synthesis. Each scene visibly
discloses that its voiceover is AI-generated. The renderer also synthesizes a
low-level ambient music bed and short UI sound effects locally, then ducks the
music under narration to preserve speech clarity; no third-party audio assets
are bundled.

Its cards
always label benchmark figures as local controlled measurements. The cost claim
is limited to the Fast Path's zero LLM calls and zero LLM-token cost per action;
it does not claim total infrastructure cost is zero. Console entries are derived
from actual execution results and verifier evidence; the page instrumentation
only renders those results for the recording.
