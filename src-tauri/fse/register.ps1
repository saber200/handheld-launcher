param(
  [Parameter(Mandatory = $true)][string]$Msix,
  [Parameter(Mandatory = $true)][string]$Cer,
  [Parameter(Mandatory = $true)][string]$ExeDir,
  [Parameter(Mandatory = $true)][string]$ExeName
)
$ErrorActionPreference = "Stop"
$exePath = Join-Path $ExeDir $ExeName
if (-not (Test-Path -LiteralPath $exePath)) {
  throw "安装目录里没有 $ExeName，无法登记全屏体验。"
}
$markerDir = Join-Path $env:APPDATA "handheld-launcher"
New-Item -ItemType Directory -Force -Path $markerDir | Out-Null
$marker = Join-Path $markerDir "fse-exe.txt"
$installed = Get-AppxPackage -Name "com.handheld.launcher" -ErrorAction SilentlyContinue | Select-Object -First 1
$prev = ""
if (Test-Path -LiteralPath $marker) { $prev = (Get-Content -LiteralPath $marker -Raw).Trim() }
if ($installed -and $prev -eq $exePath) {
  Write-Output "已登记。打开 Windows 设置，进入 游戏 → 全屏体验，把主应用选成「掌机启动器」。"
  exit 0
}
if ($installed) {
  Remove-AppxPackage -Package $installed.PackageFullName
}
Import-Certificate -FilePath $Cer -CertStoreLocation "Cert:\CurrentUser\TrustedPeople" | Out-Null
try {
  Add-AppxPackage -Path $Msix -ExternalLocation $ExeDir
} catch {
  $text = $_.Exception.Message
  if ($text -match "80073CFF") {
    throw "需要先打开开发人员模式。到 设置 → 系统 → 开发者选项，打开之后再点一次登记。"
  }
  throw $text
}
Set-Content -LiteralPath $marker -Value $exePath -Encoding UTF8
Write-Output "已登记。打开 Windows 设置，进入 游戏 → 全屏体验，把主应用选成「掌机启动器」。"
