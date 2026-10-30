#requires -version 5
<#
.SYNOPSIS
  Prints LAN IPs, network category, VPN status and phone URLs, and (if the
  server is running) locally probes /healthz on each address.
.DESCRIPTION
  IMPORTANT: a local /healthz success does NOT prove a phone can reach this PC.
  Windows Firewall and Wi-Fi client isolation only affect traffic coming from
  OTHER devices, which a loopback/local probe never exercises. The real test is
  opening the URL on the phone itself.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-network.ps1
#>
param([int]$Port)

$ErrorActionPreference = 'Continue'

# ---- Read config.json for port/token/mode (best effort) ------------------
$configPath = Join-Path $PSScriptRoot '..\config.json'
$token = $null
$mode = 'lan'
if (Test-Path $configPath) {
    try {
        $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
        if (-not $Port -and $cfg.port) { $Port = [int]$cfg.port }
        if ($cfg.token) { $token = $cfg.token }
        if ($cfg.mode) { $mode = $cfg.mode }
    } catch {
        Write-Warning "Could not parse config.json: $($_.Exception.Message)"
    }
}
if (-not $Port) { $Port = 3000 }

Write-Host "=== Network adapters (IPv4) ===" -ForegroundColor Cyan
$addrs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object InterfaceAlias, IPAddress
$addrs | Format-Table -AutoSize

Write-Host "=== Network connection profiles ===" -ForegroundColor Cyan
try {
    Get-NetConnectionProfile |
        Select-Object Name, InterfaceAlias, NetworkCategory |
        Format-Table -AutoSize
} catch {
    Write-Warning "Get-NetConnectionProfile not available: $($_.Exception.Message)"
}

Write-Host "=== VPN check ===" -ForegroundColor Cyan
$vpn = Get-NetAdapter -ErrorAction SilentlyContinue |
    Where-Object { $_.Status -eq 'Up' -and ($_.InterfaceDescription -match 'VPN|TAP|WAN Miniport|WireGuard|OpenVPN|Cisco|GlobalProtect|Zscaler') }
if ($vpn) {
    Write-Warning "A VPN-like adapter is up; it may block the phone from reaching this PC's subnet:"
    $vpn | Select-Object Name, InterfaceDescription, Status | Format-Table -AutoSize
} else {
    Write-Host "No obvious VPN adapter up."
}

Write-Host "=== Phone URLs (mode: $mode) ===" -ForegroundColor Cyan
$tok = if ($token) { [uri]::EscapeDataString($token) } else { '<token>' }
if ($mode -eq 'usb') {
    Write-Host "  http://localhost:$Port/?display=1&token=$tok   (via adb reverse)"
} else {
    foreach ($a in $addrs) {
        Write-Host ("  http://{0}:{1}/?display=1&token={2}   [{3}]" -f $a.IPAddress, $Port, $tok, $a.InterfaceAlias)
    }
}

Write-Host "=== Local /healthz probe ===" -ForegroundColor Cyan
$probeHosts = @('127.0.0.1') + ($addrs | ForEach-Object { $_.IPAddress })
foreach ($h in ($probeHosts | Select-Object -Unique)) {
    $url = "http://${h}:$Port/healthz"
    try {
        $resp = Invoke-WebRequest -Uri $url -TimeoutSec 2 -UseBasicParsing
        Write-Host ("  OK   {0} -> {1}" -f $url, $resp.Content.Trim()) -ForegroundColor Green
    } catch {
        Write-Host ("  FAIL {0} ({1})" -f $url, $_.Exception.Message) -ForegroundColor DarkYellow
    }
}

Write-Host ""
Write-Host "Reminder: a local probe passing does NOT prove a phone can connect." -ForegroundColor Yellow
Write-Host "Open the phone URL on the phone itself to confirm firewall / Wi-Fi isolation." -ForegroundColor Yellow
