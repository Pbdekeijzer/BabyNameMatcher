[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker is not installed or is not available on PATH.'
}

if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
    throw 'Tailscale is not installed or is not available on PATH.'
}

tailscale status *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'Tailscale is installed but this desktop is not connected. Open Tailscale, sign in, and rerun this script.'
}

$repositoryRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$previousPort = $env:PORT
$previousCookieSecure = $env:COOKIE_SECURE
Push-Location $repositoryRoot
try {
    $env:PORT = $Port.ToString()
    $env:COOKIE_SECURE = 'true'
    docker compose up -d --build
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker Compose could not start Baby Name Matcher.'
    }

    $health = $null
    for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
            if ($health.status -eq 'ok') { break }
        } catch {
            Start-Sleep -Seconds 1
        }
    }
    if ($null -eq $health -or $health.status -ne 'ok') {
        throw 'The app container started but did not become healthy.'
    }

    tailscale serve --bg $Port
    if ($LASTEXITCODE -ne 0) {
        throw 'Tailscale Serve could not expose the app.'
    }

    Write-Host ''
    Write-Host 'Baby Name Matcher is running privately on your tailnet.' -ForegroundColor Green
    Write-Host 'Open the HTTPS address shown by Tailscale Serve on both Android phones.'
    tailscale serve status
} finally {
    $env:PORT = $previousPort
    $env:COOKIE_SECURE = $previousCookieSecure
    Pop-Location
}
