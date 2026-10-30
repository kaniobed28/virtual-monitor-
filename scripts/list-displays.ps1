#requires -version 5
<#
.SYNOPSIS
  Lists monitors with their virtual-desktop bounds and primary flag.
.DESCRIPTION
  Makes the process per-monitor DPI-aware first so bounds are reported in
  physical pixels (matching what gdigrab offsets expect). Use -Json for machine
  output consumed by src/displays.js.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/list-displays.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/list-displays.ps1 -Json
#>
param([switch]$Json)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DpiHelper {
    [DllImport("shcore.dll")]
    public static extern int SetProcessDpiAwareness(int value);
}
"@ 2>$null | Out-Null

# 2 = PROCESS_PER_MONITOR_DPI_AWARE. Fails harmlessly if awareness is already set.
try { [DpiHelper]::SetProcessDpiAwareness(2) | Out-Null } catch { }

Add-Type -AssemblyName System.Windows.Forms

$screens = [System.Windows.Forms.Screen]::AllScreens
$list = @()
for ($i = 0; $i -lt $screens.Count; $i++) {
    $s = $screens[$i]
    $b = $s.Bounds
    $list += [PSCustomObject]@{
        index   = $i
        name    = $s.DeviceName
        x       = $b.X
        y       = $b.Y
        width   = $b.Width
        height  = $b.Height
        primary = [bool]$s.Primary
    }
}

if ($Json) {
    # -Depth keeps nested PSCustomObjects intact; -Compress for easy parsing.
    $list | ConvertTo-Json -Compress -Depth 4
    return
}

$list | Format-Table index, name, x, y, width, height, primary -AutoSize

Write-Host ""
Write-Host "NOTE: the Windows screen order above may NOT match FFmpeg's ddagrab output_idx."
Write-Host "Find the right output_idx by grabbing one frame per index and viewing it:"
for ($i = 0; $i -lt [Math]::Max($screens.Count, 1); $i++) {
    Write-Host "  ffmpeg -f lavfi -i ddagrab=output_idx=$i -frames:v 1 -vf hwdownload,format=bgra test_$i.png"
}
Write-Host "Set the matching output_idx for each display in config.json."
