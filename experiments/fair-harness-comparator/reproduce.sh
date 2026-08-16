#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TRIALS=10
OUT="$ROOT/artifacts/fair-harness-comparator"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --trials) TRIALS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ "$OUT" != /* ]]; then OUT="$ROOT/$OUT"; fi
rm -rf "$OUT"
mkdir -p "$OUT/results" "$OUT/reproducibility"
TOOLS="$(mktemp -d /tmp/lhic-fair-tools.XXXXXX)"
trap 'rm -rf "$TOOLS"' EXIT
cd "$ROOT"

python3 experiments/fair-harness-comparator/generate_fixtures.py --trials "$TRIALS" --out "$OUT/fixtures"
python3 experiments/fair-harness-comparator/self_test.py | tee "$OUT/reproducibility/fixture-self-test.txt"

mkdir -p "$TOOLS/codex"
cat > "$TOOLS/codex/package.json" <<'EOF'
{"private":true,"dependencies":{"@openai/codex":"0.147.0"}}
EOF
npm install --prefix "$TOOLS/codex" --no-audit --no-fund
cp "$TOOLS/codex/package-lock.json" "$OUT/reproducibility/codex-package-lock.json"
CODEX_BIN="$TOOLS/codex/node_modules/.bin/codex"
"$CODEX_BIN" --version | tee "$OUT/reproducibility/codex-version.txt"

GOOSE_URL="https://github.com/aaif-goose/goose/releases/download/v1.46.0/goose-x86_64-unknown-linux-gnu.tar.bz2"
GOOSE_SHA="a1cf4856a765d07d6b95689a53c7bca21fcc6e6d65c0dfd064fc704052b85a7b"
curl -fL --retry 3 "$GOOSE_URL" -o "$TOOLS/goose.tar.bz2"
echo "$GOOSE_SHA  $TOOLS/goose.tar.bz2" | sha256sum -c - | tee "$OUT/reproducibility/goose-sha256-check.txt"
mkdir -p "$TOOLS/goose"
tar -xjf "$TOOLS/goose.tar.bz2" -C "$TOOLS/goose"
GOOSE_BIN="$(find "$TOOLS/goose" -type f -name goose -perm -111 | head -1)"
test -n "$GOOSE_BIN"
"$GOOSE_BIN" --version | tee "$OUT/reproducibility/goose-version.txt"

python3 experiments/fair-harness-comparator/run_public_harness.py \
  --harness codex --binary "$CODEX_BIN" --fixtures "$OUT/fixtures" --out "$OUT/results/codex" --repo-root "$ROOT"
python3 experiments/fair-harness-comparator/run_public_harness.py \
  --harness goose --binary "$GOOSE_BIN" --fixtures "$OUT/fixtures" --out "$OUT/results/goose" --repo-root "$ROOT"
node --experimental-strip-types experiments/fair-harness-comparator/lhic_control.ts \
  --fixtures "$OUT/fixtures" --out "$OUT/results/lhic" --repo-root "$ROOT"

python3 - "$OUT/reproducibility/environment.json" <<'PY'
import json, os, platform, subprocess, sys
out = sys.argv[1]
def cmd(x):
    try:
        return subprocess.run(x, text=True, capture_output=True, check=False).stdout.strip()
    except Exception as e:
        return f"ERROR:{e}"
meta = {
  "platform": platform.platform(), "python": sys.version,
  "node": cmd(["node","--version"]), "npm": cmd(["npm","--version"]),
  "gitSha": cmd(["git","rev-parse","HEAD"]),
  "gitStatusPorcelain": cmd(["git","status","--porcelain"]),
  "githubSha": os.environ.get("GITHUB_SHA"),
  "githubRunId": os.environ.get("GITHUB_RUN_ID"),
}
open(out,"w").write(json.dumps(meta,indent=2,sort_keys=True)+"\n")
PY
python3 experiments/fair-harness-comparator/aggregate.py --root "$OUT"
sha256sum "$OUT/combined-summary.json" "$OUT/RESULTS.md" > "$OUT/reproducibility/top-level-sha256.txt"
