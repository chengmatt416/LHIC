# Builds the FlaUI bridge DLL for the LHIC Windows execution layer.
#
#   powershell -ExecutionPolicy Bypass -File scripts/build-flaui-helper.ps1
#
# Publishes to packages/skills/src/execution/flaui/bin/win-x64/lhic-flaui.dll.
# Point LHIC_FLAUI_DLL at the published DLL (or copy it beside the desktop
# executable). Windows 10 1607 or later is required.
$ErrorActionPreference = "Stop"

$project = Join-Path $PSScriptRoot "..\packages\skills\src\execution\flaui\lhic-flaui.csproj"
$output = Join-Path $PSScriptRoot "..\packages\skills\src\execution\flaui\bin\win-x64"

dotnet publish $project -c Release -r win-x64 --self-contained false -o $output

$dll = Join-Path $output "lhic-flaui.dll"
if (-not (Test-Path $dll)) {
  throw "FlaUI bridge build failed: $dll not found."
}
Write-Host "[lhic] FlaUI bridge published to $dll"
Write-Host "[lhic] Set LHIC_FLAUI_DLL=$dll (or copy it beside the app)."
