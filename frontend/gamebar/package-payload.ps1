# 把 Game Bar 小组件做成「启动器安装包能直接带的那几样东西」：
#   widget.msix                 签好名的包（没签名 Windows 不装）
#   widget.cer                  它的签名证书（安装时进当前用户的「受信任人」）
#   deps\*.appx                 三个框架依赖，目标机通常没有，必须随包带
#   INSTALL.txt / widget-payload.json   手动补救用的说明与校验信息
#
# 为什么签名证书是每次现打：私钥不能进 git；要固定下来得走 GitHub secret 导入 PFX，
# 那是后一步。现打也能用 —— 安装脚本会先卸旧的包再装新的（换证书签的同 identity 包
# 不能被覆盖安装），并且会顺手清掉同主题的旧证书。
#
# 产物直接写进启动器的 resources 目录（CI 里是 src-tauri/payload/gamebar）：
# 那几个路径在 tauri.conf.json 的 bundle.resources 里，仓库里另有 0 字节占位兜底
# （src-tauri/build.rs），所以这一步失败也不会把发版流程卡住 —— 只是那个安装包不带小组件。
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')][string]$Configuration = 'Debug',
    [Parameter(Mandatory = $true)][string]$OutDir,
    [string]$TimestampUrl
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This script requires Windows and Visual Studio UWP build tools.' }

$root = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $root '..\..')).Path
$out = $OutDir
if (-not [System.IO.Path]::IsPathRooted($out)) { $out = Join-Path (Get-Location).Path $out }
New-Item -ItemType Directory -Force -Path $out | Out-Null
$depsOut = Join-Path $out 'deps'
New-Item -ItemType Directory -Force -Path $depsOut | Out-Null

# 包名/发布者必须对得上：证书 Subject 和清单 Publisher 不一致时 signtool 直接报错。
$manifestPath = Join-Path $root 'Widget\Package.appxmanifest'
[xml]$manifest = Get-Content $manifestPath -Raw -Encoding UTF8
$publisher = [string]$manifest.Package.Identity.Publisher
$widgetVersion = [string]$manifest.Package.Identity.Version
if ($publisher -ne 'CN=FantasyHub') { throw "Unexpected manifest Publisher: $publisher" }

