param(
  [Parameter(Mandatory = $true)][string]$Msix,
  [Parameter(Mandatory = $true)][string]$Cer,
  [Parameter(Mandatory = $true)][string]$ExeDir,
  [Parameter(Mandatory = $true)][string]$ExeName,
  # Startup auto-register must NOT remove the package — Remove-AppxPackage kills
  # FantasyHub mid-splash when it is already the FSE home app.
  [switch]$Force
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

# Tauri resource_dir() often yields \\?\C:\... which Add-AppxPackage treats as a bad URI.
function Normalize-WinPath([string]$p) {
  if ([string]::IsNullOrWhiteSpace($p)) { return $p }
  $p = $p.Trim().Trim('"')
  if ($p.StartsWith("\\?\UNC\")) { return ("\\" + $p.Substring(8)) }
  if ($p.StartsWith("\\?\")) { return $p.Substring(4) }
  return $p
}

$Msix = Normalize-WinPath $Msix
$Cer = Normalize-WinPath $Cer
$ExeDir = Normalize-WinPath $ExeDir
$ExeName = Normalize-WinPath $ExeName

$exePath = Join-Path $ExeDir $ExeName
if (-not (Test-Path -LiteralPath $exePath)) {
  Fail "NO_EXE" "Missing launcher exe: $exePath"
}

# AppxManifest Executable is FantasyHub.exe (productName). Older builds shipped
# handheld-launcher.exe — FSE boot then fails with "Windows cannot find ... FantasyHub.exe".
$manifestExe = "FantasyHub.exe"
$aliasPath = Join-Path $ExeDir $manifestExe
if ($ExeName -ne $manifestExe) {
  Copy-Item -LiteralPath $exePath -Destination $aliasPath -Force
  Write-Detail "FSE alias: copied $exePath -> $aliasPath"
} elseif (-not (Test-Path -LiteralPath $aliasPath)) {
  Fail "NO_EXE" "Missing FantasyHub.exe for FSE ExternalLocation: $aliasPath"
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

function Paths-Equal([string]$a, [string]$b) {
  if ([string]::IsNullOrWhiteSpace($a) -or [string]::IsNullOrWhiteSpace($b)) { return $false }
  return ($a.TrimEnd('\') -ieq $b.TrimEnd('\'))
}

# Package already present: never Remove-AppxPackage unless -Force (settings re-register).
# Auto startup used to remove+readd when the marker path differed (e.g. handheld-launcher.exe
# vs FantasyHub.exe) and Windows terminated this process during the boot splash.
if ($installed -and -not $Force) {
  Set-Content -LiteralPath $marker -Value $exePath -Encoding ascii
  Write-Detail "Already registered (skip remove). Package=$($installed.PackageFullName) Exe=$exePath Prev=$prev"
  Write-Output "OK"
  exit 0
}
if ($installed -and $Force -and (Paths-Equal $prev $exePath)) {
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
  # Use resolved filesystem paths (no \\?\ prefix) for Add-AppxPackage.
  $msixFull = (Resolve-Path -LiteralPath $Msix).Path
  $exeDirFull = (Resolve-Path -LiteralPath $ExeDir).Path
  Write-Detail "Add-AppxPackage Path=$msixFull ExternalLocation=$exeDirFull"
  # Sparse packages sometimes resolve CustomCapability.SCCD from ExternalLocation.
  $sccdSrc = Join-Path (Split-Path -Parent $Msix) "CustomCapability.SCCD"
  if (-not (Test-Path -LiteralPath $sccdSrc)) {
    # Fall back: extract from the msix we are about to register.
    $extract = Join-Path $env:TEMP ("fse-sccd-" + [guid]::NewGuid().ToString("n"))
    try {
      New-Item -ItemType Directory -Path $extract | Out-Null
      Copy-Item -LiteralPath $msixFull -Destination (Join-Path $extract "pkg.zip")
      Expand-Archive -LiteralPath (Join-Path $extract "pkg.zip") -DestinationPath (Join-Path $extract "out") -Force
      $found = Get-ChildItem -Path (Join-Path $extract "out") -Recurse -Filter "CustomCapability.SCCD" | Select-Object -First 1
      if ($found) { $sccdSrc = $found.FullName }
    } catch {}
  }
  if (Test-Path -LiteralPath $sccdSrc) {
    Copy-Item -LiteralPath $sccdSrc -Destination (Join-Path $exeDirFull "CustomCapability.SCCD") -Force
  }
  Add-AppxPackage -Path $msixFull -ExternalLocation $exeDirFull
} catch {
  $text = $_.Exception.Message
  if ($text -match "80073CFF|Developer Mode") {
    Fail "NEED_DEVMODE" $text
  }
  if ($text -match "80073CF9|certificate|trusted|signature") {
    Fail "CERT_FAIL" $text
  }
  if ($text -match "URI|主机名|hostname") {
    Fail "ADD_FAIL" "Bad path for Add-AppxPackage (URI parse). Msix=$Msix ExeDir=$ExeDir Detail=$text"
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
