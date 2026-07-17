# Local Action-Game Training

Game training is local-only and has two incompatible execution cores. It does
not use an LLM, MCP, online multiplayer, score submission, or skill sharing.

| Core | Local target | Policy input | Controls |
| --- | --- | --- | --- |
| `2d` | [Star Trooper](https://github.com/idgm5/shootergame) | two 128x128 RGB frames | eight-way WASD movement, Space fire, optional bounded absolute aim |
| `3d` | [Nemesis](https://github.com/IceCreamYou/Nemesis) | four 96x96 RGB frames | held WASD, primary-fire, 7x7 bounded relative look |

Star Trooper's shipped profile disables pointer aim. Nemesis must be obtained
as a separate local GPLv3 checkout; neither upstream game is bundled or
modified. Both targets receive a seeded `Math.random` shim before they load.

## Setup

Create the approved isolated Python environment first:

```sh
lhic train game env setup
lhic train game env doctor
```

It installs PyTorch, `mss`, PyAutoGUI, and `pynput` into
`.lhic/game-training/venv`. Desktop execution requires an interactive
macOS or Windows session, or Linux X11; Wayland is rejected.

Clone only a permitted offline game copy and register it by core. The supplied
directory must contain `index.html`.

```sh
lhic train game 2d setup star-trooper --source /path/to/shootergame
lhic train game 3d setup nemesis --source /path/to/Nemesis
```

## Record, train, and evaluate

Recording opens only a loopback static server and a local browser window. Use
the focused game window to supply a demonstration; the recorder stores frames,
allowed input, and permitted score/health telemetry under the selected core.

```sh
lhic train game 2d record star-trooper --output .lhic/game-training/2d/datasets/run-1
lhic train game 2d fit star-trooper \
  --dataset .lhic/game-training/2d/datasets/run-1/manifest.json \
  --output .lhic/game-training/2d/skills/star-trooper-v1
lhic train game 2d evaluate star-trooper \
  --artifact .lhic/game-training/2d/skills/star-trooper-v1/artifact.json
```

Evaluation uses ten fixed seeds by default and compares the policy with that
core's legal-action random baseline. It passes only when the policy has a
positive mean score and exceeds the baseline.

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