# 启动器版本（根 Cargo.toml 与 package.json 的 5 处之一）和小组件版本对不上只是"显示旧版本"，
# 不影响安装（安装脚本按包 hash 判断要不要重装），所以只提醒、不拦。
$launcherVersion = ((Get-Content (Join-Path $repo 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version)
if ($widgetVersion -ne "$launcherVersion.0") {
    Write-Warning "Widget manifest version $widgetVersion != launcher $launcherVersion.0 — bump frontend/gamebar/Widget/Package.appxmanifest too (see .clinerules 版本 6 处)."
}

# 自签证书：Code Signing EKU 是 AppX 签名的最低要求。
$cert = New-SelfSignedCertificate -Type Custom -Subject $publisher -FriendlyName 'FantasyHub Game Bar widget (CI)' `
    -CertStoreLocation 'Cert:\CurrentUser\My' -KeyUsage DigitalSignature -KeyExportPolicy Exportable `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
$cerPath = Join-Path $out 'widget.cer'
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null
# 让 build-windows.ps1 里那句 `signtool verify /pa` 能过：自签证书得先在自己的根存储里
# （CI runner 是一次性的、而且本来就是管理员，改信任没副作用）。
foreach ($store in @('Cert:\CurrentUser\Root', 'Cert:\LocalMachine\Root')) {
    try { Import-Certificate -FilePath $cerPath -CertStoreLocation $store | Out-Null } catch { Write-Warning "trust import into $store failed: $($_.Exception.Message)" }
}

# -TimestampUrl 只在给了值时才传：给 [string] 参数传 $null 在多平台上行为不一致，别赌。
$buildArgs = @{ Configuration = $Configuration; CertificateThumbprint = $cert.Thumbprint }
if ($TimestampUrl) { $buildArgs.TimestampUrl = $TimestampUrl }
try {
    & (Join-Path $root 'build-windows.ps1') @buildArgs
} catch {
    throw "build-windows.ps1 failed: $($_.Exception.Message)"
}

$resultJson = @(Get-ChildItem (Join-Path $root 'AppPackages') -Recurse -Filter 'build-result.json' -File |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1)
if ($resultJson.Count -eq 0) { throw 'build-windows.ps1 produced no build-result.json.' }
$result = Get-Content $resultJson[0].FullName -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $result.signed) { throw 'The widget package came out unsigned; refusing to ship it.' }
if ($result.configuration -ne $Configuration) { throw "build-result.json says $($result.configuration), expected $Configuration." }

$package = [string]$result.package
Copy-Item -LiteralPath $package -Destination (Join-Path $out 'widget.msix') -Force

# 依赖包：MSBuild 把框架包放在主包旁边的 Dependencies\x64 里。
# 这三个文件名必须和 src-tauri/build.rs / src-tauri/tauri.conf.json 里登记的路径一致 ——
# 不一致的话启动器安装包会带个空占位，装到机器上就是「这个版本没带小组件」。
$expectedDeps = @(
    'Microsoft.NET.CoreRuntime.2.2.appx',
    'Microsoft.NET.CoreFramework.Debug.2.2.appx',
    'Microsoft.VCLibs.x64.Debug.14.00.appx'
)
$depSource = @(Get-ChildItem (Split-Path -Parent $package) -Recurse -File -Filter '*.appx' |
    Where-Object { $_.DirectoryName -match '[\\/]Dependencies[\\/]' })
if ($Configuration -ne 'Debug') {
    # Release 会换成非 Debug 的框架包（名字也不同），那时记得同步改上面两个文件里的路径。
    Write-Warning "Release 配置的依赖清单还没核对过：请把实际文件名同步进 src-tauri/build.rs 与 tauri.conf.json。"
}
$missing = @()
foreach ($name in $expectedDeps) {
    $found = @($depSource | Where-Object { $_.Name -eq $name } | Select-Object -First 1)
    if ($found.Count -eq 0) { $missing += $name; continue }
    Copy-Item -LiteralPath $found[0].FullName -Destination (Join-Path $depsOut $name) -Force
}
if ($missing.Count -gt 0) {
    $actual = ($depSource | ForEach-Object { $_.Name }) -join ', '
    throw "Dependencies\x64 is missing $($missing -join ', '). Found: $actual"
}

# 手动补救用的说明：安装器那一步失败时，用户/我们自己能照这个在本机装一遍。
$install = @"
FantasyHub Game Bar widget payload ($Configuration)

这个目录是给「FantasyHub 启动器安装包」用的：装启动器时会自动把小组件注册到当前用户，
不需要管理员、也不需要开发人员模式（包已签名，证书会装进当前用户的「受信任人」）。

要手动装（比如排查问题），在 Windows PowerShell 里 cd 到这个目录，然后：

  Import-Certificate -FilePath .\widget.cer -CertStoreLocation Cert:\CurrentUser\TrustedPeople
  Add-AppxPackage -Path .\deps\Microsoft.NET.CoreRuntime.2.2.appx
  Add-AppxPackage -Path .\deps\Microsoft.NET.CoreFramework.Debug.2.2.appx
  Add-AppxPackage -Path .\deps\Microsoft.VCLibs.x64.Debug.14.00.appx
  Add-AppxPackage -Path .\widget.msix

装完按 Ctrl+Shift+Esc 结束 GameBar.exe（Game Bar 只在启动时枚举小组件），再按 Win+G
就能在小组件菜单里看到 FantasyHub。

注意：
- 这份 msix 用 CI 现场生成的自签证书签的，每次构建都不一样。换新的 msix 之前要
  Remove-AppxPackage FantasyHub.GameBar，否则会报 0x80073CF9（换证书签的包不能覆盖安装）。
- 三个 deps 是小组件的框架依赖，目标机通常没有；少了它们 Add-AppxPackage 会报缺依赖。
- 失败原因看 %APPDATA%\handheld-launcher\widget-last-error.txt（启动器自己装的时候写的）。
"@
Set-Content -LiteralPath (Join-Path $out 'INSTALL.txt') -Value $install -Encoding UTF8

[ordered]@{
    configuration = $Configuration
    version = $widgetVersion
    launcherVersion = $launcherVersion
    publisher = $publisher
    name = [string]$result.name
    package = (Join-Path $out 'widget.msix')
    sha256 = (Get-FileHash (Join-Path $out 'widget.msix') -Algorithm SHA256).Hash
    certificateThumbprint = $cert.Thumbprint
    certificate = $cerPath
    dependencies = $expectedDeps
    signed = [bool]$result.signed
    generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
} | ConvertTo-Json | Set-Content (Join-Path $out 'widget-payload.json') -Encoding UTF8

Write-Host "Widget payload for the launcher installer:"
Get-ChildItem $out -Recurse -File | ForEach-Object { Write-Host ("  {0}  ({1} bytes)" -f $_.FullName.Substring($out.Length + 1), $_.Length) }
Write-Host "Version $widgetVersion ($Configuration), certificate $($cert.Thumbprint)"
