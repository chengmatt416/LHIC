# LHIC distribution redirect

`lhic.techtools.qzz.io` is a **redirect-only** Cloudflare Pages project.
GitHub is the data store: installer scripts live in the repo
(`scripts/install.sh`, `scripts/install.ps1`) and desktop installers live on
GitHub Releases — this domain only rewrites URLs to them.

| Path | Redirects to |
| --- | --- |
| `/install.sh` | `raw.githubusercontent.com/chengmatt416/LHIC/main/scripts/install.sh` |
| `/install.ps1` | `raw.githubusercontent.com/chengmatt416/LHIC/main/scripts/install.ps1` |
| `/release/*` | `github.com/chengmatt416/LHIC/releases/latest/download/*` |

## One-liners

```sh
curl -fsSL https://lhic.techtools.qzz.io/install.sh | sh
```

```powershell
irm https://lhic.techtools.qzz.io/install.ps1 | iex
```

The installers download `/release/<asset>` (redirected to the latest GitHub
release) and fall back to the GitHub URL directly when the redirect is
unreachable.

## Deployment

`.github/workflows/deploy-mirror.yml` deploys this single `_redirects` file
on `main` changes to `mirror/**`:

```sh
wrangler pages deploy mirror --project-name lhic-mirror --branch main
```

### One-time setup (maintainer, ~3 minutes)

1. Create the Pages project:
   ```sh
   wrangler pages project create lhic-mirror --production-branch main
   ```
2. Add the custom domain + DNS record. `techtools.qzz.io` is an **active
   Cloudflare zone** in this account, so do it in the Cloudflare dashboard:
   - Pages → lhic-mirror → Custom domains → add `lhic.techtools.qzz.io`
   - DNS → Records → Add record:
     `CNAME  lhic  →  lhic-mirror.pages.dev` (proxied)
   The Pages domain activates once the record resolves.
3. GitHub repository secrets (for CI deploys of `mirror/**`):
   - `CLOUDFLARE_API_TOKEN` — token with `Cloudflare Pages:Edit` and `Zone:DNS Edit`
   - `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID

Then push the repo (so raw.githubusercontent serves `scripts/install.sh`)
and push a `desktop-v0.2.0`-style tag (so `/release/*` resolves) — the
one-liner goes live.

### Status (2026-08-12)

- Pages project `lhic-mirror` created, `_redirects` deployed
  (verified live: 302 → raw.githubusercontent / releases/latest).
- Custom domain `lhic.techtools.qzz.io` added (pending DNS record).
- Remaining: the `lhic` CNAME record in Cloudflare DNS (dashboard, 30s),
  repo push, and the `desktop-v0.2.0` release tag.

### Local preview (redirects applied)

```sh
wrangler pages dev mirror --port 8788
curl -fsSL http://127.0.0.1:8788/install.sh | head -3
```
