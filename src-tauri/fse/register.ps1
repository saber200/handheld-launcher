param(
  [Parameter(Mandatory = $true)][string]$Msix,
  [Parameter(Mandatory = $true)][string]$Cer,
  [Parameter(Mandatory = $true)][string]$ExeDir,
  [Parameter(Mandatory = $true)][string]$ExeName
)
$ErrorActionPreference = "Stop"
$exePath = Join-Path $ExeDir $ExeName
if (-not (Test-Path -LiteralPath $exePath)) {
  Write-Output "NO_EXE"
  exit 1
}
$markerDir = Join-Path $env:APPDATA "handheld-launcher"
New-Item -ItemType Directory -Force -Path $markerDir | Out-Null
$marker = Join-Path $markerDir "fse-exe.txt"
$installed = Get-AppxPackage -Name "com.handheld.launcher" -ErrorAction SilentlyContinue | Select-Object -First 1
$prev = ""
if (Test-Path -LiteralPath $marker) { $prev = (Get-Content -LiteralPath $marker -Raw).Trim() }
if ($installed -and $prev -eq $exePath) {
  Write-Output "OK"
  exit 0
}
try {
  if ($installed) {
    Remove-AppxPackage -Package $installed.PackageFullName
  }
  Import-Certificate -FilePath $Cer -CertStoreLocation "Cert:\CurrentUser\TrustedPeople" | Out-Null
  Add-AppxPackage -Path $Msix -ExternalLocation $ExeDir
} catch {
  $text = $_.Exception.Message
  if ($text -match "80073CFF") {
    Write-Output "NEED_DEVMODE"
    exit 1
  }
  Write-Output "FAIL"
  exit 1
}
Set-Content -LiteralPath $marker -Value $exePath -Encoding ascii
Write-Output "OK"
