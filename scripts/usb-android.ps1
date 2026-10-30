#requires -version 5
<#
.SYNOPSIS
  Runs `adb reverse` for every connected Android device so the phone can open
  http://localhost:<Port> and reach this PC's server through the USB tunnel.
.PARAMETER Port
  TCP port to tunnel (default 3000).
.PARAMETER AdbPath
  adb executable (name on PATH or full path to a portable adb.exe).
.PARAMETER Remove
  Remove the reverse tunnel instead of adding it.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/usb-android.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/usb-android.ps1 -Port 3000 -AdbPath C:\tools\platform-tools\adb.exe
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/usb-android.ps1 -Remove
#>
param(
    [int]$Port = 3000,
    [string]$AdbPath = 'adb',
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

function Invoke-Adb {
    param([string[]]$AdbArgs)
    # Always call with an argument array; never build a command string.
    & $AdbPath @AdbArgs
}

try {
    $raw = Invoke-Adb @('devices')
} catch {
    Write-Error "Could not run adb at '$AdbPath'. Unzip platform-tools and pass -AdbPath, or add it to PATH. ($($_.Exception.Message))"
    exit 1
}

# First line is the "List of devices attached" header.
$lines = @($raw) | Where-Object { $_ -match '\S' } | Select-Object -Skip 1
if (-not $lines) {
    Write-Warning "No devices listed by adb. Check: data USB cable, USB debugging enabled, and accept the prompt on the phone."
    exit 1
}

$any = $false
foreach ($line in $lines) {
    $parts = $line -split '\s+'
    $serial = $parts[0]
    $state = $parts[1]
    if (-not $serial) { continue }

    switch ($state) {
        'device' {
            $any = $true
            if ($Remove) {
                Invoke-Adb @('-s', $serial, 'reverse', '--remove', "tcp:$Port") | Out-Null
                Write-Host "Phone $serial : removed reverse tcp:$Port"
            } else {
                Invoke-Adb @('-s', $serial, 'reverse', "tcp:$Port", "tcp:$Port") | Out-Null
                Write-Host "Phone $serial : open  http://localhost:$Port/?display=N&token=..." -ForegroundColor Green
            }
        }
        'unauthorized' {
            Write-Warning "Phone $serial is 'unauthorized' - unlock it and accept the 'Allow USB debugging' prompt, then re-run."
        }
        'offline' {
            Write-Warning "Phone $serial is 'offline' - replug the cable or toggle USB debugging, then re-run."
        }
        default {
            Write-Warning "Phone $serial is in state '$state'."
        }
    }
}

if (-not $any -and -not $Remove) {
    Write-Warning "No device in state 'device' was ready. See warnings above."
    exit 1
}
