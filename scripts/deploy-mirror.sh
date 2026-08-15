#!/bin/sh
# One-command deployment of the lhic.techtools.qzz.io redirect project.
#
#   CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account> sh scripts/deploy-mirror.sh
#
# Requires: wrangler (npm install -g wrangler), Cloudflare Pages:Edit token.
# After this, add the custom domain + DNS record (see mirror/README.md).
set -eu

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
PROJECT_NAME="${LHIC_PAGES_PROJECT:-lhic-mirror}"

command -v wrangler >/dev/null 2>&1 || {
  echo "[deploy] installing wrangler…" >&2
  npm install --global wrangler
}

export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID

if ! wrangler pages project list --json 2>/dev/null | grep -q "\"name\":\"${PROJECT_NAME}\""; then
  echo "[deploy] creating Pages project ${PROJECT_NAME}…"
  wrangler pages project create "$PROJECT_NAME" --production-branch main
else
  echo "[deploy] Pages project ${PROJECT_NAME} exists."
fi

echo "[deploy] deploying redirect rules…"
wrangler pages deploy mirror --project-name "$PROJECT_NAME" --branch main

cat <<'EOF'
[deploy] done. Remaining manual steps (mirror/README.md):
  1. Cloudflare dashboard → DNS → Records → Add: CNAME  lhic  →  lhic-mirror.pages.dev
     (techtools.qzz.io is an active Cloudflare zone; the lhic.techtools.qzz.io
      custom domain is already attached to the project).
  No repo merge is required: releases/latest serves install.sh, install.ps1,
  and the desktop artifacts directly.
Canonical one-liner (works independently of mirror DNS):
  curl -fsSL https://github.com/chengmatt416/LHIC/releases/latest/download/install.sh | sh
EOF
