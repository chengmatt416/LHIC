# PowerShell one-liner installer for the LHIC desktop app AND the LHIC CLI.
#
#   irm https://lhic.techtools.qzz.io/install.ps1 | iex
#
# Installs:
#   1. Desktop app (LHIC Control Center) — NSIS installer from the matching
#      GitHub release (desktop-v<VERSION>), SHA-256 verified, per-user.
#   2. CLI (lhic) — @pinyencheng/lhic via npm (Node.js 24+).
#
# Artifacts are downloaded from the lhic.techtools.qzz.io mirror and fall
# back to the GitHub release when the mirror is unreachable.
#
# When the desktop app is not supported (non-x64 Windows) or its install
# fails, a warning is printed and only the CLI is installed. Exits non-zero
# only when neither component could be installed.
#
# Env overrides:
#   LHIC_DESKTOP_VERSION   release version (default 0.2.1)
#   LHIC_DESKTOP_BASE_URL  release download base URL (tests/mirrors)
#   LHIC_SKIP_BACKENDS     set 1 to skip execution-layer provisioning
#   LHIC_SKIP_DESKTOP      set 1 to install the CLI only
#   LHIC_SKIP_CLI          set 1 to install the desktop only
$ErrorActionPreference = "Stop"

$version = if ($env:LHIC_DESKTOP_VERSION) { $env:LHIC_DESKTOP_VERSION } else { "0.2.1" }
$baseUrl = if ($env:LHIC_DESKTOP_BASE_URL) {
  $env:LHIC_DESKTOP_BASE_URL
} else {
  "https://lhic.techtools.qzz.io/release"
}
$githubBaseUrl = "https://github.com/chengmatt416/LHIC/releases/download/desktop-v$version"
$cliPackage = "@pinyencheng/lhic"

# Downloads $out from the mirror $url, falling back to the GitHub release.
function Fetch-Url {
  param([string]$Url, [string]$Out)
  try {
    Invoke-WebRequest -Uri $Url -OutFile $Out
  } catch {
    $asset = $Url.Split('/')[-1]
    Invoke-WebRequest -Uri "$githubBaseUrl/$asset" -OutFile $Out
  }
}

$desktopOk = $true

