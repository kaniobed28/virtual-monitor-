#requires -version 5
<#
.SYNOPSIS
  Lists visible top-level windows with a non-empty title.
.DESCRIPTION
  Copy an exact title into a display's "windowTitle" in config.json for a
  gdigrab-window source. The window must not be minimized when captured.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/list-windows.ps1
#>
param([switch]$Json)

$ErrorActionPreference = 'Stop'

$windows =
    Get-Process |
    Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Trim().Length -gt 0 } |
    Sort-Object ProcessName |
    Select-Object @{ n = 'process'; e = { $_.ProcessName } }, @{ n = 'title'; e = { $_.MainWindowTitle } }

if ($Json) {
    $windows | ConvertTo-Json -Compress -Depth 3
    return
}

if (-not $windows) {
    Write-Host "No visible titled windows found. Make sure the target app is open and not minimized."
    return
}

$windows | Format-Table process, title -AutoSize -Wrap
Write-Host ""
Write-Host 'Copy the exact title (everything in the "title" column) into windowTitle in config.json.'
