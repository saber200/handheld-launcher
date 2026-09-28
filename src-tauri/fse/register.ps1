param(
  [Parameter(Mandatory = $true)][string]$Msix,
  [Parameter(Mandatory = $true)][string]$Cer,
  [Parameter(Mandatory = $true)][string]$ExeDir,
  [Parameter(Mandatory = $true)][string]$ExeName
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$markerDir = Join-Path $env:APPDATA "handheld-launcher"
New-Item -ItemType Directory -Force -Path $markerDir | Out-Null
$detail = Join-Path $markerDir "fse-last-error.txt"
$marker = Join-Path $markerDir "fse-exe.txt"

function Write-Detail([string]$text) {
  Set-Content -LiteralPath $detail -Value $text -Encoding utf8
}

function Fail([string]$token, [string]$message) {
  Write-Detail $message
  Write-Output $token
  exit 1
}

$exePath = Join-Path $ExeDir $ExeName
if (-not (Test-Path -LiteralPath $exePath)) {
  Fail "NO_EXE" "Missing launcher exe: $exePath"
}

if (-not (Test-Path -LiteralPath $Msix) -or -not (Test-Path -LiteralPath $Cer)) {
  Fail "EMPTY_PAYLOAD" "Missing identity files. Msix=$Msix Cer=$Cer"
}

$msixLen = (Get-Item -LiteralPath $Msix).Length
$cerLen = (Get-Item -LiteralPath $Cer).Length
if ($msixLen -lt 200 -or $cerLen -lt 200) {
  Fail "EMPTY_PAYLOAD" "Identity files look empty. MsixBytes=$msixLen CerBytes=$cerLen Path=$Msix"
}

# Sideloading custom-capability packages needs Developer Mode.
$devMode = 0
try {
  $devMode = [int](Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" -Name "AllowDevelopmentWithoutDevLicense" -ErrorAction SilentlyContinue).AllowDevelopmentWithoutDevLicense
} catch {}
if ($devMode -ne 1) {
  Fail "NEED_DEVMODE" "Developer Mode is off (AppModelUnlock=$devMode)."
}

$installed = Get-AppxPackage -Name "com.handheld.launcher" -ErrorAction SilentlyContinue | Select-Object -First 1
$prev = ""
if (Test-Path -LiteralPath $marker) { $prev = (Get-Content -LiteralPath $marker -Raw).Trim() }
if ($installed -and $prev -eq $exePath) {
  Write-Detail "Already registered. Package=$($installed.PackageFullName) Exe=$exePath"
  Write-Output "OK"
  exit 0
}

# Trust the package certificate (CurrentUser always; LocalMachine when elevated).
try {
  Import-Certificate -FilePath $Cer -CertStoreLocation "Cert:\CurrentUser\TrustedPeople" | Out-Null
} catch {
  Fail "CERT_FAIL" "CurrentUser TrustedPeople import failed: $($_.Exception.Message)"
}
try {
  Import-Certificate -FilePath $Cer -CertStoreLocation "Cert:\LocalMachine\TrustedPeople" | Out-Null
} catch {
  # Non-fatal when not elevated enough; CurrentUser may still be enough.
  Write-Detail "LocalMachine cert import skipped: $($_.Exception.Message)"
}

try {
  if ($installed) {
    Remove-AppxPackage -Package $installed.PackageFullName
  }
  Add-AppxPackage -Path $Msix -ExternalLocation $ExeDir
} catch {
  $text = $_.Exception.Message
  if ($text -match "80073CFF|Developer Mode|开发人员") {
    Fail "NEED_DEVMODE" $text
  }
  if ($text -match "80073CF9|certificate|签名|签名无效|trusted") {
    Fail "CERT_FAIL" $text
  }
  Fail "ADD_FAIL" $text
}

$check = Get-AppxPackage -Name "com.handheld.launcher" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $check) {
  Fail "ADD_FAIL" "Add-AppxPackage returned but Get-AppxPackage found no com.handheld.launcher."
}

Set-Content -LiteralPath $marker -Value $exePath -Encoding ascii
Write-Detail "Registered OK. Package=$($check.PackageFullName) Exe=$exePath"
Write-Output "OK"
exit 0