# ---- 1. Desktop app --------------------------------------------------------
if ($env:LHIC_SKIP_DESKTOP -eq "1") {
  Write-Host "[lhic] warning: desktop app skipped (LHIC_SKIP_DESKTOP=1)." -ForegroundColor Yellow
  $desktopOk = $false
} else {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  if ($arch -ne "x64") {
    Write-Host "[lhic] warning: the LHIC desktop app is not supported on Windows $arch — installing the CLI only." -ForegroundColor Yellow
    $desktopOk = $false
  } else {
    $asset = "lhic-control-center-win-$version-$arch.exe"
    $destDir = Join-Path $env:LOCALAPPDATA "Programs\lhic-control-center"
    $installer = Join-Path $destDir $asset
    $manifest = Join-Path $env:TEMP "lhic-SHA256SUMS-$version.txt"

    try {
      Write-Host "[lhic] Downloading $asset..." -ForegroundColor Green
      New-Item -ItemType Directory -Force -Path $destDir | Out-Null
      Fetch-Url -Url "$baseUrl/$asset" -Out $installer
      Fetch-Url -Url "$baseUrl/SHA256SUMS-$version.txt" -Out $manifest

      $expected = (Get-Content $manifest | Where-Object { $_.TrimEnd().EndsWith("  $asset") } |
        Select-Object -First 1).Trim().Split()[0]
      if (-not $expected -or $expected -notmatch '^[a-f0-9]{64}$') {
        throw "Checksum manifest has no entry for $asset."
      }
      $actual = (Get-FileHash -Algorithm SHA256 -Path $installer).Hash.ToLower()
      if ($actual -ne $expected) {
        Remove-Item $installer -Force
        throw "SHA-256 mismatch for $asset (expected $expected, got $actual)."
      }

      Write-Host "[lhic] Running the NSIS installer..." -ForegroundColor Green
      $process = Start-Process -FilePath $installer -ArgumentList "/S", "/currentuser" -PassThru
      $process.WaitForExit()

      Write-Host "[lhic] Installed LHIC Control Center $version." -ForegroundColor Green
      $exe = Join-Path $destDir "LHIC Control Center.exe"
      if (Test-Path $exe) {
        Write-Host "[lhic] Launch with: & `"$exe`""
      } else {
        Write-Host "[lhic] Launch LHIC Control Center from the Start menu."
      }

      # Execution-layer provisioning (best-effort, non-fatal).
      if ($env:LHIC_SKIP_BACKENDS -eq "1") {
        Write-Host "[lhic] Backend provisioning skipped (LHIC_SKIP_BACKENDS=1)." -ForegroundColor Green
      } else {
        $osVersion = [System.Environment]::OSVersion.Version
        $osSupported = $osVersion.Major -gt 10 -or ($osVersion.Major -eq 10 -and $osVersion.Build -ge 14393)
        if ($osSupported) {
          $bridgeDll = Join-Path $destDir "lhic-flaui.dll"
          if (-not (Test-Path $bridgeDll)) {
            if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
              if (Get-Command winget -ErrorAction SilentlyContinue) {
                Write-Host "[lhic] Installing the .NET SDK (for the FlaUI bridge)…" -ForegroundColor Green
                winget install --id Microsoft.DotNet.SDK.8 --silent --accept-source-agreements --accept-package-agreements
              } else {
                Write-Host "[lhic] FlaUI needs the .NET SDK; install it, then run scripts/build-flaui-helper.ps1." -ForegroundColor Yellow
              }
            }
            if (Get-Command dotnet -ErrorAction SilentlyContinue) {
              Write-Host "[lhic] Building the FlaUI bridge (Windows 10+ element layer)…" -ForegroundColor Green
              $helper = "$PSScriptRoot\..\packages\skills\src\execution\flaui\lhic-flaui.csproj"
              if (Test-Path $helper) {
                dotnet publish $helper -c Release -r win-x64 --self-contained false -o $destDir
              } else {
                Write-Host "[lhic] Bridge sources not found beside the installer; set LHIC_FLAUI_DLL after building scripts/build-flaui-helper.ps1." -ForegroundColor Yellow
              }
            }
          } else {
            Write-Host "[lhic] FlaUI bridge present at $bridgeDll" -ForegroundColor Green
          }
        } else {
          Write-Host "[lhic] FlaUI requires Windows 10 1607+; using the traditional PowerShell layer." -ForegroundColor Yellow
        }
        # OmniParser V2 fallback (DOM-invisible screens), pip ladder.
        if (Get-Command python3 -ErrorAction SilentlyContinue) {
          try {
            python3 -c "import omni_parser_v2; print('ok')" 2>$null | Out-Null
          } catch { }
          $imports = $LASTEXITCODE -eq 0
          if (-not $imports) {
            Write-Host "[lhic] Installing OmniParser V2 (pip ladder)…" -ForegroundColor Green
            python3 -m pip install --user omni_parser_v2 2>$null | Out-Null
            if ($LASTEXITCODE -ne 0) {
              python3 -m pip install --user --break-system-packages omni_parser_v2 2>$null | Out-Null
            }
            if ($LASTEXITCODE -ne 0) {
              python3 -m pip install --break-system-packages omni_parser_v2 2>$null | Out-Null
            }
            try {
              python3 -c "import omni_parser_v2; print('ok')" 2>$null | Out-Null
            } catch { }
            if ($LASTEXITCODE -eq 0) {
              Write-Host "[lhic] OmniParser V2 installed (weights download on first use)." -ForegroundColor Green
            } else {
              Write-Host "[lhic] warning: OmniParser V2 install failed; LHIC falls back to coordinates." -ForegroundColor Yellow
            }
          } else {
            Write-Host "[lhic] OmniParser V2 already installed." -ForegroundColor Green
          }
        }
        Write-Host "[lhic] Provisioning done — everything still missing falls back to the traditional layer." -ForegroundColor Green
      }
    } catch {
      Write-Host "[lhic] warning: desktop install failed ($($_.Exception.Message)) — continuing with the CLI only." -ForegroundColor Yellow
      $desktopOk = $false
    }
  }
}

# ---- 2. CLI -----------------------------------------------------------------
$cliOk = $true
if ($env:LHIC_SKIP_CLI -eq "1") {
  Write-Host "[lhic] warning: CLI skipped (LHIC_SKIP_CLI=1)." -ForegroundColor Yellow
  $cliOk = $false
} elseif ($env:LHIC_SKIP_NODE -eq "1") {
  Write-Host "[lhic] warning: Node.js install skipped (LHIC_SKIP_NODE=1); the CLI needs Node.js 24+." -ForegroundColor Yellow
  $cliOk = $false
} else {
  $nodeOk = $false
  if (Get-Command node -ErrorAction SilentlyContinue) {
    try {
      $nodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
      $nodeOk = $nodeMajor -ge 24
    } catch { $nodeOk = $false }
  }
  if (-not $nodeOk) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      Write-Host "[lhic] Installing/upgrading Node.js 24 via winget…" -ForegroundColor Green
      winget install --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
    } else {
      Write-Host "[lhic] warning: Node.js 24+ is required for the CLI and winget is unavailable; install it manually." -ForegroundColor Yellow
      $cliOk = $false
    }
  }
}
if ($cliOk -and -not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "[lhic] warning: the LHIC CLI needs Node.js 24+; install it, then run: npm install --global $cliPackage" -ForegroundColor Yellow
  $cliOk = $false
}
if ($cliOk -and -not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host "[lhic] warning: npm is not available; install the LHIC CLI with: npm install --global $cliPackage" -ForegroundColor Yellow
  $cliOk = $false
}
if ($cliOk) {
  try {
    $nodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
    if ($nodeMajor -lt 24) {
      throw "Node.js 24+ is required (this is Node $nodeMajor)."
    }
    Write-Host "[lhic] Installing the LHIC CLI ($cliPackage)…" -ForegroundColor Green
    npm install --global --ignore-scripts $cliPackage | Out-Null
    if (-not (Get-Command lhic -ErrorAction SilentlyContinue)) {
      throw "npm install finished but the lhic binary is not on PATH."
    }
    Write-Host "[lhic] CLI installed — run: lhic" -ForegroundColor Green
  } catch {
    Write-Host "[lhic] warning: CLI install failed ($($_.Exception.Message)); install it manually with: npm install --global $cliPackage" -ForegroundColor Yellow
    $cliOk = $false
  }
}

# ---- Summary ----------------------------------------------------------------
if (-not $desktopOk -and -not $cliOk) {
  throw "Neither the desktop app nor the CLI could be installed."
}
if (-not $desktopOk) {
  Write-Host "[lhic] Only the CLI was installed — the desktop app is not supported on this machine." -ForegroundColor Yellow
}
Write-Host "[lhic] Done. Desktop: lhic-control-center · CLI: lhic" -ForegroundColor Green
