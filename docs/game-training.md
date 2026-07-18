# Local Action-Game Training

Game training has two incompatible execution cores. It does not use an LLM,
MCP, online multiplayer, score submission, or skill sharing. Local targets are
the default; the explicit `epic-shooter-3d` profile is an allowlisted,
browser-hosted single-player exception requested for FPS training and demos.

| Core | Local target                                                         | Policy input           | Controls                                                           |
| ---- | -------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------ |
| `2d` | future permitted 2D profiles                                         | two 128x128 RGB frames | eight-way WASD movement, Space fire, optional bounded absolute aim |
| `3d` | [Epic Shooter 3D](https://www.epicshooter3d.com/) single-player mode | four 96x96 RGB frames  | held WASD, primary-fire, 7x7 bounded relative look                 |

The 2D core remains available but Star Trooper is not used for training or
demonstration. Nemesis remains an optional separately obtained GPLv3 local
profile. The online FPS profile is browser-hosted, starts the Farm House/Easy
single-player flow, and permits requests only to
`https://www.epicshooter3d.com`; it never selects multiplayer. Local profiles
receive a seeded `Math.random` shim before loading. Remote targets deliberately
do not receive that preload. Remote registration also requires a post-start
readiness selector; startup is retried three times and fails closed if the
playable scene is not ready.

Epic Shooter 3D also requires browser pointer lock for real look-and-fire
input. The direct browser runner verifies that capability before recording or
playing and fails closed if the browser denies it; it never writes a dataset of
ineffective fire actions. Where a browser host denies pointer lock, use the
desktop surface with a user-opened, already started single-player game.

## Setup

Create the approved isolated Python environment first:

```sh
lhic train game env setup
lhic train game env doctor
```

It installs PyTorch, `mss`, PyAutoGUI, and `pynput` into
`.lhic/game-training/venv`. Desktop execution requires an interactive
macOS or Windows session, or Linux X11; Wayland is rejected.

Register the approved single-player FPS before use. This is a strict opt-in:
the profile stores its exact HTTPS target URL and origin allowlist locally.

```sh
lhic train game 3d setup epic-shooter-3d
```

Local profiles still require a permitted offline checkout whose directory
contains `index.html`, for example:

```sh
lhic train game 3d setup nemesis --source /path/to/Nemesis
```

## Record, train, and evaluate

For the remote FPS profile, recording opens the allowlisted hosted game in an
isolated browser context. `--scripted` supplies a non-multiplayer starter
demonstration; omit it to record a focused, operator-supplied demonstration.
The recorder stores frames, allowed input, and kill/health telemetry under the
3D core.

```sh
lhic train game 3d record epic-shooter-3d --scripted \
  --output .lhic/game-training/3d/datasets/epic-shooter-demo
lhic train game 3d fit epic-shooter-3d \
  --dataset .lhic/game-training/3d/datasets/epic-shooter-demo/manifest.json \
  --output .lhic/game-training/3d/skills/epic-shooter-v1
lhic train game 3d play epic-shooter-3d \
  --artifact .lhic/game-training/3d/skills/epic-shooter-v1/artifact.json \
  --viewable
```

Each record/fit response includes capture rate, movement diversity, fire, and
look sample counts. Fitting requires at least 16 frames; use the desktop
recorder to collect a genuine operator demonstration rather than promoting a
short startup smoke capture into a policy.

Recording, evaluation, and play responses also include a `realtime` summary:
the requested control rate, observed rate, processing P50/P95, frame P95, and
deadline-miss count. The runner waits only for the unused portion of a frame
after capture, local policy inference, and approved input application. An
over-budget frame is reported as a miss and never receives an extra full-frame
delay. This keeps the action loop local and makes target-rate regressions
visible without adding a model, MCP, or network call.

For an interactive online FPS window, first start the single-player scene and
acquire its pointer lock yourself. Then create a five-minute lease for the
focused game region and use the desktop driver; the driver adopts that exact
window rather than launching another browser session.

```sh
lhic train game 3d lease epic-shooter-3d \
  --window-title "Epic Shooter 3D" --region 100,100,1024,768 \
  --approved-by local-operator --output /tmp/epic-shooter-lease.json

lhic train game 3d play epic-shooter-3d --surface desktop \
  --artifact .lhic/game-training/3d/skills/epic-shooter-v1/artifact.json \
  --window-title "Epic Shooter 3D" --region 100,100,1024,768 \
  --lease /tmp/epic-shooter-lease.json
```

Use the same lease to record a real operator demonstration from that focused
window. The desktop recorder only captures the profile's allowed keys, primary
click pulses, bounded relative look, and the leased screen region; focus loss
or lease expiry stops recording without sending input.

```sh
lhic train game 3d record epic-shooter-3d --surface desktop \
  --window-title "Epic Shooter 3D" --region 100,100,1024,768 \
  --lease /tmp/epic-shooter-lease.json \
  --output .lhic/game-training/3d/datasets/epic-shooter-human-v1
```

Evaluation uses ten fixed seeds by default and compares the policy with that
core's legal-action random baseline. It passes only when the policy has a
positive mean score and exceeds the baseline. The hosted FPS does not expose a
seed API, so its reports are marked `deterministic: false` and cannot qualify
as a fixed-seed pass; use a target-provided deterministic seed interface before
treating it as a benchmark result. Reports retain per-seed failures and learned
and random availability rates, so an intermittent hosted target does not erase
the rest of a comparison run.

Datasets, weights, reports, and trace files live below
`.lhic/game-training/2d/` or `.lhic/game-training/3d/`. A load verifies core,
target-profile digest, action codec, preprocessing version, frame shape, and
weights digest, so models cannot cross cores.

## Execute

For the direct browser runner:

```sh
lhic train game 3d play nemesis \
  --artifact .lhic/game-training/3d/skills/nemesis-v1/artifact.json \
  --viewable
```

For the Python desktop capture/input driver, create a five-minute lease tied to
the exact core, profile, window title, capture rectangle, and input limits.
The desktop command launches the registered local game in a browser with its
seeded preload script. Use the exact active window title and the screen-space
content rectangle; if focus changes, capture fails, or the lease expires, all
approved inputs are released and the session stops.

```sh
lhic train game 3d lease nemesis \
  --window-title "Nemesis" --region 100,100,1024,768 \
  --approved-by local-operator --output /tmp/nemesis-lease.json

lhic train game 3d play nemesis --surface desktop \
  --artifact .lhic/game-training/3d/skills/nemesis-v1/artifact.json \
  --window-title "Nemesis" --region 100,100,1024,768 \
  --lease /tmp/nemesis-lease.json
```

Every automated control batch writes a redacted trace event. The driver only
permits profile allowlisted keys, primary-click state, and the core's bounded
pointer mode.
