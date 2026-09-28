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
Copy-Item (Join-Path $root "CustomCapability.SCCD") $layout

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
