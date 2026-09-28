$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$conf = Get-Content (Join-Path $root "..\tauri.conf.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $conf.version
if (($version.ToString().Split(".").Count) -eq 3) { $version = "$version.0" }
$exeName = "$($conf.productName).exe"

$layout = Join-Path $env:TEMP "handheld-launcher-fse"
if (Test-Path $layout) { Remove-Item $layout -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $layout "Assets") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $layout "Public") | Out-Null
Copy-Item (Join-Path $root "Assets\*") (Join-Path $layout "Assets")
Copy-Item (Join-Path $root "Public\*") (Join-Path $layout "Public")
# SCCD must sit at package root with this exact name for windows.capability registration.
Copy-Item (Join-Path $root "CustomCapability.SCCD") (Join-Path $layout "CustomCapability.SCCD")
if (-not (Test-Path (Join-Path $layout "CustomCapability.SCCD"))) {
  throw "CustomCapability.SCCD missing from pack layout"
}
Write-Output "sccd=$((Get-Item (Join-Path $layout 'CustomCapability.SCCD')).Length) bytes"
$manifest = Get-Content (Join-Path $root "AppxManifest.xml") -Raw -Encoding UTF8
$manifest = [regex]::Replace($manifest, '(<Identity[^>]*\bVersion=")[^"]+(")', "`${1}$version`${2}")
$manifest = [regex]::Replace($manifest, 'Executable="[^"]+"', "Executable=`"$exeName`"")
Set-Content (Join-Path $layout "AppxManifest.xml") -Value $manifest -Encoding utf8NoBOM

$kitRoots = @(
  "C:\Program Files (x86)\Windows Kits\10\bin",
  "C:\Program Files\Windows Kits\10\bin"
)
$make = $null
$sign = $null
foreach ($kitRoot in $kitRoots) {
  if (-not (Test-Path -LiteralPath $kitRoot)) { continue }
  $make = Get-ChildItem $kitRoot -Recurse -Filter makeappx.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  $sign = Get-ChildItem $kitRoot -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if ($make -and $sign) { break }
}
if (-not $make -or -not $sign) {
  throw "找不到 Windows SDK 的 makeappx.exe / signtool.exe（已查: $($kitRoots -join ', ')）"
}
Write-Output "makeappx=$($make.FullName)"
Write-Output "signtool=$($sign.FullName)"

$msix = Join-Path $root "identity.msix"
$cer = Join-Path $root "identity.cer"
$pfx = Join-Path $root "cert.pfx"
if (Test-Path $msix) { Remove-Item $msix -Force }
if (Test-Path $cer) { Remove-Item $cer -Force }
# /nv：exe 在包外。不跳过语义校验时，makeappx 会因 FantasyHub.exe 不在包内而拒绝清单。
& $make.FullName pack /d $layout /p $msix /o /nv
if ($LASTEXITCODE -ne 0) { throw "makeappx 失败 exit=$LASTEXITCODE" }

# Confirm SCCD landed inside the MSIX (zip). Missing file → 0x80070002 on capability register.
$probe = Join-Path $env:TEMP ("fse-msix-probe-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $probe | Out-Null
try {
  Copy-Item -LiteralPath $msix -Destination (Join-Path $probe "pkg.zip")
  Expand-Archive -LiteralPath (Join-Path $probe "pkg.zip") -DestinationPath (Join-Path $probe "out") -Force
  $sccdPacked = Get-ChildItem -Path (Join-Path $probe "out") -Recurse -Filter "CustomCapability.SCCD" | Select-Object -First 1
  if (-not $sccdPacked -or $sccdPacked.Length -lt 50) {
    throw "CustomCapability.SCCD missing from packed identity.msix (windows.capability will fail with 0x80070002)"
  }
  Write-Output "sccd-in-msix=$($sccdPacked.FullName) bytes=$($sccdPacked.Length)"
} finally {
  Remove-Item -LiteralPath $probe -Recurse -Force -ErrorAction SilentlyContinue
}

$cert = New-SelfSignedCertificate -Type Custom -Subject "CN=FantasyHub" -KeyUsage DigitalSignature -FriendlyName "FantasyHub" -CertStoreLocation "Cert:\CurrentUser\My" -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3")
if ($cert.Subject -ne "CN=FantasyHub") {
  throw "证书主题是 $($cert.Subject)，必须是 CN=FantasyHub"
}
$pwd = ConvertTo-SecureString -String "handheld" -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $pwd | Out-Null
Export-Certificate -Cert $cert -FilePath $cer | Out-Null
& $sign.FullName sign /fd SHA256 /f $pfx /p handheld $msix
if ($LASTEXITCODE -ne 0) { throw "signtool 失败 exit=$LASTEXITCODE" }
Remove-Item $pfx -Force -ErrorAction SilentlyContinue

if (-not (Test-Path $msix) -or (Get-Item $msix).Length -lt 200) {
  throw "identity.msix 生成失败或为空"
}
if (-not (Test-Path $cer) -or (Get-Item $cer).Length -lt 200) {
  throw "identity.cer 生成失败或为空"
}
Write-Output "packed $msix ($((Get-Item $msix).Length) bytes) cer=$((Get-Item $cer).Length) bytes"
