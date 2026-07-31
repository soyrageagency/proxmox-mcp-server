# rageprox installer (Windows, PowerShell) — no Node, no npm required.
#
#   irm https://raw.githubusercontent.com/soyrageagency/proxmox-mcp-server/main/scripts/install.ps1 | iex
#
# Downloads the latest standalone rageprox.exe from GitHub Releases and puts it
# on your PATH. Re-run any time to update.
#
# Crafted by SoyRage Agency — https://soyrage.es/

$ErrorActionPreference = "Stop"
$Repo   = "soyrageagency/proxmox-mcp-server"
$Asset  = "rageprox-windows-x64.exe"
$Dest   = Join-Path $env:LOCALAPPDATA "Programs\rageprox"
$Exe    = Join-Path $Dest "rageprox.exe"

Write-Host "SoyRage · installing rageprox for Windows…" -ForegroundColor Cyan

$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "rageprox-installer" }
$url = ($release.assets | Where-Object { $_.name -eq $Asset }).browser_download_url
if (-not $url) { throw "Could not find $Asset in the latest release of $Repo." }

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Write-Host "  downloading $($release.tag_name)…"
Invoke-WebRequest -Uri $url -OutFile $Exe

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$Dest*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$Dest", "User")
  Write-Host "  added $Dest to your PATH (restart the terminal to pick it up)."
}

Write-Host "`n  Done. Run:  rageprox    (preview with PROXMOX_MCP_DEMO=true)" -ForegroundColor Green
