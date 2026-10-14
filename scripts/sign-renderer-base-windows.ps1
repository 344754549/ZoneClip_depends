[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RootPath,
    [string]$SigningClient = $env:ZONECLIP_SIGNING_CLIENT
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($env:OS -ne "Windows_NT") {
    throw "Renderer base signing must run on Windows."
}

$root = (Resolve-Path -LiteralPath $RootPath).Path
if (-not $SigningClient) {
    $SigningClient = Join-Path $PSScriptRoot "../../../app/scripts/windows-signing-agent.ps1"
}
$SigningClient = (Resolve-Path -LiteralPath $SigningClient -ErrorAction Stop).Path

$thumbprintOutput = @(
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $SigningClient -Mode check
)
if ($LASTEXITCODE -ne 0 -or $thumbprintOutput.Count -eq 0) {
    throw "Windows signing Agent health check failed."
}
$expectedThumbprint = ([string]$thumbprintOutput[-1] -replace "[^0-9A-Fa-f]", "").ToUpperInvariant()
if ($expectedThumbprint.Length -ne 40) {
    throw "Windows signing Agent returned an invalid certificate thumbprint."
}

$binaries = @(
    Get-ChildItem -LiteralPath $root -Recurse -File |
        Where-Object { $_.Extension.ToLowerInvariant() -in ".dll", ".exe" } |
        Sort-Object FullName
)
if ($binaries.Count -eq 0) {
    throw "Renderer base contains no Windows PE binaries: $root"
}

$signed = 0
$preserved = 0
foreach ($binary in $binaries) {
    $signature = Get-AuthenticodeSignature -LiteralPath $binary.FullName
    if ($signature.Status -eq "Valid") {
        $preserved++
        continue
    }
    if ($signature.Status -ne "NotSigned") {
        throw "Refusing to replace an invalid signature on $($binary.FullName): $($signature.Status)"
    }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $SigningClient `
        -Mode sign -ArtifactPath $binary.FullName
    if ($LASTEXITCODE -ne 0) {
        throw "Signing failed for $($binary.FullName)"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $binary.FullName
    $actualThumbprint = if ($signature.SignerCertificate) {
        ($signature.SignerCertificate.Thumbprint -replace "[^0-9A-Fa-f]", "").ToUpperInvariant()
    } else {
        ""
    }
    if ($signature.Status -ne "Valid" -or $actualThumbprint -ne $expectedThumbprint -or -not $signature.TimeStamperCertificate) {
        throw "Signed renderer binary failed verification: $($binary.FullName)"
    }
    $signed++
}

$invalid = @(
    $binaries | Where-Object {
        (Get-AuthenticodeSignature -LiteralPath $_.FullName).Status -ne "Valid"
    }
)
if ($invalid.Count -gt 0) {
    throw "Renderer base signature audit failed for $($invalid.Count) binaries."
}

Write-Host "Renderer base signatures verified: $($binaries.Count) binaries ($signed signed, $preserved vendor-signed)."
